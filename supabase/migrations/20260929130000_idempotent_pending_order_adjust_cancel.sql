-- ==============================================================================
-- 발주 조정/취소 RPC 멱등 처리
--
-- 문제: rpc_adjust_pending_inbound_orders / rpc_cancel_pending_inbound_orders 는 요청마다 변경량을
--       그대로 적용한다. DB에는 반영됐는데 응답만 유실되면 화면은 실패로 보고 재시도하고, 같은 변경이
--       한 번 더 적용된다(줄이면 다른 열린 발주까지 추가 취소, 늘리면 발주가 두 번 생김).
--
-- 조치: 기존 입출고와 같은 방식(fn_idempotency_lock / fn_idempotency_store)으로 요청별 멱등 키를 받는다.
--  - 같은 키의 재요청은 처리하지 않고 저장된 결과를 idempotent_replay=true 로 돌려준다.
--  - 동시에 들어온 같은 키는 첫 요청이 끝날 때까지 대기한 뒤 결과를 재생한다(행 잠금).
--  - 오류로 롤백된 요청은 키가 저장되지 않으므로 같은 키로 다시 시도하면 정상 처리된다.
--  - 키를 보내지 않는 이전 화면 버전은 기존 동작 그대로(p_idempotency_key 기본값 NULL).
-- 파라미터가 늘어나면 옛 시그니처와 함께 두었을 때 호출이 모호해지므로 옛 함수는 삭제한다.
-- ==============================================================================

DROP FUNCTION IF EXISTS public.rpc_adjust_pending_inbound_orders(TEXT, JSONB, TEXT);
DROP FUNCTION IF EXISTS public.rpc_cancel_pending_inbound_orders(TEXT, JSONB);

-- 1) 발주 조정 ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_adjust_pending_inbound_orders(
  p_source_warehouse TEXT,
  p_items JSONB,
  p_admin TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_member public.app_members%ROWTYPE;
  v_cached JSONB;
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
  v_result JSONB;
BEGIN
  v_member := public.fn_require_session();

  v_cached := public.fn_idempotency_lock(p_idempotency_key);
  IF v_cached IS NOT NULL THEN
    RETURN v_cached || jsonb_build_object('idempotent_replay', true);
  END IF;

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

  v_result := jsonb_build_object(
    'success', true,
    'cancelled_units', v_cancelled,
    'added_units', v_added,
    'unmatched', v_unmatched
  );
  PERFORM public.fn_idempotency_store(p_idempotency_key, v_result);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_adjust_pending_inbound_orders(TEXT, JSONB, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_adjust_pending_inbound_orders(TEXT, JSONB, TEXT, TEXT) TO anon, authenticated, service_role;

-- 2) 발주 취소 ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_cancel_pending_inbound_orders(
  p_source_warehouse TEXT,
  p_items JSONB,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_member public.app_members%ROWTYPE;
  v_cached JSONB;
  v_wh TEXT := UPPER(TRIM(COALESCE(p_source_warehouse, '')));
  v_item RECORD;
  v_pack INTEGER;
  v_req BIGINT;
  v_done BIGINT;
  v_cancelled_total BIGINT := 0;
  v_unmatched JSONB := '[]'::JSONB;
  v_result JSONB;
BEGIN
  v_member := public.fn_require_session();

  v_cached := public.fn_idempotency_lock(p_idempotency_key);
  IF v_cached IS NOT NULL THEN
    RETURN v_cached || jsonb_build_object('idempotent_replay', true);
  END IF;

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

  v_result := jsonb_build_object(
    'success', true,
    'cancelled_units', v_cancelled_total,
    'unmatched', v_unmatched
  );
  PERFORM public.fn_idempotency_store(p_idempotency_key, v_result);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_cancel_pending_inbound_orders(TEXT, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_pending_inbound_orders(TEXT, JSONB, TEXT) TO anon, authenticated, service_role;
