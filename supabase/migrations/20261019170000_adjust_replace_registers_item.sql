-- ==============================================================================
-- 신규 서브창고: 센 수량으로 치환하는 재고조정도 이전 등록으로 본다
--
-- 배경: 이전 등록(rpc_register_warehouse_item) 말고 재고조정 화면의 치환·퀵재고·모바일 실사·창고별 재고 화면 수량 수정으로
--       MANUELDOBLADO / CIRCUNBALAXION / GUATEMALA 재고를 넣으면, 재고는 생기는데 등록 기록이 없어 출고가 계속 막혔다.
--       모두 사람이 센 수량을 그대로 넣는 동작이므로 등록과 같은 의미로 본다(사용자 결정 2026-10-19).
-- 조치: rpc_adjust_stock_apply가 needs_item_registration 창고를 치환(replace)할 때 warehouse_item_registrations를 남긴다.
--       추가(increment) 모드, 이동 입고, 전표 수정은 그대로 등록으로 치지 않는다(그 창고의 다른 상자를 센 것이 아니므로).
--       입수는 그 품목(마스터)의 입수로 계산된다 — 상자 입수가 다르면 출고 화면의 이전 등록으로 별도 품목을 만들어야 한다.
-- 본문은 운영 DB의 현재 정의(pg_get_functiondef, 2026-10-19)에 등록 기록 한 블록만 더했다.
-- ==============================================================================

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
        reason TEXT
      )
    ) WITH ORDINALITY AS x(item_id, adj_mode, box_qty, unit_qty, reason, ord)
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

    SELECT box_qty, unit_qty INTO v_prev_box, v_prev_unit
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

  RETURN jsonb_build_object(
    'success', true,
    'invoice_no', v_invoice,
    'adjusted_count', v_count
  );
END;
$function$;
