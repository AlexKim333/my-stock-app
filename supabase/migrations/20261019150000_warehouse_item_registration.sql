-- ==============================================================================
-- 신규 서브창고(MANUELDOBLADO / CIRCUNBALAXION / GUATEMALA) 품목별 "이전 등록"
--
-- 배경: 세 창고에는 물건이 있지만 품목별 수량·입수(상자당 낱개)를 모른다. 한꺼번에 실사하지 않고, 주문이 들어올 때마다
--       그 품목만 세어 앱으로 옮긴다(이전 등록). 이전 등록 전에는 그 창고에서 그 품목을 출고·이동·보류할 수 없다.
--
-- 조치:
--   1) warehouses.needs_item_registration — 품목별 이전 등록이 필요한 창고. SMOKETEST도 스모크 검증용으로 켠다.
--   2) warehouse_item_registrations — (품목, 창고)별 이전 등록 기록(센 수량·등록자·시각). 앱은 RPC로만 읽는다.
--   3) rpc_register_warehouse_item — 센 상자·낱개와 상자에 적힌 입수로 등록한다.
--      같은 품명·컬러·입수 품목이 없으면(입수가 다른 상자) 별도 품목을 새로 만든다(HF11 입수 24/48처럼).
--      숨김 처리된 같은 품목이면 다시 보이게 한다. 재고는 센 수량으로 치환(ADJUST 전표 '[이전등록]').
--      이미 등록된 품목을 다시 등록하면 다시 센 수량으로 치환한다.
--   4) fn_assert_warehouse_atp_core — 이 창고에서 재고를 빼는 모든 경로(출고·이동·전표 수정·출고 보류)가 이 함수를
--      거치므로, 여기서 이전 등록 전 품목을 거절한다. 본문은 운영 DB의 현재 정의(2026-10-19)에 검사만 더했다.
-- ==============================================================================

ALTER TABLE public.warehouses ADD COLUMN IF NOT EXISTS needs_item_registration BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE public.warehouses
SET needs_item_registration = TRUE
WHERE code IN ('MANUELDOBLADO', 'CIRCUNBALAXION', 'GUATEMALA', 'SMOKETEST')
  AND NOT needs_item_registration;

CREATE TABLE IF NOT EXISTS public.warehouse_item_registrations (
  item_id UUID NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
  warehouse_code TEXT NOT NULL REFERENCES public.warehouses(code),
  counted_box INTEGER NOT NULL DEFAULT 0,
  counted_unit INTEGER NOT NULL DEFAULT 0,
  registered_by TEXT,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (item_id, warehouse_code)
);
ALTER TABLE public.warehouse_item_registrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.warehouse_item_registrations FROM anon, authenticated;

-- 이 창고에서 이 품목을 빼려면 이전 등록이 먼저 있어야 한다.
CREATE OR REPLACE FUNCTION public.fn_assert_item_registered(p_item_id UUID, p_warehouse TEXT, p_ctx TEXT DEFAULT '출고')
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_wh TEXT := UPPER(TRIM(COALESCE(p_warehouse, 'MAIN')));
  v_label TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.warehouses WHERE code = v_wh AND needs_item_registration) THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.warehouse_item_registrations WHERE item_id = p_item_id AND warehouse_code = v_wh) THEN
    RETURN;
  END IF;
  SELECT item_name || ' (' || COALESCE(color, 'SURTIDO') || ', 입수 ' || box_packaging_qty || ')' INTO v_label
  FROM public.items WHERE id = p_item_id;
  RAISE EXCEPTION '% 불가: % 창고의 % 품목은 아직 이전 등록 전입니다. 출고 화면에서 이전 등록(센 수량·입수 확인)을 먼저 하세요.',
    COALESCE(NULLIF(TRIM(p_ctx), ''), '출고'), v_wh, COALESCE(v_label, p_item_id::TEXT);
END;
$$;
REVOKE ALL ON FUNCTION public.fn_assert_item_registered(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_assert_warehouse_atp_core(p_item_id uuid, p_warehouse text, p_req_units bigint, p_ctx text, p_always boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_wh TEXT := UPPER(TRIM(COALESCE(p_warehouse, 'MAIN')));
  v_pack INTEGER;
  v_box INTEGER;
  v_unit INTEGER;
  v_gross BIGINT;
  v_committed BIGINT := 0;
  v_held BIGINT;
  v_avail BIGINT;
  v_label TEXT;
  v_parts TEXT;
BEGIN
  IF v_wh = '' OR COALESCE(p_req_units, 0) <= 0 THEN
    RETURN;
  END IF;

  -- 이전 등록이 필요한 창고(신규 서브창고)는 등록한 품목만 뺄 수 있다.
  PERFORM public.fn_assert_item_registered(p_item_id, v_wh, p_ctx);

  v_pack := public.fn_item_pack_qty(p_item_id);
  PERFORM public.fn_ensure_stock_row(p_item_id, v_wh);

  -- 발주 등록/조정·보류 저장과 같은 행을 먼저 잠가, 동시에 들어온 요청이 같은 재고를 이중으로 쓰지 못하게 한다.
  SELECT box_qty, unit_qty INTO v_box, v_unit
  FROM public.inventory_stocks
  WHERE item_id = p_item_id AND warehouse_code = v_wh
  FOR UPDATE;
  v_gross := public.fn_stock_units(COALESCE(v_box, 0), COALESCE(v_unit, 0), v_pack);

  IF v_wh <> 'MAIN' THEN
    SELECT COALESCE(SUM(public.fn_stock_units(box_qty, unit_qty, v_pack)), 0) INTO v_committed
    FROM public.pending_orders
    WHERE item_id = p_item_id
      AND from_warehouse = v_wh
      AND to_warehouse = 'MAIN'
      AND status IN ('PENDING', 'IN_TRANSIT');
  END IF;

  v_held := public.fn_outbound_held_units(p_item_id, v_wh);

  IF NOT COALESCE(p_always, FALSE) AND v_committed + v_held <= 0 THEN
    RETURN;
  END IF;

  v_avail := GREATEST(v_gross - v_committed - v_held, 0);
  IF p_req_units > v_avail THEN
    SELECT item_name || ' (' || COALESCE(color, 'SURTIDO') || ')' INTO v_label
    FROM public.items WHERE id = p_item_id;
    v_parts := format('실재고 %s상자 %s개', v_gross / v_pack, v_gross % v_pack);
    IF v_committed > 0 THEN
      v_parts := v_parts || format(' − MAIN 입고 예정 발주 %s상자 %s개', v_committed / v_pack, v_committed % v_pack);
    END IF;
    IF v_held > 0 THEN
      v_parts := v_parts || format(' − 출고 보류 %s상자 %s개', v_held / v_pack, v_held % v_pack);
    END IF;
    RAISE EXCEPTION '% 불가: 창고 % % 가용재고 부족 — 요청 %상자 %개, 가용 %상자 %개 (%).%',
      COALESCE(NULLIF(TRIM(p_ctx), ''), '출고'), v_wh, COALESCE(v_label, p_item_id::TEXT),
      p_req_units / v_pack, p_req_units % v_pack,
      v_avail / v_pack, v_avail % v_pack,
      v_parts,
      CASE
        WHEN v_committed > 0 AND v_held > 0 THEN ' 발주나 출고 보류를 먼저 줄이거나 취소하세요.'
        WHEN v_committed > 0 THEN ' 발주를 먼저 줄이거나 취소하세요.'
        WHEN v_held > 0 THEN ' 출고 보류를 먼저 줄이거나 삭제하세요.'
        ELSE ''
      END;
  END IF;
END;
$function$;

-- 이전 등록: 센 수량·상자에 적힌 입수로 그 창고 재고를 치환하고 등록 기록을 남긴다.
CREATE OR REPLACE FUNCTION public.rpc_register_warehouse_item(
  p_item_name TEXT,
  p_color TEXT,
  p_pack INTEGER,
  p_warehouse TEXT,
  p_box INTEGER,
  p_unit INTEGER,
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
  v_name TEXT := TRIM(COALESCE(p_item_name, ''));
  v_color TEXT := UPPER(TRIM(COALESCE(NULLIF(TRIM(p_color), ''), 'SURTIDO')));
  v_pack INTEGER := COALESCE(p_pack, 0);
  v_wh TEXT := UPPER(TRIM(COALESCE(p_warehouse, '')));
  v_box INTEGER := COALESCE(p_box, 0);
  v_unit INTEGER := COALESCE(p_unit, 0);
  v_item_id UUID;
  v_active BOOLEAN;
  v_brand UUID;
  v_created BOOLEAN := FALSE;
  v_reactivated BOOLEAN := FALSE;
  v_again BOOLEAN := FALSE;
  v_prev_box INTEGER;
  v_prev_unit INTEGER;
  v_held BIGINT;
  v_admin TEXT;
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
  IF v_name = '' THEN
    RAISE EXCEPTION '품명을 입력하세요.';
  END IF;
  IF v_pack < 1 THEN
    RAISE EXCEPTION '입수(상자당 수량)는 1 이상이어야 합니다.';
  END IF;
  IF v_box < 0 OR v_unit < 0 THEN
    RAISE EXCEPTION '수량에는 음수를 입력할 수 없습니다.';
  END IF;

  -- 같은 품명·컬러·입수 품목(숨김 포함). 없으면 입수가 다른 별도 품목으로 만든다.
  SELECT id, COALESCE(is_active, TRUE) INTO v_item_id, v_active
  FROM public.items
  WHERE item_name = v_name AND UPPER(COALESCE(color, 'SURTIDO')) = v_color AND box_packaging_qty = v_pack
  ORDER BY COALESCE(is_active, TRUE) DESC, created_at
  LIMIT 1
  FOR UPDATE;

  IF v_item_id IS NULL THEN
    SELECT brand_id INTO v_brand
    FROM public.items
    WHERE item_name = v_name AND UPPER(COALESCE(color, 'SURTIDO')) = v_color
    ORDER BY COALESCE(is_active, TRUE) DESC, created_at
    LIMIT 1;
    INSERT INTO public.items (item_name, color, box_packaging_qty, brand_id, is_grid_item, is_active)
    VALUES (v_name, v_color, v_pack, v_brand, FALSE, TRUE)
    RETURNING id INTO v_item_id;
    INSERT INTO public.inventory_stocks (item_id, warehouse_code, box_qty, unit_qty)
    VALUES (v_item_id, 'MAIN', 0, 0)
    ON CONFLICT (item_id, warehouse_code) DO NOTHING;
    v_created := TRUE;
  ELSIF NOT v_active THEN
    UPDATE public.items SET is_active = TRUE WHERE id = v_item_id;
    v_reactivated := TRUE;
  END IF;

  -- 응답·화면 키는 품목에 저장된 컬러 표기를 쓴다(입력 대소문자와 다를 수 있음).
  SELECT COALESCE(color, 'SURTIDO') INTO v_color FROM public.items WHERE id = v_item_id;

  v_again := EXISTS (SELECT 1 FROM public.warehouse_item_registrations WHERE item_id = v_item_id AND warehouse_code = v_wh);

  PERFORM public.fn_ensure_stock_row(v_item_id, v_wh);
  SELECT box_qty, unit_qty INTO v_prev_box, v_prev_unit
  FROM public.inventory_stocks
  WHERE item_id = v_item_id AND warehouse_code = v_wh
  FOR UPDATE;

  v_held := public.fn_outbound_held_units(v_item_id, v_wh);
  IF public.fn_stock_units(v_box, v_unit, v_pack) < v_held THEN
    RAISE EXCEPTION '% 창고 % 재고를 %상자 %개로 등록할 수 없습니다: 출고 보류가 %상자 %개 걸려 있습니다.',
      v_wh, v_name, v_box, v_unit, v_held / v_pack, v_held % v_pack;
  END IF;

  PERFORM public.rpc_adjust_stock_apply(
    v_admin,
    jsonb_build_array(jsonb_build_object(
      'item_id', v_item_id, 'adj_mode', 'replace', 'box_qty', v_box, 'unit_qty', v_unit, 'reason', NULL
    )),
    v_wh,
    NULL,
    -- 사유를 앞에 둔다(스모크 정리 스크립트가 '스모크테스트' 접두어로 테스트 전표를 찾는다).
    format('%s[이전등록] %s 입수 %s: %s상자/%s개 → %s상자/%s개',
      COALESCE(NULLIF(TRIM(COALESCE(p_memo, '')), '') || ' ', ''),
      v_wh, v_pack, COALESCE(v_prev_box, 0), COALESCE(v_prev_unit, 0), v_box, v_unit)
  );

  INSERT INTO public.warehouse_item_registrations (item_id, warehouse_code, counted_box, counted_unit, registered_by, registered_at)
  VALUES (v_item_id, v_wh, v_box, v_unit, v_admin, NOW())
  ON CONFLICT (item_id, warehouse_code) DO UPDATE
  SET counted_box = EXCLUDED.counted_box,
      counted_unit = EXCLUDED.counted_unit,
      registered_by = EXCLUDED.registered_by,
      registered_at = EXCLUDED.registered_at;

  v_result := jsonb_build_object(
    'success', true,
    'item_id', v_item_id,
    'item_name', v_name,
    'color', v_color,
    'pack', v_pack,
    'warehouse', v_wh,
    'box_qty', v_box,
    'unit_qty', v_unit,
    'created_item', v_created,
    'reactivated', v_reactivated,
    're_registered', v_again
  );
  PERFORM public.fn_idempotency_store(p_idempotency_key, v_result);
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.rpc_register_warehouse_item(TEXT, TEXT, INTEGER, TEXT, INTEGER, INTEGER, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_register_warehouse_item(TEXT, TEXT, INTEGER, TEXT, INTEGER, INTEGER, TEXT, TEXT) TO anon, authenticated, service_role;

-- 이전 등록 목록(출고 화면이 "미확인" 표시에 쓴다)
CREATE OR REPLACE FUNCTION public.rpc_list_warehouse_item_registrations()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public
AS $$
BEGIN
  PERFORM public.fn_assert_read_session();
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'item_id', r.item_id,
      'item_name', i.item_name,
      'color', COALESCE(i.color, 'SURTIDO'),
      'pack', i.box_packaging_qty,
      'warehouse', r.warehouse_code,
      'counted_box', r.counted_box,
      'counted_unit', r.counted_unit,
      'registered_by', r.registered_by,
      'registered_at', r.registered_at
    ) ORDER BY r.registered_at DESC)
    FROM public.warehouse_item_registrations r
    JOIN public.items i ON i.id = r.item_id
  ), '[]'::JSONB);
END;
$$;
REVOKE ALL ON FUNCTION public.rpc_list_warehouse_item_registrations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_list_warehouse_item_registrations() TO anon, authenticated, service_role;
