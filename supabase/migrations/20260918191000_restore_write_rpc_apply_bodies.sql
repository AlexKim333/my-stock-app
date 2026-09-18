-- 세션 래퍼가 덮어쓴 쓰기 RPC 본문을 _apply로 복구
CREATE OR REPLACE FUNCTION public.rpc_execute_stock_normalization_apply(p_groups JSONB)
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
    canonical_item_id UUID, canonical_name TEXT, color TEXT, box_packaging_qty NUMERIC, members JSONB
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
    IF COALESCE(array_length(v_ids, 1), 0) <= 1 OR NOT (v_canonical = ANY (v_ids)) THEN
      CONTINUE;
    END IF;

    v_secondary := ARRAY(SELECT unnest(v_ids) EXCEPT SELECT v_canonical);

    PERFORM 1 FROM public.items WHERE id = ANY (v_ids) FOR UPDATE;
    PERFORM 1 FROM public.inventory_stocks WHERE item_id = ANY (v_ids) FOR UPDATE;

    IF COALESCE(array_length(v_secondary, 1), 0) > 0 THEN
      UPDATE public.items
      SET item_name = item_name || ' [MERGED ' || id::TEXT || ']', is_active = FALSE
      WHERE id = ANY (v_secondary);
    END IF;

    UPDATE public.items
    SET item_name = v_name, color = v_color, box_packaging_qty = v_pkg, is_active = TRUE
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
      SET box_qty = EXCLUDED.box_qty, unit_qty = EXCLUDED.unit_qty, updated_at = NOW();
    END LOOP;

    IF COALESCE(array_length(v_secondary, 1), 0) > 0 THEN
      UPDATE public.stock_transactions SET item_id = v_canonical WHERE item_id = ANY (v_secondary);
      UPDATE public.pending_orders SET item_id = v_canonical WHERE item_id = ANY (v_secondary);
      DELETE FROM public.inventory_stocks WHERE item_id = ANY (v_secondary);
    END IF;

    v_merged_groups := v_merged_groups + 1;
    v_merged_items := v_merged_items + COALESCE(array_length(v_secondary, 1), 0);
  END LOOP;

  RETURN jsonb_build_object('success', true, 'merged_groups', v_merged_groups, 'merged_items', v_merged_items);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_execute_color_normalization_apply(p_items JSONB)
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
    item_id UUID, normalized_name TEXT, normalized_color TEXT, box_content NUMERIC
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
      IF FOUND THEN v_done := v_done + 1; ELSE v_skipped := v_skipped + 1; END IF;
    EXCEPTION
      WHEN unique_violation THEN v_skipped := v_skipped + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'updated', v_done, 'skipped', v_skipped);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_submit_warehouse_order_drafts_apply(
  p_by_warehouse JSONB,
  p_admin TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_wh TEXT;
  v_items JSONB;
  v_item RECORD;
  v_item_id UUID;
  v_item_name TEXT;
  v_color TEXT;
  v_box_content INT;
  v_box_qty INT;
  v_inserted_count INT := 0;
BEGIN
  IF p_by_warehouse IS NULL OR p_by_warehouse = '{}'::JSONB THEN
    RETURN jsonb_build_object('success', true, 'count', 0, 'message', '발주할 품목이 없습니다.');
  END IF;

  FOR v_wh, v_items IN SELECT * FROM jsonb_each(p_by_warehouse)
  LOOP
    FOR v_item IN SELECT * FROM jsonb_to_recordset(v_items) AS x(
      item_name TEXT, color TEXT, box_content INT, box_qty INT, item_id UUID
    )
    LOOP
      v_item_id := v_item.item_id;
      v_item_name := TRIM(COALESCE(v_item.item_name, ''));
      v_color := TRIM(COALESCE(v_item.color, 'SURTIDO'));
      v_box_content := COALESCE(v_item.box_content, 1);
      v_box_qty := ABS(COALESCE(v_item.box_qty, 0));

      IF v_box_qty > 0 THEN
        IF v_item_id IS NULL AND v_item_name <> '' THEN
          SELECT id INTO v_item_id
          FROM public.items
          WHERE item_name = v_item_name AND color = v_color AND box_packaging_qty = v_box_content
          LIMIT 1;
          IF v_item_id IS NULL THEN
            INSERT INTO public.items (item_name, color, box_packaging_qty)
            VALUES (v_item_name, v_color, v_box_content)
            RETURNING id INTO v_item_id;
          END IF;
        END IF;

        IF v_item_id IS NOT NULL THEN
          INSERT INTO public.pending_orders (
            item_id, from_warehouse, to_warehouse, box_qty, unit_qty, status, requested_by, memo
          ) VALUES (
            v_item_id, UPPER(TRIM(v_wh)), 'MAIN', v_box_qty, 0, 'PENDING',
            COALESCE(p_admin, 'ADMIN'), '외부창고 100상자 발주 드래프트'
          );
          v_inserted_count := v_inserted_count + 1;
        END IF;
      END IF;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'count', v_inserted_count,
    'message', format('총 %s건의 서브창고 발주 드래프트가 성공적으로 등록되었습니다.', v_inserted_count));
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_apply_recommended_safe_stock_apply(p_recommendations JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_rec RECORD;
  v_item_id UUID;
  v_safe_stock INT;
  v_updated_count INT := 0;
BEGIN
  IF p_recommendations IS NULL OR jsonb_array_length(p_recommendations) = 0 THEN
    RETURN jsonb_build_object('success', true, 'count', 0);
  END IF;

  FOR v_rec IN SELECT * FROM jsonb_to_recordset(p_recommendations) AS x(
    item_id UUID, recommended_safe_stock INT, safe_stock INT
  )
  LOOP
    v_item_id := v_rec.item_id;
    v_safe_stock := GREATEST(0, COALESCE(v_rec.recommended_safe_stock, v_rec.safe_stock, 0));
    IF v_item_id IS NULL THEN CONTINUE; END IF;

    UPDATE public.inventory_stocks
    SET safe_stock_boxes = v_safe_stock, updated_at = NOW()
    WHERE item_id = v_item_id AND warehouse_code = 'MAIN';

    IF FOUND THEN
      v_updated_count := v_updated_count + 1;
    ELSE
      INSERT INTO public.inventory_stocks (item_id, warehouse_code, box_qty, unit_qty, safe_stock_boxes)
      VALUES (v_item_id, 'MAIN', 0, 0, v_safe_stock);
      v_updated_count := v_updated_count + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'count', v_updated_count,
    'message', format('총 %s개 품목의 안전재고가 성공적으로 갱신되었습니다.', v_updated_count));
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_update_transaction_records_apply(
  p_invoice_no TEXT,
  p_tx_type TEXT,
  p_new_records JSONB,
  p_admin TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_canonical TEXT := public.fn_normalize_invoice_no(p_invoice_no);
  v_old_tx RECORD;
  v_new_item RECORD;
  v_new_item_id UUID;
  v_new_box INT;
  v_new_unit INT;
  v_pack INT;
  v_req BIGINT;
  v_warehouse TEXT := 'MAIN';
  v_partner TEXT := '';
  v_src TEXT;
  v_dst TEXT;
  v_apply_type TEXT := UPPER(TRIM(COALESCE(p_tx_type, 'OUTBOUND')));
  v_match_types TEXT[];
BEGIN
  IF v_canonical IS NULL OR v_canonical = '' THEN
    RAISE EXCEPTION '수정할 전표 번호가 지정되지 않았습니다.';
  END IF;

  IF v_apply_type IN ('OUTBOUND', 'MOVE') THEN
    v_match_types := ARRAY['OUTBOUND', 'MOVE'];
  ELSIF v_apply_type = 'INBOUND' THEN
    v_match_types := ARRAY['INBOUND'];
  ELSIF v_apply_type = 'ADJUST' THEN
    v_match_types := ARRAY['ADJUST'];
  ELSE
    v_match_types := ARRAY[v_apply_type];
  END IF;

  FOR v_old_tx IN
    SELECT *
    FROM public.stock_transactions
    WHERE public.fn_normalize_invoice_no(invoice_no) = v_canonical
      AND transaction_type = ANY (v_match_types)
    FOR UPDATE
  LOOP
    v_warehouse := COALESCE(v_old_tx.warehouse_code, 'MAIN');
    v_partner := COALESCE(v_old_tx.partner_name, v_partner);
    v_src := COALESCE(v_old_tx.source_warehouse, v_warehouse);
    v_dst := v_old_tx.target_warehouse;
    v_apply_type := v_old_tx.transaction_type;
    v_pack := public.fn_item_pack_qty(v_old_tx.item_id);
    v_req := public.fn_stock_units(v_old_tx.box_qty, v_old_tx.unit_qty, v_pack);

    IF v_old_tx.transaction_type = 'INBOUND' THEN
      PERFORM public.fn_apply_stock_units(
        v_old_tx.item_id,
        COALESCE(v_old_tx.target_warehouse, v_warehouse),
        -v_req, TRUE, '입고 전표 취소'
      );
    ELSIF v_old_tx.transaction_type = 'OUTBOUND' THEN
      PERFORM public.fn_apply_stock_units(v_old_tx.item_id, v_src, v_req, FALSE, '출고 전표 취소');
    ELSIF v_old_tx.transaction_type = 'MOVE' THEN
      PERFORM public.fn_apply_stock_units(v_old_tx.item_id, v_src, v_req, FALSE, '이동 전표 취소');
      IF v_dst IS NOT NULL AND v_dst <> '' THEN
        PERFORM public.fn_apply_stock_units(v_old_tx.item_id, v_dst, -v_req, TRUE, '이동 전표 취소');
      END IF;
    ELSIF v_old_tx.transaction_type = 'ADJUST' THEN
      PERFORM public.fn_apply_stock_units(v_old_tx.item_id, v_warehouse, -v_req, TRUE, '재고조정 전표 취소');
    END IF;
  END LOOP;

  DELETE FROM public.stock_transactions
  WHERE public.fn_normalize_invoice_no(invoice_no) = v_canonical
    AND transaction_type = ANY (v_match_types);

  IF p_new_records IS NOT NULL AND jsonb_array_length(p_new_records) > 0 THEN
    FOR v_new_item IN SELECT * FROM jsonb_to_recordset(p_new_records) AS x(
      item_id UUID, item_name TEXT, color TEXT, box_content INT, box_qty INT, unit_qty INT, partner_name TEXT
    )
    LOOP
      v_new_item_id := v_new_item.item_id;
      v_new_box := ABS(COALESCE(v_new_item.box_qty, 0));
      v_new_unit := ABS(COALESCE(v_new_item.unit_qty, 0));
      IF v_new_item.partner_name IS NOT NULL AND TRIM(v_new_item.partner_name) <> '' THEN
        v_partner := TRIM(v_new_item.partner_name);
      END IF;

      IF v_new_item_id IS NULL THEN
        SELECT id INTO v_new_item_id
        FROM public.items
        WHERE item_name = TRIM(COALESCE(v_new_item.item_name, ''))
          AND color = TRIM(COALESCE(v_new_item.color, 'SURTIDO'))
          AND box_packaging_qty = COALESCE(v_new_item.box_content, 1)
        LIMIT 1;
      END IF;

      IF v_new_item_id IS NULL OR (v_new_box = 0 AND v_new_unit = 0) THEN
        CONTINUE;
      END IF;

      v_pack := public.fn_item_pack_qty(v_new_item_id);
      v_req := public.fn_stock_units(v_new_box, v_new_unit, v_pack);

      IF v_apply_type = 'MOVE' THEN
        v_src := COALESCE(v_src, v_warehouse, 'MAIN');
        v_dst := COALESCE(v_dst, v_partner);
        PERFORM public.fn_apply_stock_units(v_new_item_id, v_src, -v_req, TRUE, '수정 이동');
        PERFORM public.fn_apply_stock_units(v_new_item_id, v_dst, v_req, FALSE, '수정 이동입고');
        INSERT INTO public.stock_transactions (
          transaction_type, item_id, warehouse_code, source_warehouse, target_warehouse,
          partner_name, box_qty, unit_qty, handler_name, invoice_no, memo
        ) VALUES (
          'MOVE', v_new_item_id, v_src, v_src, v_dst, v_partner,
          v_new_box, v_new_unit, COALESCE(p_admin, 'ADMIN'), v_canonical,
          format('[전표수정] %s (%s)', v_canonical, COALESCE(p_admin, 'ADMIN'))
        );
      ELSIF v_apply_type = 'INBOUND' THEN
        PERFORM public.fn_apply_stock_units(v_new_item_id, v_warehouse, v_req, FALSE, '수정 입고');
        INSERT INTO public.stock_transactions (
          transaction_type, item_id, warehouse_code, source_warehouse, target_warehouse,
          partner_name, box_qty, unit_qty, handler_name, invoice_no, memo
        ) VALUES (
          'INBOUND', v_new_item_id, v_warehouse, NULL, v_warehouse, v_partner,
          v_new_box, v_new_unit, COALESCE(p_admin, 'ADMIN'), v_canonical,
          format('[전표수정] %s (%s)', v_canonical, COALESCE(p_admin, 'ADMIN'))
        );
      ELSE
        PERFORM public.fn_apply_stock_units(v_new_item_id, v_warehouse, -v_req, TRUE, '수정 출고');
        INSERT INTO public.stock_transactions (
          transaction_type, item_id, warehouse_code, source_warehouse, target_warehouse,
          partner_name, box_qty, unit_qty, handler_name, invoice_no, memo
        ) VALUES (
          'OUTBOUND', v_new_item_id, v_warehouse, v_warehouse, NULL, v_partner,
          v_new_box, v_new_unit, COALESCE(p_admin, 'ADMIN'), v_canonical,
          format('[전표수정] %s (%s)', v_canonical, COALESCE(p_admin, 'ADMIN'))
        );
      END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_no', v_canonical,
    'message', format('전표(%s)가 원자적으로 수정되었습니다.', v_canonical)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_execute_stock_normalization_apply(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_execute_color_normalization_apply(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_submit_warehouse_order_drafts_apply(JSONB, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_apply_recommended_safe_stock_apply(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_update_transaction_records_apply(TEXT, TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rpc_execute_stock_normalization(JSONB) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_execute_color_normalization(JSONB) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_submit_warehouse_order_drafts(JSONB, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_apply_recommended_safe_stock(JSONB) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_update_transaction_records(TEXT, TEXT, JSONB, TEXT) TO anon, authenticated;
