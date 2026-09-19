-- ==============================================================================
-- 전 창고(메인 + 8대 서브창고) 재고 정합성 검사
--  * view_stock_tx_effects : 거래 1건이 각 창고 재고에 준 영향(개수 단위)을 행으로 펼친 뷰
--  * stock_baselines       : 창고·품목별 기준(기초) 재고와 기준 시각
--                            — 시트 이관·수동 수정처럼 거래 기록이 없는 과거분을 확정해 두는 용도
--  * rpc_set_stock_baseline: 현재 재고를 기준으로 확정 (관리자)
--  * rpc_verify_stock_integrity : 기준재고 + 기준시각 이후 거래 = 현재고 대조 + 음수 재고 +
--                                 유령 보류(재고보다 많은 진행 중 발주) 검사. 집계는 모두 서버에서 한다.
-- ==============================================================================

-- 1) 거래 → 창고별 영향 (개수 단위) --------------------------------------------------
CREATE OR REPLACE VIEW public.view_stock_tx_effects
WITH (security_invoker = true)
AS
WITH tx AS (
  SELECT
    t.id,
    t.created_at,
    t.item_id,
    UPPER(TRIM(COALESCE(t.transaction_type, ''))) AS tx_type,
    UPPER(COALESCE(NULLIF(TRIM(t.warehouse_code), ''), 'MAIN')) AS wh,
    UPPER(NULLIF(TRIM(COALESCE(t.source_warehouse, '')), '')) AS src,
    UPPER(NULLIF(TRIM(COALESCE(t.target_warehouse, '')), '')) AS dst,
    COALESCE(t.box_qty, 0) AS box_qty,
    public.fn_stock_units(t.box_qty, t.unit_qty, public.fn_item_pack_qty(t.item_id)) AS units
  FROM public.stock_transactions t
)
-- 입고: 도착 창고 증가
SELECT id, created_at, item_id, COALESCE(dst, wh) AS warehouse_code, tx_type, units, box_qty AS boxes
FROM tx WHERE tx_type IN ('INBOUND', '재고추가')
UNION ALL
-- 서브창고발 입고 확정: 출발 서브창고 차감 (source_warehouse가 기록된 입고)
SELECT id, created_at, item_id, src, tx_type, -units, -box_qty
FROM tx WHERE tx_type IN ('INBOUND', '재고추가') AND src IS NOT NULL AND src <> COALESCE(dst, wh)
UNION ALL
-- 출고: 출발 창고 차감
SELECT id, created_at, item_id, COALESCE(src, wh), tx_type, -units, -box_qty
FROM tx WHERE tx_type = 'OUTBOUND'
UNION ALL
-- 이동: 출발 차감 / 도착 증가
SELECT id, created_at, item_id, COALESCE(src, wh), tx_type, -units, -box_qty
FROM tx WHERE tx_type = 'MOVE'
UNION ALL
SELECT id, created_at, item_id, dst, tx_type, units, box_qty
FROM tx WHERE tx_type = 'MOVE' AND dst IS NOT NULL
UNION ALL
-- 재고조정: 부호 있는 증감
SELECT id, created_at, item_id, wh, tx_type, units, box_qty
FROM tx WHERE tx_type = 'ADJUST';

COMMENT ON VIEW public.view_stock_tx_effects IS '거래 1건이 각 창고 재고에 준 영향(개수 단위). 정합성 검사·원장 계산용';
GRANT SELECT ON public.view_stock_tx_effects TO anon, authenticated, service_role;

-- 2) 창고·품목별 기준(기초) 재고 -----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stock_baselines (
  item_id UUID NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
  warehouse_code TEXT NOT NULL REFERENCES public.warehouses(code) ON DELETE CASCADE,
  box_qty INTEGER NOT NULL DEFAULT 0,
  unit_qty INTEGER NOT NULL DEFAULT 0,
  as_of TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  memo TEXT,
  created_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (item_id, warehouse_code)
);

ALTER TABLE public.stock_baselines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "stock_baselines_select" ON public.stock_baselines;
CREATE POLICY "stock_baselines_select"
  ON public.stock_baselines FOR SELECT TO anon, authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE ON public.stock_baselines FROM anon, authenticated;

-- 현재 재고를 기준으로 확정한다. p_warehouse가 NULL이면 전 창고.
CREATE OR REPLACE FUNCTION public.rpc_set_stock_baseline(p_warehouse TEXT DEFAULT NULL, p_memo TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_member public.app_members%ROWTYPE;
  v_wh TEXT := NULLIF(UPPER(TRIM(COALESCE(p_warehouse, ''))), '');
  v_now TIMESTAMPTZ := NOW();
  v_count INT;
BEGIN
  v_member := public.fn_require_admin();

  -- 스냅샷을 찍는 동안 재고 쓰기를 막는다. 커밋 직전이던 거래가 기준 시각 이후로 밀려
  -- 영구 오차로 남는 것을 방지한다 (조회는 계속 가능).
  LOCK TABLE public.inventory_stocks IN EXCLUSIVE MODE;

  INSERT INTO public.stock_baselines (item_id, warehouse_code, box_qty, unit_qty, as_of, memo, created_by, updated_at)
  SELECT s.item_id, s.warehouse_code, s.box_qty, s.unit_qty, v_now,
         COALESCE(p_memo, '현재 재고 기준 확정'), v_member.member_name, v_now
  FROM public.inventory_stocks s
  WHERE v_wh IS NULL OR s.warehouse_code = v_wh
  ON CONFLICT (item_id, warehouse_code) DO UPDATE
  SET box_qty = EXCLUDED.box_qty,
      unit_qty = EXCLUDED.unit_qty,
      as_of = EXCLUDED.as_of,
      memo = EXCLUDED.memo,
      created_by = EXCLUDED.created_by,
      updated_at = EXCLUDED.updated_at;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('success', true, 'count', v_count, 'warehouse', COALESCE(v_wh, 'ALL'), 'as_of', v_now);
END;
$$;

-- 3) 전 창고 정합성 검사 -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_verify_stock_integrity(p_warehouse TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path TO public
AS $$
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
      COALESCE(
        public.fn_stock_units(b.box_qty, b.unit_qty, st.pack),
        CASE WHEN st.warehouse_code = 'MAIN'
          THEN public.fn_stock_units(
                 ROUND(COALESCE(it.initial_stock_boxes, 0))::INT,
                 ROUND(COALESCE(it.initial_stock_units, 0))::INT,
                 st.pack)
          ELSE 0 END,
        0
      ) AS base_units,
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
$$;

GRANT EXECUTE ON FUNCTION public.rpc_verify_stock_integrity(TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_set_stock_baseline(TEXT, TEXT) TO anon, authenticated, service_role;
