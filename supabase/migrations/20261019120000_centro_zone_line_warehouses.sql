-- ==============================================================================
-- 센트로 구역(MAIN + MANUELDOBLADO / CIRCUNBALAXION / GUATEMALA): 출고 전표 줄마다 출고창고 지정
--
-- 배경: 센트로의 4개 창고는 모두 손님에게 직접 출고하고, 영수증은 MAIN에서 한 장으로 쓴다.
--       한 품목이 여러 창고에 나뉘어 있어 한 영수증에 "제품 A 3상자는 MAIN, 2상자는 CIRCUNBALAXION"처럼
--       창고가 섞일 수 있다. 지금까지는 전표 한 장 = 출고창고 하나였다.
--
-- 조치:
--   1) warehouses.zone — 같은 zone의 창고끼리만 한 출고 전표에 섞을 수 있다(센트로 = 'CENTRO').
--      스모크 테스트 창고(SMOKETEST, 비활성·UI 비노출)도 혼합 전표를 검증하려고 CENTRO에 넣는다.
--   2) 출고(rpc_process_transaction_apply): p_items 각 줄의 선택 키 warehouse로 줄별 출고창고를 받는다.
--      줄에 창고가 없으면 지금처럼 전표 창고(p_warehouse)를 쓴다 — 기존 화면은 그대로 동작한다.
--      입고·이동은 지금처럼 전표 하나에 경로 하나(줄별 창고를 다르게 주면 거절).
--   3) 전표 수정(rpc_update_transaction_records_apply): 출고 전표와 반품 입고 전표는 창고가 섞여 있어도
--      수정할 수 있다. 각 기존 행을 자기 창고로 되돌린 뒤, 새 행은 줄의 warehouse(없으면 같은 품목의 기존
--      창고, 그것도 없으면 전표 창고)로 다시 반영한다.
--   4) 반품(rpc_process_return_apply): 줄마다 반품받을 창고를 받는다. 없으면 그 품목을 출고한 창고가 한 곳일 때
--      그 창고, 아니면 p_warehouse. rpc_invoice_returnable은 품목별 출고창고(out_warehouses)를 알려 준다.
--   5) 출고 보류(rpc_save_outbound_hold): 줄별 창고로 예약한다(outbound_hold_items.warehouse_code는 이미 줄 단위).
--   6) 전표 지문(fn_invoice_signature)에 창고를 넣어, 다른 사람이 줄의 창고만 바꾼 수정도 충돌로 잡는다.
-- 함수 본문은 운영 DB의 현재 정의(pg_get_functiondef, 2026-10-19)를 바탕으로 했다.
-- ==============================================================================

ALTER TABLE public.warehouses ADD COLUMN IF NOT EXISTS zone TEXT;

UPDATE public.warehouses
SET zone = 'CENTRO'
WHERE code IN ('MAIN', 'MANUELDOBLADO', 'CIRCUNBALAXION', 'GUATEMALA', 'SMOKETEST')
  AND zone IS DISTINCT FROM 'CENTRO';

-- 줄의 창고를 정규화하고, 전표 창고와 다르면 같은 구역인지 검사한다.
CREATE OR REPLACE FUNCTION public.fn_line_warehouse(p_header TEXT, p_line TEXT)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_header TEXT := UPPER(TRIM(COALESCE(NULLIF(TRIM(p_header), ''), 'MAIN')));
  v_line TEXT := UPPER(TRIM(COALESCE(NULLIF(TRIM(p_line), ''), NULLIF(TRIM(p_header), ''), 'MAIN')));
  v_header_zone TEXT;
  v_line_zone TEXT;
BEGIN
  IF v_line = v_header THEN
    RETURN v_line;
  END IF;
  SELECT zone INTO v_line_zone FROM public.warehouses WHERE code = v_line;
  IF NOT FOUND THEN
    RAISE EXCEPTION '창고를 찾을 수 없습니다: %', v_line;
  END IF;
  SELECT zone INTO v_header_zone FROM public.warehouses WHERE code = v_header;
  IF v_header_zone IS NULL OR v_line_zone IS DISTINCT FROM v_header_zone THEN
    RAISE EXCEPTION '% 창고 물건은 % 전표에 함께 담을 수 없습니다(같은 구역의 창고끼리만 한 전표에 섞을 수 있습니다).',
      v_line, v_header;
  END IF;
  RETURN v_line;
END;
$$;
REVOKE ALL ON FUNCTION public.fn_line_warehouse(TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------------------------
-- 2) 출고·이동·입고 처리
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_process_transaction_apply(p_tx_type text, p_warehouse text, p_partner text, p_handler text, p_invoice text, p_memo text, p_items jsonb, p_target_warehouse text DEFAULT NULL::text, p_pending_from_warehouse text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_line_wh TEXT;
  v_line_whs TEXT[] := ARRAY[]::TEXT[];
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

  -- (item_id, 창고) 순서로 잠가 동시 트랜잭션 간 교착을 방지한다.
  FOR v_item IN
    SELECT *
    FROM jsonb_to_recordset(p_items) AS x(item_id UUID, box_qty INT, unit_qty INT, warehouse TEXT)
    ORDER BY x.item_id, UPPER(TRIM(COALESCE(x.warehouse, '')))
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

    IF v_tx_type = 'OUTBOUND' AND NOT v_is_transfer THEN
      v_line_wh := public.fn_line_warehouse(v_src_wh, v_item.warehouse);
    ELSE
      IF NULLIF(TRIM(COALESCE(v_item.warehouse, '')), '') IS NOT NULL
         AND UPPER(TRIM(v_item.warehouse)) <> v_src_wh THEN
        RAISE EXCEPTION '입고·이동 전표는 줄마다 창고를 다르게 지정할 수 없습니다.';
      END IF;
      v_line_wh := v_src_wh;
    END IF;

    v_pack := public.fn_item_pack_qty(v_item_id);
    v_req := public.fn_stock_units(v_box_qty, v_unit_qty, v_pack);
    IF v_req = 0 THEN
      CONTINUE;
    END IF;

    IF NOT (v_line_wh = ANY (v_line_whs)) THEN
      v_line_whs := v_line_whs || v_line_wh;
    END IF;

    IF v_is_transfer THEN
      PERFORM public.fn_assert_warehouse_atp(v_item_id, v_src_wh, v_req, '이동');
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
      PERFORM public.fn_assert_warehouse_atp(v_item_id, v_line_wh, v_req, '출고');
      PERFORM public.fn_apply_stock_units(v_item_id, v_line_wh, -v_req, TRUE, '출고');
      INSERT INTO public.stock_transactions (
        transaction_type, item_id, warehouse_code, source_warehouse, target_warehouse,
        partner_name, box_qty, unit_qty, handler_name, invoice_no, memo
      ) VALUES (
        'OUTBOUND', v_item_id, v_line_wh, v_line_wh, NULL,
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
    'target_warehouse', v_dest_wh,
    'line_warehouses', to_jsonb(v_line_whs)
  );
END;
$function$;

-- ------------------------------------------------------------------------------
-- 3) 전표 수정
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_update_transaction_records_apply(p_invoice_no text, p_tx_type text, p_new_records jsonb, p_admin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_return_of TEXT;
  v_line_routes BOOLEAN;
  v_old_wh JSONB;
  v_row_wh TEXT;
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

  SELECT transaction_type, warehouse_code, source_warehouse, target_warehouse, partner_name, return_of_invoice
  INTO v_first
  FROM public.stock_transactions
  WHERE public.fn_normalize_invoice_no(invoice_no) = v_canonical
    AND transaction_type = ANY (v_match_types)
  ORDER BY item_id, id
  LIMIT 1;

  v_type := v_first.transaction_type;
  v_wh := UPPER(COALESCE(NULLIF(TRIM(v_first.warehouse_code), ''), 'MAIN'));
  v_partner := COALESCE(v_first.partner_name, '');
  v_return_of := v_first.return_of_invoice;

  -- 출고 전표와 반품 입고 전표는 줄마다 창고가 다를 수 있다(센트로 구역 혼합 출고·줄별 반품 창고).
  v_line_routes := v_type = 'OUTBOUND' OR (v_type = 'INBOUND' AND v_return_of IS NOT NULL);
  IF v_route_count > 1 AND NOT v_line_routes THEN
    RAISE EXCEPTION '창고 경로가 서로 다른 행이 섞인 전표(%)는 수정할 수 없습니다.', v_canonical;
  END IF;

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

  -- 줄별 창고 전표: 새 행에 창고가 없으면 같은 품목의 기존 창고(한 곳일 때)를 쓴다.
  IF v_line_routes THEN
    SELECT jsonb_object_agg(t.item_id::TEXT, t.wh)
    INTO v_old_wh
    FROM (
      SELECT item_id, MIN(wh) AS wh
      FROM (
        SELECT item_id,
               UPPER(COALESCE(
                 NULLIF(TRIM(CASE WHEN v_type = 'OUTBOUND' THEN source_warehouse ELSE target_warehouse END), ''),
                 NULLIF(TRIM(warehouse_code), ''),
                 'MAIN')) AS wh
        FROM public.stock_transactions
        WHERE public.fn_normalize_invoice_no(invoice_no) = v_canonical
          AND transaction_type = ANY (v_match_types)
      ) r
      GROUP BY item_id
      HAVING COUNT(DISTINCT wh) = 1
    ) t;
  END IF;
  v_old_wh := COALESCE(v_old_wh, '{}'::JSONB);

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
      v_row_wh := CASE WHEN v_return_of IS NOT NULL
        THEN UPPER(COALESCE(NULLIF(TRIM(v_old.target_warehouse), ''), NULLIF(TRIM(v_old.warehouse_code), ''), v_dst))
        ELSE v_dst END;
      PERFORM public.fn_apply_stock_units(v_old.item_id, v_row_wh, -v_req, TRUE, '입고 전표 취소');
      IF v_pending_src IS NOT NULL THEN
        PERFORM public.fn_apply_stock_units(v_old.item_id, v_pending_src, v_req, FALSE, '서브창고 입고확정 취소');
      END IF;
    ELSIF v_type = 'OUTBOUND' THEN
      v_row_wh := UPPER(COALESCE(NULLIF(TRIM(v_old.source_warehouse), ''), NULLIF(TRIM(v_old.warehouse_code), ''), v_src));
      PERFORM public.fn_apply_stock_units(v_old.item_id, v_row_wh, v_req, FALSE, '출고 전표 취소');
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
        item_id UUID, item_name TEXT, color TEXT, box_content INT, box_qty INT, unit_qty INT, partner_name TEXT,
        warehouse TEXT
      )
      ORDER BY x.item_id NULLS LAST, UPPER(TRIM(COALESCE(x.warehouse, '')))
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

      IF NOT v_line_routes
         AND NULLIF(TRIM(COALESCE(v_new.warehouse, '')), '') IS NOT NULL
         AND UPPER(TRIM(v_new.warehouse)) <> COALESCE(v_src, v_dst, v_wh) THEN
        RAISE EXCEPTION '이 전표(%)는 줄마다 창고를 다르게 지정할 수 없습니다.', v_canonical;
      END IF;

      v_row_partner := COALESCE(NULLIF(TRIM(COALESCE(v_new.partner_name, '')), ''), v_partner);
      v_pack := public.fn_item_pack_qty(v_item_id);
      v_req := public.fn_stock_units(v_box, v_unit, v_pack);

      IF v_type = 'INBOUND' THEN
        IF v_return_of IS NOT NULL THEN
          v_row_wh := UPPER(TRIM(COALESCE(NULLIF(TRIM(v_new.warehouse), ''), v_old_wh->>v_item_id::TEXT, v_dst)));
          IF NOT EXISTS (SELECT 1 FROM public.warehouses WHERE code = v_row_wh) THEN
            RAISE EXCEPTION '반품받을 창고를 찾을 수 없습니다: %', v_row_wh;
          END IF;
        ELSE
          v_row_wh := v_dst;
        END IF;
        PERFORM public.fn_apply_stock_units(v_item_id, v_row_wh, v_req, FALSE, '수정 입고');
        IF v_pending_src IS NOT NULL THEN
          PERFORM public.fn_apply_stock_units(v_item_id, v_pending_src, -v_req, TRUE, '수정 서브창고 입고확정');
        END IF;
        INSERT INTO public.stock_transactions (
          transaction_type, item_id, warehouse_code, source_warehouse, target_warehouse,
          partner_name, box_qty, unit_qty, handler_name, invoice_no, memo, created_at, return_of_invoice
        ) VALUES (
          'INBOUND', v_item_id, v_row_wh, v_pending_src, v_row_wh,
          v_row_partner, v_box, v_unit, v_admin, v_canonical, v_memo, v_created_at, v_return_of
        );
      ELSIF v_type = 'OUTBOUND' THEN
        v_row_wh := public.fn_line_warehouse(v_src, COALESCE(NULLIF(TRIM(v_new.warehouse), ''), v_old_wh->>v_item_id::TEXT));
        PERFORM public.fn_assert_warehouse_atp(v_item_id, v_row_wh, v_req, '수정 출고');
        PERFORM public.fn_apply_stock_units(v_item_id, v_row_wh, -v_req, TRUE, '수정 출고');
        INSERT INTO public.stock_transactions (
          transaction_type, item_id, warehouse_code, source_warehouse, target_warehouse,
          partner_name, box_qty, unit_qty, handler_name, invoice_no, memo, created_at
        ) VALUES (
          'OUTBOUND', v_item_id, v_row_wh, v_row_wh, NULL,
          v_row_partner, v_box, v_unit, v_admin, v_canonical, v_memo, v_created_at
        );
      ELSIF v_type = 'MOVE' THEN
        PERFORM public.fn_assert_warehouse_atp(v_item_id, v_src, v_req, '수정 이동');
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

  -- 반품 불변식: 원 출고 전표를 고쳤으면 그 전표, 반품 전표를 고쳤으면 그 원 전표를 다시 검사한다.
  IF v_type = 'OUTBOUND' THEN
    PERFORM public.fn_assert_returns_within_outbound(v_canonical);
  ELSIF v_type = 'INBOUND' AND v_return_of IS NOT NULL THEN
    PERFORM public.fn_assert_returns_within_outbound(v_return_of);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_no', v_canonical,
    'tx_type', v_type,
    'line_count', v_inserted,
    'message', format('전표(%s)가 원자적으로 수정되었습니다.', v_canonical)
  );
END;
$function$;

-- ------------------------------------------------------------------------------
-- 4) 반품
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_process_return_apply(p_orig_invoice text, p_warehouse text, p_handler text, p_memo text, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_orig TEXT := public.fn_normalize_invoice_no(p_orig_invoice);
  v_wh TEXT := UPPER(TRIM(COALESCE(NULLIF(TRIM(p_warehouse), ''), 'MAIN')));
  v_line_wh TEXT;
  v_line_whs TEXT[] := ARRAY[]::TEXT[];
  v_out_wh TEXT;
  v_partner TEXT;
  v_invoice TEXT;
  v_memo TEXT;
  v_item RECORD;
  v_pack INT;
  v_req BIGINT;
  v_lines INT := 0;
  v_total BIGINT := 0;
BEGIN
  IF v_orig IS NULL OR v_orig = '' THEN
    RAISE EXCEPTION '원 출고 전표번호가 없습니다.';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION '반품할 품목이 없습니다.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.warehouses WHERE code = v_wh) THEN
    RAISE EXCEPTION '반품받을 창고를 찾을 수 없습니다: %', v_wh;
  END IF;

  -- 원 출고 행을 잠가 같은 전표의 동시 반품·수정을 직렬화한다(수정 RPC와 같은 잠금 순서).
  PERFORM 1
  FROM public.stock_transactions
  WHERE public.fn_normalize_invoice_no(invoice_no) = v_orig
    AND transaction_type IN ('OUTBOUND', 'MOVE')
  ORDER BY item_id, id
  FOR UPDATE;

  SELECT partner_name INTO v_partner
  FROM public.stock_transactions
  WHERE public.fn_normalize_invoice_no(invoice_no) = v_orig
    AND transaction_type = 'OUTBOUND'
  ORDER BY item_id, id
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION '출고 전표를 찾을 수 없습니다: % (이동 전표는 반품할 수 없습니다)', v_orig;
  END IF;

  v_invoice := public.rpc_next_invoice_no('INBOUND');
  -- 사용자 메모를 앞에 둔다(스모크 정리 스크립트가 '스모크테스트' 접두어로 테스트 전표를 찾는다).
  v_memo := COALESCE(NULLIF(TRIM(COALESCE(p_memo, '')), '') || ' ', '') || '[반품 · 원전표 ' || v_orig || ']';

  FOR v_item IN
    SELECT *
    FROM jsonb_to_recordset(p_items) AS x(item_id UUID, box_qty INT, unit_qty INT, warehouse TEXT)
    ORDER BY x.item_id, UPPER(TRIM(COALESCE(x.warehouse, '')))
  LOOP
    IF v_item.item_id IS NULL THEN
      RAISE EXCEPTION '품목 ID가 없는 행이 있습니다.';
    END IF;
    IF COALESCE(v_item.box_qty, 0) < 0 OR COALESCE(v_item.unit_qty, 0) < 0 THEN
      RAISE EXCEPTION '반품 수량은 음수일 수 없습니다.';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.stock_transactions
      WHERE public.fn_normalize_invoice_no(invoice_no) = v_orig
        AND transaction_type = 'OUTBOUND'
        AND item_id = v_item.item_id
    ) THEN
      RAISE EXCEPTION '원 출고 전표(%)에 없는 품목은 반품할 수 없습니다.', v_orig;
    END IF;

    v_pack := public.fn_item_pack_qty(v_item.item_id);
    v_req := public.fn_stock_units(COALESCE(v_item.box_qty, 0), COALESCE(v_item.unit_qty, 0), v_pack);
    IF v_req = 0 THEN
      CONTINUE;
    END IF;

    -- 반품받을 창고: 줄에 지정한 창고 → 그 품목을 출고한 창고(한 곳일 때) → p_warehouse
    v_line_wh := UPPER(NULLIF(TRIM(COALESCE(v_item.warehouse, '')), ''));
    IF v_line_wh IS NULL THEN
      SELECT MIN(UPPER(COALESCE(NULLIF(TRIM(source_warehouse), ''), NULLIF(TRIM(warehouse_code), ''), 'MAIN')))
      INTO v_out_wh
      FROM public.stock_transactions
      WHERE public.fn_normalize_invoice_no(invoice_no) = v_orig
        AND transaction_type = 'OUTBOUND'
        AND item_id = v_item.item_id
      HAVING COUNT(DISTINCT UPPER(COALESCE(NULLIF(TRIM(source_warehouse), ''), NULLIF(TRIM(warehouse_code), ''), 'MAIN'))) = 1;
      v_line_wh := COALESCE(v_out_wh, v_wh);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.warehouses WHERE code = v_line_wh) THEN
      RAISE EXCEPTION '반품받을 창고를 찾을 수 없습니다: %', v_line_wh;
    END IF;
    IF NOT (v_line_wh = ANY (v_line_whs)) THEN
      v_line_whs := v_line_whs || v_line_wh;
    END IF;

    PERFORM public.fn_apply_stock_units(v_item.item_id, v_line_wh, v_req, FALSE, '반품 입고');
    INSERT INTO public.stock_transactions (
      transaction_type, item_id, warehouse_code, source_warehouse, target_warehouse,
      partner_name, box_qty, unit_qty, handler_name, invoice_no, memo, return_of_invoice
    ) VALUES (
      'INBOUND', v_item.item_id, v_line_wh, NULL, v_line_wh,
      v_partner, COALESCE(v_item.box_qty, 0), COALESCE(v_item.unit_qty, 0), p_handler, v_invoice, v_memo, v_orig
    );
    v_lines := v_lines + 1;
    v_total := v_total + v_req;
  END LOOP;

  IF v_lines = 0 THEN
    RAISE EXCEPTION '반품 수량을 입력하세요.';
  END IF;

  PERFORM public.fn_assert_returns_within_outbound(v_orig);

  RETURN jsonb_build_object(
    'success', true,
    'invoice_no', v_invoice,
    'return_of_invoice', v_orig,
    'warehouse', CASE WHEN cardinality(v_line_whs) = 1 THEN v_line_whs[1] ELSE v_wh END,
    'line_warehouses', to_jsonb(v_line_whs),
    'partner', v_partner,
    'line_count', v_lines,
    'total_units', v_total
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.rpc_invoice_returnable(p_invoice_no text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_orig TEXT := public.fn_normalize_invoice_no(p_invoice_no);
  v_head RECORD;
  v_lines JSONB;
  v_returns JSONB;
BEGIN
  PERFORM public.fn_require_session();

  IF v_orig IS NULL OR v_orig = '' THEN
    RAISE EXCEPTION '원 출고 전표번호가 없습니다.';
  END IF;

  SELECT partner_name, UPPER(COALESCE(NULLIF(TRIM(source_warehouse), ''), NULLIF(TRIM(warehouse_code), ''), 'MAIN')) AS wh,
         MIN(created_at) OVER () AS created_at
  INTO v_head
  FROM public.stock_transactions
  WHERE public.fn_normalize_invoice_no(invoice_no) = v_orig
    AND transaction_type = 'OUTBOUND'
  ORDER BY item_id, id
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION '출고 전표를 찾을 수 없습니다: % (이동 전표는 반품할 수 없습니다)', v_orig;
  END IF;

  WITH outrows AS (
    SELECT item_id, box_qty, unit_qty,
           UPPER(COALESCE(NULLIF(TRIM(source_warehouse), ''), NULLIF(TRIM(warehouse_code), ''), 'MAIN')) AS wh,
           public.fn_stock_units(box_qty, unit_qty, public.fn_item_pack_qty(item_id)) AS units
    FROM public.stock_transactions
    WHERE public.fn_normalize_invoice_no(invoice_no) = v_orig
      AND transaction_type = 'OUTBOUND'
  ), outb AS (
    SELECT item_id,
           SUM(box_qty)::BIGINT AS box_qty,
           SUM(unit_qty)::BIGINT AS unit_qty,
           SUM(units) AS units
    FROM outrows
    GROUP BY item_id
  ), outwh AS (
    SELECT item_id,
           jsonb_agg(jsonb_build_object('warehouse', wh, 'units', units) ORDER BY wh) AS warehouses
    FROM (SELECT item_id, wh, SUM(units) AS units FROM outrows GROUP BY item_id, wh) w
    GROUP BY item_id
  ), ret AS (
    SELECT item_id, SUM(public.fn_stock_units(box_qty, unit_qty, public.fn_item_pack_qty(item_id))) AS units
    FROM public.stock_transactions
    WHERE return_of_invoice = v_orig
      AND transaction_type = 'INBOUND'
    GROUP BY item_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'item_id', o.item_id,
           'item_name', i.item_name,
           'color', COALESCE(i.color, 'SURTIDO'),
           'pack', public.fn_item_pack_qty(o.item_id),
           'out_box', o.box_qty,
           'out_unit', o.unit_qty,
           'out_units', o.units,
           'out_warehouses', COALESCE(w.warehouses, '[]'::JSONB),
           'returned_units', COALESCE(r.units, 0),
           'remaining_units', GREATEST(o.units - COALESCE(r.units, 0), 0)
         ) ORDER BY i.item_name, i.color), '[]'::JSONB)
  INTO v_lines
  FROM outb o
  LEFT JOIN outwh w ON w.item_id = o.item_id
  LEFT JOIN ret r ON r.item_id = o.item_id
  LEFT JOIN public.items i ON i.id = o.item_id;

  SELECT COALESCE(jsonb_agg(DISTINCT invoice_no), '[]'::JSONB)
  INTO v_returns
  FROM public.stock_transactions
  WHERE return_of_invoice = v_orig
    AND transaction_type = 'INBOUND';

  RETURN jsonb_build_object(
    'invoice_no', v_orig,
    'partner', v_head.partner_name,
    'warehouse', v_head.wh,
    'created_at', v_head.created_at,
    'lines', v_lines,
    'return_invoices', v_returns
  );
END;
$function$;

-- ------------------------------------------------------------------------------
-- 5) 출고 보류
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_save_outbound_hold(p_replace jsonb, p_warehouse text, p_partner text, p_admin text, p_hold_date text, p_created_label text, p_records jsonb, p_items jsonb, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_member public.app_members%ROWTYPE;
  v_cached JSONB;
  v_wh TEXT := UPPER(TRIM(COALESCE(p_warehouse, '')));
  v_consumed JSONB;
  v_id UUID;
  v_created_at TIMESTAMPTZ;
  v_item RECORD;
  v_line_wh TEXT;
  v_pack INTEGER;
  v_count INTEGER := 0;
  v_result JSONB;
BEGIN
  v_member := public.fn_require_admin();

  v_cached := public.fn_idempotency_lock(p_idempotency_key);
  IF v_cached IS NOT NULL THEN
    RETURN v_cached || jsonb_build_object('idempotent_replay', true);
  END IF;

  IF v_wh = '' OR NOT EXISTS (SELECT 1 FROM public.warehouses WHERE code = v_wh) THEN
    RAISE EXCEPTION '출발창고가 올바르지 않습니다: %', COALESCE(p_warehouse, '(없음)');
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION '보류할 품목이 없습니다.';
  END IF;

  -- 불러온 보류를 먼저 지워 자기 예약과 겹쳐 계산되지 않게 한다(실패하면 전체 롤백되어 그대로 남는다).
  v_consumed := public.fn_consume_outbound_holds(p_replace);
  v_created_at := COALESCE((v_consumed->>'created_at')::TIMESTAMPTZ, NOW());

  INSERT INTO public.outbound_holds (
    warehouse_code, partner_name, admin_name, hold_date, created_label, records, created_by, created_at
  ) VALUES (
    v_wh,
    NULLIF(TRIM(COALESCE(p_partner, '')), ''),
    COALESCE(NULLIF(TRIM(COALESCE(p_admin, '')), ''), v_member.member_name),
    p_hold_date,
    COALESCE(NULLIF(v_consumed->>'created_label', ''), p_created_label),
    COALESCE(p_records, '[]'::JSONB),
    v_member.member_name,
    v_created_at
  ) RETURNING id INTO v_id;

  -- (item_id, 창고) 순서로 잠가 동시 처리 간 교착을 방지한다. 줄에 창고가 없으면 보류의 출발창고.
  FOR v_item IN
    SELECT x.item_id,
           UPPER(TRIM(COALESCE(NULLIF(TRIM(x.warehouse), ''), v_wh))) AS warehouse,
           SUM(ABS(COALESCE(x.box_qty, 0)))::INTEGER AS box_qty,
           SUM(ABS(COALESCE(x.unit_qty, 0)))::INTEGER AS unit_qty
    FROM jsonb_to_recordset(p_items) AS x(item_id UUID, box_qty INT, unit_qty INT, warehouse TEXT)
    GROUP BY x.item_id, UPPER(TRIM(COALESCE(NULLIF(TRIM(x.warehouse), ''), v_wh)))
    ORDER BY x.item_id, 2
  LOOP
    IF v_item.item_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.items WHERE id = v_item.item_id) THEN
      RAISE EXCEPTION '등록되지 않은 품목이 있어 보류할 수 없습니다.';
    END IF;
    CONTINUE WHEN v_item.box_qty = 0 AND v_item.unit_qty = 0;

    v_line_wh := public.fn_line_warehouse(v_wh, v_item.warehouse);
    v_pack := public.fn_item_pack_qty(v_item.item_id);
    PERFORM public.fn_assert_warehouse_atp_core(
      v_item.item_id, v_line_wh, public.fn_stock_units(v_item.box_qty, v_item.unit_qty, v_pack), '보류', TRUE
    );
    INSERT INTO public.outbound_hold_items (hold_id, item_id, warehouse_code, box_qty, unit_qty)
    VALUES (v_id, v_item.item_id, v_line_wh, v_item.box_qty, v_item.unit_qty);
    v_count := v_count + 1;
  END LOOP;

  IF v_count = 0 THEN
    RAISE EXCEPTION '보류할 수량이 없습니다.';
  END IF;

  v_result := jsonb_build_object('success', true, 'id', v_id, 'version', 1, 'item_count', v_count,
                                 'replaced', COALESCE((v_consumed->>'count')::INT, 0));
  PERFORM public.fn_idempotency_store(p_idempotency_key, v_result);
  RETURN v_result;
END;
$function$;

-- ------------------------------------------------------------------------------
-- 6) 전표 지문에 창고 포함
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_invoice_signature(p_invoice_no text, p_tx_type text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT md5(COALESCE(string_agg(
    item_id::TEXT || ':' || box_qty || ':' || unit_qty || ':' || COALESCE(warehouse_code, ''), ','
    ORDER BY item_id::TEXT COLLATE "C", box_qty, unit_qty, COALESCE(warehouse_code, '') COLLATE "C"
  ), ''))
  FROM public.stock_transactions
  WHERE public.fn_normalize_invoice_no(invoice_no) = public.fn_normalize_invoice_no(p_invoice_no)
    AND transaction_type = ANY (public.fn_invoice_match_types(p_tx_type));
$function$;
