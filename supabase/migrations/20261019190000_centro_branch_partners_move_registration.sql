-- ==============================================================================
-- 신규 서브창고로 앱에서 이동(MOVE)하기 + 이동 수량으로 이전 등록
--
-- 배경: 앱의 창고 간 이동은 출고 화면에서 "지점 거래처"(partners.is_branch, warehouse_code)를 출고처로 고르는 방식이다.
--       MANUELDOBLADO / CIRCUNBALAXION / GUATEMALA에는 지점 거래처가 없어 MAIN에서 이 창고들로 옮길 수 없었다.
--       또 이동 입고는 이전 등록으로 치지 않으므로(그 창고의 다른 상자를 센 것이 아님), 이동 후에도 "미확인"으로 남았다.
--
-- 조치:
--   1) 세 창고의 지점 거래처를 기존 지점(PANTACO 등)과 같은 형태(이름 = 창고 코드)로 추가한다.
--   2) rpc_register_moved_items — 이동 확인창에서 "도착 창고에 이 품목이 원래 없었음"을 체크했을 때, 이동이 끝난 뒤
--      그 품목들을 도착 창고의 현재 재고(= 이동 수량)로 이전 등록한다. 재고는 바꾸지 않는다. 이미 등록된 품목은 그대로 둔다.
-- ==============================================================================

INSERT INTO public.partners (partner_type, name, is_active, is_supplier, is_customer, is_branch, warehouse_code)
SELECT 'OUTBOUND', w.code, TRUE, TRUE, TRUE, TRUE, w.code
FROM public.warehouses w
WHERE w.code IN ('MANUELDOBLADO', 'CIRCUNBALAXION', 'GUATEMALA')
  AND NOT EXISTS (SELECT 1 FROM public.partners p WHERE p.is_branch AND p.warehouse_code = w.code)
  -- 같은 이름의 기존 거래처(고객 등)가 있으면 건드리지 않는다
  AND NOT EXISTS (SELECT 1 FROM public.partners p WHERE UPPER(p.name) = w.code);

CREATE OR REPLACE FUNCTION public.rpc_register_moved_items(
  p_warehouse TEXT,
  p_item_ids JSONB,
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
  v_wh TEXT := UPPER(TRIM(COALESCE(p_warehouse, '')));
  v_admin TEXT;
  v_item_id UUID;
  v_box INTEGER;
  v_unit INTEGER;
  v_registered INTEGER := 0;
  v_skipped INTEGER := 0;
BEGIN
  v_member := public.fn_require_admin();
  v_cached := public.fn_idempotency_lock(p_idempotency_key);
  IF v_cached IS NOT NULL THEN
    RETURN v_cached || jsonb_build_object('idempotent_replay', true);
  END IF;
  v_admin := COALESCE(NULLIF(TRIM(v_member.member_name), ''), 'ADMIN');

  IF NOT EXISTS (SELECT 1 FROM public.warehouses WHERE code = v_wh AND needs_item_registration) THEN
    RAISE EXCEPTION '% 창고는 이전 등록 대상이 아닙니다.', COALESCE(NULLIF(v_wh, ''), '(없음)');
  END IF;
  IF p_item_ids IS NULL OR jsonb_typeof(p_item_ids) <> 'array' OR jsonb_array_length(p_item_ids) = 0 THEN
    RAISE EXCEPTION '등록할 품목이 없습니다.';
  END IF;

  FOR v_item_id IN
    SELECT DISTINCT (x)::UUID FROM jsonb_array_elements_text(p_item_ids) AS x ORDER BY 1
  LOOP
    IF EXISTS (SELECT 1 FROM public.warehouse_item_registrations WHERE item_id = v_item_id AND warehouse_code = v_wh) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
    SELECT box_qty, unit_qty INTO v_box, v_unit
    FROM public.inventory_stocks
    WHERE item_id = v_item_id AND warehouse_code = v_wh
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION '% 창고에 이동된 재고가 없는 품목이 있어 등록할 수 없습니다.', v_wh;
    END IF;
    INSERT INTO public.warehouse_item_registrations (item_id, warehouse_code, counted_box, counted_unit, registered_by, registered_at)
    VALUES (v_item_id, v_wh, COALESCE(v_box, 0), COALESCE(v_unit, 0), v_admin, NOW());
    v_registered := v_registered + 1;
  END LOOP;

  v_result := jsonb_build_object('success', true, 'warehouse', v_wh, 'registered', v_registered, 'already_registered', v_skipped);
  PERFORM public.fn_idempotency_store(p_idempotency_key, v_result);
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.rpc_register_moved_items(TEXT, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_register_moved_items(TEXT, JSONB, TEXT) TO anon, authenticated, service_role;
