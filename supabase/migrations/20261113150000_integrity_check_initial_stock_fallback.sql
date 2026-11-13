-- ==============================================================================
-- 정합성 검사(rpc_verify_stock_integrity): 기준재고가 없는 MAIN 품목의 기초재고 대체가 동작하지 않던 오류 수정
--
-- 배경(2026-11-13 전 창고 점검): 기준 재고를 COALESCE(fn_stock_units(확정본), 기초재고, 0)로 골랐는데,
--       fn_stock_units가 NULL 인자를 0으로 바꿔 돌려주므로 확정본이 없어도 0이 되어 기초재고로 넘어가지 않았다.
--       그 결과 9/19 기준 확정 이후 기초재고를 넣어 등록한 MAIN 품목 12개(GS2300, HF11, LC093 등)가
--       실제로는 '기초재고 + 거래 = 현재고'로 맞는데도 불일치로 표시됐다.
-- 조치: 확정본 행이 있는지(b.item_id IS NOT NULL)로 기준을 고른다. 나머지 본문은 운영 정의(2026-11-13) 그대로다.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.rpc_verify_stock_integrity(p_warehouse text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_wh TEXT := NULLIF(UPPER(TRIM(COALESCE(p_warehouse, ''))), '');
  v_result JSONB;
BEGIN
  WITH stock AS (
    SELECT
      s.item_id,
      s.warehouse_code,
      s.box_qty,
      s.unit_qty,
      GREATEST(1, ROUND(COALESCE(i.box_packaging_qty, 1)))::INT AS pack,
      i.item_name,
      COALESCE(i.color, 'SURTIDO') AS color,
      COALESCE(i.is_active, TRUE) AS is_active,
      w.name AS warehouse_name,
      COALESCE(w.sort_order, 0) AS sort_order
    FROM public.inventory_stocks s
    JOIN public.items i ON i.id = s.item_id
    JOIN public.warehouses w ON w.code = s.warehouse_code
    WHERE v_wh IS NULL OR s.warehouse_code = v_wh
  ),
  base AS (
    SELECT
      st.item_id,
      st.warehouse_code,
      -- 기준 재고: 확정본 > (메인창고는) 품목 기초재고 > 0
      -- fn_stock_units는 NULL을 0으로 바꾸므로 COALESCE로는 기초재고로 넘어가지 않는다 — 확정본 유무로 고른다.
      CASE
        WHEN b.item_id IS NOT NULL THEN public.fn_stock_units(b.box_qty, b.unit_qty, st.pack)
        WHEN st.warehouse_code = 'MAIN' THEN public.fn_stock_units(
               ROUND(COALESCE(it.initial_stock_boxes, 0))::INT,
               ROUND(COALESCE(it.initial_stock_units, 0))::INT,
               st.pack)
        ELSE 0
      END AS base_units,
      COALESCE(b.as_of, '-infinity'::TIMESTAMPTZ) AS as_of,
      (b.item_id IS NOT NULL) AS has_baseline
    FROM stock st
    LEFT JOIN public.stock_baselines b ON b.item_id = st.item_id AND b.warehouse_code = st.warehouse_code
    LEFT JOIN public.items it ON it.id = st.item_id
  ),
  moved AS (
    SELECT
      st.item_id,
      st.warehouse_code,
      COALESCE(SUM(e.units), 0) AS net_units,
      COALESCE(SUM(GREATEST(e.boxes, 0)), 0) AS in_boxes,
      COALESCE(SUM(GREATEST(-e.boxes, 0)), 0) AS out_boxes,
      COUNT(e.id) AS tx_count
    FROM stock st
    LEFT JOIN base bs ON bs.item_id = st.item_id AND bs.warehouse_code = st.warehouse_code
    LEFT JOIN public.view_stock_tx_effects e
      ON e.item_id = st.item_id
     AND e.warehouse_code = st.warehouse_code
     AND e.created_at > bs.as_of
    GROUP BY st.item_id, st.warehouse_code
  ),
  calc AS (
    SELECT
      st.*,
      bs.base_units,
      bs.as_of,
      bs.has_baseline,
      mv.net_units,
      mv.in_boxes,
      mv.out_boxes,
      mv.tx_count,
      public.fn_stock_units(st.box_qty, st.unit_qty, st.pack) AS current_units,
      bs.base_units + mv.net_units AS expected_units
    FROM stock st
    JOIN base bs ON bs.item_id = st.item_id AND bs.warehouse_code = st.warehouse_code
    JOIN moved mv ON mv.item_id = st.item_id AND mv.warehouse_code = st.warehouse_code
  ),
  mismatches AS (
    SELECT jsonb_build_object(
      'kind', 'MISMATCH',
      'warehouseCode', c.warehouse_code,
      'warehouseName', c.warehouse_name,
      'itemId', c.item_id,
      'name', c.item_name,
      'color', c.color,
      'boxContent', c.pack,
      'currentBox', c.box_qty,
      'currentIndividual', c.unit_qty,
      'currentTotal', c.current_units,
      'baselineTotal', c.base_units,
      'hasBaseline', c.has_baseline,
      'baselineAsOf', CASE WHEN c.has_baseline THEN c.as_of ELSE NULL END,
      'expectedTotal', c.expected_units,
      'diffTotal', c.current_units - c.expected_units,
      'diffBoxes', ((c.current_units - c.expected_units) / c.pack)::INT,
      'diffIndividuals', ((c.current_units - c.expected_units) % c.pack)::INT,
      'txCount', c.tx_count,
      'inSummary', '입고 ' || c.in_boxes || '상자',
      'outSummary', '출고 ' || c.out_boxes || '상자'
    ) AS j, c.sort_order, c.item_name
    FROM calc c
    WHERE c.current_units <> c.expected_units
  ),
  negatives AS (
    SELECT jsonb_build_object(
      'kind', 'NEGATIVE',
      'warehouseCode', c.warehouse_code,
      'warehouseName', c.warehouse_name,
      'itemId', c.item_id,
      'name', c.item_name,
      'color', c.color,
      'boxContent', c.pack,
      'currentBox', c.box_qty,
      'currentIndividual', c.unit_qty,
      'currentTotal', c.current_units
    ) AS j, c.sort_order, c.item_name
    FROM calc c
    WHERE c.box_qty < 0 OR c.unit_qty < 0
  ),
  orphans AS (
    SELECT jsonb_build_object(
      'kind', 'ORPHAN_PENDING',
      'warehouseCode', p.from_warehouse,
      'warehouseName', w.name,
      'itemId', p.item_id,
      'name', i.item_name,
      'color', COALESCE(i.color, 'SURTIDO'),
      'currentBox', COALESCE(s.box_qty, 0),
      'pendingBoxes', SUM(p.box_qty),
      'orderCount', COUNT(*),
      'overBoxes', SUM(p.box_qty) - COALESCE(s.box_qty, 0)
    ) AS j, COALESCE(w.sort_order, 0) AS sort_order, i.item_name
    FROM public.pending_orders p
    JOIN public.items i ON i.id = p.item_id
    LEFT JOIN public.warehouses w ON w.code = p.from_warehouse
    LEFT JOIN public.inventory_stocks s ON s.item_id = p.item_id AND s.warehouse_code = p.from_warehouse
    WHERE p.status IN ('PENDING', 'IN_TRANSIT')
      AND p.to_warehouse = 'MAIN'
      AND (v_wh IS NULL OR p.from_warehouse = v_wh)
    GROUP BY p.from_warehouse, w.name, w.sort_order, p.item_id, i.item_name, i.color, s.box_qty
    HAVING SUM(p.box_qty) > COALESCE(s.box_qty, 0)
  ),
  per_warehouse AS (
    SELECT jsonb_build_object(
      'warehouseCode', c.warehouse_code,
      'warehouseName', MIN(c.warehouse_name),
      'checkedCount', COUNT(*),
      'baselineCount', COUNT(*) FILTER (WHERE c.has_baseline),
      'discrepancyCount', COUNT(*) FILTER (WHERE c.current_units <> c.expected_units),
      'negativeCount', COUNT(*) FILTER (WHERE c.box_qty < 0 OR c.unit_qty < 0),
      'baselineAsOf', MAX(c.as_of) FILTER (WHERE c.has_baseline)
    ) AS j, MIN(c.sort_order) AS sort_order
    FROM calc c
    GROUP BY c.warehouse_code
  )
  SELECT jsonb_build_object(
    'success', true,
    'warehouse', COALESCE(v_wh, 'ALL'),
    'checkedCount', (SELECT COUNT(*) FROM calc),
    'discrepancyCount', (SELECT COUNT(*) FROM mismatches),
    'negativeCount', (SELECT COUNT(*) FROM negatives),
    'orphanPendingCount', (SELECT COUNT(*) FROM orphans),
    'baselineCount', (SELECT COUNT(*) FROM calc WHERE has_baseline),
    'discrepancies', COALESCE((SELECT jsonb_agg(j ORDER BY sort_order, item_name) FROM mismatches), '[]'::JSONB),
    'negativeStocks', COALESCE((SELECT jsonb_agg(j ORDER BY sort_order, item_name) FROM negatives), '[]'::JSONB),
    'orphanPendings', COALESCE((SELECT jsonb_agg(j ORDER BY sort_order, item_name) FROM orphans), '[]'::JSONB),
    'warehouses', COALESCE((SELECT jsonb_agg(j ORDER BY sort_order) FROM per_warehouse), '[]'::JSONB)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;
