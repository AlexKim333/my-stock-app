-- ==============================================================================
-- 로그인 RPC, 유효재고 목록 RPC, 출고예약 RPC, 상품등록 RPC, app_members 해시 차단
-- ==============================================================================

CREATE OR REPLACE VIEW public.app_members_public
AS
SELECT
  id,
  member_name,
  branch_name,
  access_level,
  preferred_language,
  is_active,
  created_at
FROM public.app_members;

GRANT SELECT ON public.app_members_public TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "Enable all access for all users on app_members" ON public.app_members;
CREATE POLICY "app_members_no_direct_client_access"
  ON public.app_members
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.rpc_login(p_member_name TEXT, p_password TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_row public.app_members%ROWTYPE;
BEGIN
  SELECT * INTO v_row
  FROM public.app_members
  WHERE member_name = TRIM(COALESCE(p_member_name, ''))
    AND COALESCE(is_active, TRUE) = TRUE
  LIMIT 1;

  IF NOT FOUND OR v_row.password_hash IS DISTINCT FROM p_password THEN
    RETURN jsonb_build_object('success', false);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'user', jsonb_build_object(
      'id', v_row.id,
      'member_name', v_row.member_name,
      'branch_name', v_row.branch_name,
      'access_level', v_row.access_level,
      'preferred_language', v_row.preferred_language
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_list_effective_stocks()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public
AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'item_id', v.item_id,
        'item_name', v.item_name,
        'color', COALESCE(v.color, 'SURTIDO'),
        'barcode', COALESCE(v.barcode, ''),
        'box_packaging_qty', COALESCE(v.box_packaging_qty, 1),
        'main_box_qty', COALESCE(v.main_box_qty, 0),
        'main_unit_qty', COALESCE(v.main_unit_qty, 0),
        'effective_box_qty', COALESCE(v.effective_box_qty, 0),
        'safe_stock_boxes', COALESCE(v.safe_stock_boxes, 0),
        'pending_in_boxes', COALESCE(v.pending_in_boxes, 0),
        'pending_out_boxes', COALESCE(v.pending_out_boxes, 0)
      )
      ORDER BY v.item_name, v.color
    ),
    '[]'::jsonb
  )
  FROM public.view_effective_stocks v
  JOIN public.items i ON i.id = v.item_id
  WHERE COALESCE(i.is_active, TRUE) = TRUE;
$$;

CREATE OR REPLACE FUNCTION public.rpc_register_item(
  p_item_name TEXT,
  p_color TEXT DEFAULT 'SURTIDO',
  p_box_packaging_qty NUMERIC DEFAULT 1,
  p_barcode TEXT DEFAULT NULL,
  p_brand_id UUID DEFAULT NULL,
  p_initial_boxes INTEGER DEFAULT 0,
  p_initial_units INTEGER DEFAULT 0,
  p_safe_stock INTEGER DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_id UUID;
  v_name TEXT := TRIM(COALESCE(p_item_name, ''));
  v_color TEXT := TRIM(COALESCE(p_color, 'SURTIDO'));
  v_pkg NUMERIC := COALESCE(p_box_packaging_qty, 1);
  v_boxes INTEGER := GREATEST(COALESCE(p_initial_boxes, 0), 0);
  v_units INTEGER := GREATEST(COALESCE(p_initial_units, 0), 0);
  v_safe INTEGER := GREATEST(COALESCE(p_safe_stock, 0), 0);
BEGIN
  IF v_name = '' OR v_pkg < 1 THEN
    RAISE EXCEPTION '품명과 박스당 수량(1 이상)은 필수입니다.';
  END IF;

  INSERT INTO public.items (
    item_name, color, box_packaging_qty, barcode, brand_id,
    initial_stock_boxes, initial_stock_units, is_grid_item, is_active
  ) VALUES (
    v_name, v_color, v_pkg, NULLIF(TRIM(COALESCE(p_barcode, '')), ''), p_brand_id,
    v_boxes, v_units, FALSE, TRUE
  )
  RETURNING id INTO v_id;

  INSERT INTO public.inventory_stocks (item_id, warehouse_code, box_qty, unit_qty, safe_stock_boxes)
  VALUES (v_id, 'MAIN', v_boxes, v_units, v_safe)
  ON CONFLICT (item_id, warehouse_code) DO UPDATE
  SET box_qty = EXCLUDED.box_qty,
      unit_qty = EXCLUDED.unit_qty,
      safe_stock_boxes = EXCLUDED.safe_stock_boxes,
      updated_at = NOW();

  RETURN jsonb_build_object('success', true, 'id', v_id);
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION '이미 등록된 품명+컬러+포장수량 조합입니다.';
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_reserve_outbound(
  p_partner TEXT,
  p_handler TEXT,
  p_items JSONB,
  p_to_warehouse TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_item RECORD;
  v_count INTEGER := 0;
  v_dest TEXT := NULLIF(UPPER(TRIM(COALESCE(p_to_warehouse, ''))), '');
  v_item_id UUID;
  v_box INTEGER;
  v_unit INTEGER;
BEGIN
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION '예약할 품목이 없습니다.';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_to_recordset(p_items) AS x(item_id UUID, box_qty INT, unit_qty INT)
  LOOP
    v_item_id := v_item.item_id;
    v_box := ABS(COALESCE(v_item.box_qty, 0));
    v_unit := ABS(COALESCE(v_item.unit_qty, 0));
    IF v_item_id IS NULL OR (v_box = 0 AND v_unit = 0) THEN
      CONTINUE;
    END IF;

    INSERT INTO public.pending_orders (
      item_id, from_warehouse, to_warehouse, box_qty, unit_qty,
      status, requested_by, memo
    ) VALUES (
      v_item_id,
      'MAIN',
      v_dest,
      v_box,
      v_unit,
      'PENDING',
      COALESCE(NULLIF(TRIM(p_handler), ''), 'ADMIN'),
      format('출고예약 %s', COALESCE(NULLIF(TRIM(p_partner), ''), '미지정'))
    );
    v_count := v_count + 1;
  END LOOP;

  IF v_count = 0 THEN
    RAISE EXCEPTION '예약할 유효 수량이 없습니다.';
  END IF;

  RETURN jsonb_build_object('success', true, 'count', v_count);
END;
$$;

ALTER FUNCTION public.rpc_process_transaction(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT) SECURITY DEFINER;
ALTER FUNCTION public.rpc_adjust_stock(TEXT, JSONB, TEXT, TEXT, TEXT) SECURITY DEFINER;
ALTER FUNCTION public.rpc_update_transaction_records(TEXT, TEXT, JSONB, TEXT) SECURITY DEFINER;
ALTER FUNCTION public.rpc_complete_inbound_pending_orders(TEXT, JSONB) SECURITY DEFINER;
ALTER FUNCTION public.rpc_submit_warehouse_order_drafts(JSONB, TEXT) SECURITY DEFINER;
ALTER FUNCTION public.rpc_apply_recommended_safe_stock(JSONB) SECURITY DEFINER;
ALTER FUNCTION public.rpc_next_invoice_no(TEXT, DATE) SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.rpc_login(TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_list_effective_stocks() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_register_item(TEXT, TEXT, NUMERIC, TEXT, UUID, INTEGER, INTEGER, INTEGER) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_reserve_outbound(TEXT, TEXT, JSONB, TEXT) TO anon, authenticated, service_role;
