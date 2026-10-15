-- ==============================================================================
-- 상품관리: 여러 품목의 제조사(items.brand_id)를 한 번에 지정·변경
--
-- 예전 registerProduct가 p_brand_id를 넘기지 않아 화면에서 고른 제조사가 저장되지 않았고,
-- 그 결과 많은 품목이 brand_id = NULL로 남았다. items는 anon 키로 SELECT만 허용되므로
-- 관리자 전용 SECURITY DEFINER RPC로 바꾼다(rpc_set_items_active와 같은 방식).
--   1) rpc_list_item_catalog: 제조사(brandId, brand) 필드 추가 — 본문은 20261013120000과 같고 두 필드만 더한다.
--   2) rpc_set_items_brand: 선택 품목의 제조사 일괄 지정 (NULL이면 미지정으로 되돌림)
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
      'holdCount', COALESCE(hd.cnt, 0),
      'brandId', i.brand_id,
      'brand', b.name
    ) ORDER BY i.item_name, i.color, i.box_packaging_qty)
    FROM public.items i
    LEFT JOIN public.brands b ON b.id = i.brand_id
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

-- 2) 제조사 일괄 지정 (관리자 전용)
--    p_brand_id가 NULL이면 "미지정"으로 되돌린다. 이미 같은 제조사인 품목은 건너뛴다.
CREATE OR REPLACE FUNCTION public.rpc_set_items_brand(
  p_item_ids UUID[],
  p_brand_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_member public.app_members%ROWTYPE;
  v_item public.items%ROWTYPE;
  v_brand_name TEXT;
  v_old_name TEXT;
  v_changed INT := 0;
  v_unchanged INT := 0;
BEGIN
  v_member := public.fn_require_admin();

  IF p_item_ids IS NULL OR cardinality(p_item_ids) = 0 THEN
    RAISE EXCEPTION '대상 품목을 선택하세요.';
  END IF;
  IF cardinality(p_item_ids) > 1000 THEN
    RAISE EXCEPTION '한 번에 1000개까지만 처리할 수 있습니다.';
  END IF;

  IF p_brand_id IS NOT NULL THEN
    SELECT name INTO v_brand_name FROM public.brands WHERE id = p_brand_id AND COALESCE(is_active, TRUE);
    IF NOT FOUND THEN
      RAISE EXCEPTION '제조사를 찾을 수 없습니다(삭제되었거나 비활성).';
    END IF;
  END IF;

  -- id 순서로 잠가 동시 처리 간 교착을 방지한다.
  FOR v_item IN
    SELECT * FROM public.items
    WHERE id = ANY (p_item_ids)
    ORDER BY id
    FOR UPDATE
  LOOP
    IF v_item.brand_id IS NOT DISTINCT FROM p_brand_id THEN
      v_unchanged := v_unchanged + 1;
      CONTINUE;
    END IF;

    SELECT name INTO v_old_name FROM public.brands WHERE id = v_item.brand_id;

    UPDATE public.items SET brand_id = p_brand_id WHERE id = v_item.id;

    INSERT INTO public.item_change_log (
      item_id, item_name, color, field, old_value, new_value, changed_by
    ) VALUES (
      v_item.id, v_item.item_name, COALESCE(v_item.color, 'SURTIDO'), 'brand',
      v_old_name, v_brand_name, v_member.member_name
    );

    v_changed := v_changed + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', TRUE,
    'brandId', p_brand_id,
    'brand', v_brand_name,
    'changed', v_changed,
    'unchanged', v_unchanged
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_set_items_brand(UUID[], UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_set_items_brand(UUID[], UUID) TO anon, authenticated, service_role;
