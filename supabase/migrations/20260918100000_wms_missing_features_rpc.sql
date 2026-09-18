-- ==============================================================================
-- 🚀 WMS 누락 기능 완전 복구 및 원자적 트랜잭션 RPC 마이그레이션
-- ==============================================================================

-- 1. 8대 서브창고 발주 드래프트 일괄 전송 (rpc_submit_warehouse_order_drafts)
CREATE OR REPLACE FUNCTION public.rpc_submit_warehouse_order_drafts(
  p_by_warehouse JSONB,
  p_admin TEXT
) RETURNS JSONB AS $$
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
      item_name TEXT,
      color TEXT,
      box_content INT,
      box_qty INT,
      item_id UUID
    )
    LOOP
      v_item_id := v_item.item_id;
      v_item_name := TRIM(COALESCE(v_item.item_name, ''));
      v_color := TRIM(COALESCE(v_item.color, 'SURTIDO'));
      v_box_content := COALESCE(v_item.box_content, 1);
      v_box_qty := ABS(COALESCE(v_item.box_qty, 0));

      IF v_box_qty > 0 THEN
        -- item_id가 없으면 items 테이블에서 조회 또는 등록
        IF v_item_id IS NULL AND v_item_name <> '' THEN
          SELECT id INTO v_item_id
          FROM public.items
          WHERE item_name = v_item_name
            AND color = v_color
            AND box_packaging_qty = v_box_content
          LIMIT 1;

          IF v_item_id IS NULL THEN
            INSERT INTO public.items (item_name, color, box_packaging_qty)
            VALUES (v_item_name, v_color, v_box_content)
            RETURNING id INTO v_item_id;
          END IF;
        END IF;

        IF v_item_id IS NOT NULL THEN
          INSERT INTO public.pending_orders (
            item_id,
            from_warehouse,
            to_warehouse,
            box_qty,
            unit_qty,
            status,
            requested_by,
            memo
          ) VALUES (
            v_item_id,
            UPPER(TRIM(v_wh)),
            'MAIN',
            v_box_qty,
            0,
            'PENDING',
            COALESCE(p_admin, 'ADMIN'),
            '외부창고 100상자 발주 드래프트'
          );
          v_inserted_count := v_inserted_count + 1;
        END IF;
      END IF;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'count', v_inserted_count,
    'message', format('총 %s건의 서브창고 발주 드래프트가 성공적으로 등록되었습니다.', v_inserted_count)
  );
END;
$$ LANGUAGE plpgsql;

-- 2. 과거 전표 수정 시 원자적 재고 롤백 + 신규 수량 재반영 (rpc_update_transaction_records)
CREATE OR REPLACE FUNCTION public.rpc_update_transaction_records(
  p_invoice_no TEXT,
  p_tx_type TEXT,
  p_new_records JSONB,
  p_admin TEXT
) RETURNS JSONB AS $$
DECLARE
  v_target_inv TEXT;
  v_old_tx RECORD;
  v_curr_box INT;
  v_curr_unit INT;
  v_new_item RECORD;
  v_new_item_id UUID;
  v_new_box INT;
  v_new_unit INT;
  v_warehouse TEXT := 'MAIN';
  v_partner TEXT := '';
BEGIN
  v_target_inv := TRIM(p_invoice_no);
  IF v_target_inv = '' THEN
    RAISE EXCEPTION '수정할 전표 번호가 지정되지 않았습니다.';
  END IF;

  -- 1. 기존 트랜잭션 기록 조회 및 원상복구 (Rollback)
  FOR v_old_tx IN 
    SELECT *
    FROM public.stock_transactions
    WHERE (invoice_no = v_target_inv OR invoice_no = REPLACE(v_target_inv, '/', '-'))
      AND transaction_type = p_tx_type
    FOR UPDATE
  LOOP
    v_warehouse := COALESCE(v_old_tx.warehouse_code, 'MAIN');
    v_partner := COALESCE(v_old_tx.partner_name, '');

    SELECT box_qty, unit_qty INTO v_curr_box, v_curr_unit
    FROM public.inventory_stocks
    WHERE item_id = v_old_tx.item_id AND warehouse_code = v_warehouse
    FOR UPDATE;

    IF FOUND THEN
      IF p_tx_type = 'INBOUND' THEN
        -- 과거 입고 기록 취소: 재고 차감
        UPDATE public.inventory_stocks
        SET box_qty = GREATEST(0, box_qty - v_old_tx.box_qty),
            unit_qty = GREATEST(0, unit_qty - v_old_tx.unit_qty),
            updated_at = NOW()
        WHERE item_id = v_old_tx.item_id AND warehouse_code = v_warehouse;
      ELSIF p_tx_type = 'OUTBOUND' THEN
        -- 과거 출고 기록 취소: 재고 원상복구(증가)
        UPDATE public.inventory_stocks
        SET box_qty = box_qty + v_old_tx.box_qty,
            unit_qty = unit_qty + v_old_tx.unit_qty,
            updated_at = NOW()
        WHERE item_id = v_old_tx.item_id AND warehouse_code = v_warehouse;
      END IF;
    END IF;
  END LOOP;

  -- 2. 기존 트랜잭션 로그 삭제
  DELETE FROM public.stock_transactions
  WHERE (invoice_no = v_target_inv OR invoice_no = REPLACE(v_target_inv, '/', '-'))
    AND transaction_type = p_tx_type;

  -- 3. 새로운 수정 레코드 반영
  IF p_new_records IS NOT NULL AND jsonb_array_length(p_new_records) > 0 THEN
    FOR v_new_item IN SELECT * FROM jsonb_to_recordset(p_new_records) AS x(
      item_id UUID,
      item_name TEXT,
      color TEXT,
      box_content INT,
      box_qty INT,
      unit_qty INT,
      partner_name TEXT
    )
    LOOP
      v_new_item_id := v_new_item.item_id;
      v_new_box := ABS(COALESCE(v_new_item.box_qty, 0));
      v_new_unit := ABS(COALESCE(v_new_item.unit_qty, 0));
      IF v_new_item.partner_name IS NOT NULL AND TRIM(v_new_item.partner_name) <> '' THEN
        v_partner := TRIM(v_new_item.partner_name);
      END IF;

      -- item_id가 없으면 품명/색상으로 조회
      IF v_new_item_id IS NULL THEN
        SELECT id INTO v_new_item_id
        FROM public.items
        WHERE item_name = TRIM(COALESCE(v_new_item.item_name, ''))
          AND color = TRIM(COALESCE(v_new_item.color, 'SURTIDO'))
          AND box_packaging_qty = COALESCE(v_new_item.box_content, 1)
        LIMIT 1;
      END IF;

      IF v_new_item_id IS NOT NULL AND (v_new_box > 0 OR v_new_unit > 0) THEN
        -- 재고 레코드 행 락
        SELECT box_qty, unit_qty INTO v_curr_box, v_curr_unit
        FROM public.inventory_stocks
        WHERE item_id = v_new_item_id AND warehouse_code = v_warehouse
        FOR UPDATE;

        IF NOT FOUND THEN
          INSERT INTO public.inventory_stocks (item_id, warehouse_code, box_qty, unit_qty)
          VALUES (v_new_item_id, v_warehouse, 0, 0)
          RETURNING box_qty, unit_qty INTO v_curr_box, v_curr_unit;
        END IF;

        IF p_tx_type = 'INBOUND' THEN
          UPDATE public.inventory_stocks
          SET box_qty = box_qty + v_new_box,
              unit_qty = unit_qty + v_new_unit,
              updated_at = NOW()
          WHERE item_id = v_new_item_id AND warehouse_code = v_warehouse;
        ELSIF p_tx_type = 'OUTBOUND' THEN
          IF v_curr_box < v_new_box THEN
            RAISE EXCEPTION '수정 출고 재고 부족: 현재 재고(%상자)가 출고 요청 수량(%상자)보다 적습니다.', v_curr_box, v_new_box;
          END IF;

          UPDATE public.inventory_stocks
          SET box_qty = box_qty - v_new_box,
              unit_qty = unit_qty - v_new_unit,
              updated_at = NOW()
          WHERE item_id = v_new_item_id AND warehouse_code = v_warehouse;
        END IF;

        -- 신규 트랜잭션 기록 인서트
        INSERT INTO public.stock_transactions (
          transaction_type,
          item_id,
          warehouse_code,
          source_warehouse,
          target_warehouse,
          partner_name,
          box_qty,
          unit_qty,
          handler_name,
          invoice_no,
          memo
        ) VALUES (
          p_tx_type,
          v_new_item_id,
          v_warehouse,
          v_warehouse,
          NULL,
          v_partner,
          v_new_box,
          v_new_unit,
          COALESCE(p_admin, 'ADMIN'),
          v_target_inv,
          format('[전표수정] %s (%s)', v_target_inv, COALESCE(p_admin, 'ADMIN'))
        );
      END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'message', format('전표(%s)가 성공적으로 수정 및 원자적 재고 롤백/재반영되었습니다.', v_target_inv)
  );
END;
$$ LANGUAGE plpgsql;

-- 3. 서브창고 입고 확정 시 보류 주문 완료 및 서브창고 재고 차감 (rpc_complete_inbound_pending_orders)
CREATE OR REPLACE FUNCTION public.rpc_complete_inbound_pending_orders(
  p_source_warehouse TEXT,
  p_items JSONB
) RETURNS JSONB AS $$
DECLARE
  v_item RECORD;
  v_item_id UUID;
  v_box_qty INT;
  v_wh TEXT;
  v_completed_count INT := 0;
BEGIN
  v_wh := UPPER(TRIM(p_source_warehouse));
  IF v_wh = '' OR v_wh = 'MAIN' OR p_items IS NULL THEN
    RETURN jsonb_build_object('success', true, 'count', 0);
  END IF;

  FOR v_item IN SELECT * FROM jsonb_to_recordset(p_items) AS x(item_id UUID, box_qty INT)
  LOOP
    v_item_id := v_item.item_id;
    v_box_qty := ABS(COALESCE(v_item.box_qty, 0));

    IF v_item_id IS NOT NULL AND v_box_qty > 0 THEN
      -- 1. pending_orders 상태 완료로 업데이트
      UPDATE public.pending_orders
      SET status = 'COMPLETED',
          updated_at = NOW()
      WHERE id IN (
        SELECT id FROM public.pending_orders
        WHERE from_warehouse = v_wh
          AND item_id = v_item_id
          AND status IN ('PENDING', 'IN_TRANSIT')
        ORDER BY created_at ASC
        LIMIT 1
      );

      -- 2. 해당 서브창고 실재고 차감
      UPDATE public.inventory_stocks
      SET box_qty = GREATEST(0, box_qty - v_box_qty),
          updated_at = NOW()
      WHERE item_id = v_item_id AND warehouse_code = v_wh;

      v_completed_count := v_completed_count + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'count', v_completed_count);
END;
$$ LANGUAGE plpgsql;

-- 4. 추천 안전재고 원장 일괄 업데이트 (rpc_apply_recommended_safe_stock)
CREATE OR REPLACE FUNCTION public.rpc_apply_recommended_safe_stock(
  p_recommendations JSONB
) RETURNS JSONB AS $$
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
    item_id UUID,
    recommended_safe_stock INT,
    safe_stock INT
  )
  LOOP
    v_item_id := v_rec.item_id;
    v_safe_stock := GREATEST(0, COALESCE(v_rec.recommended_safe_stock, v_rec.safe_stock, 0));

    IF v_item_id IS NOT NULL THEN
      UPDATE public.inventory_stocks
      SET safe_stock_boxes = v_safe_stock,
          updated_at = NOW()
      WHERE item_id = v_item_id AND warehouse_code = 'MAIN';

      IF FOUND THEN
        v_updated_count := v_updated_count + 1;
      ELSE
        INSERT INTO public.inventory_stocks (item_id, warehouse_code, box_qty, unit_qty, safe_stock_boxes)
        VALUES (v_item_id, 'MAIN', 0, 0, v_safe_stock);
        v_updated_count := v_updated_count + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'count', v_updated_count,
    'message', format('총 %s개 품목의 안전재고가 성공적으로 갱신되었습니다.', v_updated_count)
  );
END;
$$ LANGUAGE plpgsql;
