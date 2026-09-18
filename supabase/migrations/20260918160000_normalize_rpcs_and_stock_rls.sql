-- ==============================================================================
-- 재고/색상 정규화 RPC, 입고 시 품목 보장 RPC, 재고 테이블 직접 쓰기 차단
-- ==============================================================================

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
  v_out JSONB := '[]'::JSONB;
BEGIN
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RETURN v_out;
  END IF;

  FOR v_row IN SELECT * FROM jsonb_to_recordset(p_items) AS x(
    item_name TEXT,
    color TEXT,
    box_packaging_qty NUMERIC
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
    WHERE item_name = v_name
      AND color = v_color
      AND box_packaging_qty = v_pkg
    LIMIT 1;

    IF v_id IS NULL THEN
      INSERT INTO public.items (item_name, color, box_packaging_qty, is_grid_item, is_active)
      VALUES (v_name, v_color, v_pkg, FALSE, TRUE)
      RETURNING id INTO v_id;

      INSERT INTO public.inventory_stocks (item_id, warehouse_code, box_qty, unit_qty)
      VALUES (v_id, 'MAIN', 0, 0)
      ON CONFLICT (item_id, warehouse_code) DO NOTHING;
    END IF;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'item_id', v_id,
      'item_name', v_name,
      'color', v_color,
      'box_packaging_qty', v_pkg
    ));
  END LOOP;

  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_execute_stock_normalization(p_groups JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_group RECORD;
  v_canonical UUID;
  v_name TEXT;
  v_color TEXT;
  v_pkg NUMERIC;
  v_ids UUID[];
  v_secondary UUID[];
  v_wh TEXT;
  v_total NUMERIC;
  v_merged_box INTEGER;
  v_merged_unit INTEGER;
  v_merged_groups INTEGER := 0;
  v_merged_items INTEGER := 0;
BEGIN
  IF p_groups IS NULL OR jsonb_array_length(p_groups) = 0 THEN
    RETURN jsonb_build_object('success', true, 'merged_groups', 0, 'merged_items', 0);
  END IF;

  FOR v_group IN SELECT * FROM jsonb_to_recordset(p_groups) AS x(
    canonical_item_id UUID,
    canonical_name TEXT,
    color TEXT,
    box_packaging_qty NUMERIC,
    members JSONB
  )
  LOOP
    v_canonical := v_group.canonical_item_id;
    v_name := TRIM(COALESCE(v_group.canonical_name, ''));
    v_color := TRIM(COALESCE(v_group.color, 'SURTIDO'));
    v_pkg := COALESCE(v_group.box_packaging_qty, 1);
    IF v_canonical IS NULL OR v_name = '' OR v_group.members IS NULL THEN
      CONTINUE;
    END IF;

    v_ids := ARRAY(
      SELECT DISTINCT (m.item_id)::UUID
      FROM jsonb_to_recordset(v_group.members) AS m(item_id UUID, box_content NUMERIC)
      WHERE m.item_id IS NOT NULL
    );
    IF COALESCE(array_length(v_ids, 1), 0) <= 1 THEN
      CONTINUE;
    END IF;
    IF NOT (v_canonical = ANY (v_ids)) THEN
      CONTINUE;
    END IF;

    v_secondary := ARRAY(
      SELECT unnest(v_ids) EXCEPT SELECT v_canonical
    );

    PERFORM 1
    FROM public.items
    WHERE id = ANY (v_ids)
    FOR UPDATE;

    PERFORM 1
    FROM public.inventory_stocks
    WHERE item_id = ANY (v_ids)
    FOR UPDATE;

    IF COALESCE(array_length(v_secondary, 1), 0) > 0 THEN
      UPDATE public.items
      SET item_name = item_name || ' [MERGED ' || id::TEXT || ']',
          is_active = FALSE
      WHERE id = ANY (v_secondary);
    END IF;

    UPDATE public.items
    SET item_name = v_name,
        color = v_color,
        box_packaging_qty = v_pkg,
        is_active = TRUE
    WHERE id = v_canonical;

    FOR v_wh, v_total IN
      SELECT s.warehouse_code,
             SUM((COALESCE(s.box_qty, 0) * COALESCE(m.box_content, 1)) + COALESCE(s.unit_qty, 0))
      FROM public.inventory_stocks s
      JOIN jsonb_to_recordset(v_group.members) AS m(item_id UUID, box_content NUMERIC)
        ON m.item_id = s.item_id
      GROUP BY s.warehouse_code
    LOOP
      v_merged_box := CASE WHEN v_pkg > 0 THEN FLOOR(v_total / v_pkg)::INTEGER ELSE 0 END;
      v_merged_unit := CASE WHEN v_pkg > 0 THEN (v_total % v_pkg)::INTEGER ELSE v_total::INTEGER END;

      INSERT INTO public.inventory_stocks (item_id, warehouse_code, box_qty, unit_qty, updated_at)
      VALUES (v_canonical, v_wh, v_merged_box, v_merged_unit, NOW())
      ON CONFLICT (item_id, warehouse_code) DO UPDATE
      SET box_qty = EXCLUDED.box_qty,
          unit_qty = EXCLUDED.unit_qty,
          updated_at = NOW();
    END LOOP;

    IF COALESCE(array_length(v_secondary, 1), 0) > 0 THEN
      UPDATE public.stock_transactions
      SET item_id = v_canonical
      WHERE item_id = ANY (v_secondary);

      UPDATE public.pending_orders
      SET item_id = v_canonical
      WHERE item_id = ANY (v_secondary);

      DELETE FROM public.inventory_stocks
      WHERE item_id = ANY (v_secondary);
    END IF;

    v_merged_groups := v_merged_groups + 1;
    v_merged_items := v_merged_items + COALESCE(array_length(v_secondary, 1), 0);
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'merged_groups', v_merged_groups,
    'merged_items', v_merged_items
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_execute_color_normalization(p_items JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_row RECORD;
  v_done INTEGER := 0;
  v_skipped INTEGER := 0;
  v_exists UUID;
BEGIN
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RETURN jsonb_build_object('success', true, 'updated', 0, 'skipped', 0);
  END IF;

  FOR v_row IN SELECT * FROM jsonb_to_recordset(p_items) AS x(
    item_id UUID,
    normalized_name TEXT,
    normalized_color TEXT,
    box_content NUMERIC
  )
  LOOP
    IF v_row.item_id IS NULL THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    SELECT id INTO v_exists
    FROM public.items
    WHERE id <> v_row.item_id
      AND item_name = TRIM(COALESCE(v_row.normalized_name, ''))
      AND color = TRIM(COALESCE(v_row.normalized_color, 'SURTIDO'))
      AND box_packaging_qty = COALESCE(v_row.box_content, 1)
    LIMIT 1;

    IF v_exists IS NOT NULL THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    BEGIN
      UPDATE public.items
      SET item_name = TRIM(COALESCE(v_row.normalized_name, item_name)),
          color = TRIM(COALESCE(v_row.normalized_color, 'SURTIDO'))
      WHERE id = v_row.item_id;
      IF FOUND THEN
        v_done := v_done + 1;
      ELSE
        v_skipped := v_skipped + 1;
      END IF;
    EXCEPTION
      WHEN unique_violation THEN
        v_skipped := v_skipped + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'updated', v_done, 'skipped', v_skipped);
END;
$$;

-- 재고 원장 직접 쓰기 차단: SELECT만 허용 (쓰기는 SECURITY DEFINER RPC)
DROP POLICY IF EXISTS "Enable all access for all users on inventory_stocks" ON public.inventory_stocks;
DROP POLICY IF EXISTS "inventory_stocks_select" ON public.inventory_stocks;
CREATE POLICY "inventory_stocks_select"
  ON public.inventory_stocks FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Enable all access for all users on stock_transactions" ON public.stock_transactions;
DROP POLICY IF EXISTS "stock_transactions_select" ON public.stock_transactions;
CREATE POLICY "stock_transactions_select"
  ON public.stock_transactions FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Enable all access for all users on pending_orders" ON public.pending_orders;
DROP POLICY IF EXISTS "pending_orders_select" ON public.pending_orders;
CREATE POLICY "pending_orders_select"
  ON public.pending_orders FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Enable all access for all users on items" ON public.items;
DROP POLICY IF EXISTS "items_select" ON public.items;
CREATE POLICY "items_select"
  ON public.items FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Enable all access for all users on invoice_sequences" ON public.invoice_sequences;
DROP POLICY IF EXISTS "invoice_sequences_no_direct_client_access" ON public.invoice_sequences;
CREATE POLICY "invoice_sequences_no_direct_client_access"
  ON public.invoice_sequences FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

GRANT EXECUTE ON FUNCTION public.rpc_ensure_items(JSONB) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_execute_stock_normalization(JSONB) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_execute_color_normalization(JSONB) TO anon, authenticated, service_role;
