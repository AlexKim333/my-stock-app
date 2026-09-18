-- ==============================================================================
-- 상자+낱개 → 총 개수 환산 재고 연산, 정규화 트리거, 예약 ATP
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.fn_item_pack_qty(p_item_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
SET search_path TO public
AS $$
DECLARE
  v_pack INTEGER;
BEGIN
  SELECT GREATEST(1, COALESCE(ROUND(box_packaging_qty)::INTEGER, 1))
    INTO v_pack
  FROM public.items
  WHERE id = p_item_id;
  RETURN COALESCE(v_pack, 1);
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_stock_units(p_box INTEGER, p_unit INTEGER, p_pack INTEGER)
RETURNS BIGINT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT (COALESCE(p_box, 0)::BIGINT * GREATEST(COALESCE(p_pack, 1), 1)::BIGINT)
       + COALESCE(p_unit, 0)::BIGINT;
$$;

CREATE OR REPLACE FUNCTION public.fn_apply_stock_units(
  p_item_id UUID,
  p_warehouse TEXT,
  p_delta_units BIGINT,
  p_check_enough BOOLEAN,
  p_ctx TEXT DEFAULT '재고'
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_wh TEXT := UPPER(TRIM(COALESCE(p_warehouse, 'MAIN')));
  v_pack INTEGER;
  v_box INTEGER;
  v_unit INTEGER;
  v_cur BIGINT;
  v_new BIGINT;
BEGIN
  IF COALESCE(p_delta_units, 0) = 0 THEN
    RETURN;
  END IF;

  v_pack := public.fn_item_pack_qty(p_item_id);
  PERFORM public.fn_ensure_stock_row(p_item_id, v_wh);

  SELECT box_qty, unit_qty INTO v_box, v_unit
  FROM public.inventory_stocks
  WHERE item_id = p_item_id AND warehouse_code = v_wh
  FOR UPDATE;

  v_cur := public.fn_stock_units(v_box, v_unit, v_pack);
  v_new := v_cur + p_delta_units;

  IF v_new < 0 THEN
    RAISE EXCEPTION '% 재고 부족: 창고 % 현재 %상자/%개(총 %개), 요청 후 %개',
      COALESCE(NULLIF(TRIM(p_ctx), ''), '재고'),
      v_wh, COALESCE(v_box, 0), COALESCE(v_unit, 0), v_cur, v_new;
  END IF;

  UPDATE public.inventory_stocks
  SET box_qty = (v_new / v_pack)::INTEGER,
      unit_qty = (v_new % v_pack)::INTEGER,
      updated_at = NOW()
  WHERE item_id = p_item_id AND warehouse_code = v_wh;
END;
$$;

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
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_normalize_stock_row ON public.inventory_stocks;
CREATE TRIGGER trg_normalize_stock_row
BEFORE INSERT OR UPDATE OF box_qty, unit_qty, item_id
ON public.inventory_stocks
FOR EACH ROW
EXECUTE FUNCTION public.fn_normalize_stock_row();

-- 기존 행도 포장수량 기준으로 정규화
UPDATE public.inventory_stocks s
SET box_qty = s.box_qty,
    unit_qty = s.unit_qty
WHERE EXISTS (SELECT 1 FROM public.items i WHERE i.id = s.item_id);

CREATE OR REPLACE FUNCTION public.rpc_process_transaction_apply(
  p_tx_type TEXT,
  p_warehouse TEXT,
  p_partner TEXT,
  p_handler TEXT,
  p_invoice TEXT,
  p_memo TEXT,
  p_items JSONB,
  p_target_warehouse TEXT DEFAULT NULL,
  p_pending_from_warehouse TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_item RECORD;
  v_item_id UUID;
  v_box_qty INT;
  v_unit_qty INT;
  v_pack INT;
  v_req BIGINT;
  v_is_transfer BOOLEAN := FALSE;
  v_dest_wh TEXT;
  v_src_wh TEXT := UPPER(TRIM(COALESCE(p_warehouse, 'MAIN')));
  v_tx_type TEXT := UPPER(TRIM(COALESCE(p_tx_type, 'INBOUND')));
  v_invoice TEXT := public.fn_normalize_invoice_no(p_invoice);
  v_pending_wh TEXT := UPPER(TRIM(COALESCE(p_pending_from_warehouse, '')));
BEGIN
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION '처리할 품목이 없습니다.';
  END IF;

  IF v_tx_type = 'MOVE' OR (
    p_target_warehouse IS NOT NULL
    AND TRIM(p_target_warehouse) <> ''
    AND UPPER(TRIM(p_target_warehouse)) <> v_src_wh
  ) THEN
    v_is_transfer := TRUE;
    v_tx_type := 'MOVE';
    v_dest_wh := UPPER(TRIM(p_target_warehouse));
    IF v_dest_wh IS NULL OR v_dest_wh = '' THEN
      RAISE EXCEPTION '이동 도착창고가 지정되지 않았습니다.';
    END IF;
    IF v_dest_wh = v_src_wh THEN
      RAISE EXCEPTION '출발창고와 도착창고가 동일합니다: %', v_src_wh;
    END IF;
  END IF;

  IF v_invoice IS NULL OR v_invoice = '' THEN
    v_invoice := public.rpc_next_invoice_no(v_tx_type);
  END IF;

  FOR v_item IN SELECT * FROM jsonb_to_recordset(p_items) AS x(item_id UUID, box_qty INT, unit_qty INT)
  LOOP
    v_item_id := v_item.item_id;
    v_box_qty := COALESCE(v_item.box_qty, 0);
    v_unit_qty := COALESCE(v_item.unit_qty, 0);

    IF v_item_id IS NULL THEN
      RAISE EXCEPTION '품목 ID가 없는 행이 있습니다.';
    END IF;
    IF v_box_qty < 0 OR v_unit_qty < 0 THEN
      RAISE EXCEPTION '수량은 음수일 수 없습니다.';
    END IF;

    v_pack := public.fn_item_pack_qty(v_item_id);
    v_req := public.fn_stock_units(v_box_qty, v_unit_qty, v_pack);
    IF v_req = 0 THEN
      CONTINUE;
    END IF;

    IF v_is_transfer THEN
      PERFORM public.fn_apply_stock_units(v_item_id, v_src_wh, -v_req, TRUE, '이동');
      PERFORM public.fn_apply_stock_units(v_item_id, v_dest_wh, v_req, FALSE, '이동입고');

      INSERT INTO public.stock_transactions (
        transaction_type, item_id, warehouse_code, source_warehouse, target_warehouse,
        partner_name, box_qty, unit_qty, handler_name, invoice_no, memo
      ) VALUES (
        'MOVE', v_item_id, v_src_wh, v_src_wh, v_dest_wh,
        COALESCE(p_partner, v_dest_wh), v_box_qty, v_unit_qty, p_handler, v_invoice, p_memo
      );

    ELSIF v_tx_type = 'OUTBOUND' THEN
      PERFORM public.fn_apply_stock_units(v_item_id, v_src_wh, -v_req, TRUE, '출고');

      INSERT INTO public.stock_transactions (
        transaction_type, item_id, warehouse_code, source_warehouse, target_warehouse,
        partner_name, box_qty, unit_qty, handler_name, invoice_no, memo
      ) VALUES (
        'OUTBOUND', v_item_id, v_src_wh, v_src_wh, NULL,
        p_partner, v_box_qty, v_unit_qty, p_handler, v_invoice, p_memo
      );

    ELSE
      PERFORM public.fn_apply_stock_units(v_item_id, v_src_wh, v_req, FALSE, '입고');

      INSERT INTO public.stock_transactions (
        transaction_type, item_id, warehouse_code, source_warehouse, target_warehouse,
        partner_name, box_qty, unit_qty, handler_name, invoice_no, memo
      ) VALUES (
        'INBOUND', v_item_id, v_src_wh, NULL, v_src_wh,
        p_partner, v_box_qty, v_unit_qty, p_handler, v_invoice, p_memo
      );

      IF v_tx_type = 'INBOUND' AND v_pending_wh <> '' AND v_pending_wh <> 'MAIN' AND v_box_qty > 0 THEN
        PERFORM public.fn_fifo_complete_pending(v_pending_wh, v_item_id, v_box_qty);
      END IF;

      IF v_tx_type = 'INBOUND' AND v_pending_wh <> '' AND v_pending_wh <> 'MAIN' THEN
        PERFORM public.fn_apply_stock_units(v_item_id, v_pending_wh, -v_req, TRUE, '서브창고 입고확정');
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_no', v_invoice,
    'tx_type', CASE WHEN v_is_transfer THEN 'MOVE' ELSE v_tx_type END,
    'source_warehouse', v_src_wh,
    'target_warehouse', v_dest_wh
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_adjust_stock_apply(
  p_admin TEXT,
  p_items JSONB,
  p_warehouse TEXT DEFAULT 'MAIN',
  p_invoice TEXT DEFAULT NULL,
  p_memo TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
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

  FOR v_item IN SELECT * FROM jsonb_to_recordset(p_items) AS x(
    item_id UUID,
    adj_mode TEXT,
    box_qty INT,
    unit_qty INT,
    reason TEXT
  )
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

    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_no', v_invoice,
    'adjusted_count', v_count
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_update_transaction_records(
  p_invoice_no TEXT,
  p_tx_type TEXT,
  p_new_records JSONB,
  p_admin TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_canonical TEXT := public.fn_normalize_invoice_no(p_invoice_no);
  v_old_tx RECORD;
  v_new_item RECORD;
  v_new_item_id UUID;
  v_new_box INT;
  v_new_unit INT;
  v_pack INT;
  v_req BIGINT;
  v_warehouse TEXT := 'MAIN';
  v_partner TEXT := '';
  v_src TEXT;
  v_dst TEXT;
  v_apply_type TEXT := UPPER(TRIM(COALESCE(p_tx_type, 'OUTBOUND')));
  v_match_types TEXT[];
BEGIN
  IF v_canonical IS NULL OR v_canonical = '' THEN
    RAISE EXCEPTION '수정할 전표 번호가 지정되지 않았습니다.';
  END IF;

  IF v_apply_type IN ('OUTBOUND', 'MOVE') THEN
    v_match_types := ARRAY['OUTBOUND', 'MOVE'];
  ELSIF v_apply_type = 'INBOUND' THEN
    v_match_types := ARRAY['INBOUND'];
  ELSIF v_apply_type = 'ADJUST' THEN
    v_match_types := ARRAY['ADJUST'];
  ELSE
    v_match_types := ARRAY[v_apply_type];
  END IF;

  FOR v_old_tx IN
    SELECT *
    FROM public.stock_transactions
    WHERE public.fn_normalize_invoice_no(invoice_no) = v_canonical
      AND transaction_type = ANY (v_match_types)
    FOR UPDATE
  LOOP
    v_warehouse := COALESCE(v_old_tx.warehouse_code, 'MAIN');
    v_partner := COALESCE(v_old_tx.partner_name, v_partner);
    v_src := COALESCE(v_old_tx.source_warehouse, v_warehouse);
    v_dst := v_old_tx.target_warehouse;
    v_apply_type := v_old_tx.transaction_type;
    v_pack := public.fn_item_pack_qty(v_old_tx.item_id);
    v_req := public.fn_stock_units(v_old_tx.box_qty, v_old_tx.unit_qty, v_pack);

    IF v_old_tx.transaction_type = 'INBOUND' THEN
      PERFORM public.fn_apply_stock_units(
        v_old_tx.item_id,
        COALESCE(v_old_tx.target_warehouse, v_warehouse),
        -v_req, TRUE, '입고 전표 취소'
      );
    ELSIF v_old_tx.transaction_type = 'OUTBOUND' THEN
      PERFORM public.fn_apply_stock_units(v_old_tx.item_id, v_src, v_req, FALSE, '출고 전표 취소');
    ELSIF v_old_tx.transaction_type = 'MOVE' THEN
      PERFORM public.fn_apply_stock_units(v_old_tx.item_id, v_src, v_req, FALSE, '이동 전표 취소');
      IF v_dst IS NOT NULL AND v_dst <> '' THEN
        PERFORM public.fn_apply_stock_units(v_old_tx.item_id, v_dst, -v_req, TRUE, '이동 전표 취소');
      END IF;
    ELSIF v_old_tx.transaction_type = 'ADJUST' THEN
      PERFORM public.fn_apply_stock_units(v_old_tx.item_id, v_warehouse, -v_req, TRUE, '재고조정 전표 취소');
    END IF;
  END LOOP;

  DELETE FROM public.stock_transactions
  WHERE public.fn_normalize_invoice_no(invoice_no) = v_canonical
    AND transaction_type = ANY (v_match_types);

  IF p_new_records IS NOT NULL AND jsonb_array_length(p_new_records) > 0 THEN
    FOR v_new_item IN SELECT * FROM jsonb_to_recordset(p_new_records) AS x(
      item_id UUID,
      item_name TEXT,
      color TEXT,
      box_content INT,
      box_qty INT,
      unit_qty INT,
      partner_name TEXT
    )
    LOOP
      v_new_item_id := v_new_item.item_id;
      v_new_box := ABS(COALESCE(v_new_item.box_qty, 0));
      v_new_unit := ABS(COALESCE(v_new_item.unit_qty, 0));
      IF v_new_item.partner_name IS NOT NULL AND TRIM(v_new_item.partner_name) <> '' THEN
        v_partner := TRIM(v_new_item.partner_name);
      END IF;

      IF v_new_item_id IS NULL THEN
        SELECT id INTO v_new_item_id
        FROM public.items
        WHERE item_name = TRIM(COALESCE(v_new_item.item_name, ''))
          AND color = TRIM(COALESCE(v_new_item.color, 'SURTIDO'))
          AND box_packaging_qty = COALESCE(v_new_item.box_content, 1)
        LIMIT 1;
      END IF;

      IF v_new_item_id IS NULL OR (v_new_box = 0 AND v_new_unit = 0) THEN
        CONTINUE;
      END IF;

      v_pack := public.fn_item_pack_qty(v_new_item_id);
      v_req := public.fn_stock_units(v_new_box, v_new_unit, v_pack);

      IF v_apply_type = 'MOVE' THEN
        v_src := COALESCE(v_src, v_warehouse, 'MAIN');
        v_dst := COALESCE(v_dst, v_partner);
        PERFORM public.fn_apply_stock_units(v_new_item_id, v_src, -v_req, TRUE, '수정 이동');
        PERFORM public.fn_apply_stock_units(v_new_item_id, v_dst, v_req, FALSE, '수정 이동입고');
        INSERT INTO public.stock_transactions (
          transaction_type, item_id, warehouse_code, source_warehouse, target_warehouse,
          partner_name, box_qty, unit_qty, handler_name, invoice_no, memo
        ) VALUES (
          'MOVE', v_new_item_id, v_src, v_src, v_dst, v_partner,
          v_new_box, v_new_unit, COALESCE(p_admin, 'ADMIN'), v_canonical,
          format('[전표수정] %s (%s)', v_canonical, COALESCE(p_admin, 'ADMIN'))
        );
      ELSIF v_apply_type = 'INBOUND' THEN
        PERFORM public.fn_apply_stock_units(v_new_item_id, v_warehouse, v_req, FALSE, '수정 입고');
        INSERT INTO public.stock_transactions (
          transaction_type, item_id, warehouse_code, source_warehouse, target_warehouse,
          partner_name, box_qty, unit_qty, handler_name, invoice_no, memo
        ) VALUES (
          'INBOUND', v_new_item_id, v_warehouse, NULL, v_warehouse, v_partner,
          v_new_box, v_new_unit, COALESCE(p_admin, 'ADMIN'), v_canonical,
          format('[전표수정] %s (%s)', v_canonical, COALESCE(p_admin, 'ADMIN'))
        );
      ELSE
        PERFORM public.fn_apply_stock_units(v_new_item_id, v_warehouse, -v_req, TRUE, '수정 출고');
        INSERT INTO public.stock_transactions (
          transaction_type, item_id, warehouse_code, source_warehouse, target_warehouse,
          partner_name, box_qty, unit_qty, handler_name, invoice_no, memo
        ) VALUES (
          'OUTBOUND', v_new_item_id, v_warehouse, v_warehouse, NULL, v_partner,
          v_new_box, v_new_unit, COALESCE(p_admin, 'ADMIN'), v_canonical,
          format('[전표수정] %s (%s)', v_canonical, COALESCE(p_admin, 'ADMIN'))
        );
      END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_no', v_canonical,
    'message', format('전표(%s)가 원자적으로 수정되었습니다.', v_canonical)
  );
END;
$$;

DROP FUNCTION IF EXISTS public.rpc_reserve_outbound(TEXT, TEXT, JSONB, TEXT);

CREATE OR REPLACE FUNCTION public.rpc_reserve_outbound(
  p_partner TEXT,
  p_handler TEXT,
  p_items JSONB,
  p_to_warehouse TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_cached JSONB;
  v_item RECORD;
  v_count INTEGER := 0;
  v_dest TEXT := NULLIF(UPPER(TRIM(COALESCE(p_to_warehouse, ''))), '');
  v_item_id UUID;
  v_box INTEGER;
  v_unit INTEGER;
  v_pack INTEGER;
  v_req BIGINT;
  v_stock_box INTEGER;
  v_stock_unit INTEGER;
  v_avail BIGINT;
  v_pending BIGINT;
BEGIN
  v_cached := public.fn_idempotency_lock(p_idempotency_key);
  IF v_cached IS NOT NULL THEN
    RETURN v_cached || jsonb_build_object('idempotent_replay', true);
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION '예약할 품목이 없습니다.';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_to_recordset(p_items) AS x(item_id UUID, box_qty INT, unit_qty INT)
  LOOP
    v_item_id := v_item.item_id;
    v_box := ABS(COALESCE(v_item.box_qty, 0));
    v_unit := ABS(COALESCE(v_item.unit_qty, 0));
    IF v_item_id IS NULL OR (v_box = 0 AND v_unit = 0) THEN
      CONTINUE;
    END IF;

    v_pack := public.fn_item_pack_qty(v_item_id);
    v_req := public.fn_stock_units(v_box, v_unit, v_pack);

    PERFORM public.fn_ensure_stock_row(v_item_id, 'MAIN');
    SELECT box_qty, unit_qty INTO v_stock_box, v_stock_unit
    FROM public.inventory_stocks
    WHERE item_id = v_item_id AND warehouse_code = 'MAIN'
    FOR UPDATE;

    SELECT COALESCE(SUM(public.fn_stock_units(po.box_qty, po.unit_qty, v_pack)), 0)
      INTO v_pending
    FROM public.pending_orders po
    WHERE po.item_id = v_item_id
      AND po.from_warehouse = 'MAIN'
      AND po.status IN ('PENDING', 'IN_TRANSIT');

    v_avail := public.fn_stock_units(v_stock_box, v_stock_unit, v_pack) - v_pending;
    IF v_avail < v_req THEN
      RAISE EXCEPTION '예약 가능 재고 부족: 현재 가용 %개, 요청 %개', v_avail, v_req;
    END IF;

    INSERT INTO public.pending_orders (
      item_id, from_warehouse, to_warehouse, box_qty, unit_qty,
      status, requested_by, memo
    ) VALUES (
      v_item_id,
      'MAIN',
      v_dest,
      v_box,
      v_unit,
      'PENDING',
      COALESCE(NULLIF(TRIM(p_handler), ''), 'ADMIN'),
      format('출고예약 %s', COALESCE(NULLIF(TRIM(p_partner), ''), '미지정'))
    );
    v_count := v_count + 1;
  END LOOP;

  IF v_count = 0 THEN
    RAISE EXCEPTION '예약할 유효 수량이 없습니다.';
  END IF;

  PERFORM public.fn_idempotency_store(
    p_idempotency_key,
    jsonb_build_object('success', true, 'count', v_count)
  );

  RETURN jsonb_build_object('success', true, 'count', v_count);
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_reserve_outbound(TEXT, TEXT, JSONB, TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_update_transaction_records(TEXT, TEXT, JSONB, TEXT) TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_apply_stock_units(UUID, TEXT, BIGINT, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
