-- 거래처/담당자 수정, 시스템 설정 저장
CREATE TABLE IF NOT EXISTS public.app_settings (
  id TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT
);

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "app_settings_no_direct_client_access" ON public.app_settings;
CREATE POLICY "app_settings_no_direct_client_access"
  ON public.app_settings FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

INSERT INTO public.app_settings (id, value)
VALUES (
  'system',
  jsonb_build_object(
    'truckTargetBoxes', 100,
    'winterPeakMultiplier', 1.3,
    'alertOnIndividualOut', true,
    'receiptCompany', 'LADY POLO S.A. DE C.V.',
    'receiptAddress', 'ALARCÓN #42, COL. CENTRO, CDMX',
    'receiptNotice', '30일 이내 영수증 지참 시 교환 가능 (환불 불가)',
    'receiptRowsPerPage', 15,
    'activeSubWarehouses', jsonb_build_array(
      'PANTACO', 'IKEA', 'LERMA', 'PINO', 'YARE', 'ALMINTER', 'TLANE', 'STAR'
    )
  )
)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.rpc_get_system_settings()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_value JSONB;
BEGIN
  PERFORM public.fn_require_session();
  SELECT value INTO v_value FROM public.app_settings WHERE id = 'system';
  RETURN jsonb_build_object('success', true, 'settings', COALESCE(v_value, '{}'::JSONB));
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_save_system_settings(p_settings JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_member public.app_members%ROWTYPE;
  v_boxes INTEGER;
  v_merged JSONB;
BEGIN
  v_member := public.fn_require_admin();
  IF p_settings IS NULL OR jsonb_typeof(p_settings) <> 'object' THEN
    RAISE EXCEPTION '유효하지 않은 설정값입니다.';
  END IF;

  SELECT COALESCE(value, '{}'::JSONB) || p_settings
    INTO v_merged
  FROM public.app_settings
  WHERE id = 'system';

  v_merged := COALESCE(v_merged, p_settings);

  INSERT INTO public.app_settings (id, value, updated_at, updated_by)
  VALUES ('system', v_merged, NOW(), v_member.member_name)
  ON CONFLICT (id) DO UPDATE
  SET value = EXCLUDED.value,
      updated_at = NOW(),
      updated_by = EXCLUDED.updated_by;

  v_boxes := GREATEST(1, COALESCE((v_merged->>'truckTargetBoxes')::INTEGER, 100));
  UPDATE public.warehouses
  SET truck_capacity_boxes = v_boxes
  WHERE COALESCE(is_hub, FALSE) = FALSE;

  RETURN jsonb_build_object('success', true, 'settings', v_merged);
END;
$$;

DROP FUNCTION IF EXISTS public.rpc_upsert_partner(TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.rpc_upsert_partner(
  p_name TEXT,
  p_role TEXT DEFAULT 'OUTBOUND',
  p_warehouse_code TEXT DEFAULT NULL,
  p_id UUID DEFAULT NULL,
  p_is_active BOOLEAN DEFAULT TRUE
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
  v_id UUID := p_id;
  v_dup UUID;
BEGIN
  PERFORM public.fn_require_admin();
  IF v_id IS NULL AND v_name = '' THEN
    RAISE EXCEPTION '거래처 이름이 비어 있습니다.';
  END IF;
  IF v_role NOT IN ('INBOUND', 'OUTBOUND', 'BRANCH', 'BOTH') THEN
    v_role := 'OUTBOUND';
  END IF;

  v_type := CASE WHEN v_role = 'BRANCH' THEN 'OUTBOUND' ELSE v_role END;

  IF v_id IS NOT NULL THEN
    SELECT name INTO v_name
    FROM public.partners
    WHERE id = v_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION '거래처를 찾을 수 없습니다.';
    END IF;
    v_name := COALESCE(NULLIF(TRIM(COALESCE(p_name, '')), ''), v_name);

    SELECT id INTO v_dup
    FROM public.partners
    WHERE id <> v_id
      AND lower(name) = lower(v_name)
      AND COALESCE(partner_type, '') = v_type
    LIMIT 1;
    IF v_dup IS NOT NULL THEN
      RAISE EXCEPTION '같은 이름과 유형의 거래처가 이미 있습니다.';
    END IF;

    UPDATE public.partners
    SET name = v_name,
        partner_type = v_type,
        is_active = COALESCE(p_is_active, TRUE),
        is_supplier = v_role IN ('INBOUND', 'BOTH'),
        is_customer = v_role IN ('OUTBOUND', 'BOTH', 'BRANCH'),
        is_branch = (v_role = 'BRANCH'),
        warehouse_code = CASE WHEN v_role = 'BRANCH' THEN COALESCE(v_wh, warehouse_code) ELSE v_wh END
    WHERE id = v_id;
  ELSE
    SELECT id INTO v_id
    FROM public.partners
    WHERE lower(name) = lower(v_name)
      AND COALESCE(partner_type, '') = v_type
    LIMIT 1;

    IF v_id IS NULL THEN
      INSERT INTO public.partners (
        name, partner_type, is_active, is_supplier, is_customer, is_branch, warehouse_code
      ) VALUES (
        v_name, v_type, COALESCE(p_is_active, TRUE),
        v_role IN ('INBOUND', 'BOTH'),
        v_role IN ('OUTBOUND', 'BOTH', 'BRANCH'),
        v_role = 'BRANCH',
        v_wh
      )
      RETURNING id INTO v_id;
    ELSE
      UPDATE public.partners
      SET is_active = COALESCE(p_is_active, TRUE),
          is_supplier = v_role IN ('INBOUND', 'BOTH'),
          is_customer = v_role IN ('OUTBOUND', 'BOTH', 'BRANCH'),
          is_branch = (v_role = 'BRANCH'),
          warehouse_code = COALESCE(v_wh, warehouse_code)
      WHERE id = v_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'id', v_id,
    'name', v_name,
    'role', v_role,
    'is_active', COALESCE(p_is_active, TRUE)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_update_member(
  p_id UUID,
  p_branch_name TEXT DEFAULT NULL,
  p_access_level TEXT DEFAULT NULL,
  p_password TEXT DEFAULT NULL,
  p_is_active BOOLEAN DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_self public.app_members%ROWTYPE;
  v_level TEXT;
BEGIN
  v_self := public.fn_require_admin();
  IF p_id IS NULL THEN
    RAISE EXCEPTION '담당자가 지정되지 않았습니다.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.app_members WHERE id = p_id) THEN
    RAISE EXCEPTION '담당자를 찾을 수 없습니다.';
  END IF;

  IF p_id = v_self.id AND p_is_active IS FALSE THEN
    RAISE EXCEPTION '자신의 계정은 비활성화할 수 없습니다.';
  END IF;

  v_level := LOWER(TRIM(COALESCE(p_access_level, '')));
  IF v_level <> '' AND v_level NOT IN ('admin', 'staff') THEN
    v_level := 'staff';
  END IF;

  UPDATE public.app_members
  SET branch_name = CASE
        WHEN p_branch_name IS NULL THEN branch_name
        ELSE NULLIF(TRIM(p_branch_name), '')
      END,
      access_level = CASE WHEN v_level = '' THEN access_level ELSE v_level END,
      password_hash = CASE
        WHEN COALESCE(p_password, '') = '' THEN password_hash
        ELSE extensions.crypt(p_password, extensions.gen_salt('bf', 10))
      END,
      is_active = COALESCE(p_is_active, is_active)
  WHERE id = p_id;

  RETURN jsonb_build_object('success', true, 'id', p_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_get_system_settings() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_save_system_settings(JSONB) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_upsert_partner(TEXT, TEXT, TEXT, UUID, BOOLEAN) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_update_member(UUID, TEXT, TEXT, TEXT, BOOLEAN) TO anon, authenticated, service_role;
