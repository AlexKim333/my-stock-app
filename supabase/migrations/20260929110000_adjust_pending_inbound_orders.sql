-- ==============================================================================
-- 외부창고 발주(pending_orders) 수량 조정 RPC — 보류/장바구니와 DB 발주를 항상 일치시킨다
--
-- 배경: 보류를 장바구니로 불러와 수량 변경·행 추가/삭제 후 다시 보류하거나 제출해도
--       DB 발주(=매트릭스의 이동중/발주중, 유효재고 pending_in)는 최초 수량 그대로라서
--       보류 목록과 매트릭스가 어긋났다. 수량을 늘려 제출하면 같은 품목의 다른 발주 예약이
--       소진되기도 했다(입고확정 FIFO는 보류 단위를 구분하지 않고 창고·품목 합계로 소진).
--
-- 동작: 창고·품목 단위로 "변경량(delta)"을 반영한다. 같은 창고·품목의 열린 발주는 합계만
--       의미가 있으므로(FIFO 소진도 합계 기준) 보류별 소유 관계 없이 합계가 항상 맞는다.
--   - delta < 0 : 오래된 열린 발주부터 취소/감소 (fn_fifo_cancel_pending). 열린 발주가
--                 부족하면 오류로 막지 않고 unmatched 로 보고한다.
--   - delta > 0 : 가용재고(실재고 − 열린 발주 합계)를 창고 재고 행 잠금 아래에서 검증하고
--                 새 발주 행을 만든다. 부족하면 예외 → 전체 롤백(원자적).
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.rpc_adjust_pending_inbound_orders(
  p_source_warehouse TEXT,
  p_items JSONB,
  p_admin TEXT DEFAULT NULL
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
  v_delta BIGINT;
  v_done BIGINT;
  v_gross BIGINT;
  v_committed BIGINT;
  v_label TEXT;
  v_cancelled BIGINT := 0;
  v_added BIGINT := 0;
  v_unmatched JSONB := '[]'::JSONB;
BEGIN
  v_member := public.fn_require_session();

  IF v_wh = '' OR v_wh = 'MAIN' OR NOT EXISTS (SELECT 1 FROM public.warehouses WHERE code = v_wh) THEN
    RAISE EXCEPTION '발주 출발 창고가 올바르지 않습니다: %', COALESCE(p_source_warehouse, '(없음)');
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RETURN jsonb_build_object('success', true, 'cancelled_units', 0, 'added_units', 0, 'unmatched', '[]'::JSONB);
  END IF;

  -- item_id 순서로 처리해 동시 처리 간 교착을 방지한다.
  FOR v_item IN
    SELECT x.item_id,
           SUM(COALESCE(x.delta_box, 0)) AS delta_box,
           SUM(COALESCE(x.delta_unit, 0)) AS delta_unit
    FROM jsonb_to_recordset(p_items) AS x(item_id UUID, delta_box INT, delta_unit INT)
    WHERE x.item_id IS NOT NULL
    GROUP BY x.item_id
    ORDER BY x.item_id
  LOOP
    v_pack := public.fn_item_pack_qty(v_item.item_id);
    v_delta := (v_item.delta_box::BIGINT * v_pack::BIGINT) + v_item.delta_unit::BIGINT;

    IF v_delta = 0 THEN
      CONTINUE;
    END IF;

    IF v_delta < 0 THEN
      v_done := public.fn_fifo_cancel_pending(v_wh, v_item.item_id, -v_delta);
      v_cancelled := v_cancelled + v_done;
      IF v_done < -v_delta THEN
        v_unmatched := v_unmatched || jsonb_build_array(jsonb_build_object(
          'item_id', v_item.item_id,
          'requested_units', -v_delta,
          'cancelled_units', v_done
        ));
      END IF;
    ELSE
      -- 발주 등록과 같은 가용재고 검증 (창고 재고 행을 잠가 동시 발주로 초과되지 않게 한다)
      SELECT public.fn_stock_units(box_qty, unit_qty, v_pack) INTO v_gross
      FROM public.inventory_stocks
      WHERE item_id = v_item.item_id AND warehouse_code = v_wh
      FOR UPDATE;
      v_gross := COALESCE(v_gross, 0);

      SELECT COALESCE(SUM(public.fn_stock_units(box_qty, unit_qty, v_pack)), 0) INTO v_committed
      FROM public.pending_orders
      WHERE item_id = v_item.item_id
        AND from_warehouse = v_wh
        AND to_warehouse = 'MAIN'
        AND status IN ('PENDING', 'IN_TRANSIT');

      IF v_committed + v_delta > v_gross THEN
        SELECT item_name || ' (' || COALESCE(color, 'SURTIDO') || ')' INTO v_label
        FROM public.items WHERE id = v_item.item_id;
        RAISE EXCEPTION '% 창고 % 가용재고 부족: 추가 요청 %개, 가용 %개 (실재고 %개 − 발주진행 %개)',
          v_wh, v_label, v_delta, GREATEST(v_gross - v_committed, 0), v_gross, v_committed;
      END IF;

      INSERT INTO public.pending_orders (
        item_id, from_warehouse, to_warehouse, box_qty, unit_qty, status, requested_by, memo
      ) VALUES (
        v_item.item_id, v_wh, 'MAIN',
        (v_delta / v_pack)::INTEGER, (v_delta % v_pack)::INTEGER,
        'PENDING', COALESCE(NULLIF(TRIM(p_admin), ''), NULLIF(TRIM(v_member.member_name), ''), 'ADMIN'),
        '보류 수정 반영(발주 추가)'
      );
      v_added := v_added + v_delta;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'cancelled_units', v_cancelled,
    'added_units', v_added,
    'unmatched', v_unmatched
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_adjust_pending_inbound_orders(TEXT, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_adjust_pending_inbound_orders(TEXT, JSONB, TEXT) TO anon, authenticated, service_role;
