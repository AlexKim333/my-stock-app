-- 반품 입고: 원 출고 전표는 그대로 두고, 반품을 반품일 기준의 새 입고(INBOUND) 전표로 남긴다.
--
-- 지금까지는 검색수정에서 원 출고 전표의 행을 지워 반품을 처리했다. 재고는 맞게 돌아오지만
-- stock_transactions 행이 삭제되어 판매 이력·보고서·수불원장에서 과거 판매가 소급해 사라졌다.
--
-- 설계: transaction_type은 'INBOUND' 그대로 두고 return_of_invoice(원 출고 전표번호)로 반품을 구분한다.
--   - 재고 +로 처리하는 기존 집계(수불원장 잔액, 정합성 검사, 재고 집계 RPC, AI 조회)는 손대지 않아도 맞다.
--   - 입고 합계를 보여 주는 화면(기간 보고서·대시보드·수불원장)은 이 컬럼으로 반품을 따로 뺀다.
--
-- 불변식: 원 출고 전표의 품목별 반품 합계(낱개 환산) ≤ 그 전표의 출고 수량.
--   - 반품 등록(rpc_process_return)에서 검사한다.
--   - 검색수정으로 원 출고 전표를 줄이거나 지울 때, 반품 전표를 늘릴 때도 같은 검사를 한다
--     (rpc_update_transaction_records_apply 패치). 반품 전표를 고쳐도 원 전표 연결은 유지된다.

-- 1) 컬럼 -------------------------------------------------------------------------------------
ALTER TABLE public.stock_transactions ADD COLUMN IF NOT EXISTS return_of_invoice TEXT;

COMMENT ON COLUMN public.stock_transactions.return_of_invoice IS
  '반품 입고(INBOUND) 행이면 원 출고 전표번호(정규화된 YYYY/MM/DD-NNN). 일반 입고·출고는 NULL.';

CREATE INDEX IF NOT EXISTS idx_stock_transactions_return_of_invoice
  ON public.stock_transactions (return_of_invoice)
  WHERE return_of_invoice IS NOT NULL;

-- 2) 불변식 검사 ------------------------------------------------------------------------------
-- 원 출고 전표의 품목별 반품 합계가 출고 수량을 넘으면 예외. 낱개 환산은 현재 입수 기준.
CREATE OR REPLACE FUNCTION public.fn_assert_returns_within_outbound(p_orig_invoice TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_orig TEXT := public.fn_normalize_invoice_no(p_orig_invoice);
  v_bad RECORD;
BEGIN
  IF v_orig IS NULL OR v_orig = '' THEN
    RETURN;
  END IF;

  WITH outb AS (
    SELECT item_id, SUM(public.fn_stock_units(box_qty, unit_qty, public.fn_item_pack_qty(item_id))) AS units
    FROM public.stock_transactions
    WHERE public.fn_normalize_invoice_no(invoice_no) = v_orig
      AND transaction_type = 'OUTBOUND'
    GROUP BY item_id
  ), ret AS (
    SELECT item_id, SUM(public.fn_stock_units(box_qty, unit_qty, public.fn_item_pack_qty(item_id))) AS units
    FROM public.stock_transactions
    WHERE return_of_invoice = v_orig
      AND transaction_type = 'INBOUND'
    GROUP BY item_id
  )
  SELECT r.item_id, r.units AS ret_units, COALESCE(o.units, 0) AS out_units,
         i.item_name, COALESCE(i.color, 'SURTIDO') AS color
  INTO v_bad
  FROM ret r
  LEFT JOIN outb o ON o.item_id = r.item_id
  LEFT JOIN public.items i ON i.id = r.item_id
  WHERE r.units > COALESCE(o.units, 0)
  ORDER BY i.item_name
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION '반품 수량이 원 출고 수량을 넘습니다: % (%) — 원 전표 % 출고 %개, 반품 합계 %개',
      COALESCE(v_bad.item_name, v_bad.item_id::TEXT), v_bad.color, v_orig, v_bad.out_units, v_bad.ret_units;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.fn_assert_returns_within_outbound(TEXT) FROM PUBLIC, anon, authenticated;

-- 3) 반품 가능 수량 조회 ------------------------------------------------------------------------
-- 원 출고 전표의 품목별 출고·기반품·남은 수량(낱개)을 돌려준다. 로그인한 사용자 누구나 조회 가능.
CREATE OR REPLACE FUNCTION public.rpc_invoice_returnable(p_invoice_no TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
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

  WITH outb AS (
    SELECT item_id,
           SUM(box_qty)::BIGINT AS box_qty,
           SUM(unit_qty)::BIGINT AS unit_qty,
           SUM(public.fn_stock_units(box_qty, unit_qty, public.fn_item_pack_qty(item_id))) AS units
    FROM public.stock_transactions
    WHERE public.fn_normalize_invoice_no(invoice_no) = v_orig
      AND transaction_type = 'OUTBOUND'
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
           'returned_units', COALESCE(r.units, 0),
           'remaining_units', GREATEST(o.units - COALESCE(r.units, 0), 0)
         ) ORDER BY i.item_name, i.color), '[]'::JSONB)
  INTO v_lines
  FROM outb o
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
$$;
REVOKE ALL ON FUNCTION public.rpc_invoice_returnable(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_invoice_returnable(TEXT) TO anon, authenticated, service_role;

-- 4) 반품 등록 --------------------------------------------------------------------------------
-- p_items: [{ item_id, box_qty, unit_qty }] — 원 출고 전표에 있는 품목만. 수량 0인 행은 건너뛴다.
-- 거래처는 원 전표의 거래처, 전표번호는 오늘 날짜의 입고 번호로 새로 채번한다.
CREATE OR REPLACE FUNCTION public.rpc_process_return_apply(
  p_orig_invoice TEXT,
  p_warehouse TEXT,
  p_handler TEXT,
  p_memo TEXT,
  p_items JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_orig TEXT := public.fn_normalize_invoice_no(p_orig_invoice);
  v_wh TEXT := UPPER(TRIM(COALESCE(NULLIF(TRIM(p_warehouse), ''), 'MAIN')));
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
    FROM jsonb_to_recordset(p_items) AS x(item_id UUID, box_qty INT, unit_qty INT)
    ORDER BY x.item_id
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

    PERFORM public.fn_apply_stock_units(v_item.item_id, v_wh, v_req, FALSE, '반품 입고');
    INSERT INTO public.stock_transactions (
      transaction_type, item_id, warehouse_code, source_warehouse, target_warehouse,
      partner_name, box_qty, unit_qty, handler_name, invoice_no, memo, return_of_invoice
    ) VALUES (
      'INBOUND', v_item.item_id, v_wh, NULL, v_wh,
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
    'warehouse', v_wh,
    'partner', v_partner,
    'line_count', v_lines,
    'total_units', v_total
  );
END;
$$;
REVOKE ALL ON FUNCTION public.rpc_process_return_apply(TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.rpc_process_return(
  p_orig_invoice TEXT,
  p_warehouse TEXT,
  p_memo TEXT,
  p_items JSONB,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_member public.app_members%ROWTYPE;
  v_cached JSONB;
  v_result JSONB;
BEGIN
  v_member := public.fn_require_admin();
  v_cached := public.fn_idempotency_lock(p_idempotency_key);
  IF v_cached IS NOT NULL THEN
    RETURN v_cached || jsonb_build_object('idempotent_replay', true);
  END IF;

  v_result := public.rpc_process_return_apply(
    p_orig_invoice,
    p_warehouse,
    COALESCE(NULLIF(TRIM(v_member.member_name), ''), 'ADMIN'),
    p_memo,
    p_items
  );

  PERFORM public.fn_idempotency_store(p_idempotency_key, v_result);
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.rpc_process_return(TEXT, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_process_return(TEXT, TEXT, TEXT, JSONB, TEXT) TO anon, authenticated, service_role;

-- 5) 전표 수정에 반품 반영 (운영 정의에서 정확히 한 번 나오는 문장만 교체) -----------------------
--   - 반품 전표를 고쳐도 return_of_invoice를 유지한다.
--   - 수정 결과가 불변식을 깨면(원 출고를 반품 합계 아래로 줄임, 반품을 출고보다 늘림) 롤백한다.
DO $$
DECLARE
  v_fn REGPROCEDURE := 'public.rpc_update_transaction_records_apply(text,text,jsonb,text)'::regprocedure;
  v_patch RECORD;
  v_def TEXT;
  v_hits INT;
BEGIN
  v_def := pg_get_functiondef(v_fn);
  FOR v_patch IN
    SELECT * FROM (VALUES
      (1, E'  v_inserted INT := 0;\nBEGIN',
          E'  v_inserted INT := 0;\n  v_return_of TEXT;\nBEGIN'),
      (2, E'  SELECT transaction_type, warehouse_code, source_warehouse, target_warehouse, partner_name\n  INTO v_first',
          E'  SELECT transaction_type, warehouse_code, source_warehouse, target_warehouse, partner_name, return_of_invoice\n  INTO v_first'),
      (3, E'  v_partner := COALESCE(v_first.partner_name, '''');',
          E'  v_partner := COALESCE(v_first.partner_name, '''');\n  v_return_of := v_first.return_of_invoice;'),
      (4, E'invoice_no, memo, created_at\n        ) VALUES (\n          ''INBOUND'', v_item_id, v_dst, v_pending_src, v_dst,\n          v_row_partner, v_box, v_unit, v_admin, v_canonical, v_memo, v_created_at\n        );',
          E'invoice_no, memo, created_at, return_of_invoice\n        ) VALUES (\n          ''INBOUND'', v_item_id, v_dst, v_pending_src, v_dst,\n          v_row_partner, v_box, v_unit, v_admin, v_canonical, v_memo, v_created_at, v_return_of\n        );'),
      (5, E'  RETURN jsonb_build_object(\n    ''success'', true,\n    ''invoice_no'', v_canonical,',
          E'  -- 반품 불변식: 원 출고 전표를 고쳤으면 그 전표, 반품 전표를 고쳤으면 그 원 전표를 다시 검사한다.\n  IF v_type = ''OUTBOUND'' THEN\n    PERFORM public.fn_assert_returns_within_outbound(v_canonical);\n  ELSIF v_type = ''INBOUND'' AND v_return_of IS NOT NULL THEN\n    PERFORM public.fn_assert_returns_within_outbound(v_return_of);\n  END IF;\n\n  RETURN jsonb_build_object(\n    ''success'', true,\n    ''invoice_no'', v_canonical,')
    ) AS t(n, old_text, new_text)
    ORDER BY n
  LOOP
    v_hits := (length(v_def) - length(replace(v_def, v_patch.old_text, ''))) / length(v_patch.old_text);
    IF v_hits <> 1 THEN
      RAISE EXCEPTION 'rpc_update_transaction_records_apply 패치 %: 바꿀 문장이 % 번 발견되었습니다(1번이어야 함).', v_patch.n, v_hits;
    END IF;
    v_def := replace(v_def, v_patch.old_text, v_patch.new_text);
  END LOOP;
  EXECUTE v_def;
END;
$$;
