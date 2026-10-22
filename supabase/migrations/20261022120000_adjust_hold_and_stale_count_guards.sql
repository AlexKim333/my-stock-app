-- ==============================================================================
-- 재고조정(치환)에 두 가지 검사를 더한다 — 재고조정 화면·퀵재고·모바일 실사 경로 포함
--
-- 배경: 창고별 재고 화면 수정(rpc_adjust_stock_checked)에만 있던 검사가 다른 치환 경로(rpc_adjust_stock → apply)에는 없었다.
--       센트로 구역 서브창고(MANUELDOBLADO / CIRCUNBALAXION / GUATEMALA)는 MAIN 합산 영수증의 줄로 출고·보류되므로,
--       그 창고를 세는 동안 MAIN에서 나간 전표가 치환으로 되살아나거나, 보류가 실재고 없이 남을 수 있었다(사용자 결정 2026-10-22).
-- 조치:
--   1) 실사 이후 재고 변동: 행마다 counted_at(센 시각)을 받으면, 그 뒤에 그 창고·품목 재고가 바뀐 경우 치환을 거절한다.
--      바뀐 품목을 모두 모아 한 번에 알린다(메시지는 '[실사 이후 재고 변동]'으로 시작 — 화면이 이 표시로 다시 확인을 묻는다).
--      counted_at이 없으면(창고별 재고 화면·이전 등록 등 자체 검사가 있는 경로) 검사하지 않는다. 추가(increment) 모드는 차이만 더하므로 제외.
--   2) 출고 보류(+ 서브창고는 MAIN 입고 예정 발주) 아래로 줄이는 치환을 거절한다. 이미 예약보다 적은 재고를 늘리는 조정은 허용한다.
--   3) 재고 변동 시각을 믿을 수 있게, 수량이 바뀌는 모든 갱신에서 inventory_stocks.updated_at을 트리거로 갱신한다.
-- 본문은 20261019170000의 rpc_adjust_stock_apply(운영 정의 기준)에 검사 블록만 더했다.
-- ==============================================================================

-- 3) 수량이 바뀌면 updated_at을 갱신한다(어느 RPC가 바꾸든 실사 이후 변동 검사가 놓치지 않도록).
CREATE OR REPLACE FUNCTION public.fn_normalize_stock_row()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO public
AS $$
DECLARE
  v_pack INTEGER;
  v_total BIGINT;
BEGIN
  v_pack := public.fn_item_pack_qty(NEW.item_id);
  NEW.box_qty := COALESCE(NEW.box_qty, 0);
  NEW.unit_qty := COALESCE(NEW.unit_qty, 0);
  v_total := public.fn_stock_units(NEW.box_qty, NEW.unit_qty, v_pack);
  IF v_total < 0 THEN
    RAISE EXCEPTION '재고는 음수가 될 수 없습니다 (품목 %, 창고 %).', NEW.item_id, NEW.warehouse_code;
  END IF;
  NEW.box_qty := (v_total / v_pack)::INTEGER;
  NEW.unit_qty := (v_total % v_pack)::INTEGER;
  IF TG_OP = 'UPDATE' AND (NEW.box_qty IS DISTINCT FROM OLD.box_qty OR NEW.unit_qty IS DISTINCT FROM OLD.unit_qty) THEN
    NEW.updated_at := NOW();
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_adjust_stock_apply(p_admin text, p_items jsonb, p_warehouse text DEFAULT 'MAIN'::text, p_invoice text DEFAULT NULL::text, p_memo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_item RECORD;
  v_wh TEXT := UPPER(TRIM(COALESCE(p_warehouse, 'MAIN')));
  v_invoice TEXT := public.fn_normalize_invoice_no(p_invoice);
  v_item_id UUID;
  v_mode TEXT;
  v_pack INT;
  v_in_box INT;
  v_in_unit INT;
  v_prev_box INT;
  v_prev_unit INT;
  v_after_box INT;
  v_after_unit INT;
  v_delta_box INT;
  v_delta_unit INT;
  v_prev_units BIGINT;
  v_after_units BIGINT;
  v_count INT := 0;
  v_updated_at TIMESTAMPTZ;
  v_label TEXT;
  v_held BIGINT;
  v_committed BIGINT;
  v_reserved BIGINT;
  v_stale TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION '처리할 재고조사 데이터가 없습니다.';
  END IF;

  IF v_invoice IS NULL OR v_invoice = '' THEN
    v_invoice := public.rpc_next_invoice_no('ADJUST');
  END IF;

  -- item_id 순서로 잠근다. 같은 품목이 여러 번 오면 입력 순서(ord)를 유지한다.
  FOR v_item IN
    SELECT x.*
    FROM ROWS FROM (
      jsonb_to_recordset(p_items) AS (
        item_id UUID,
        adj_mode TEXT,
        box_qty INT,
        unit_qty INT,
        reason TEXT,
        counted_at TIMESTAMPTZ
      )
    ) WITH ORDINALITY AS x(item_id, adj_mode, box_qty, unit_qty, reason, counted_at, ord)
    ORDER BY x.item_id, x.ord
  LOOP
    v_item_id := v_item.item_id;
    IF v_item_id IS NULL THEN
      RAISE EXCEPTION '품목 ID가 없는 재고조사 행이 있습니다.';
    END IF;

    v_mode := LOWER(TRIM(COALESCE(v_item.adj_mode, 'replace')));
    IF v_mode NOT IN ('replace', 'increment') THEN
      v_mode := 'replace';
    END IF;

    v_in_box := COALESCE(v_item.box_qty, 0);
    v_in_unit := COALESCE(v_item.unit_qty, 0);
    IF v_in_box < 0 OR v_in_unit < 0 THEN
      RAISE EXCEPTION '실사 수량에는 음수를 입력할 수 없습니다.';
    END IF;

    v_pack := public.fn_item_pack_qty(v_item_id);
    PERFORM public.fn_ensure_stock_row(v_item_id, v_wh);

    SELECT box_qty, unit_qty, updated_at INTO v_prev_box, v_prev_unit, v_updated_at
    FROM public.inventory_stocks
    WHERE item_id = v_item_id AND warehouse_code = v_wh
    FOR UPDATE;

    v_prev_units := public.fn_stock_units(v_prev_box, v_prev_unit, v_pack);
    IF v_mode = 'increment' THEN
      v_after_units := v_prev_units + public.fn_stock_units(v_in_box, v_in_unit, v_pack);
    ELSE
      v_after_units := public.fn_stock_units(v_in_box, v_in_unit, v_pack);
    END IF;

    IF v_after_units < 0 THEN
      RAISE EXCEPTION '재고조사 결과 음수 재고가 됩니다.';
    END IF;

    IF v_mode = 'replace' THEN
      SELECT item_name || ' (' || COALESCE(color, 'SURTIDO') || ')' INTO v_label
      FROM public.items WHERE id = v_item_id;

      -- 1) 센 뒤에 이 창고·품목 재고가 바뀌었으면(출고·입고·이동·보류 출고 등) 치환하지 않는다.
      --    updated_at = NOW()는 이 호출 안에서 같은 품목을 앞서 치환한 경우라 제외한다.
      IF v_item.counted_at IS NOT NULL AND v_updated_at IS NOT NULL
         AND v_updated_at > v_item.counted_at AND v_updated_at <> NOW() THEN
        v_stale := v_stale || format('%s: 현재 %s상자 %s개', v_label, v_prev_box, v_prev_unit);
        CONTINUE;
      END IF;

      -- 2) 줄이는 치환은 출고 보류(+ 서브창고의 MAIN 입고 예정 발주) 아래로 내려갈 수 없다.
      IF v_after_units < v_prev_units THEN
        v_held := public.fn_outbound_held_units(v_item_id, v_wh);
        v_committed := 0;
        IF v_wh <> 'MAIN' THEN
          SELECT COALESCE(SUM(public.fn_stock_units(box_qty, unit_qty, v_pack)), 0) INTO v_committed
          FROM public.pending_orders
          WHERE item_id = v_item_id
            AND from_warehouse = v_wh
            AND to_warehouse = 'MAIN'
            AND status IN ('PENDING', 'IN_TRANSIT');
        END IF;
        v_reserved := v_held + v_committed;
        IF v_after_units < v_reserved THEN
          RAISE EXCEPTION '% 창고 % 재고를 %상자 %개로 줄일 수 없습니다: %이(가) %상자 %개 걸려 있습니다. 먼저 %.',
            v_wh, v_label, v_after_units / v_pack, v_after_units % v_pack,
            CASE WHEN v_held > 0 AND v_committed > 0 THEN '출고 보류·MAIN 입고 예정 발주'
                 WHEN v_committed > 0 THEN 'MAIN 입고 예정 발주'
                 ELSE '출고 보류' END,
            v_reserved / v_pack, v_reserved % v_pack,
            CASE WHEN v_held > 0 AND v_committed > 0 THEN '출고 보류와 발주를 줄이거나 취소하세요'
                 WHEN v_committed > 0 THEN '발주를 줄이거나 취소하세요'
                 ELSE '출고 보류를 줄이거나 삭제하세요' END;
        END IF;
      END IF;
    END IF;

    v_after_box := (v_after_units / v_pack)::INTEGER;
    v_after_unit := (v_after_units % v_pack)::INTEGER;
    v_delta_box := v_after_box - v_prev_box;
    v_delta_unit := v_after_unit - v_prev_unit;

    UPDATE public.inventory_stocks
    SET box_qty = v_after_box,
        unit_qty = v_after_unit,
        updated_at = NOW()
    WHERE item_id = v_item_id AND warehouse_code = v_wh;

    INSERT INTO public.stock_transactions (
      transaction_type, item_id, warehouse_code, box_qty, unit_qty,
      handler_name, invoice_no, memo
    ) VALUES (
      'ADJUST',
      v_item_id,
      v_wh,
      v_delta_box,
      v_delta_unit,
      COALESCE(p_admin, 'ADMIN'),
      v_invoice,
      COALESCE(
        p_memo,
        CASE WHEN v_mode = 'increment'
          THEN format('[추가] %s상자/%s개 → %s상자/%s개 (Δ %s/%s) %s', v_prev_box, v_prev_unit, v_after_box, v_after_unit, v_delta_box, v_delta_unit, COALESCE(v_item.reason, ''))
          ELSE format('[치환] %s상자/%s개 → %s상자/%s개 (Δ %s/%s) %s', v_prev_box, v_prev_unit, v_after_box, v_after_unit, v_delta_box, v_delta_unit, COALESCE(v_item.reason, ''))
        END
      )
    );

    -- 이전 등록이 필요한 창고(신규 서브창고)에서 센 수량으로 치환하면 그 품목의 이전 등록으로 본다
    -- (재고조정 화면·퀵재고·모바일 실사·창고별 재고 수정·이전 등록이 모두 여기를 거친다). 추가(increment)는 세지 않은 것이라 제외.
    IF v_mode = 'replace' AND EXISTS (SELECT 1 FROM public.warehouses WHERE code = v_wh AND needs_item_registration) THEN
      INSERT INTO public.warehouse_item_registrations (item_id, warehouse_code, counted_box, counted_unit, registered_by, registered_at)
      VALUES (v_item_id, v_wh, v_after_box, v_after_unit, COALESCE(p_admin, 'ADMIN'), NOW())
      ON CONFLICT (item_id, warehouse_code) DO UPDATE
      SET counted_box = EXCLUDED.counted_box,
          counted_unit = EXCLUDED.counted_unit,
          registered_by = EXCLUDED.registered_by,
          registered_at = EXCLUDED.registered_at;
    END IF;

    v_count := v_count + 1;
  END LOOP;

  IF array_length(v_stale, 1) > 0 THEN
    RAISE EXCEPTION '[실사 이후 재고 변동] % 창고에서 센 뒤에 재고가 바뀐 품목이 %개 있습니다(그 사이 출고·입고·이동 등). 다시 세어 확인하세요.%',
      v_wh, array_length(v_stale, 1), E'\n- ' || array_to_string(v_stale, E'\n- ');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_no', v_invoice,
    'adjusted_count', v_count
  );
END;
$function$;
