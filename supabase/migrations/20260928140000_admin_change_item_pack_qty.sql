-- ==============================================================================
-- 관리자용 포장수량(box_packaging_qty) 변경 RPC + 변경 이력 + 중복 품목 자동등록 방지
--
-- 배경: 재고/기준재고/거래내역은 (상자, 낱개) 원본값으로 저장되고, 총 개수는 항상 "현재"
--       포장수량으로 환산된다(fn_stock_units). 따라서 포장수량만 바꾸면 세 값이 함께 재해석되어
--       정합성 검사는 계속 일치하지만, 낱개(unit_qty) 원본값이 있거나 보류가 진행 중이면
--       의미가 어긋난다. 이 RPC는 그런 경우를 사전에 차단하고, 변경 후 정합성을 재검증해
--       문제가 생기면 트랜잭션 전체를 롤백한다.
-- ==============================================================================

-- 1) 변경 이력 (직접 접근 불가, RPC로만 기록/조회)
CREATE TABLE IF NOT EXISTS public.item_change_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  item_id UUID NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
  item_name TEXT NOT NULL,
  color TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  changed_by TEXT,
  reason TEXT,
  impact JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_item_change_log_item ON public.item_change_log(item_id);
CREATE INDEX IF NOT EXISTS idx_item_change_log_name ON public.item_change_log(item_name, color, field);

ALTER TABLE public.item_change_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "item_change_log_no_direct_client_access" ON public.item_change_log;
CREATE POLICY "item_change_log_no_direct_client_access"
  ON public.item_change_log FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

-- 2) 포장수량 변경 (p_apply = false 이면 영향 검토만 수행)
CREATE OR REPLACE FUNCTION public.rpc_change_item_pack_qty(
  p_item_id UUID,
  p_new_pack INTEGER,
  p_apply BOOLEAN DEFAULT FALSE,
  p_confirm_boxes BOOLEAN DEFAULT FALSE,
  p_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_member public.app_members%ROWTYPE;
  v_item public.items%ROWTYPE;
  v_old_pack INTEGER;
  v_blockers TEXT[] := ARRAY[]::TEXT[];
  v_warnings TEXT[] := ARRAY[]::TEXT[];
  v_stock_rows INTEGER;
  v_stock_unit_rows INTEGER;
  v_base_unit_rows INTEGER;
  v_tx_count INTEGER;
  v_tx_unit_rows INTEGER;
  v_pending_active INTEGER;
  v_pending_unit_rows INTEGER;
  v_units_before BIGINT;
  v_units_after BIGINT;
  v_needs_ack BOOLEAN;
  v_impact JSONB;
  v_bad_before BOOLEAN;
  v_bad_after BOOLEAN;
BEGIN
  v_member := public.fn_require_admin();

  IF p_item_id IS NULL THEN
    RAISE EXCEPTION '대상 품목이 지정되지 않았습니다.';
  END IF;

  SELECT * INTO v_item FROM public.items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '품목을 찾을 수 없습니다.';
  END IF;

  v_old_pack := GREATEST(1, ROUND(COALESCE(v_item.box_packaging_qty, 1)))::INTEGER;

  IF p_new_pack IS NULL OR p_new_pack < 1 OR p_new_pack > 100000 THEN
    RAISE EXCEPTION '새 포장수량은 1 이상 100000 이하의 정수여야 합니다.';
  END IF;
  IF p_new_pack = v_old_pack AND v_item.box_packaging_qty = p_new_pack THEN
    RAISE EXCEPTION '현재 포장수량(%)과 같아 변경할 내용이 없습니다.', v_old_pack;
  END IF;

  -- 같은 이름/색상/포장수량 품목이 이미 있으면 유일 제약과 충돌
  IF EXISTS (
    SELECT 1 FROM public.items o
    WHERE o.id <> v_item.id
      AND o.item_name = v_item.item_name
      AND COALESCE(o.color, 'SURTIDO') = COALESCE(v_item.color, 'SURTIDO')
      AND o.box_packaging_qty = p_new_pack
  ) THEN
    v_blockers := array_append(v_blockers, 'DUPLICATE_ITEM');
  END IF;

  SELECT COUNT(*), COUNT(*) FILTER (WHERE unit_qty <> 0),
         COALESCE(SUM(public.fn_stock_units(box_qty, unit_qty, v_old_pack)), 0),
         COALESCE(SUM(public.fn_stock_units(box_qty, unit_qty, p_new_pack)), 0)
    INTO v_stock_rows, v_stock_unit_rows, v_units_before, v_units_after
  FROM public.inventory_stocks WHERE item_id = v_item.id;

  SELECT COUNT(*) FILTER (WHERE unit_qty <> 0) INTO v_base_unit_rows
  FROM public.stock_baselines WHERE item_id = v_item.id;

  SELECT COUNT(*), COUNT(*) FILTER (WHERE unit_qty <> 0)
    INTO v_tx_count, v_tx_unit_rows
  FROM public.stock_transactions WHERE item_id = v_item.id;

  SELECT COUNT(*) FILTER (WHERE status IN ('PENDING', 'IN_TRANSIT', 'LISTO')),
         COUNT(*) FILTER (WHERE status IN ('PENDING', 'IN_TRANSIT', 'LISTO') AND unit_qty <> 0)
    INTO v_pending_active, v_pending_unit_rows
  FROM public.pending_orders WHERE item_id = v_item.id;

  IF v_pending_active > 0 THEN
    v_blockers := array_append(v_blockers, 'PENDING_ORDERS');
  END IF;

  -- 낱개 원본값이 있으면 포장수량을 바꿀 때 의미가 달라지므로 자동 변경하지 않는다.
  IF v_stock_unit_rows > 0 OR v_base_unit_rows > 0 OR v_tx_unit_rows > 0
     OR v_pending_unit_rows > 0 OR COALESCE(v_item.initial_stock_units, 0) <> 0 THEN
    v_blockers := array_append(v_blockers, 'UNIT_QTY_PRESENT');
  END IF;

  IF v_tx_count > 0 THEN
    v_warnings := array_append(v_warnings, 'HAS_TRANSACTIONS');
  END IF;
  IF v_old_pack > 1 THEN
    v_warnings := array_append(v_warnings, 'OLD_PACK_NOT_1');
  END IF;

  -- 재고나 거래내역이 있으면, 기존 상자 수량이 "새 포장수량 기준 상자"임을 확인해야 한다.
  v_needs_ack := (v_units_before > 0 OR v_tx_count > 0);
  IF v_needs_ack AND NOT COALESCE(p_confirm_boxes, FALSE) AND p_apply THEN
    v_blockers := array_append(v_blockers, 'CONFIRM_REQUIRED');
  END IF;

  v_impact := jsonb_build_object(
    'stockRows', v_stock_rows,
    'stockUnitRows', v_stock_unit_rows,
    'baselineUnitRows', v_base_unit_rows,
    'txCount', v_tx_count,
    'txUnitRows', v_tx_unit_rows,
    'pendingActive', v_pending_active,
    'unitsBefore', v_units_before,
    'unitsAfter', v_units_after,
    'needsConfirm', v_needs_ack
  );

  IF NOT p_apply OR array_length(v_blockers, 1) IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', array_length(v_blockers, 1) IS NULL,
      'applied', FALSE,
      'item', jsonb_build_object(
        'id', v_item.id, 'name', v_item.item_name, 'color', v_item.color,
        'oldPack', v_old_pack, 'newPack', p_new_pack
      ),
      'blockers', to_jsonb(v_blockers),
      'warnings', to_jsonb(v_warnings),
      'impact', v_impact
    );
  END IF;

  v_bad_before := position(v_item.id::TEXT IN public.rpc_verify_stock_integrity(NULL)::TEXT) > 0;

  UPDATE public.items
  SET box_packaging_qty = p_new_pack
  WHERE id = v_item.id;

  -- 변경 후 이 품목이 새로 정합성 오류(불일치/음수/유령보류)에 걸리면 전체 롤백
  v_bad_after := position(v_item.id::TEXT IN public.rpc_verify_stock_integrity(NULL)::TEXT) > 0;
  IF v_bad_after AND NOT v_bad_before THEN
    RAISE EXCEPTION '포장수량 변경 후 정합성 검사에 실패하여 변경을 취소했습니다.';
  END IF;

  INSERT INTO public.item_change_log (
    item_id, item_name, color, field, old_value, new_value, changed_by, reason, impact
  ) VALUES (
    v_item.id, v_item.item_name, COALESCE(v_item.color, 'SURTIDO'), 'box_packaging_qty',
    v_old_pack::TEXT, p_new_pack::TEXT, v_member.member_name, NULLIF(TRIM(COALESCE(p_reason, '')), ''), v_impact
  );

  RETURN jsonb_build_object(
    'success', TRUE,
    'applied', TRUE,
    'item', jsonb_build_object(
      'id', v_item.id, 'name', v_item.item_name, 'color', v_item.color,
      'oldPack', v_old_pack, 'newPack', p_new_pack
    ),
    'blockers', '[]'::JSONB,
    'warnings', to_jsonb(v_warnings),
    'impact', v_impact
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_change_item_pack_qty(UUID, INTEGER, BOOLEAN, BOOLEAN, TEXT)
  TO anon, authenticated, service_role;

-- 3) 최근 포장수량 변경 이력 조회 (관리자 전용)
CREATE OR REPLACE FUNCTION public.rpc_list_item_pack_changes(p_limit INTEGER DEFAULT 20)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
BEGIN
  PERFORM public.fn_require_admin();
  RETURN COALESCE((
    SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC)
    FROM (
      SELECT item_name, color, old_value, new_value, changed_by, reason, created_at
      FROM public.item_change_log
      WHERE field = 'box_packaging_qty'
      ORDER BY created_at DESC
      LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 200))
    ) x
  ), '[]'::JSONB);
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_list_item_pack_changes(INTEGER) TO anon, authenticated, service_role;

-- 4) 포장수량이 바뀐 품목을 "옛 포장수량"으로 다시 자동 등록해 중복 품목이 생기는 사고 방지
--    (오래 열려 있던 화면/장바구니가 옛 박스당수량으로 입고를 제출하는 경우)
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
  v_changed_to TEXT;
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
      SELECT i.box_packaging_qty::TEXT INTO v_changed_to
      FROM public.item_change_log l
      JOIN public.items i ON i.id = l.item_id
      WHERE l.field = 'box_packaging_qty'
        AND l.item_name = v_name
        AND l.color = v_color
        AND l.old_value::NUMERIC = v_pkg
        AND i.box_packaging_qty <> v_pkg
      ORDER BY l.created_at DESC
      LIMIT 1;

      IF v_changed_to IS NOT NULL THEN
        RAISE EXCEPTION '[%] (%) 품목의 포장수량이 %개에서 %개로 변경되었습니다. 화면을 새로고침하고 장바구니의 박스당수량을 확인하세요.',
          v_name, v_color, v_pkg, v_changed_to;
      END IF;

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

GRANT EXECUTE ON FUNCTION public.rpc_ensure_items(JSONB) TO anon, authenticated, service_role;

-- 5) 이미 수동(SQL)으로 변경한 SXY-2440(1 → 50)을 이력에 소급 기록해 같은 방어가 적용되도록 한다.
INSERT INTO public.item_change_log (
  item_id, item_name, color, field, old_value, new_value, changed_by, reason, impact
)
SELECT i.id, i.item_name, COALESCE(i.color, 'SURTIDO'), 'box_packaging_qty', '1', i.box_packaging_qty::TEXT,
       'admin', '수동 SQL로 변경한 내역 소급 기록 (재고 16상자, 거래내역 0건)', '{}'::JSONB
FROM public.items i
WHERE i.item_name = 'SXY-2440' AND COALESCE(i.color, 'SURTIDO') = 'SURTIDO' AND i.box_packaging_qty = 50
  AND NOT EXISTS (
    SELECT 1 FROM public.item_change_log l
    WHERE l.item_id = i.id AND l.field = 'box_packaging_qty'
  );
