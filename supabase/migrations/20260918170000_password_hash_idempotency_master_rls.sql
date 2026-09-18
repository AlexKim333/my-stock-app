-- ==============================================================================
-- bcrypt 비밀번호, 전표 멱등 키, 브랜드/별칭 RPC, 마스터 테이블 직접 쓰기 차단
-- ==============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- 기존 평문 password_hash → bcrypt (이미 $2 해시인 행은 건너뜀)
UPDATE public.app_members
SET password_hash = extensions.crypt(password_hash, extensions.gen_salt('bf', 10))
WHERE password_hash IS NOT NULL
  AND password_hash NOT LIKE '$2a$%'
  AND password_hash NOT LIKE '$2b$%'
  AND password_hash NOT LIKE '$2y$%';

CREATE OR REPLACE FUNCTION public.rpc_login(p_member_name TEXT, p_password TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_row public.app_members%ROWTYPE;
  v_ok BOOLEAN := FALSE;
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

  RETURN jsonb_build_object(
    'success', true,
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

CREATE TABLE IF NOT EXISTS public.request_idempotency (
  id TEXT PRIMARY KEY,
  result JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.request_idempotency ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "request_idempotency_no_direct_client_access" ON public.request_idempotency;
CREATE POLICY "request_idempotency_no_direct_client_access"
  ON public.request_idempotency
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.fn_idempotency_lock(p_key TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_key TEXT := TRIM(COALESCE(p_key, ''));
  v_result JSONB;
BEGIN
  IF v_key = '' THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.request_idempotency (id, result)
  VALUES (v_key, jsonb_build_object('status', 'pending'))
  ON CONFLICT (id) DO UPDATE
    SET result = public.request_idempotency.result
  RETURNING result INTO v_result;

  IF v_result ? 'invoice_no' OR COALESCE(v_result->>'success', '') = 'true' THEN
    RETURN v_result;
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_idempotency_store(p_key TEXT, p_result JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_key TEXT := TRIM(COALESCE(p_key, ''));
BEGIN
  IF v_key = '' OR p_result IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.request_idempotency
  SET result = p_result
  WHERE id = v_key;
END;
$$;

ALTER FUNCTION public.rpc_process_transaction(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT)
  RENAME TO rpc_process_transaction_apply;

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
  v_cached JSONB;
  v_result JSONB;
BEGIN
  v_cached := public.fn_idempotency_lock(p_idempotency_key);
  IF v_cached IS NOT NULL THEN
    RETURN v_cached || jsonb_build_object('idempotent_replay', true);
  END IF;

  v_result := public.rpc_process_transaction_apply(
    p_tx_type,
    p_warehouse,
    p_partner,
    p_handler,
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

ALTER FUNCTION public.rpc_adjust_stock(TEXT, JSONB, TEXT, TEXT, TEXT)
  RENAME TO rpc_adjust_stock_apply;

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
  v_cached JSONB;
  v_result JSONB;
BEGIN
  v_cached := public.fn_idempotency_lock(p_idempotency_key);
  IF v_cached IS NOT NULL THEN
    RETURN v_cached || jsonb_build_object('idempotent_replay', true);
  END IF;

  v_result := public.rpc_adjust_stock_apply(
    p_admin,
    p_items,
    p_warehouse,
    p_invoice,
    p_memo
  );

  PERFORM public.fn_idempotency_store(p_idempotency_key, v_result);
  RETURN v_result;
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
  IF p_aliases IS NULL OR jsonb_typeof(p_aliases) <> 'array' OR jsonb_array_length(p_aliases) = 0 THEN
    RETURN jsonb_build_object('success', true, 'count', 0);
  END IF;

  INSERT INTO public.aliases (alias, target_item_name)
  SELECT
    UPPER(TRIM(x.alias)),
    TRIM(x.target_item_name)
  FROM jsonb_to_recordset(p_aliases) AS x(alias TEXT, target_item_name TEXT)
  WHERE TRIM(COALESCE(x.alias, '')) <> ''
    AND TRIM(COALESCE(x.target_item_name, '')) <> ''
  ON CONFLICT (alias) DO UPDATE
    SET target_item_name = EXCLUDED.target_item_name;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('success', true, 'count', v_count);
END;
$$;

DROP POLICY IF EXISTS "Enable all access for all users on brands" ON public.brands;
DROP POLICY IF EXISTS "brands_select" ON public.brands;
CREATE POLICY "brands_select"
  ON public.brands FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Enable all access for all users on aliases" ON public.aliases;
DROP POLICY IF EXISTS "aliases_select" ON public.aliases;
CREATE POLICY "aliases_select"
  ON public.aliases FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Enable all access for all users on partners" ON public.partners;
DROP POLICY IF EXISTS "partners_select" ON public.partners;
CREATE POLICY "partners_select"
  ON public.partners FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Enable all access for all users on warehouses" ON public.warehouses;
DROP POLICY IF EXISTS "warehouses_select" ON public.warehouses;
CREATE POLICY "warehouses_select"
  ON public.warehouses FOR SELECT TO anon, authenticated USING (true);

REVOKE ALL ON FUNCTION public.rpc_process_transaction_apply(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_adjust_stock_apply(TEXT, JSONB, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rpc_process_transaction(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_adjust_stock(TEXT, JSONB, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_create_brand(TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_upsert_aliases(JSONB) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_login(TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_idempotency_lock(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_idempotency_store(TEXT, JSONB) TO service_role;
