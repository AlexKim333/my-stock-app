-- 창고별 재고 화면의 수량 직접 수정 = 퀵 재고조정(치환)과 같은 ADJUST 전표로 남긴다.
--
-- 기존 rpc_adjust_stock에 두 가지 검사를 더한 단건 전용 RPC:
--   1) 화면을 연 뒤 재고가 바뀌었으면 거절한다(조회 시점 수량 p_expected_*와 현재 수량 비교).
--      스냅샷 화면에서 "12상자로 치환"하는 사이에 들어온 출고가 조용히 되살아나는 것을 막는다.
--   2) 출고 보류(+ 서브창고는 MAIN 입고 예정 발주)보다 적게는 조정할 수 없다.
--      보류 물건도 같은 선반에 보관하므로 입력값은 실재고(센 수량)이고, 예약분 아래로 내려가면
--      보류·발주가 실재고 없이 남게 된다. 먼저 보류·발주를 줄이도록 안내한다.
-- 실제 반영과 전표 기록은 rpc_adjust_stock_apply(치환 모드)를 그대로 쓴다.

CREATE OR REPLACE FUNCTION public.rpc_adjust_stock_checked(
  p_item_id UUID,
  p_warehouse TEXT,
  p_expected_box INT,
  p_expected_unit INT,
  p_target_box INT,
  p_target_unit INT,
  p_reason TEXT DEFAULT NULL,
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
  v_wh TEXT := UPPER(TRIM(COALESCE(NULLIF(TRIM(p_warehouse), ''), 'MAIN')));
  v_pack INT;
  v_box INT;
  v_unit INT;
  v_target BIGINT;
  v_held BIGINT;
  v_committed BIGINT := 0;
  v_reserved BIGINT;
  v_label TEXT;
BEGIN
  v_member := public.fn_require_admin();
  v_cached := public.fn_idempotency_lock(p_idempotency_key);
  IF v_cached IS NOT NULL THEN
    RETURN v_cached || jsonb_build_object('idempotent_replay', true);
  END IF;

  IF p_item_id IS NULL THEN
    RAISE EXCEPTION '품목이 지정되지 않았습니다.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.warehouses WHERE code = v_wh) THEN
    RAISE EXCEPTION '창고를 찾을 수 없습니다: %', v_wh;
  END IF;
  IF COALESCE(p_target_box, 0) < 0 OR COALESCE(p_target_unit, 0) < 0 THEN
    RAISE EXCEPTION '재고 수량에는 음수를 입력할 수 없습니다.';
  END IF;

  SELECT item_name || ' (' || COALESCE(color, 'SURTIDO') || ')' INTO v_label
  FROM public.items WHERE id = p_item_id;
  IF v_label IS NULL THEN
    RAISE EXCEPTION '품목을 찾을 수 없습니다.';
  END IF;

  v_pack := public.fn_item_pack_qty(p_item_id);
  PERFORM public.fn_ensure_stock_row(p_item_id, v_wh);

  -- 보류 저장·발주 등록·출고와 같은 행을 잠가 검사와 반영 사이에 끼어들지 못하게 한다.
  SELECT box_qty, unit_qty INTO v_box, v_unit
  FROM public.inventory_stocks
  WHERE item_id = p_item_id AND warehouse_code = v_wh
  FOR UPDATE;

  IF public.fn_stock_units(COALESCE(v_box, 0), COALESCE(v_unit, 0), v_pack)
     <> public.fn_stock_units(COALESCE(p_expected_box, 0), COALESCE(p_expected_unit, 0), v_pack) THEN
    RAISE EXCEPTION '화면을 연 뒤 % 창고 % 재고가 바뀌었습니다(화면 %상자 %개 → 현재 %상자 %개). 새로고침한 뒤 다시 수정하세요.',
      v_wh, v_label, COALESCE(p_expected_box, 0), COALESCE(p_expected_unit, 0), COALESCE(v_box, 0), COALESCE(v_unit, 0);
  END IF;

  v_target := public.fn_stock_units(COALESCE(p_target_box, 0), COALESCE(p_target_unit, 0), v_pack);
  v_held := public.fn_outbound_held_units(p_item_id, v_wh);
  IF v_wh <> 'MAIN' THEN
    SELECT COALESCE(SUM(public.fn_stock_units(box_qty, unit_qty, v_pack)), 0) INTO v_committed
    FROM public.pending_orders
    WHERE item_id = p_item_id
      AND from_warehouse = v_wh
      AND to_warehouse = 'MAIN'
      AND status IN ('PENDING', 'IN_TRANSIT');
  END IF;
  v_reserved := v_held + v_committed;

  IF v_target < v_reserved THEN
    RAISE EXCEPTION '% 창고 % 재고를 %상자 %개로 줄일 수 없습니다: %이(가) %상자 %개 걸려 있습니다. 먼저 %.',
      v_wh, v_label, v_target / v_pack, v_target % v_pack,
      CASE WHEN v_held > 0 AND v_committed > 0 THEN '출고 보류·MAIN 입고 예정 발주'
           WHEN v_committed > 0 THEN 'MAIN 입고 예정 발주'
           ELSE '출고 보류' END,
      v_reserved / v_pack, v_reserved % v_pack,
      CASE WHEN v_held > 0 AND v_committed > 0 THEN '출고 보류와 발주를 줄이거나 취소하세요'
           WHEN v_committed > 0 THEN '발주를 줄이거나 취소하세요'
           ELSE '출고 보류를 줄이거나 삭제하세요' END;
  END IF;

  v_result := public.rpc_adjust_stock_apply(
    COALESCE(NULLIF(TRIM(v_member.member_name), ''), 'ADMIN'),
    jsonb_build_array(jsonb_build_object(
      'item_id', p_item_id,
      'adj_mode', 'replace',
      'box_qty', COALESCE(p_target_box, 0),
      'unit_qty', COALESCE(p_target_unit, 0),
      'reason', NULL
    )),
    v_wh,
    NULL,
    -- 사유를 앞에 둔다(스모크 정리 스크립트가 '스모크테스트' 접두어로 테스트 전표를 찾는다).
    format('%s [치환·재고현황] %s상자/%s개 → %s상자/%s개',
      COALESCE(NULLIF(TRIM(COALESCE(p_reason, '')), ''), '창고별 재고 화면 수정'),
      COALESCE(v_box, 0), COALESCE(v_unit, 0), v_target / v_pack, v_target % v_pack)
  );

  SELECT box_qty, unit_qty INTO v_box, v_unit
  FROM public.inventory_stocks
  WHERE item_id = p_item_id AND warehouse_code = v_wh;

  v_result := v_result || jsonb_build_object(
    'warehouse', v_wh,
    'item_id', p_item_id,
    'box_qty', v_box,
    'unit_qty', v_unit
  );
  PERFORM public.fn_idempotency_store(p_idempotency_key, v_result);
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.rpc_adjust_stock_checked(UUID, TEXT, INT, INT, INT, INT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_adjust_stock_checked(UUID, TEXT, INT, INT, INT, INT, TEXT, TEXT) TO anon, authenticated, service_role;
