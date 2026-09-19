-- ==============================================================================
-- 4단계 패치: 브라우저로 stock_transactions 전체를 내려받던 집계를 서버 GROUP BY로 이전
--  * rpc_main_stock_movement_summary: 품목별 MAIN 창고 순증감(개수 단위) — 정합성 검사용
--    창고 방향을 정확히 반영: 서브창고 출고/조정은 제외, 서브창고→MAIN 이동은 입고로 계산
--  * rpc_outbound_daily_boxes: 품목·일자별 출고 상자 합계 — 동절기 피크/안전재고 분석용
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.rpc_main_stock_movement_summary()
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path TO public
AS $$
  WITH tx AS (
    SELECT
      t.item_id,
      t.transaction_type AS tx_type,
      UPPER(COALESCE(NULLIF(TRIM(t.warehouse_code), ''), 'MAIN')) AS wh,
      UPPER(NULLIF(TRIM(COALESCE(t.source_warehouse, '')), '')) AS src,
      UPPER(NULLIF(TRIM(COALESCE(t.target_warehouse, '')), '')) AS dst,
      COALESCE(t.box_qty, 0) AS box_qty,
      public.fn_stock_units(t.box_qty, t.unit_qty, public.fn_item_pack_qty(t.item_id)) AS units
    FROM public.stock_transactions t
  ),
  eff AS (
    SELECT
      item_id,
      CASE
        WHEN tx_type IN ('INBOUND', '재고추가') AND COALESCE(dst, wh) = 'MAIN' THEN units
        WHEN tx_type = 'MOVE' AND dst = 'MAIN' AND COALESCE(src, wh) <> 'MAIN' THEN units
        ELSE 0
      END AS in_units,
      CASE
        WHEN tx_type IN ('INBOUND', '재고추가') AND COALESCE(dst, wh) = 'MAIN' THEN box_qty
        WHEN tx_type = 'MOVE' AND dst = 'MAIN' AND COALESCE(src, wh) <> 'MAIN' THEN box_qty
        ELSE 0
      END AS in_boxes,
      CASE
        WHEN tx_type = 'OUTBOUND' AND COALESCE(src, wh) = 'MAIN' THEN units
        WHEN tx_type = 'MOVE' AND COALESCE(src, wh) = 'MAIN' AND COALESCE(dst, '') <> 'MAIN' THEN units
        ELSE 0
      END AS out_units,
      CASE
        WHEN tx_type = 'OUTBOUND' AND COALESCE(src, wh) = 'MAIN' THEN box_qty
        WHEN tx_type = 'MOVE' AND COALESCE(src, wh) = 'MAIN' AND COALESCE(dst, '') <> 'MAIN' THEN box_qty
        ELSE 0
      END AS out_boxes,
      CASE WHEN tx_type = 'ADJUST' AND wh = 'MAIN' THEN units ELSE 0 END AS adj_units,
      CASE WHEN tx_type = 'ADJUST' AND wh = 'MAIN' THEN 1 ELSE 0 END AS adj_count
    FROM tx
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'item_id', item_id,
    'in_units', in_units,
    'in_boxes', in_boxes,
    'out_units', out_units,
    'out_boxes', out_boxes,
    'adj_units', adj_units,
    'adj_count', adj_count
  )), '[]'::jsonb)
  FROM (
    SELECT
      item_id,
      SUM(in_units) AS in_units,
      SUM(in_boxes) AS in_boxes,
      SUM(out_units) AS out_units,
      SUM(out_boxes) AS out_boxes,
      SUM(adj_units) AS adj_units,
      SUM(adj_count) AS adj_count
    FROM eff
    GROUP BY item_id
  ) g;
$$;

CREATE OR REPLACE FUNCTION public.rpc_outbound_daily_boxes()
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path TO public
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'item_id', item_id,
    'day', to_char(d, 'YYYY-MM-DD'),
    'boxes', boxes,
    'tx_count', tx_count
  )), '[]'::jsonb)
  FROM (
    SELECT
      item_id,
      (created_at AT TIME ZONE 'America/Mexico_City')::date AS d,
      SUM(ABS(box_qty)) AS boxes,
      COUNT(*) AS tx_count
    FROM public.stock_transactions
    WHERE transaction_type IN ('OUTBOUND', 'MOVE')
      AND box_qty <> 0
    GROUP BY item_id, (created_at AT TIME ZONE 'America/Mexico_City')::date
  ) g;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_main_stock_movement_summary() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_outbound_daily_boxes() TO anon, authenticated, service_role;
