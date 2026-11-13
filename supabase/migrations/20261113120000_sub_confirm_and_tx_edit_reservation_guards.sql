-- ==============================================================================
-- 서브창고 입고확정·전표 수정이 출고 보류/입고 예정 발주를 침범하지 않게 막는다
--
-- 배경(2026-11-13 정합성 점검):
--   * 서브창고 입고확정(rpc_process_transaction_apply, p_pending_from_warehouse)은 열린 발주를 FIFO로 완료한 뒤
--     확정 수량 전체를 서브창고에서 뺀다. 열린 발주보다 많이 확정하면(발주 없이 바로 확정하는 경우 포함)
--     초과분이 그 창고의 출고 보류·남은 발주 예약을 확인하지 않고 빠졌다.
--   * 전표 수정(rpc_update_transaction_records_apply)의 입고 취소·이동 도착창고 취소·재고조정 취소/재반영·
--     서브창고 입고확정 재차감은 실재고 >= 0만 확인해, 보류·발주에 묶인 재고 아래로 내려갈 수 있었다.
--   * 서브창고 입고확정 전표 수정으로 확정 수량을 늘려도 열린 발주를 더 완료하지 않았고,
--     비활성 창고로 가는 이동 전표를 수정으로 늘릴 수 있었다.
-- 조치:
--   1) fn_assert_stock_covers_reservations: 창고·품목 실재고가 출고 보류 + (서브창고면) MAIN 입고 예정 발주 이상인지 검사.
--   2) 입고확정: 열린 발주를 넘는 초과분만 fn_assert_warehouse_atp로 검사한다(발주 완료분은 원래 예약이었으니 통과).
--   3) 전표 수정: (품목, 창고)별 순증감을 모아, 줄어든 곳만 마지막에 1)로 검사한다. 원래 예약보다 적던 재고를
--      늘리는 수정은 허용한다(20261022120000 재고조정 가드와 같은 원칙).
--      입고확정 전표의 확정 수량이 늘면 늘어난 만큼 열린 발주를 FIFO로 완료한다. 줄여도 완료된 발주는 다시 열지 않는다
--      (어느 발주를 열지 정할 수 없음 — 필요하면 발주를 새로 등록).
--      비활성 창고(SMOKETEST 제외)로 가는 이동 전표는 품목 수량을 늘리는 수정을 거절한다(줄이기·삭제는 허용).
-- 본문은 운영 정의(pg_get_functiondef, 2026-11-13)에 위 검사만 더했다.
-- ==============================================================================

-- 1) 예약 하한 검사 --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_assert_stock_covers_reservations(p_item_id uuid, p_warehouse text, p_ctx text DEFAULT '전표 수정'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_wh TEXT := UPPER(TRIM(COALESCE(p_warehouse, 'MAIN')));
  v_pack INTEGER;
  v_box INTEGER;
  v_unit INTEGER;
  v_gross BIGINT;
  v_committed BIGINT := 0;
  v_held BIGINT;
  v_label TEXT;
  v_parts TEXT;
BEGIN
  IF v_wh = '' OR p_item_id IS NULL THEN
    RETURN;
  END IF;

  v_pack := public.fn_item_pack_qty(p_item_id);
  SELECT box_qty, unit_qty INTO v_box, v_unit
  FROM public.inventory_stocks
  WHERE item_id = p_item_id AND warehouse_code = v_wh
  FOR UPDATE;
  v_gross := public.fn_stock_units(COALESCE(v_box, 0), COALESCE(v_unit, 0), v_pack);

  IF v_wh <> 'MAIN' THEN
    SELECT COALESCE(SUM(public.fn_stock_units(box_qty, unit_qty, v_pack)), 0) INTO v_committed
    FROM public.pending_orders
    WHERE item_id = p_item_id
      AND from_warehouse = v_wh
      AND to_warehouse = 'MAIN'
      AND status IN ('PENDING', 'IN_TRANSIT');
  END IF;

  v_held := public.fn_outbound_held_units(p_item_id, v_wh);

  IF v_gross < v_committed + v_held THEN
    SELECT item_name || ' (' || COALESCE(color, 'SURTIDO') || ')' INTO v_label
    FROM public.items WHERE id = p_item_id;
    v_parts := '';
    IF v_committed > 0 THEN
      v_parts := v_parts || format(' MAIN 입고 예정 발주 %s상자 %s개', v_committed / v_pack, v_committed % v_pack);
    END IF;
    IF v_held > 0 THEN
      v_parts := v_parts || format(' 출고 보류 %s상자 %s개', v_held / v_pack, v_held % v_pack);
    END IF;
    RAISE EXCEPTION '% 불가: 창고 % % — 처리 후 실재고 %상자 %개가 예약(%)보다 적어집니다.%',
      COALESCE(NULLIF(TRIM(p_ctx), ''), '전표 수정'), v_wh, COALESCE(v_label, p_item_id::TEXT),
      v_gross / v_pack, v_gross % v_pack, TRIM(v_parts),
      CASE
        WHEN v_committed > 0 AND v_held > 0 THEN ' 발주나 출고 보류를 먼저 줄이거나 취소하세요.'
        WHEN v_committed > 0 THEN ' 발주를 먼저 줄이거나 취소하세요.'
        ELSE ' 출고 보류를 먼저 줄이거나 삭제하세요.'
      END;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_assert_stock_covers_reservations(uuid, text, text) FROM PUBLIC, anon, authenticated;

-- jsonb 누적 맵 헬퍼: j[k] += d
CREATE OR REPLACE FUNCTION public.fn_jsonb_add_units(j jsonb, k text, d bigint)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT jsonb_set(COALESCE(j, '{}'::jsonb), ARRAY[k], to_jsonb(COALESCE((j->>k)::BIGINT, 0) + COALESCE(d, 0)));
$function$;

REVOKE ALL ON FUNCTION public.fn_jsonb_add_units(jsonb, text, bigint) FROM PUBLIC, anon, authenticated;

-- 2) 입고확정 초과분 가드 ------------------------------------------------------------------
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
  v_open BIGINT;
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
    -- 비활성(또는 없는) 창고로는 옮기지 않는다. 지점 거래처가 활성으로 남아 있어도 막는다.
    -- SMOKETEST는 UI에 안 보이게 비활성으로 두는 스모크 전용 창고라 예외로 둔다.
    IF v_dest_wh <> 'SMOKETEST' AND NOT EXISTS (
      SELECT 1 FROM public.warehouses WHERE code = v_dest_wh AND is_active
    ) THEN
      RAISE EXCEPTION '[비활성 창고] 도착창고 %은(는) 비활성 상태이거나 없는 창고라 이동할 수 없습니다.', v_dest_wh;
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
        -- 열린 발주를 넘는 확정분은 그 서브창고의 출고 보류·남은 발주 예약을 침범하면 안 된다.
        -- (발주 완료분은 원래 MAIN으로 보낼 예약이었으니 검사하지 않는다. 발주 완료 전에 검사해야
        --  남은 예약 = 열린 발주 전체로 계산된다.)
        SELECT COALESCE(SUM(public.fn_stock_units(box_qty, unit_qty, v_pack)), 0) INTO v_open
        FROM public.pending_orders
        WHERE from_warehouse = v_pending_wh
          AND item_id = v_item_id
          AND status IN ('PENDING', 'IN_TRANSIT');
        IF v_req > v_open THEN
          PERFORM public.fn_assert_warehouse_atp(v_item_id, v_pending_wh, v_req - v_open, '서브창고 입고확정(발주 초과분)');
        END IF;
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

-- 3) 전표 수정 예약 가드 -------------------------------------------------------------------
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
  -- (품목|창고)별 순증감, 품목별 옛/새 수량(입고확정 발주 완료·비활성 도착창고 판단용)
  v_delta JSONB := '{}'::JSONB;
  v_old_units JSONB := '{}'::JSONB;
  v_new_units JSONB := '{}'::JSONB;
  v_key TEXT;
  v_val TEXT;
  v_more BIGINT;
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
    v_old_units := public.fn_jsonb_add_units(v_old_units, v_old.item_id::TEXT, v_req);

    IF v_type = 'INBOUND' THEN
      v_row_wh := CASE WHEN v_return_of IS NOT NULL
        THEN UPPER(COALESCE(NULLIF(TRIM(v_old.target_warehouse), ''), NULLIF(TRIM(v_old.warehouse_code), ''), v_dst))
        ELSE v_dst END;
      PERFORM public.fn_apply_stock_units(v_old.item_id, v_row_wh, -v_req, TRUE, '입고 전표 취소');
      v_delta := public.fn_jsonb_add_units(v_delta, v_old.item_id::TEXT || '|' || v_row_wh, -v_req);
      IF v_pending_src IS NOT NULL THEN
        PERFORM public.fn_apply_stock_units(v_old.item_id, v_pending_src, v_req, FALSE, '서브창고 입고확정 취소');
        v_delta := public.fn_jsonb_add_units(v_delta, v_old.item_id::TEXT || '|' || v_pending_src, v_req);
      END IF;
    ELSIF v_type = 'OUTBOUND' THEN
      v_row_wh := UPPER(COALESCE(NULLIF(TRIM(v_old.source_warehouse), ''), NULLIF(TRIM(v_old.warehouse_code), ''), v_src));
      PERFORM public.fn_apply_stock_units(v_old.item_id, v_row_wh, v_req, FALSE, '출고 전표 취소');
      v_delta := public.fn_jsonb_add_units(v_delta, v_old.item_id::TEXT || '|' || v_row_wh, v_req);
    ELSIF v_type = 'MOVE' THEN
      PERFORM public.fn_apply_stock_units(v_old.item_id, v_src, v_req, FALSE, '이동 전표 취소');
      PERFORM public.fn_apply_stock_units(v_old.item_id, v_dst, -v_req, TRUE, '이동 전표 취소');
      v_delta := public.fn_jsonb_add_units(v_delta, v_old.item_id::TEXT || '|' || v_src, v_req);
      v_delta := public.fn_jsonb_add_units(v_delta, v_old.item_id::TEXT || '|' || v_dst, -v_req);
    ELSIF v_type = 'ADJUST' THEN
      -- ADJUST 행은 부호 있는 증감(Δ)으로 저장된다.
      PERFORM public.fn_apply_stock_units(v_old.item_id, v_wh, -v_req, TRUE, '재고조정 전표 취소');
      v_delta := public.fn_jsonb_add_units(v_delta, v_old.item_id::TEXT || '|' || v_wh, -v_req);
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
      v_new_units := public.fn_jsonb_add_units(v_new_units, v_item_id::TEXT, v_req);

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
        v_delta := public.fn_jsonb_add_units(v_delta, v_item_id::TEXT || '|' || v_row_wh, v_req);
        IF v_pending_src IS NOT NULL THEN
          PERFORM public.fn_apply_stock_units(v_item_id, v_pending_src, -v_req, TRUE, '수정 서브창고 입고확정');
          v_delta := public.fn_jsonb_add_units(v_delta, v_item_id::TEXT || '|' || v_pending_src, -v_req);
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
        v_delta := public.fn_jsonb_add_units(v_delta, v_item_id::TEXT || '|' || v_row_wh, -v_req);
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
        v_delta := public.fn_jsonb_add_units(v_delta, v_item_id::TEXT || '|' || v_src, -v_req);
        v_delta := public.fn_jsonb_add_units(v_delta, v_item_id::TEXT || '|' || v_dst, v_req);
        INSERT INTO public.stock_transactions (
          transaction_type, item_id, warehouse_code, source_warehouse, target_warehouse,
          partner_name, box_qty, unit_qty, handler_name, invoice_no, memo, created_at
        ) VALUES (
          'MOVE', v_item_id, v_src, v_src, v_dst,
          v_row_partner, v_box, v_unit, v_admin, v_canonical, v_memo, v_created_at
        );
      ELSE
        PERFORM public.fn_apply_stock_units(v_item_id, v_wh, v_req, TRUE, '수정 재고조정');
        v_delta := public.fn_jsonb_add_units(v_delta, v_item_id::TEXT || '|' || v_wh, v_req);
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

  -- 3. 수량이 늘어난 품목: 입고확정이면 늘어난 만큼 열린 발주를 완료하고, 비활성 창고로의 이동이면 거절한다.
  FOR v_key, v_val IN SELECT key, value FROM jsonb_each_text(v_new_units) ORDER BY key
  LOOP
    v_more := v_val::BIGINT - COALESCE((v_old_units->>v_key)::BIGINT, 0);
    CONTINUE WHEN v_more <= 0;
    IF v_type = 'INBOUND' AND v_pending_src IS NOT NULL THEN
      PERFORM public.fn_fifo_complete_pending(v_pending_src, v_key::UUID, v_more);
    ELSIF v_type = 'MOVE' AND v_dst <> 'SMOKETEST'
          AND NOT EXISTS (SELECT 1 FROM public.warehouses WHERE code = v_dst AND is_active) THEN
      RAISE EXCEPTION '[비활성 창고] 도착창고 %은(는) 비활성 상태이거나 없는 창고라 이동 수량을 늘릴 수 없습니다.', v_dst;
    END IF;
  END LOOP;

  -- 4. 재고가 줄어든 (품목, 창고)는 출고 보류·입고 예정 발주 아래로 내려가면 안 된다.
  FOR v_key, v_val IN SELECT key, value FROM jsonb_each_text(v_delta) ORDER BY key
  LOOP
    CONTINUE WHEN v_val::BIGINT >= 0;
    PERFORM public.fn_assert_stock_covers_reservations(
      split_part(v_key, '|', 1)::UUID, split_part(v_key, '|', 2), '전표 수정');
  END LOOP;

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
