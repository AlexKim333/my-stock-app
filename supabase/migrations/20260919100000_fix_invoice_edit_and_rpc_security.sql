-- ==============================================================================
-- 1단계 패치: 전표 수정 정합성 + 세션 없는 쓰기 RPC 차단
--  * 재고조정(ADJUST) 전표 수정 시 OUTBOUND로 재기록되던 문제 수정 (부호 있는 증감 유지)
--  * 서브창고발 입고(PENDING 입고확정)의 서브창고 차감분을 source_warehouse로 기록하고,
--    전표 수정/삭제 시 서브창고 재고도 함께 되돌림
--  * 유형/창고 경로가 섞인 전표, 도착창고 없는 MOVE 수정 차단 (거래처명이 창고코드로 쓰이던 문제)
--  * 품목을 찾지 못한 행을 조용히 버리지 않고 예외 처리
--  * 수정 후에도 원 거래일(created_at) 유지
--  * 품목 잠금 순서를 item_id로 고정해 동시 처리 시 교착(deadlock) 방지
--  * rpc_complete_inbound_pending_orders 등 세션 검증 없는 SECURITY DEFINER 함수의 외부 실행 권한 회수
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.rpc_process_transaction_apply(
  p_tx_type TEXT,
  p_warehouse TEXT,
  p_partner TEXT,
  p_handler TEXT,
  p_invoice TEXT,
  p_memo TEXT,
  p_items JSONB,
  p_target_warehouse TEXT DEFAULT NULL,
  p_pending_from_warehouse TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_item RECORD;
  v_item_id UUID;
  v_box_qty INT;
  v_unit_qty INT;
  v_pack INT;
  v_req BIGINT;
  v_is_transfer BOOLEAN := FALSE;
  v_dest_wh TEXT;
  v_src_wh TEXT := UPPER(TRIM(COALESCE(p_warehouse, 'MAIN')));
  v_tx_type TEXT := UPPER(TRIM(COALESCE(p_tx_type, 'INBOUND')));
  v_invoice TEXT := public.fn_normalize_invoice_no(p_invoice);
  v_pending_wh TEXT := UPPER(TRIM(COALESCE(p_pending_from_warehouse, '')));
BEGIN
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION '처리할 품목이 없습니다.';
  END IF;

  IF v_tx_type = 'MOVE' OR (
    p_target_warehouse IS NOT NULL
    AND TRIM(p_target_warehouse) <> ''
    AND UPPER(TRIM(p_target_warehouse)) <> v_src_wh
  ) THEN
    v_is_transfer := TRUE;
    v_tx_type := 'MOVE';
    v_dest_wh := UPPER(TRIM(p_target_warehouse));
    IF v_dest_wh IS NULL OR v_dest_wh = '' THEN
      RAISE EXCEPTION '이동 도착창고가 지정되지 않았습니다.';
    END IF;
    IF v_dest_wh = v_src_wh THEN
      RAISE EXCEPTION '출발창고와 도착창고가 동일합니다: %', v_src_wh;
    END IF;
  END IF;

  IF v_pending_wh = 'MAIN' OR v_pending_wh = v_src_wh THEN
    v_pending_wh := '';
  END IF;

  IF v_invoice IS NULL OR v_invoice = '' THEN
    v_invoice := public.rpc_next_invoice_no(v_tx_type);
  END IF;

  -- item_id 순서로 잠가 동시 트랜잭션 간 교착을 방지한다.
  FOR v_item IN
    SELECT *
    FROM jsonb_to_recordset(p_items) AS x(item_id UUID, box_qty INT, unit_qty INT)
    ORDER BY x.item_id
  LOOP
    v_item_id := v_item.item_id;
    v_box_qty := COALESCE(v_item.box_qty, 0);
    v_unit_qty := COALESCE(v_item.unit_qty, 0);

    IF v_item_id IS NULL THEN
      RAISE EXCEPTION '품목 ID가 없는 행이 있습니다.';
    END IF;
    IF v_box_qty < 0 OR v_unit_qty < 0 THEN
      RAISE EXCEPTION '수량은 음수일 수 없습니다.';
    END IF;

    v_pack := public.fn_item_pack_qty(v_item_id);
    v_req := public.fn_stock_units(v_box_qty, v_unit_qty, v_pack);
    IF v_req = 0 THEN
      CONTINUE;
    END IF;

    IF v_is_transfer THEN
      PERFORM public.fn_apply_stock_units(v_item_id, v_src_wh, -v_req, TRUE, '이동');
      PERFORM public.fn_apply_stock_units(v_item_id, v_dest_wh, v_req, FALSE, '이동입고');
      INSERT INTO public.stock_transactions (
        transaction_type, item_id, warehouse_code, source_warehouse, target_warehouse,
        partner_name, box_qty, unit_qty, handler_name, invoice_no, memo
      ) VALUES (
        'MOVE', v_item_id, v_src_wh, v_src_wh, v_dest_wh,
        COALESCE(p_partner, v_dest_wh), v_box_qty, v_unit_qty, p_handler, v_invoice, p_memo
      );
    ELSIF v_tx_type = 'OUTBOUND' THEN
      PERFORM public.fn_apply_stock_units(v_item_id, v_src_wh, -v_req, TRUE, '출고');
      INSERT INTO public.stock_transactions (
        transaction_type, item_id, warehouse_code, source_warehouse, target_warehouse,
        partner_name, box_qty, unit_qty, handler_name, invoice_no, memo
      ) VALUES (
        'OUTBOUND', v_item_id, v_src_wh, v_src_wh, NULL,
        p_partner, v_box_qty, v_unit_qty, p_handler, v_invoice, p_memo
      );
    ELSE
      PERFORM public.fn_apply_stock_units(v_item_id, v_src_wh, v_req, FALSE, '입고');

      IF v_pending_wh <> '' THEN
        PERFORM public.fn_fifo_complete_pending(v_pending_wh, v_item_id, v_req);
        PERFORM public.fn_apply_stock_units(v_item_id, v_pending_wh, -v_req, TRUE, '서브창고 입고확정');
      END IF;

      -- source_warehouse: 서브창고발 입고일 때 차감된 서브창고 (일반 입고는 NULL)
      INSERT INTO public.stock_transactions (
        transaction_type, item_id, warehouse_code, source_warehouse, target_warehouse,
        partner_name, box_qty, unit_qty, handler_name, invoice_no, memo
      ) VALUES (
        'INBOUND', v_item_id, v_src_wh, NULLIF(v_pending_wh, ''), v_src_wh,
        p_partner, v_box_qty, v_unit_qty, p_handler, v_invoice, p_memo
      );
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_no', v_invoice,
    'tx_type', CASE WHEN v_is_transfer THEN 'MOVE' ELSE v_tx_type END,
    'source_warehouse', v_src_wh,
    'target_warehouse', v_dest_wh
  );
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
  v_req_type TEXT := UPPER(TRIM(COALESCE(p_tx_type, 'OUTBOUND')));
  v_admin TEXT := COALESCE(NULLIF(TRIM(p_admin), ''), 'ADMIN');
  v_match_types TEXT[];
  v_type_count INT;
  v_route_count INT;
  v_created_at TIMESTAMPTZ;
  v_first RECORD;
  v_old RECORD;
  v_new RECORD;
  v_type TEXT;
  v_wh TEXT;
  v_src TEXT;
  v_dst TEXT;
  v_pending_src TEXT;
  v_partner TEXT;
  v_row_partner TEXT;
  v_memo TEXT;
  v_item_id UUID;
  v_box INT;
  v_unit INT;
  v_pack INT;
  v_req BIGINT;
  v_inserted INT := 0;
BEGIN
  IF v_canonical IS NULL OR v_canonical = '' THEN
    RAISE EXCEPTION '수정할 전표 번호가 지정되지 않았습니다.';
  END IF;

  IF v_req_type IN ('OUTBOUND', 'MOVE') THEN
    v_match_types := ARRAY['OUTBOUND', 'MOVE'];
  ELSIF v_req_type = 'INBOUND' THEN
    v_match_types := ARRAY['INBOUND'];
  ELSIF v_req_type = 'ADJUST' THEN
    v_match_types := ARRAY['ADJUST'];
  ELSE
    RAISE EXCEPTION '지원하지 않는 전표 유형입니다: %', v_req_type;
  END IF;

  -- 전표 행 전체를 item_id 순서로 잠근다.
  PERFORM 1
  FROM public.stock_transactions
  WHERE public.fn_normalize_invoice_no(invoice_no) = v_canonical
    AND transaction_type = ANY (v_match_types)
  ORDER BY item_id, id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '수정할 전표를 찾을 수 없습니다: %', v_canonical;
  END IF;

  SELECT
    COUNT(DISTINCT transaction_type),
    COUNT(DISTINCT
      COALESCE(warehouse_code, '') || '|' ||
      COALESCE(source_warehouse, '') || '|' ||
      COALESCE(target_warehouse, '')
    ),
    MIN(created_at)
  INTO v_type_count, v_route_count, v_created_at
  FROM public.stock_transactions
  WHERE public.fn_normalize_invoice_no(invoice_no) = v_canonical
    AND transaction_type = ANY (v_match_types);

  IF v_type_count > 1 THEN
    RAISE EXCEPTION '출고와 이동이 섞인 전표(%)는 수정할 수 없습니다.', v_canonical;
  END IF;
  IF v_route_count > 1 THEN
    RAISE EXCEPTION '창고 경로가 서로 다른 행이 섞인 전표(%)는 수정할 수 없습니다.', v_canonical;
  END IF;

  SELECT transaction_type, warehouse_code, source_warehouse, target_warehouse, partner_name
  INTO v_first
  FROM public.stock_transactions
  WHERE public.fn_normalize_invoice_no(invoice_no) = v_canonical
    AND transaction_type = ANY (v_match_types)
  ORDER BY item_id, id
  LIMIT 1;

  v_type := v_first.transaction_type;
  v_wh := UPPER(COALESCE(NULLIF(TRIM(v_first.warehouse_code), ''), 'MAIN'));
  v_partner := COALESCE(v_first.partner_name, '');

  IF v_type = 'INBOUND' THEN
    v_dst := UPPER(COALESCE(NULLIF(TRIM(v_first.target_warehouse), ''), v_wh));
    v_pending_src := UPPER(NULLIF(TRIM(COALESCE(v_first.source_warehouse, '')), ''));
    IF v_pending_src = v_dst THEN
      v_pending_src := NULL;
    END IF;
  ELSIF v_type = 'OUTBOUND' THEN
    v_src := UPPER(COALESCE(NULLIF(TRIM(v_first.source_warehouse), ''), v_wh));
  ELSIF v_type = 'MOVE' THEN
    v_src := UPPER(COALESCE(NULLIF(TRIM(v_first.source_warehouse), ''), v_wh));
    v_dst := UPPER(NULLIF(TRIM(COALESCE(v_first.target_warehouse, '')), ''));
    IF v_dst IS NULL THEN
      RAISE EXCEPTION '도착창고 정보가 없는 이동 전표(%)는 수정할 수 없습니다.', v_canonical;
    END IF;
  END IF;

  -- 1. 기존 전표 재고 효과 되돌리기
  FOR v_old IN
    SELECT *
    FROM public.stock_transactions
    WHERE public.fn_normalize_invoice_no(invoice_no) = v_canonical
      AND transaction_type = ANY (v_match_types)
    ORDER BY item_id, id
  LOOP
    v_pack := public.fn_item_pack_qty(v_old.item_id);
    v_req := public.fn_stock_units(v_old.box_qty, v_old.unit_qty, v_pack);

    IF v_type = 'INBOUND' THEN
      PERFORM public.fn_apply_stock_units(v_old.item_id, v_dst, -v_req, TRUE, '입고 전표 취소');
      IF v_pending_src IS NOT NULL THEN
        PERFORM public.fn_apply_stock_units(v_old.item_id, v_pending_src, v_req, FALSE, '서브창고 입고확정 취소');
      END IF;
    ELSIF v_type = 'OUTBOUND' THEN
      PERFORM public.fn_apply_stock_units(v_old.item_id, v_src, v_req, FALSE, '출고 전표 취소');
    ELSIF v_type = 'MOVE' THEN
      PERFORM public.fn_apply_stock_units(v_old.item_id, v_src, v_req, FALSE, '이동 전표 취소');
      PERFORM public.fn_apply_stock_units(v_old.item_id, v_dst, -v_req, TRUE, '이동 전표 취소');
    ELSIF v_type = 'ADJUST' THEN
      -- ADJUST 행은 부호 있는 증감(Δ)으로 저장된다.
      PERFORM public.fn_apply_stock_units(v_old.item_id, v_wh, -v_req, TRUE, '재고조정 전표 취소');
    END IF;
  END LOOP;

  DELETE FROM public.stock_transactions
  WHERE public.fn_normalize_invoice_no(invoice_no) = v_canonical
    AND transaction_type = ANY (v_match_types);

  -- 2. 새 행 재반영 (원 전표 유형·경로·거래일 유지)
  v_memo := format('[전표수정] %s (%s)', v_canonical, v_admin);

  IF p_new_records IS NOT NULL AND jsonb_array_length(p_new_records) > 0 THEN
    FOR v_new IN
      SELECT *
      FROM jsonb_to_recordset(p_new_records) AS x(
        item_id UUID, item_name TEXT, color TEXT, box_content INT, box_qty INT, unit_qty INT, partner_name TEXT
      )
      ORDER BY x.item_id NULLS LAST
    LOOP
      v_item_id := v_new.item_id;
      IF v_item_id IS NULL THEN
        SELECT id INTO v_item_id
        FROM public.items
        WHERE item_name = TRIM(COALESCE(v_new.item_name, ''))
          AND color = TRIM(COALESCE(v_new.color, 'SURTIDO'))
          AND box_packaging_qty = COALESCE(v_new.box_content, 1)
        ORDER BY COALESCE(is_active, TRUE) DESC
        LIMIT 1;
      END IF;
      IF v_item_id IS NULL THEN
        RAISE EXCEPTION '품목을 찾을 수 없습니다: % (%)',
          COALESCE(v_new.item_name, ''), COALESCE(v_new.color, 'SURTIDO');
      END IF;

      IF v_type = 'ADJUST' THEN
        v_box := COALESCE(v_new.box_qty, 0);
        v_unit := COALESCE(v_new.unit_qty, 0);
      ELSE
        v_box := ABS(COALESCE(v_new.box_qty, 0));
        v_unit := ABS(COALESCE(v_new.unit_qty, 0));
      END IF;
      IF v_box = 0 AND v_unit = 0 THEN
        CONTINUE;
      END IF;

      v_row_partner := COALESCE(NULLIF(TRIM(COALESCE(v_new.partner_name, '')), ''), v_partner);
      v_pack := public.fn_item_pack_qty(v_item_id);
      v_req := public.fn_stock_units(v_box, v_unit, v_pack);

      IF v_type = 'INBOUND' THEN
        PERFORM public.fn_apply_stock_units(v_item_id, v_dst, v_req, FALSE, '수정 입고');
        IF v_pending_src IS NOT NULL THEN
          PERFORM public.fn_apply_stock_units(v_item_id, v_pending_src, -v_req, TRUE, '수정 서브창고 입고확정');
        END IF;
        INSERT INTO public.stock_transactions (
          transaction_type, item_id, warehouse_code, source_warehouse, target_warehouse,
          partner_name, box_qty, unit_qty, handler_name, invoice_no, memo, created_at
        ) VALUES (
          'INBOUND', v_item_id, v_dst, v_pending_src, v_dst,
          v_row_partner, v_box, v_unit, v_admin, v_canonical, v_memo, v_created_at
        );
      ELSIF v_type = 'OUTBOUND' THEN
        PERFORM public.fn_apply_stock_units(v_item_id, v_src, -v_req, TRUE, '수정 출고');
        INSERT INTO public.stock_transactions (
          transaction_type, item_id, warehouse_code, source_warehouse, target_warehouse,
          partner_name, box_qty, unit_qty, handler_name, invoice_no, memo, created_at
        ) VALUES (
          'OUTBOUND', v_item_id, v_src, v_src, NULL,
          v_row_partner, v_box, v_unit, v_admin, v_canonical, v_memo, v_created_at
        );
      ELSIF v_type = 'MOVE' THEN
        PERFORM public.fn_apply_stock_units(v_item_id, v_src, -v_req, TRUE, '수정 이동');
        PERFORM public.fn_apply_stock_units(v_item_id, v_dst, v_req, FALSE, '수정 이동입고');
        INSERT INTO public.stock_transactions (
          transaction_type, item_id, warehouse_code, source_warehouse, target_warehouse,
          partner_name, box_qty, unit_qty, handler_name, invoice_no, memo, created_at
        ) VALUES (
          'MOVE', v_item_id, v_src, v_src, v_dst,
          v_row_partner, v_box, v_unit, v_admin, v_canonical, v_memo, v_created_at
        );
      ELSE
        PERFORM public.fn_apply_stock_units(v_item_id, v_wh, v_req, TRUE, '수정 재고조정');
        INSERT INTO public.stock_transactions (
          transaction_type, item_id, warehouse_code, source_warehouse, target_warehouse,
          partner_name, box_qty, unit_qty, handler_name, invoice_no, memo, created_at
        ) VALUES (
          'ADJUST', v_item_id, v_wh, NULL, NULL,
          NULLIF(v_row_partner, ''), v_box, v_unit, v_admin, v_canonical, v_memo, v_created_at
        );
      END IF;

      v_inserted := v_inserted + 1;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_no', v_canonical,
    'tx_type', v_type,
    'line_count', v_inserted,
    'message', format('전표(%s)가 원자적으로 수정되었습니다.', v_canonical)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_process_transaction_apply(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_update_transaction_records_apply(TEXT, TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated;

-- 세션 검증 없이 재고를 바꿀 수 있던 함수들: 외부(anon/authenticated) 실행 권한 회수.
-- 내부 SECURITY DEFINER RPC에서 호출되는 경로는 소유자 권한으로 계속 동작한다.
REVOKE ALL ON FUNCTION public.rpc_complete_inbound_pending_orders(TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ensure_stock_row(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_next_invoice_no(TEXT, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_fifo_complete_pending(TEXT, UUID, BIGINT) FROM PUBLIC, anon, authenticated;
