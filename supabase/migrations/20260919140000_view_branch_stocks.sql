-- ==============================================================================
-- 외부(서브)창고 재고 조회용 뷰: inventory_stocks에 품명·창고명을 붙여 Table Editor에서 바로 보이게 한다.
--  * MAIN(허브) 제외, 비활성 품목 포함 (is_active 컬럼으로 구분)
--  * committed_boxes: 그 창고에서 MAIN으로 가는 진행 중 발주(PENDING/IN_TRANSIT) 상자 수
--  * available_boxes: 앱의 서브창고 매트릭스와 같은 기준 (실재고 − 발주진행, 0 미만은 0)
--  * security_invoker: 조회자 권한·RLS로 동작 (Supabase의 UNRESTRICTED 경고 대상 아님)
-- ==============================================================================

CREATE OR REPLACE VIEW public.view_branch_stocks
WITH (security_invoker = true)
AS
WITH committed AS (
  SELECT
    UPPER(TRIM(from_warehouse)) AS warehouse_code,
    item_id,
    SUM(box_qty) AS committed_boxes
  FROM public.pending_orders
  WHERE to_warehouse = 'MAIN'
    AND status IN ('PENDING', 'IN_TRANSIT')
  GROUP BY UPPER(TRIM(from_warehouse)), item_id
)
SELECT
  s.warehouse_code,
  w.name AS warehouse_name,
  w.sort_order AS warehouse_sort_order,
  s.item_id,
  i.item_name,
  i.color,
  i.box_packaging_qty,
  s.box_qty,
  s.unit_qty,
  public.fn_stock_units(s.box_qty, s.unit_qty, public.fn_item_pack_qty(s.item_id)) AS total_units,
  COALESCE(c.committed_boxes, 0) AS committed_boxes,
  GREATEST(s.box_qty - COALESCE(c.committed_boxes, 0), 0) AS available_boxes,
  COALESCE(i.is_active, TRUE) AS is_active,
  s.updated_at
FROM public.inventory_stocks s
JOIN public.items i ON i.id = s.item_id
JOIN public.warehouses w ON w.code = s.warehouse_code
LEFT JOIN committed c ON c.warehouse_code = s.warehouse_code AND c.item_id = s.item_id
WHERE COALESCE(w.is_hub, FALSE) = FALSE
  AND s.warehouse_code <> 'MAIN';

COMMENT ON VIEW public.view_branch_stocks IS '외부(서브)창고 품목별 재고 (품명·창고명 포함, 발주진행/가용 상자 수)';

GRANT SELECT ON public.view_branch_stocks TO anon, authenticated, service_role;
