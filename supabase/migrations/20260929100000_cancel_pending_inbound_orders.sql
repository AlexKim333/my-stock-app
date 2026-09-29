-- ==============================================================================
-- 입고 보류 삭제 시 DB 발주(pending_orders) 취소 RPC
--
-- 배경: 외부(서브)창고 발주는 화면 보류 목록(localStorage)과 DB pending_orders(PENDING)에
--       동시에 등록되고, 유효재고의 pending_in 은 pending_orders 만 합산한다.
--       그런데 보류 삭제는 localStorage 만 지워 DB 행이 유령 예약으로 남았다.
--       (pending_orders 는 클라이언트 SELECT 전용이라 세션 검증 SECURITY DEFINER RPC 필요)
--
-- 동작: 입고확정(fn_fifo_complete_pending)과 같은 FIFO 규칙으로, 지정한 출발창고·품목의
--       열린 발주(PENDING/IN_TRANSIT)를 오래된 순으로 CANCELLED 처리한다.
--       발주 행보다 취소 수량이 적으면 행의 수량만 줄인다.
--       열린 발주가 부족해도(예: 등록 당시 DB 전송이 실패했던 보류) 오류로 막지 않고
--       처리하지 못한 수량을 unmatched 로 돌려준다.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.fn_fifo_cancel_pending(
  p_from_warehouse TEXT,
  p_item_id UUID,
  p_qty_units BIGINT
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_remain BIGINT := GREATEST(COALESCE(p_qty_units, 0), 0);
  v_po RECORD;
  v_pack INTEGER;
  v_po_units BIGINT;
  v_left BIGINT;
  v_cancelled BIGINT := 0;
BEGIN
  IF v_remain <= 0 OR p_item_id IS NULL THEN
    RETURN 0;
  END IF;

  v_pack := public.fn_item_pack_qty(p_item_id);

  FOR v_po IN
    SELECT id, box_qty, unit_qty
    FROM public.pending_orders
    WHERE from_warehouse = p_from_warehouse
      AND item_id = p_item_id
      AND status IN ('PENDING', 'IN_TRANSIT')
    ORDER BY created_at ASC, id ASC
    FOR UPDATE
  LOOP
    EXIT WHEN v_remain <= 0;
    v_po_units := public.fn_stock_units(v_po.box_qty, v_po.unit_qty, v_pack);

    IF v_po_units <= 0 THEN
      UPDATE public.pending_orders
      SET status = 'CANCELLED', updated_at = NOW()
      WHERE id = v_po.id;
      CONTINUE;
    END IF;

    IF v_po_units <= v_remain THEN
      UPDATE public.pending_orders
      SET status = 'CANCELLED', updated_at = NOW()
      WHERE id = v_po.id;
      v_remain := v_remain - v_po_units;
      v_cancelled := v_cancelled + v_po_units;
    ELSE
      v_left := v_po_units - v_remain;
      UPDATE public.pending_orders
      SET box_qty = (v_left / v_pack)::INTEGER,
          unit_qty = (v_left % v_pack)::INTEGER,
          updated_at = NOW()
      WHERE id = v_po.id;
      v_cancelled := v_cancelled + v_remain;
      v_remain := 0;
    END IF;
  END LOOP;

  RETURN v_cancelled;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_fifo_cancel_pending(TEXT, UUID, BIGINT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.rpc_cancel_pending_inbound_orders(
  p_source_warehouse TEXT,
  p_items JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_member public.app_members%ROWTYPE;
  v_wh TEXT := UPPER(TRIM(COALESCE(p_source_warehouse, '')));
  v_item RECORD;
  v_pack INTEGER;
  v_req BIGINT;
  v_done BIGINT;
  v_cancelled_total BIGINT := 0;
  v_unmatched JSONB := '[]'::JSONB;
BEGIN
  v_member := public.fn_require_session();

  IF v_wh = '' OR v_wh = 'MAIN' THEN
    RAISE EXCEPTION '취소할 발주의 출발(외부)창고가 올바르지 않습니다: %', COALESCE(p_source_warehouse, '(없음)');
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RETURN jsonb_build_object('success', true, 'cancelled_units', 0, 'unmatched', '[]'::JSONB);
  END IF;

  -- item_id 순서로 처리해 동시 처리 간 교착을 방지한다.
  FOR v_item IN
    SELECT x.item_id, SUM(COALESCE(x.box_qty, 0)) AS box_qty, SUM(COALESCE(x.unit_qty, 0)) AS unit_qty
    FROM jsonb_to_recordset(p_items) AS x(item_id UUID, box_qty INT, unit_qty INT)
    WHERE x.item_id IS NOT NULL
    GROUP BY x.item_id
    ORDER BY x.item_id
  LOOP
    v_pack := public.fn_item_pack_qty(v_item.item_id);
    v_req := public.fn_stock_units(ABS(v_item.box_qty)::INTEGER, ABS(v_item.unit_qty)::INTEGER, v_pack);
    IF v_req <= 0 THEN
      CONTINUE;
    END IF;

    v_done := public.fn_fifo_cancel_pending(v_wh, v_item.item_id, v_req);
    v_cancelled_total := v_cancelled_total + v_done;

    IF v_done < v_req THEN
      v_unmatched := v_unmatched || jsonb_build_array(jsonb_build_object(
        'item_id', v_item.item_id,
        'requested_units', v_req,
        'cancelled_units', v_done
      ));
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'cancelled_units', v_cancelled_total,
    'unmatched', v_unmatched
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_cancel_pending_inbound_orders(TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_pending_inbound_orders(TEXT, JSONB) TO anon, authenticated, service_role;
