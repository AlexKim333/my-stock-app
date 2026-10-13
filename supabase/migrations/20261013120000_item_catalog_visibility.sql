-- ==============================================================================
-- 상품관리: 오래된/단종/중복 등록 품목을 "숨김(비활성)" 처리해 검색 대상에서 제외
--
-- 새 컬럼 없이 기존 items.is_active를 쓴다. 비활성 품목은 이미
--   - 재고 목록·검색(rpc_list_effective_stocks), OCR 품명 후보, AI 조회에서 빠지고
--   - 입출고·발주 기록이 트리거(fn_reject_inactive_item)로 차단된다.
-- 여기서는 관리자가 안전하게 전환할 수 있는 RPC와 관리 화면용 목록 RPC를 추가한다.
--
-- 숨김 조건: 모든 창고 재고 0, 진행 중 이동/발주 없음, 출고 보류에 담겨 있지 않음.
--   재고가 남은 품목을 숨기면 재고 합계·매트릭스에서 수량이 조용히 사라지므로 막는다.
--   (재고가 남아 있다면 재고조정으로 0을 맞추거나, 중복 품목이면 남길 품목으로 옮긴 뒤 숨긴다.)
-- 복구는 언제나 가능하다(같은 품명·색상·포장수량 조합은 유일 제약상 하나뿐이므로 충돌이 없다).
-- ==============================================================================

-- 1) 관리 화면용 전체 품목 목록 (관리자 전용, 활성+비활성 모두)
CREATE OR REPLACE FUNCTION public.rpc_list_item_catalog()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public
AS $$
BEGIN
  PERFORM public.fn_require_admin();
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', i.id,
      'name', i.item_name,
      'color', COALESCE(i.color, 'SURTIDO'),
      'pack', COALESCE(i.box_packaging_qty, 1),
      'active', COALESCE(i.is_active, TRUE),
      'createdAt', i.created_at,
      'mainBox', COALESCE(st.main_box, 0),
      'mainUnit', COALESCE(st.main_unit, 0),
      'stocks', COALESCE(st.stocks, '[]'::JSONB),
      'txCount', COALESCE(tx.cnt, 0),
      'lastTxAt', tx.last_at,
      'pendingActive', COALESCE(po.cnt, 0),
      'holdCount', COALESCE(hd.cnt, 0)
    ) ORDER BY i.item_name, i.color, i.box_packaging_qty)
    FROM public.items i
    LEFT JOIN (
      SELECT s.item_id,
             SUM(s.box_qty) FILTER (WHERE s.warehouse_code = 'MAIN') AS main_box,
             SUM(s.unit_qty) FILTER (WHERE s.warehouse_code = 'MAIN') AS main_unit,
             jsonb_agg(jsonb_build_object('wh', s.warehouse_code, 'box', s.box_qty, 'unit', s.unit_qty)
                       ORDER BY s.warehouse_code)
               FILTER (WHERE s.box_qty <> 0 OR s.unit_qty <> 0) AS stocks
      FROM public.inventory_stocks s
      GROUP BY s.item_id
    ) st ON st.item_id = i.id
    LEFT JOIN (
      SELECT item_id, COUNT(*) AS cnt, MAX(created_at) AS last_at
      FROM public.stock_transactions
      GROUP BY item_id
    ) tx ON tx.item_id = i.id
    LEFT JOIN (
      SELECT item_id, COUNT(*) AS cnt
      FROM public.pending_orders
      WHERE status IN ('PENDING', 'IN_TRANSIT', 'LISTO')
      GROUP BY item_id
    ) po ON po.item_id = i.id
    LEFT JOIN (
      SELECT item_id, COUNT(DISTINCT hold_id) AS cnt
      FROM public.outbound_hold_items
      GROUP BY item_id
    ) hd ON hd.item_id = i.id
  ), '[]'::JSONB);
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_list_item_catalog() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_list_item_catalog() TO anon, authenticated, service_role;

-- 2) 일괄 숨김/복구 (관리자 전용)
--    차단 사유가 있는 품목은 건너뛰고 나머지만 바꾼다. 결과에 바뀐 품목과 건너뛴 품목(사유)을 돌려준다.
CREATE OR REPLACE FUNCTION public.rpc_set_items_active(
  p_item_ids UUID[],
  p_active BOOLEAN,
  p_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_member public.app_members%ROWTYPE;
  v_item public.items%ROWTYPE;
  v_reason TEXT := NULLIF(TRIM(COALESCE(p_reason, '')), '');
  v_blockers TEXT[];
  v_changed JSONB := '[]'::JSONB;
  v_skipped JSONB := '[]'::JSONB;
BEGIN
  v_member := public.fn_require_admin();

  IF p_active IS NULL THEN
    RAISE EXCEPTION '숨김/복구 여부가 지정되지 않았습니다.';
  END IF;
  IF p_item_ids IS NULL OR cardinality(p_item_ids) = 0 THEN
    RAISE EXCEPTION '대상 품목을 선택하세요.';
  END IF;
  IF cardinality(p_item_ids) > 500 THEN
    RAISE EXCEPTION '한 번에 500개까지만 처리할 수 있습니다.';
  END IF;

  -- id 순서로 잠가 동시 처리 간 교착을 방지한다.
  FOR v_item IN
    SELECT * FROM public.items
    WHERE id = ANY (p_item_ids)
    ORDER BY id
    FOR UPDATE
  LOOP
    IF COALESCE(v_item.is_active, TRUE) = p_active THEN
      CONTINUE;
    END IF;

    v_blockers := ARRAY[]::TEXT[];
    IF NOT p_active THEN
      -- 재고 행도 잠가, 검사 직후 다른 처리가 재고를 넣는 경합을 막는다.
      PERFORM 1 FROM public.inventory_stocks WHERE item_id = v_item.id ORDER BY warehouse_code FOR UPDATE;

      IF EXISTS (SELECT 1 FROM public.inventory_stocks
                 WHERE item_id = v_item.id AND (box_qty <> 0 OR unit_qty <> 0)) THEN
        v_blockers := array_append(v_blockers, 'STOCK_REMAINING');
      END IF;
      IF EXISTS (SELECT 1 FROM public.pending_orders
                 WHERE item_id = v_item.id AND status IN ('PENDING', 'IN_TRANSIT', 'LISTO')) THEN
        v_blockers := array_append(v_blockers, 'PENDING_ORDERS');
      END IF;
      IF EXISTS (SELECT 1 FROM public.outbound_hold_items WHERE item_id = v_item.id) THEN
        v_blockers := array_append(v_blockers, 'OUTBOUND_HOLDS');
      END IF;
    END IF;

    IF array_length(v_blockers, 1) IS NOT NULL THEN
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'id', v_item.id, 'name', v_item.item_name, 'color', COALESCE(v_item.color, 'SURTIDO'),
        'pack', v_item.box_packaging_qty, 'blockers', to_jsonb(v_blockers)
      ));
      CONTINUE;
    END IF;

    UPDATE public.items SET is_active = p_active WHERE id = v_item.id;

    INSERT INTO public.item_change_log (
      item_id, item_name, color, field, old_value, new_value, changed_by, reason
    ) VALUES (
      v_item.id, v_item.item_name, COALESCE(v_item.color, 'SURTIDO'), 'is_active',
      (NOT p_active)::TEXT, p_active::TEXT, v_member.member_name, v_reason
    );

    -- 다른 기기의 재고 목록·검색 색인을 다시 읽게 한다(stockSync.js).
    INSERT INTO public.stock_change_signals (source, item_id, warehouses)
    VALUES ('items', v_item.id, ARRAY['MAIN']);

    v_changed := v_changed || jsonb_build_array(jsonb_build_object(
      'id', v_item.id, 'name', v_item.item_name, 'color', COALESCE(v_item.color, 'SURTIDO'),
      'pack', v_item.box_packaging_qty
    ));
  END LOOP;

  RETURN jsonb_build_object(
    'success', TRUE,
    'active', p_active,
    'changed', v_changed,
    'skipped', v_skipped
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_set_items_active(UUID[], BOOLEAN, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_set_items_active(UUID[], BOOLEAN, TEXT) TO anon, authenticated, service_role;

-- 3) 최근 숨김/복구 이력 (관리자 전용)
CREATE OR REPLACE FUNCTION public.rpc_list_item_visibility_changes(p_limit INTEGER DEFAULT 30)
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
      SELECT item_id, item_name, color, new_value, changed_by, reason, created_at
      FROM public.item_change_log
      WHERE field = 'is_active'
      ORDER BY created_at DESC
      LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 30), 200))
    ) x
  ), '[]'::JSONB);
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_list_item_visibility_changes(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_list_item_visibility_changes(INTEGER) TO anon, authenticated, service_role;

-- 4) 숨김 품목 거래 차단 안내 문구에 복구 방법을 덧붙인다 (동작은 그대로).
CREATE OR REPLACE FUNCTION public.fn_reject_inactive_item()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO public
AS $$
DECLARE
  v_name TEXT;
BEGIN
  SELECT item_name INTO v_name
  FROM public.items
  WHERE id = NEW.item_id AND NOT COALESCE(is_active, TRUE);
  IF FOUND THEN
    RAISE EXCEPTION '숨김(비활성) 처리된 품목에는 입출고·발주를 기록할 수 없습니다: % — 계속 쓰려면 [상품관리]에서 다시 활성화한 뒤 화면을 새로고침하세요.', v_name;
  END IF;
  RETURN NEW;
END;
$$;

-- 출고 보류에도 같은 차단을 적용한다(숨김은 보류가 없을 때만 가능하므로 기존 보류에는 영향 없음).
DROP TRIGGER IF EXISTS trg_reject_inactive_item_hold ON public.outbound_hold_items;
CREATE TRIGGER trg_reject_inactive_item_hold
BEFORE INSERT ON public.outbound_hold_items
FOR EACH ROW EXECUTE FUNCTION public.fn_reject_inactive_item();

-- 5) 상품등록: 같은 조합이 "숨김" 상태로 있으면 그 사실을 알려 준다.
--    본문은 옛 마이그레이션이 아니라 운영 DB의 현재 정의에서 한 줄만 바꾼다(20261009130000과 같은 방식).
DO $$
DECLARE
  v_oid OID;
  v_def TEXT;
  v_old TEXT := 'RAISE EXCEPTION ''이미 등록된 품명+컬러+포장수량 조합입니다.'';';
  v_new TEXT := 'IF EXISTS (SELECT 1 FROM public.items WHERE item_name = v_name AND color = v_color'
    || ' AND box_packaging_qty = v_pkg AND NOT COALESCE(is_active, TRUE)) THEN'
    || ' RAISE EXCEPTION ''같은 품명+컬러+포장수량 품목이 숨김(비활성) 상태로 있습니다. [상품관리]에서 다시 활성화하세요.'';'
    || ' END IF; ' || v_old;
  v_hits INT;
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'rpc_register_item') <> 1 THEN
    RAISE EXCEPTION 'rpc_register_item 함수가 정확히 하나가 아닙니다.';
  END IF;

  SELECT p.oid INTO v_oid
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'rpc_register_item';

  v_def := pg_get_functiondef(v_oid);
  IF position('숨김(비활성) 상태로 있습니다' IN v_def) > 0 THEN
    RETURN; -- 이미 적용됨
  END IF;

  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'rpc_register_item 본문에서 바꿀 문구가 % 번 발견되었습니다(1번이어야 함).', v_hits;
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
END;
$$;
