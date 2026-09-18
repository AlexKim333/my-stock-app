-- ==============================================================================
-- 원자적 입출고+pending, 재고조사 RPC, 전표번호 시퀀스, MOVE 전표 수정
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.invoice_sequences (
  biz_date DATE NOT NULL,
  tx_group TEXT NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (biz_date, tx_group)
);

ALTER TABLE public.invoice_sequences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Enable all access for all users on invoice_sequences" ON public.invoice_sequences;
CREATE POLICY "Enable all access for all users on invoice_sequences"
  ON public.invoice_sequences FOR ALL TO public USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_stock_transactions_invoice_no
  ON public.stock_transactions (invoice_no);
CREATE INDEX IF NOT EXISTS idx_stock_transactions_invoice_type
  ON public.stock_transactions (invoice_no, transaction_type);

CREATE OR REPLACE FUNCTION public.fn_invoice_tx_group(p_tx_type TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO public
AS $$
DECLARE
  t TEXT := UPPER(TRIM(COALESCE(p_tx_type, '')));
BEGIN
  IF t IN ('INBOUND', 'IN', '입고') THEN
    RETURN 'INBOUND';
  ELSIF t IN ('ADJUST', 'ADJ', '재고조정', '재고조사', '재고치환', '재고추가') THEN
    RETURN 'ADJUST';
  ELSE
    RETURN 'OUTBOUND';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_normalize_invoice_no(p_invoice TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO public
AS $$
DECLARE
  v TEXT := TRIM(COALESCE(p_invoice, ''));
BEGIN
  IF v ~ '^\d{4}[-/]\d{2}[-/]\d{2}-.+$' THEN
    RETURN regexp_replace(v, '^(\d{4})[-/](\d{2})[-/](\d{2})-(.+)$', '\1/\2/\3-\4');
  END IF;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_parse_invoice_seq(p_invoice TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO public
AS $$
DECLARE
  v TEXT := public.fn_normalize_invoice_no(p_invoice);
  v_seq TEXT;
BEGIN
  v_seq := regexp_replace(v, '^.*-', '');
  IF v_seq ~ '^\d+$' THEN
    RETURN v_seq::INTEGER;
  END IF;
  RETURN 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_next_invoice_no(p_tx_type TEXT, p_biz_date DATE DEFAULT NULL)
RETURNS TEXT
LANGUAGE plpgsql
SET search_path TO public
AS $$
DECLARE
  v_group TEXT := public.fn_invoice_tx_group(p_tx_type);
  v_date DATE := COALESCE(
    p_biz_date,
    (timezone('America/Mexico_City', now()))::date
  );
  v_seq INTEGER;
  v_seed INTEGER := 0;
  v_types TEXT[];
BEGIN
  IF v_group = 'INBOUND' THEN
    v_types := ARRAY['INBOUND'];
  ELSIF v_group = 'ADJUST' THEN
    v_types := ARRAY['ADJUST'];
  ELSE
    v_types := ARRAY['OUTBOUND', 'MOVE'];
  END IF;

  INSERT INTO public.invoice_sequences (biz_date, tx_group, last_seq)
  VALUES (v_date, v_group, 0)
  ON CONFLICT (biz_date, tx_group) DO NOTHING;

  SELECT last_seq INTO v_seq
  FROM public.invoice_sequences
  WHERE biz_date = v_date AND tx_group = v_group
  FOR UPDATE;

  IF v_seq = 0 THEN
    SELECT COALESCE(MAX(public.fn_parse_invoice_seq(invoice_no)), 0)
    INTO v_seed
    FROM public.stock_transactions
    WHERE transaction_type = ANY (v_types)
      AND public.fn_normalize_invoice_no(invoice_no) LIKE (
        to_char(v_date, 'YYYY/MM/DD') || '-%'
      );
    v_seq := GREATEST(v_seq, v_seed);
  END IF;

  v_seq := v_seq + 1;

  UPDATE public.invoice_sequences
  SET last_seq = v_seq, updated_at = NOW()
  WHERE biz_date = v_date AND tx_group = v_group;

  RETURN to_char(v_date, 'YYYY/MM/DD') || '-' || lpad(v_seq::TEXT, 3, '0');
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_peek_next_invoice_seq(p_tx_type TEXT, p_biz_date DATE DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path TO public
AS $$
DECLARE
  v_group TEXT := public.fn_invoice_tx_group(p_tx_type);
  v_date DATE := COALESCE(
    p_biz_date,
    (timezone('America/Mexico_City', now()))::date
  );
  v_seq INTEGER := 0;
  v_seed INTEGER := 0;
  v_types TEXT[];
BEGIN
  IF v_group = 'INBOUND' THEN
    v_types := ARRAY['INBOUND'];
  ELSIF v_group = 'ADJUST' THEN
    v_types := ARRAY['ADJUST'];
  ELSE
    v_types := ARRAY['OUTBOUND', 'MOVE'];
  END IF;

  SELECT last_seq INTO v_seq
  FROM public.invoice_sequences
  WHERE biz_date = v_date AND tx_group = v_group;

  v_seq := COALESCE(v_seq, 0);

  SELECT COALESCE(MAX(public.fn_parse_invoice_seq(invoice_no)), 0)
  INTO v_seed
  FROM public.stock_transactions
  WHERE transaction_type = ANY (v_types)
    AND public.fn_normalize_invoice_no(invoice_no) LIKE (
      to_char(v_date, 'YYYY/MM/DD') || '-%'
    );

  RETURN GREATEST(v_seq, v_seed) + 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_ensure_stock_row(p_item_id UUID, p_warehouse TEXT)
RETURNS VOID
LANGUAGE plpgsql
SET search_path TO public
AS $$
BEGIN
  INSERT INTO public.inventory_stocks (item_id, warehouse_code, box_qty, unit_qty)
  VALUES (p_item_id, p_warehouse, 0, 0)
  ON CONFLICT (item_id, warehouse_code) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_fifo_complete_pending(
  p_from_warehouse TEXT,
  p_item_id UUID,
  p_box_qty INTEGER
) RETURNS INTEGER
LANGUAGE plpgsql
SET search_path TO public
AS $$
DECLARE
  v_remain INTEGER := GREATEST(COALESCE(p_box_qty, 0), 0);
  v_po RECORD;
  v_completed INTEGER := 0;
BEGIN
  IF v_remain <= 0 OR p_item_id IS NULL THEN
    RETURN 0;
  END IF;

  FOR v_po IN
    SELECT id, box_qty
    FROM public.pending_orders
    WHERE from_warehouse = p_from_warehouse
      AND item_id = p_item_id
      AND status IN ('PENDING', 'IN_TRANSIT')
    ORDER BY created_at ASC
    FOR UPDATE
  LOOP
    EXIT WHEN v_remain <= 0;

    IF v_po.box_qty <= v_remain THEN
      UPDATE public.pending_orders
      SET status = 'COMPLETED', updated_at = NOW()
      WHERE id = v_po.id;
      v_remain := v_remain - v_po.box_qty;
      v_completed := v_completed + v_po.box_qty;
    ELSE
      UPDATE public.pending_orders
      SET box_qty = box_qty - v_remain, updated_at = NOW()
      WHERE id = v_po.id;
      v_completed := v_completed + v_remain;
      v_remain := 0;
    END IF;
  END LOOP;

  RETURN v_completed;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_complete_inbound_pending_orders(
  p_source_warehouse TEXT,
  p_items JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path TO public
AS $$
DECLARE
  v_item RECORD;
  v_wh TEXT := UPPER(TRIM(COALESCE(p_source_warehouse, '')));
  v_box INTEGER;
  v_curr_box INTEGER;
  v_curr_unit INTEGER;
  v_done INTEGER := 0;
BEGIN
  IF v_wh = '' OR v_wh = 'MAIN' OR p_items IS NULL THEN
    RETURN jsonb_build_object('success', true, 'count', 0);
  END IF;

  FOR v_item IN SELECT * FROM jsonb_to_recordset(p_items) AS x(item_id UUID, box_qty INT)
  LOOP
    IF v_item.item_id IS NULL THEN
      CONTINUE;
    END IF;
    v_box := ABS(COALESCE(v_item.box_qty, 0));
    IF v_box <= 0 THEN
      CONTINUE;
    END IF;

    PERFORM public.fn_fifo_complete_pending(v_wh, v_item.item_id, v_box);

    PERFORM public.fn_ensure_stock_row(v_item.item_id, v_wh);

    SELECT box_qty, unit_qty INTO v_curr_box, v_curr_unit
    FROM public.inventory_stocks
    WHERE item_id = v_item.item_id AND warehouse_code = v_wh
    FOR UPDATE;

    IF v_curr_box < v_box THEN
      RAISE EXCEPTION '서브창고(%) 재고 부족: 현재 %상자, 입고확정 %상자', v_wh, v_curr_box, v_box;
    END IF;

    UPDATE public.inventory_stocks
    SET box_qty = box_qty - v_box, updated_at = NOW()
    WHERE item_id = v_item.item_id AND warehouse_code = v_wh;

    v_done := v_done + 1;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'count', v_done);
END;
$$;

DROP FUNCTION IF EXISTS public.rpc_process_transaction(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB);
DROP FUNCTION IF EXISTS public.rpc_process_transaction(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT);

CREATE OR REPLACE FUNCTION public.rpc_process_transaction(
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
SET search_path TO public
AS $$
DECLARE
  v_item RECORD;
  v_item_id UUID;
  v_box_qty INT;
  v_unit_qty INT;
  v_curr_box INT;
  v_curr_unit INT;
  v_is_transfer BOOLEAN := FALSE;
  v_dest_wh TEXT;
  v_src_wh TEXT := UPPER(TRIM(COALESCE(p_warehouse, 'MAIN')));
  v_tx_type TEXT := UPPER(TRIM(COALESCE(p_tx_type, 'INBOUND')));
  v_invoice TEXT := public.fn_normalize_invoice_no(p_invoice);
  v_pending_wh TEXT := UPPER(TRIM(COALESCE(p_pending_from_warehouse, '')));
  v_sub_box INT;
  v_sub_unit INT;
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
    IF v_box_qty = 0 AND v_unit_qty = 0 THEN
      CONTINUE;
    END IF;

    IF v_is_transfer THEN
      PERFORM public.fn_ensure_stock_row(v_item_id, v_src_wh);
      PERFORM public.fn_ensure_stock_row(v_item_id, v_dest_wh);

      SELECT box_qty, unit_qty INTO v_curr_box, v_curr_unit
      FROM public.inventory_stocks
      WHERE item_id = v_item_id AND warehouse_code = v_src_wh
      FOR UPDATE;

      IF v_curr_box < v_box_qty OR v_curr_unit < v_unit_qty THEN
        RAISE EXCEPTION '이동 재고 부족: 창고 % 현재 %상자/%개, 요청 %상자/%개',
          v_src_wh, v_curr_box, v_curr_unit, v_box_qty, v_unit_qty;
      END IF;

      UPDATE public.inventory_stocks
      SET box_qty = box_qty - v_box_qty,
          unit_qty = unit_qty - v_unit_qty,
          updated_at = NOW()
      WHERE item_id = v_item_id AND warehouse_code = v_src_wh;

      SELECT box_qty, unit_qty INTO v_curr_box, v_curr_unit
      FROM public.inventory_stocks
      WHERE item_id = v_item_id AND warehouse_code = v_dest_wh
      FOR UPDATE;

      UPDATE public.inventory_stocks
      SET box_qty = box_qty + v_box_qty,
          unit_qty = unit_qty + v_unit_qty,
          updated_at = NOW()
      WHERE item_id = v_item_id AND warehouse_code = v_dest_wh;

      INSERT INTO public.stock_transactions (
        transaction_type, item_id, warehouse_code, source_warehouse, target_warehouse,
        partner_name, box_qty, unit_qty, handler_name, invoice_no, memo
      ) VALUES (
        'MOVE', v_item_id, v_src_wh, v_src_wh, v_dest_wh,
        COALESCE(p_partner, v_dest_wh), v_box_qty, v_unit_qty, p_handler, v_invoice, p_memo
      );

    ELSIF v_tx_type = 'OUTBOUND' THEN
      PERFORM public.fn_ensure_stock_row(v_item_id, v_src_wh);

      SELECT box_qty, unit_qty INTO v_curr_box, v_curr_unit
      FROM public.inventory_stocks
      WHERE item_id = v_item_id AND warehouse_code = v_src_wh
      FOR UPDATE;

      IF v_curr_box < v_box_qty OR v_curr_unit < v_unit_qty THEN
        RAISE EXCEPTION '출고 재고 부족: 창고 % 현재 %상자/%개, 요청 %상자/%개',
          v_src_wh, v_curr_box, v_curr_unit, v_box_qty, v_unit_qty;
      END IF;

      UPDATE public.inventory_stocks
      SET box_qty = box_qty - v_box_qty,
          unit_qty = unit_qty - v_unit_qty,
          updated_at = NOW()
      WHERE item_id = v_item_id AND warehouse_code = v_src_wh;

      INSERT INTO public.stock_transactions (
        transaction_type, item_id, warehouse_code, source_warehouse, target_warehouse,
        partner_name, box_qty, unit_qty, handler_name, invoice_no, memo
      ) VALUES (
        'OUTBOUND', v_item_id, v_src_wh, v_src_wh, NULL,
        p_partner, v_box_qty, v_unit_qty, p_handler, v_invoice, p_memo
      );

    ELSE
      PERFORM public.fn_ensure_stock_row(v_item_id, v_src_wh);

      SELECT box_qty, unit_qty INTO v_curr_box, v_curr_unit
      FROM public.inventory_stocks
      WHERE item_id = v_item_id AND warehouse_code = v_src_wh
      FOR UPDATE;

      UPDATE public.inventory_stocks
      SET box_qty = box_qty + v_box_qty,
          unit_qty = unit_qty + v_unit_qty,
          updated_at = NOW()
      WHERE item_id = v_item_id AND warehouse_code = v_src_wh;

      INSERT INTO public.stock_transactions (
        transaction_type, item_id, warehouse_code, source_warehouse, target_warehouse,
        partner_name, box_qty, unit_qty, handler_name, invoice_no, memo
      ) VALUES (
        'INBOUND', v_item_id, v_src_wh, NULL, v_src_wh,
        p_partner, v_box_qty, v_unit_qty, p_handler, v_invoice, p_memo
      );

      IF v_tx_type = 'INBOUND' AND v_pending_wh <> '' AND v_pending_wh <> 'MAIN' AND v_box_qty > 0 THEN
        PERFORM public.fn_fifo_complete_pending(v_pending_wh, v_item_id, v_box_qty);
        PERFORM public.fn_ensure_stock_row(v_item_id, v_pending_wh);

        SELECT box_qty, unit_qty INTO v_sub_box, v_sub_unit
        FROM public.inventory_stocks
        WHERE item_id = v_item_id AND warehouse_code = v_pending_wh
        FOR UPDATE;

        IF v_sub_box < v_box_qty THEN
          RAISE EXCEPTION '서브창고(%) 재고 부족: 현재 %상자, 입고확정 %상자',
            v_pending_wh, v_sub_box, v_box_qty;
        END IF;

        UPDATE public.inventory_stocks
        SET box_qty = box_qty - v_box_qty, updated_at = NOW()
        WHERE item_id = v_item_id AND warehouse_code = v_pending_wh;
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

CREATE OR REPLACE FUNCTION public.rpc_adjust_stock(
  p_admin TEXT,
  p_items JSONB,
  p_warehouse TEXT DEFAULT 'MAIN',
  p_invoice TEXT DEFAULT NULL,
  p_memo TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path TO public
AS $$
DECLARE
  v_item RECORD;
  v_wh TEXT := UPPER(TRIM(COALESCE(p_warehouse, 'MAIN')));
  v_invoice TEXT := public.fn_normalize_invoice_no(p_invoice);
  v_item_id UUID;
  v_mode TEXT;
  v_in_box INT;
  v_in_unit INT;
  v_prev_box INT;
  v_prev_unit INT;
  v_after_box INT;
  v_after_unit INT;
  v_delta_box INT;
  v_delta_unit INT;
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

    PERFORM public.fn_ensure_stock_row(v_item_id, v_wh);

    SELECT box_qty, unit_qty INTO v_prev_box, v_prev_unit
    FROM public.inventory_stocks
    WHERE item_id = v_item_id AND warehouse_code = v_wh
    FOR UPDATE;

    IF v_mode = 'increment' THEN
      v_after_box := v_prev_box + v_in_box;
      v_after_unit := v_prev_unit + v_in_unit;
    ELSE
      v_after_box := v_in_box;
      v_after_unit := v_in_unit;
    END IF;

    IF v_after_box < 0 OR v_after_unit < 0 THEN
      RAISE EXCEPTION '재고조사 결과 음수 재고가 됩니다 (상자 %, 낱개 %)', v_after_box, v_after_unit;
    END IF;

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
SET search_path TO public
AS $$
DECLARE
  v_canonical TEXT := public.fn_normalize_invoice_no(p_invoice_no);
  v_old_tx RECORD;
  v_curr_box INT;
  v_curr_unit INT;
  v_new_item RECORD;
  v_new_item_id UUID;
  v_new_box INT;
  v_new_unit INT;
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

    IF v_old_tx.transaction_type = 'INBOUND' THEN
      SELECT box_qty, unit_qty INTO v_curr_box, v_curr_unit
      FROM public.inventory_stocks
      WHERE item_id = v_old_tx.item_id AND warehouse_code = COALESCE(v_old_tx.target_warehouse, v_warehouse)
      FOR UPDATE;

      IF NOT FOUND OR v_curr_box < v_old_tx.box_qty OR v_curr_unit < v_old_tx.unit_qty THEN
        RAISE EXCEPTION '입고 전표 취소 불가: 이후 출고로 재고가 부족합니다.';
      END IF;

      UPDATE public.inventory_stocks
      SET box_qty = box_qty - v_old_tx.box_qty,
          unit_qty = unit_qty - v_old_tx.unit_qty,
          updated_at = NOW()
      WHERE item_id = v_old_tx.item_id
        AND warehouse_code = COALESCE(v_old_tx.target_warehouse, v_warehouse);

    ELSIF v_old_tx.transaction_type = 'OUTBOUND' THEN
      PERFORM public.fn_ensure_stock_row(v_old_tx.item_id, v_src);
      UPDATE public.inventory_stocks
      SET box_qty = box_qty + v_old_tx.box_qty,
          unit_qty = unit_qty + v_old_tx.unit_qty,
          updated_at = NOW()
      WHERE item_id = v_old_tx.item_id AND warehouse_code = v_src;

    ELSIF v_old_tx.transaction_type = 'MOVE' THEN
      PERFORM public.fn_ensure_stock_row(v_old_tx.item_id, v_src);
      UPDATE public.inventory_stocks
      SET box_qty = box_qty + v_old_tx.box_qty,
          unit_qty = unit_qty + v_old_tx.unit_qty,
          updated_at = NOW()
      WHERE item_id = v_old_tx.item_id AND warehouse_code = v_src;

      IF v_dst IS NOT NULL AND v_dst <> '' THEN
        SELECT box_qty, unit_qty INTO v_curr_box, v_curr_unit
        FROM public.inventory_stocks
        WHERE item_id = v_old_tx.item_id AND warehouse_code = v_dst
        FOR UPDATE;

        IF NOT FOUND OR v_curr_box < v_old_tx.box_qty OR v_curr_unit < v_old_tx.unit_qty THEN
          RAISE EXCEPTION '이동 전표 취소 불가: 도착창고(%) 재고가 부족합니다.', v_dst;
        END IF;

        UPDATE public.inventory_stocks
        SET box_qty = box_qty - v_old_tx.box_qty,
            unit_qty = unit_qty - v_old_tx.unit_qty,
            updated_at = NOW()
        WHERE item_id = v_old_tx.item_id AND warehouse_code = v_dst;
      END IF;

    ELSIF v_old_tx.transaction_type = 'ADJUST' THEN
      PERFORM public.fn_ensure_stock_row(v_old_tx.item_id, v_warehouse);
      SELECT box_qty, unit_qty INTO v_curr_box, v_curr_unit
      FROM public.inventory_stocks
      WHERE item_id = v_old_tx.item_id AND warehouse_code = v_warehouse
      FOR UPDATE;

      IF v_curr_box - v_old_tx.box_qty < 0 OR v_curr_unit - v_old_tx.unit_qty < 0 THEN
        RAISE EXCEPTION '재고조정 전표 취소 시 음수 재고가 됩니다.';
      END IF;

      UPDATE public.inventory_stocks
      SET box_qty = box_qty - v_old_tx.box_qty,
          unit_qty = unit_qty - v_old_tx.unit_qty,
          updated_at = NOW()
      WHERE item_id = v_old_tx.item_id AND warehouse_code = v_warehouse;
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

      IF v_new_item_id IS NOT NULL AND (v_new_box > 0 OR v_new_unit > 0) THEN
        IF v_apply_type = 'MOVE' THEN
          v_src := COALESCE(v_src, v_warehouse, 'MAIN');
          v_dst := COALESCE(v_dst, v_partner);
          PERFORM public.fn_ensure_stock_row(v_new_item_id, v_src);
          PERFORM public.fn_ensure_stock_row(v_new_item_id, v_dst);

          SELECT box_qty, unit_qty INTO v_curr_box, v_curr_unit
          FROM public.inventory_stocks
          WHERE item_id = v_new_item_id AND warehouse_code = v_src
          FOR UPDATE;

          IF v_curr_box < v_new_box OR v_curr_unit < v_new_unit THEN
            RAISE EXCEPTION '수정 이동 재고 부족: 출발 % 현재 %상자', v_src, v_curr_box;
          END IF;

          UPDATE public.inventory_stocks
          SET box_qty = box_qty - v_new_box,
              unit_qty = unit_qty - v_new_unit,
              updated_at = NOW()
          WHERE item_id = v_new_item_id AND warehouse_code = v_src;

          UPDATE public.inventory_stocks
          SET box_qty = box_qty + v_new_box,
              unit_qty = unit_qty + v_new_unit,
              updated_at = NOW()
          WHERE item_id = v_new_item_id AND warehouse_code = v_dst;

          INSERT INTO public.stock_transactions (
            transaction_type, item_id, warehouse_code, source_warehouse, target_warehouse,
            partner_name, box_qty, unit_qty, handler_name, invoice_no, memo
          ) VALUES (
            'MOVE', v_new_item_id, v_src, v_src, v_dst, v_partner,
            v_new_box, v_new_unit, COALESCE(p_admin, 'ADMIN'), v_canonical,
            format('[전표수정] %s (%s)', v_canonical, COALESCE(p_admin, 'ADMIN'))
          );

        ELSIF v_apply_type = 'INBOUND' THEN
          PERFORM public.fn_ensure_stock_row(v_new_item_id, v_warehouse);
          UPDATE public.inventory_stocks
          SET box_qty = box_qty + v_new_box,
              unit_qty = unit_qty + v_new_unit,
              updated_at = NOW()
          WHERE item_id = v_new_item_id AND warehouse_code = v_warehouse;

          INSERT INTO public.stock_transactions (
            transaction_type, item_id, warehouse_code, source_warehouse, target_warehouse,
            partner_name, box_qty, unit_qty, handler_name, invoice_no, memo
          ) VALUES (
            'INBOUND', v_new_item_id, v_warehouse, NULL, v_warehouse, v_partner,
            v_new_box, v_new_unit, COALESCE(p_admin, 'ADMIN'), v_canonical,
            format('[전표수정] %s (%s)', v_canonical, COALESCE(p_admin, 'ADMIN'))
          );

        ELSE
          PERFORM public.fn_ensure_stock_row(v_new_item_id, v_warehouse);
          SELECT box_qty, unit_qty INTO v_curr_box, v_curr_unit
          FROM public.inventory_stocks
          WHERE item_id = v_new_item_id AND warehouse_code = v_warehouse
          FOR UPDATE;

          IF v_curr_box < v_new_box OR v_curr_unit < v_new_unit THEN
            RAISE EXCEPTION '수정 출고 재고 부족: 현재 %상자/%개, 요청 %상자/%개',
              v_curr_box, v_curr_unit, v_new_box, v_new_unit;
          END IF;

          UPDATE public.inventory_stocks
          SET box_qty = box_qty - v_new_box,
              unit_qty = unit_qty - v_new_unit,
              updated_at = NOW()
          WHERE item_id = v_new_item_id AND warehouse_code = v_warehouse;

          INSERT INTO public.stock_transactions (
            transaction_type, item_id, warehouse_code, source_warehouse, target_warehouse,
            partner_name, box_qty, unit_qty, handler_name, invoice_no, memo
          ) VALUES (
            'OUTBOUND', v_new_item_id, v_warehouse, v_warehouse, NULL, v_partner,
            v_new_box, v_new_unit, COALESCE(p_admin, 'ADMIN'), v_canonical,
            format('[전표수정] %s (%s)', v_canonical, COALESCE(p_admin, 'ADMIN'))
          );
        END IF;
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

GRANT ALL ON TABLE public.invoice_sequences TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_invoice_tx_group(TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_normalize_invoice_no(TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_parse_invoice_seq(TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ensure_stock_row(UUID, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_fifo_complete_pending(TEXT, UUID, INTEGER) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_next_invoice_no(TEXT, DATE) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_peek_next_invoice_seq(TEXT, DATE) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_complete_inbound_pending_orders(TEXT, JSONB) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_process_transaction(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_adjust_stock(TEXT, JSONB, TEXT, TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_update_transaction_records(TEXT, TEXT, JSONB, TEXT) TO anon, authenticated, service_role;
