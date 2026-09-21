-- ==============================================================================
-- 🚀 안전재고 낱개(개) ➔ 상자(Box) 단위 일괄 변환 및 정규화
--  * 과거 구글 시트 원장(E열)에서 낱개 단위(예: 300개, 420개, 499개, 610개 등)로
--    기록되어 상자 컬럼(safe_stock_boxes)으로 잘못 이관된 품목들을
--    올바른 상자(Box) 단위(Math.ceil(수치 / 박스당수량))로 일괄 정상화합니다.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.rpc_normalize_safe_stock_units()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_updated_count INT := 0;
  v_details JSONB := '[]'::JSONB;
  v_row RECORD;
  v_new_box INT;
BEGIN
  -- 대상: 메인 창고 재고 중,
  -- 1) 안전재고가 박스당 포장수량 이상이거나,
  -- 2) 안전재고가 50 이상이면서 박스당 포장수량이 1보다 큰 품목
  -- (단, 사용자 요청에 따라 실제 피크 상자 출고 품목인 LIGA1204는 보존)
  FOR v_row IN
    SELECT 
      s.id AS stock_row_id,
      s.item_id,
      i.item_name,
      i.color,
      i.box_packaging_qty,
      s.safe_stock_boxes,
      s.warehouse_code
    FROM public.inventory_stocks s
    JOIN public.items i ON s.item_id = i.id
    WHERE s.warehouse_code = 'MAIN'
      AND s.safe_stock_boxes > 0
      AND i.item_name <> 'LIGA1204'
      AND (
        s.safe_stock_boxes >= i.box_packaging_qty
        OR (s.safe_stock_boxes >= 50 AND i.box_packaging_qty > 1)
      )
  LOOP
    -- 포장수량 기준 올림(CEIL)하여 최소 1상자 이상으로 환산
    v_new_box := GREATEST(1, CEIL(v_row.safe_stock_boxes::NUMERIC / NULLIF(v_row.box_packaging_qty, 0)::NUMERIC)::INT);

    UPDATE public.inventory_stocks
    SET safe_stock_boxes = v_new_box,
        updated_at = NOW()
    WHERE id = v_row.stock_row_id;

    v_updated_count := v_updated_count + 1;
    v_details := v_details || jsonb_build_array(jsonb_build_object(
      'item_name', v_row.item_name,
      'color', v_row.color,
      'pkg', v_row.box_packaging_qty,
      'old_safe_stock', v_row.safe_stock_boxes,
      'new_safe_stock', v_new_box
    ));
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'updated_count', v_updated_count,
    'details', v_details
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_normalize_safe_stock_units() TO anon, authenticated, service_role;

-- 1회성 정규화 즉각 실행
SELECT public.rpc_normalize_safe_stock_units();
