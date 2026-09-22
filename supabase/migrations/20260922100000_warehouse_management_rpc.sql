-- ==============================================================================
-- 🏢 서브창고 등록/수정 및 활성-비활성 관리 (노드 관리 UI 2단계)
-- ==============================================================================

-- 1. 활성 여부 컬럼 추가 (partners/app_members와 동일한 소프트 삭제 패턴)
ALTER TABLE public.warehouses ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

-- 2. 서브창고 등록/수정 RPC (관리자 전용, code는 불변 PK — 등록 시에만 지정)
CREATE OR REPLACE FUNCTION public.rpc_upsert_warehouse(
  p_code TEXT,
  p_name TEXT,
  p_truck_capacity_boxes INTEGER DEFAULT 100,
  p_sort_order INTEGER DEFAULT NULL,
  p_is_active BOOLEAN DEFAULT TRUE
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_code TEXT := UPPER(TRIM(COALESCE(p_code, '')));
  v_name TEXT := TRIM(COALESCE(p_name, ''));
  v_sort INTEGER;
  v_exists BOOLEAN;
BEGIN
  PERFORM public.fn_require_admin();

  IF v_code = '' THEN
    RAISE EXCEPTION '창고 코드가 비어 있습니다.';
  END IF;
  IF v_code = 'MAIN' THEN
    RAISE EXCEPTION '메인 허브 창고는 이 화면에서 수정할 수 없습니다.';
  END IF;
  IF v_name = '' THEN
    RAISE EXCEPTION '창고 이름이 비어 있습니다.';
  END IF;

  SELECT EXISTS(SELECT 1 FROM public.warehouses WHERE code = v_code) INTO v_exists;

  IF v_exists THEN
    UPDATE public.warehouses
    SET name = v_name,
        truck_capacity_boxes = GREATEST(1, COALESCE(p_truck_capacity_boxes, truck_capacity_boxes)),
        sort_order = COALESCE(p_sort_order, sort_order),
        is_active = COALESCE(p_is_active, is_active)
    WHERE code = v_code;
  ELSE
    SELECT COALESCE(MAX(sort_order), 0) + 1 INTO v_sort
    FROM public.warehouses
    WHERE COALESCE(is_hub, FALSE) = FALSE;

    INSERT INTO public.warehouses (code, name, is_hub, sort_order, truck_capacity_boxes, is_active)
    VALUES (
      v_code, v_name, FALSE,
      COALESCE(p_sort_order, v_sort),
      GREATEST(1, COALESCE(p_truck_capacity_boxes, 100)),
      COALESCE(p_is_active, TRUE)
    );
  END IF;

  RETURN jsonb_build_object('success', true, 'code', v_code, 'name', v_name, 'is_active', COALESCE(p_is_active, TRUE));
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_upsert_warehouse(TEXT, TEXT, INTEGER, INTEGER, BOOLEAN) TO anon, authenticated, service_role;
