-- ==============================================================================
-- 세션 토큰 검증, PENDING FIFO 개수 환산, 거래처/담당자 마스터 RPC
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.app_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID NOT NULL REFERENCES public.app_members(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_sessions_member ON public.app_sessions(member_id);
CREATE INDEX IF NOT EXISTS idx_app_sessions_expires ON public.app_sessions(expires_at);

ALTER TABLE public.app_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "app_sessions_no_direct_client_access" ON public.app_sessions;
CREATE POLICY "app_sessions_no_direct_client_access"
  ON public.app_sessions FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.fn_hash_session_token(p_token TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path TO public, extensions
AS $$
  SELECT encode(extensions.digest(CONVERT_TO(COALESCE(p_token, ''), 'UTF8'), 'sha256'), 'hex');
$$;

CREATE OR REPLACE FUNCTION public.fn_request_session_token()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_headers JSON;
  v_token TEXT;
BEGIN
  BEGIN
    v_headers := current_setting('request.headers', true)::JSON;
  EXCEPTION
    WHEN OTHERS THEN
      v_headers := NULL;
  END;

  v_token := NULLIF(TRIM(COALESCE(
    v_headers->>'x-wms-session',
    v_headers->>'X-WMS-Session',
    ''
  )), '');
  RETURN v_token;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_require_session()
RETURNS public.app_members
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_token TEXT := public.fn_request_session_token();
  v_hash TEXT;
  v_member public.app_members%ROWTYPE;
BEGIN
  DELETE FROM public.app_sessions WHERE expires_at < NOW();

  IF v_token IS NULL OR v_token = '' THEN
    RAISE EXCEPTION '로그인이 필요합니다.';
  END IF;

  v_hash := public.fn_hash_session_token(v_token);

  SELECT m.*
    INTO v_member
  FROM public.app_sessions s
  JOIN public.app_members m ON m.id = s.member_id
  WHERE s.token_hash = v_hash
    AND s.expires_at > NOW()
    AND COALESCE(m.is_active, TRUE) = TRUE
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION '세션이 만료되었습니다. 다시 로그인하세요.';
  END IF;

  RETURN v_member;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_require_admin()
RETURNS public.app_members
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_member public.app_members%ROWTYPE;
BEGIN
  v_member := public.fn_require_session();
  IF LOWER(TRIM(COALESCE(v_member.access_level, ''))) <> 'admin' THEN
    RAISE EXCEPTION '관리자만 수행할 수 있습니다.';
  END IF;
  RETURN v_member;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_login(p_member_name TEXT, p_password TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_row public.app_members%ROWTYPE;
  v_ok BOOLEAN := FALSE;
  v_token TEXT;
  v_hash TEXT;
BEGIN
  SELECT * INTO v_row
  FROM public.app_members
  WHERE member_name = TRIM(COALESCE(p_member_name, ''))
    AND COALESCE(is_active, TRUE) = TRUE
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false);
  END IF;

  IF v_row.password_hash LIKE '$2a$%'
     OR v_row.password_hash LIKE '$2b$%'
     OR v_row.password_hash LIKE '$2y$%' THEN
    v_ok := (extensions.crypt(COALESCE(p_password, ''), v_row.password_hash) = v_row.password_hash);
  ELSE
    v_ok := (v_row.password_hash IS NOT DISTINCT FROM p_password);
    IF v_ok THEN
      UPDATE public.app_members
      SET password_hash = extensions.crypt(p_password, extensions.gen_salt('bf', 10))
      WHERE id = v_row.id;
    END IF;
  END IF;

  IF NOT v_ok THEN
    RETURN jsonb_build_object('success', false);
  END IF;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_hash := public.fn_hash_session_token(v_token);

  INSERT INTO public.app_sessions (member_id, token_hash, expires_at)
  VALUES (v_row.id, v_hash, NOW() + INTERVAL '12 hours');

  RETURN jsonb_build_object(
    'success', true,
    'session_token', v_token,
    'expires_at', (NOW() + INTERVAL '12 hours'),
    'user', jsonb_build_object(
      'id', v_row.id,
      'member_name', v_row.member_name,
      'branch_name', v_row.branch_name,
      'access_level', v_row.access_level,
      'preferred_language', v_row.preferred_language
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_logout()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_token TEXT := public.fn_request_session_token();
BEGIN
  IF v_token IS NOT NULL THEN
    DELETE FROM public.app_sessions
    WHERE token_hash = public.fn_hash_session_token(v_token);
  END IF;
  RETURN jsonb_build_object('success', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_session_info()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_member public.app_members%ROWTYPE;
BEGIN
  v_member := public.fn_require_session();
  RETURN jsonb_build_object(
    'success', true,
    'user', jsonb_build_object(
      'id', v_member.id,
      'member_name', v_member.member_name,
      'branch_name', v_member.branch_name,
      'access_level', v_member.access_level,
      'preferred_language', v_member.preferred_language
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_process_transaction(
  p_tx_type TEXT,
  p_warehouse TEXT,
  p_partner TEXT,
  p_handler TEXT,
  p_invoice TEXT,
  p_memo TEXT,
  p_items JSONB,
  p_target_warehouse TEXT DEFAULT NULL,
  p_pending_from_warehouse TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_member public.app_members%ROWTYPE;
  v_cached JSONB;
  v_result JSONB;
BEGIN
  v_member := public.fn_require_session();
  v_cached := public.fn_idempotency_lock(p_idempotency_key);
  IF v_cached IS NOT NULL THEN
    RETURN v_cached || jsonb_build_object('idempotent_replay', true);
  END IF;

  v_result := public.rpc_process_transaction_apply(
    p_tx_type,
    p_warehouse,
    p_partner,
    COALESCE(NULLIF(TRIM(v_member.member_name), ''), p_handler),
    p_invoice,
    p_memo,
    p_items,
    p_target_warehouse,
    p_pending_from_warehouse
  );

  PERFORM public.fn_idempotency_store(p_idempotency_key, v_result);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_adjust_stock(
  p_admin TEXT,
  p_items JSONB,
  p_warehouse TEXT DEFAULT 'MAIN',
  p_invoice TEXT DEFAULT NULL,
  p_memo TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_member public.app_members%ROWTYPE;
  v_cached JSONB;
  v_result JSONB;
BEGIN
  v_member := public.fn_require_session();
  v_cached := public.fn_idempotency_lock(p_idempotency_key);
  IF v_cached IS NOT NULL THEN
    RETURN v_cached || jsonb_build_object('idempotent_replay', true);
  END IF;

  v_result := public.rpc_adjust_stock_apply(
    COALESCE(NULLIF(TRIM(v_member.member_name), ''), p_admin),
    p_items,
    p_warehouse,
    p_invoice,
    p_memo
  );

  PERFORM public.fn_idempotency_store(p_idempotency_key, v_result);
  RETURN v_result;
END;
$$;

-- FIFO: 상자 단위 → 총 개수
DROP FUNCTION IF EXISTS public.fn_fifo_complete_pending(TEXT, UUID, INTEGER);

CREATE OR REPLACE FUNCTION public.fn_fifo_complete_pending(
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
  v_completed BIGINT := 0;
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
    ORDER BY created_at ASC
    FOR UPDATE
  LOOP
    EXIT WHEN v_remain <= 0;
    v_po_units := public.fn_stock_units(v_po.box_qty, v_po.unit_qty, v_pack);
    IF v_po_units <= 0 THEN
      UPDATE public.pending_orders
      SET status = 'COMPLETED', updated_at = NOW()
      WHERE id = v_po.id;
      CONTINUE;
    END IF;

    IF v_po_units <= v_remain THEN
      UPDATE public.pending_orders
      SET status = 'COMPLETED', updated_at = NOW()
      WHERE id = v_po.id;
      v_remain := v_remain - v_po_units;
      v_completed := v_completed + v_po_units;
    ELSE
      v_left := v_po_units - v_remain;
      UPDATE public.pending_orders
      SET box_qty = (v_left / v_pack)::INTEGER,
          unit_qty = (v_left % v_pack)::INTEGER,
          updated_at = NOW()
      WHERE id = v_po.id;
      v_completed := v_completed + v_remain;
      v_remain := 0;
    END IF;
  END LOOP;

  RETURN v_completed;
END;
$$;

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

      IF v_tx_type = 'INBOUND' AND v_pending_wh <> '' AND v_pending_wh <> 'MAIN' THEN
        PERFORM public.fn_fifo_complete_pending(v_pending_wh, v_item_id, v_req);
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
  v_member public.app_members%ROWTYPE;
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
  v_member := public.fn_require_session();
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
      COALESCE(v_member.member_name, NULLIF(TRIM(p_handler), ''), 'ADMIN'),
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

CREATE OR REPLACE FUNCTION public.rpc_register_item(
  p_item_name TEXT,
  p_color TEXT DEFAULT 'SURTIDO',
  p_box_packaging_qty NUMERIC DEFAULT 1,
  p_barcode TEXT DEFAULT NULL,
  p_brand_id UUID DEFAULT NULL,
  p_initial_boxes INTEGER DEFAULT 0,
  p_initial_units INTEGER DEFAULT 0,
  p_safe_stock INTEGER DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_id UUID;
  v_name TEXT := TRIM(COALESCE(p_item_name, ''));
  v_color TEXT := TRIM(COALESCE(p_color, 'SURTIDO'));
  v_pkg NUMERIC := COALESCE(p_box_packaging_qty, 1);
  v_boxes INTEGER := GREATEST(COALESCE(p_initial_boxes, 0), 0);
  v_units INTEGER := GREATEST(COALESCE(p_initial_units, 0), 0);
  v_safe INTEGER := GREATEST(COALESCE(p_safe_stock, 0), 0);
BEGIN
  PERFORM public.fn_require_session();
  IF v_name = '' OR v_pkg < 1 THEN
    RAISE EXCEPTION '품명과 박스당 수량(1 이상)은 필수입니다.';
  END IF;

  INSERT INTO public.items (
    item_name, color, box_packaging_qty, barcode, brand_id,
    initial_stock_boxes, initial_stock_units, is_grid_item, is_active
  ) VALUES (
    v_name, v_color, v_pkg, NULLIF(TRIM(COALESCE(p_barcode, '')), ''), p_brand_id,
    v_boxes, v_units, FALSE, TRUE
  )
  RETURNING id INTO v_id;

  INSERT INTO public.inventory_stocks (item_id, warehouse_code, box_qty, unit_qty, safe_stock_boxes)
  VALUES (v_id, 'MAIN', v_boxes, v_units, v_safe)
  ON CONFLICT (item_id, warehouse_code) DO UPDATE
  SET box_qty = EXCLUDED.box_qty,
      unit_qty = EXCLUDED.unit_qty,
      safe_stock_boxes = EXCLUDED.safe_stock_boxes,
      updated_at = NOW();

  RETURN jsonb_build_object('success', true, 'id', v_id);
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION '이미 등록된 품명+컬러+포장수량 조합입니다.';
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_create_brand(p_name TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_name TEXT := TRIM(COALESCE(p_name, ''));
  v_id UUID;
  v_out TEXT;
BEGIN
  PERFORM public.fn_require_session();
  IF v_name = '' THEN
    RAISE EXCEPTION '브랜드 이름이 비어 있습니다.';
  END IF;

  SELECT id, name INTO v_id, v_out
  FROM public.brands
  WHERE lower(name) = lower(v_name)
  LIMIT 1;

  IF v_id IS NOT NULL THEN
    UPDATE public.brands
    SET is_active = TRUE
    WHERE id = v_id AND COALESCE(is_active, TRUE) IS DISTINCT FROM TRUE;
    RETURN jsonb_build_object('id', v_id, 'name', v_out);
  END IF;

  INSERT INTO public.brands (name, is_active)
  VALUES (v_name, TRUE)
  RETURNING id, name INTO v_id, v_out;
  RETURN jsonb_build_object('id', v_id, 'name', v_out);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_upsert_aliases(p_aliases JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_count INTEGER := 0;
BEGIN
  PERFORM public.fn_require_session();
  IF p_aliases IS NULL OR jsonb_typeof(p_aliases) <> 'array' OR jsonb_array_length(p_aliases) = 0 THEN
    RETURN jsonb_build_object('success', true, 'count', 0);
  END IF;

  INSERT INTO public.aliases (alias, target_item_name)
  SELECT UPPER(TRIM(x.alias)), TRIM(x.target_item_name)
  FROM jsonb_to_recordset(p_aliases) AS x(alias TEXT, target_item_name TEXT)
  WHERE TRIM(COALESCE(x.alias, '')) <> ''
    AND TRIM(COALESCE(x.target_item_name, '')) <> ''
  ON CONFLICT (alias) DO UPDATE
    SET target_item_name = EXCLUDED.target_item_name;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('success', true, 'count', v_count);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_ensure_items(p_items JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_row RECORD;
  v_id UUID;
  v_name TEXT;
  v_color TEXT;
  v_pkg NUMERIC;
  v_out JSONB := '[]'::JSONB;
BEGIN
  PERFORM public.fn_require_session();
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RETURN v_out;
  END IF;

  FOR v_row IN SELECT * FROM jsonb_to_recordset(p_items) AS x(
    item_name TEXT, color TEXT, box_packaging_qty NUMERIC
  )
  LOOP
    v_name := TRIM(COALESCE(v_row.item_name, ''));
    v_color := TRIM(COALESCE(v_row.color, 'SURTIDO'));
    v_pkg := COALESCE(v_row.box_packaging_qty, 1);
    IF v_name = '' THEN
      CONTINUE;
    END IF;

    SELECT id INTO v_id
    FROM public.items
    WHERE item_name = v_name AND color = v_color AND box_packaging_qty = v_pkg
    LIMIT 1;

    IF v_id IS NULL THEN
      INSERT INTO public.items (item_name, color, box_packaging_qty, is_grid_item, is_active)
      VALUES (v_name, v_color, v_pkg, FALSE, TRUE)
      RETURNING id INTO v_id;
      INSERT INTO public.inventory_stocks (item_id, warehouse_code, box_qty, unit_qty)
      VALUES (v_id, 'MAIN', 0, 0)
      ON CONFLICT (item_id, warehouse_code) DO NOTHING;
    END IF;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'item_id', v_id, 'item_name', v_name, 'color', v_color, 'box_packaging_qty', v_pkg
    ));
  END LOOP;
  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_upsert_partner(
  p_name TEXT,
  p_role TEXT DEFAULT 'OUTBOUND',
  p_warehouse_code TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_name TEXT := TRIM(COALESCE(p_name, ''));
  v_role TEXT := UPPER(TRIM(COALESCE(p_role, 'OUTBOUND')));
  v_wh TEXT := NULLIF(UPPER(TRIM(COALESCE(p_warehouse_code, ''))), '');
  v_type TEXT;
  v_id UUID;
BEGIN
  PERFORM public.fn_require_admin();
  IF v_name = '' THEN
    RAISE EXCEPTION '거래처 이름이 비어 있습니다.';
  END IF;
  IF v_role NOT IN ('INBOUND', 'OUTBOUND', 'BRANCH', 'BOTH') THEN
    v_role := 'OUTBOUND';
  END IF;

  v_type := CASE WHEN v_role = 'BRANCH' THEN 'OUTBOUND' ELSE v_role END;

  SELECT id INTO v_id
  FROM public.partners
  WHERE lower(name) = lower(v_name)
    AND COALESCE(partner_type, '') = v_type
  LIMIT 1;

  IF v_id IS NULL THEN
    INSERT INTO public.partners (
      name, partner_type, is_active, is_supplier, is_customer, is_branch, warehouse_code
    ) VALUES (
      v_name,
      v_type,
      TRUE,
      v_role IN ('INBOUND', 'BOTH'),
      v_role IN ('OUTBOUND', 'BOTH', 'BRANCH'),
      v_role = 'BRANCH',
      v_wh
    )
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.partners
    SET is_active = TRUE,
        is_supplier = v_role IN ('INBOUND', 'BOTH'),
        is_customer = v_role IN ('OUTBOUND', 'BOTH', 'BRANCH'),
        is_branch = (v_role = 'BRANCH'),
        warehouse_code = COALESCE(v_wh, warehouse_code)
    WHERE id = v_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'id', v_id, 'name', v_name, 'role', v_role);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_create_member(
  p_member_name TEXT,
  p_password TEXT,
  p_access_level TEXT DEFAULT 'staff',
  p_branch_name TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_name TEXT := TRIM(COALESCE(p_member_name, ''));
  v_level TEXT := LOWER(TRIM(COALESCE(p_access_level, 'staff')));
  v_id UUID;
BEGIN
  PERFORM public.fn_require_admin();
  IF v_name = '' OR COALESCE(p_password, '') = '' THEN
    RAISE EXCEPTION '아이디와 비밀번호는 필수입니다.';
  END IF;
  IF v_level NOT IN ('admin', 'staff') THEN
    v_level := 'staff';
  END IF;

  INSERT INTO public.app_members (
    member_name, password_hash, branch_name, access_level, preferred_language, is_active
  ) VALUES (
    v_name,
    extensions.crypt(p_password, extensions.gen_salt('bf', 10)),
    NULLIF(TRIM(COALESCE(p_branch_name, '')), ''),
    v_level,
    'es',
    TRUE
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('success', true, 'id', v_id, 'member_name', v_name);
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION '이미 등록된 담당자 아이디입니다.';
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'rpc_execute_stock_normalization'
      AND pg_get_function_identity_arguments(p.oid) = 'p_groups jsonb'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'rpc_execute_stock_normalization_apply'
  ) THEN
    ALTER FUNCTION public.rpc_execute_stock_normalization(JSONB)
      RENAME TO rpc_execute_stock_normalization_apply;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.rpc_execute_stock_normalization(p_groups JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
BEGIN
  PERFORM public.fn_require_admin();
  RETURN public.rpc_execute_stock_normalization_apply(p_groups);
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'rpc_execute_color_normalization'
      AND pg_get_function_identity_arguments(p.oid) = 'p_items jsonb'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'rpc_execute_color_normalization_apply'
  ) THEN
    ALTER FUNCTION public.rpc_execute_color_normalization(JSONB)
      RENAME TO rpc_execute_color_normalization_apply;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.rpc_execute_color_normalization(p_items JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
BEGIN
  PERFORM public.fn_require_admin();
  RETURN public.rpc_execute_color_normalization_apply(p_items);
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'rpc_update_transaction_records'
      AND pg_get_function_identity_arguments(p.oid) = 'p_invoice_no text, p_tx_type text, p_new_records jsonb, p_admin text'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'rpc_update_transaction_records_apply'
  ) THEN
    ALTER FUNCTION public.rpc_update_transaction_records(TEXT, TEXT, JSONB, TEXT)
      RENAME TO rpc_update_transaction_records_apply;
  END IF;
END $$;

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
  v_member public.app_members%ROWTYPE;
BEGIN
  v_member := public.fn_require_session();
  RETURN public.rpc_update_transaction_records_apply(
    p_invoice_no,
    p_tx_type,
    p_new_records,
    COALESCE(v_member.member_name, p_admin)
  );
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'rpc_submit_warehouse_order_drafts'
      AND pg_get_function_identity_arguments(p.oid) = 'p_by_warehouse jsonb, p_admin text'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'rpc_submit_warehouse_order_drafts_apply'
  ) THEN
    ALTER FUNCTION public.rpc_submit_warehouse_order_drafts(JSONB, TEXT)
      RENAME TO rpc_submit_warehouse_order_drafts_apply;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.rpc_submit_warehouse_order_drafts(
  p_by_warehouse JSONB,
  p_admin TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_member public.app_members%ROWTYPE;
BEGIN
  v_member := public.fn_require_session();
  RETURN public.rpc_submit_warehouse_order_drafts_apply(
    p_by_warehouse,
    COALESCE(v_member.member_name, p_admin)
  );
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'rpc_apply_recommended_safe_stock'
      AND pg_get_function_identity_arguments(p.oid) = 'p_recommendations jsonb'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'rpc_apply_recommended_safe_stock_apply'
  ) THEN
    ALTER FUNCTION public.rpc_apply_recommended_safe_stock(JSONB)
      RENAME TO rpc_apply_recommended_safe_stock_apply;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.rpc_apply_recommended_safe_stock(p_recommendations JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
BEGIN
  PERFORM public.fn_require_admin();
  RETURN public.rpc_apply_recommended_safe_stock_apply(p_recommendations);
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_login(TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_logout() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_session_info() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_upsert_partner(TEXT, TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_create_member(TEXT, TEXT, TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_fifo_complete_pending(TEXT, UUID, BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_process_transaction(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_adjust_stock(TEXT, JSONB, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_reserve_outbound(TEXT, TEXT, JSONB, TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_update_transaction_records(TEXT, TEXT, JSONB, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_submit_warehouse_order_drafts(JSONB, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_execute_stock_normalization(JSONB) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_execute_color_normalization(JSONB) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_apply_recommended_safe_stock(JSONB) TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.rpc_process_transaction_apply(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_adjust_stock_apply(TEXT, JSONB, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

