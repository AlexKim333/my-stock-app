-- ==============================================================================
-- 3단계 패치: 동시성·성능
--  * 재고조사(rpc_adjust_stock_apply) 품목 잠금 순서를 item_id로 고정 (교착 방지)
--  * fn_require_session: 매 호출마다 실행되던 만료 세션 DELETE 제거 (읽기 RPC가 쓰기가 되던 문제)
--    → 만료 세션/오래된 멱등 키 정리는 로그인 시점으로 이동
--  * 전표번호 정규화 표현식 인덱스 (전표 조회·수정·채번 시 전체 스캔 제거)
--  * PENDING FIFO 조회용 부분 인덱스, 멱등 키 정리용 인덱스
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.rpc_adjust_stock_apply(
  p_admin TEXT,
  p_items JSONB,
  p_warehouse TEXT DEFAULT 'MAIN',
  p_invoice TEXT DEFAULT NULL,
  p_memo TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_item RECORD;
  v_wh TEXT := UPPER(TRIM(COALESCE(p_warehouse, 'MAIN')));
  v_invoice TEXT := public.fn_normalize_invoice_no(p_invoice);
  v_item_id UUID;
  v_mode TEXT;
  v_pack INT;
  v_in_box INT;
  v_in_unit INT;
  v_prev_box INT;
  v_prev_unit INT;
  v_after_box INT;
  v_after_unit INT;
  v_delta_box INT;
  v_delta_unit INT;
  v_prev_units BIGINT;
  v_after_units BIGINT;
  v_count INT := 0;
BEGIN
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION '처리할 재고조사 데이터가 없습니다.';
  END IF;

  IF v_invoice IS NULL OR v_invoice = '' THEN
    v_invoice := public.rpc_next_invoice_no('ADJUST');
  END IF;

  -- item_id 순서로 잠근다. 같은 품목이 여러 번 오면 입력 순서(ord)를 유지한다.
  FOR v_item IN
    SELECT x.*
    FROM ROWS FROM (
      jsonb_to_recordset(p_items) AS (
        item_id UUID,
        adj_mode TEXT,
        box_qty INT,
        unit_qty INT,
        reason TEXT
      )
    ) WITH ORDINALITY AS x(item_id, adj_mode, box_qty, unit_qty, reason, ord)
    ORDER BY x.item_id, x.ord
  LOOP
    v_item_id := v_item.item_id;
    IF v_item_id IS NULL THEN
      RAISE EXCEPTION '품목 ID가 없는 재고조사 행이 있습니다.';
    END IF;

    v_mode := LOWER(TRIM(COALESCE(v_item.adj_mode, 'replace')));
    IF v_mode NOT IN ('replace', 'increment') THEN
      v_mode := 'replace';
    END IF;

    v_in_box := COALESCE(v_item.box_qty, 0);
    v_in_unit := COALESCE(v_item.unit_qty, 0);
    IF v_in_box < 0 OR v_in_unit < 0 THEN
      RAISE EXCEPTION '실사 수량에는 음수를 입력할 수 없습니다.';
    END IF;

    v_pack := public.fn_item_pack_qty(v_item_id);
    PERFORM public.fn_ensure_stock_row(v_item_id, v_wh);

    SELECT box_qty, unit_qty INTO v_prev_box, v_prev_unit
    FROM public.inventory_stocks
    WHERE item_id = v_item_id AND warehouse_code = v_wh
    FOR UPDATE;

    v_prev_units := public.fn_stock_units(v_prev_box, v_prev_unit, v_pack);
    IF v_mode = 'increment' THEN
      v_after_units := v_prev_units + public.fn_stock_units(v_in_box, v_in_unit, v_pack);
    ELSE
      v_after_units := public.fn_stock_units(v_in_box, v_in_unit, v_pack);
    END IF;

    IF v_after_units < 0 THEN
      RAISE EXCEPTION '재고조사 결과 음수 재고가 됩니다.';
    END IF;

    v_after_box := (v_after_units / v_pack)::INTEGER;
    v_after_unit := (v_after_units % v_pack)::INTEGER;
    v_delta_box := v_after_box - v_prev_box;
    v_delta_unit := v_after_unit - v_prev_unit;

    UPDATE public.inventory_stocks
    SET box_qty = v_after_box,
        unit_qty = v_after_unit,
        updated_at = NOW()
    WHERE item_id = v_item_id AND warehouse_code = v_wh;

    INSERT INTO public.stock_transactions (
      transaction_type, item_id, warehouse_code, box_qty, unit_qty,
      handler_name, invoice_no, memo
    ) VALUES (
      'ADJUST',
      v_item_id,
      v_wh,
      v_delta_box,
      v_delta_unit,
      COALESCE(p_admin, 'ADMIN'),
      v_invoice,
      COALESCE(
        p_memo,
        CASE WHEN v_mode = 'increment'
          THEN format('[추가] %s상자/%s개 → %s상자/%s개 (Δ %s/%s) %s', v_prev_box, v_prev_unit, v_after_box, v_after_unit, v_delta_box, v_delta_unit, COALESCE(v_item.reason, ''))
          ELSE format('[치환] %s상자/%s개 → %s상자/%s개 (Δ %s/%s) %s', v_prev_box, v_prev_unit, v_after_box, v_after_unit, v_delta_box, v_delta_unit, COALESCE(v_item.reason, ''))
        END
      )
    );

    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_no', v_invoice,
    'adjusted_count', v_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_adjust_stock_apply(TEXT, JSONB, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- 세션 확인은 조회만 한다. 만료 세션은 expires_at 조건으로 이미 걸러진다.
CREATE OR REPLACE FUNCTION public.fn_require_session()
RETURNS public.app_members
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_token TEXT := public.fn_request_session_token();
  v_hash TEXT;
  v_member public.app_members%ROWTYPE;
BEGIN
  IF v_token IS NULL OR v_token = '' THEN
    RAISE EXCEPTION '로그인이 필요합니다.';
  END IF;

  v_hash := public.fn_hash_session_token(v_token);

  SELECT m.*
    INTO v_member
  FROM public.app_sessions s
  JOIN public.app_members m ON m.id = s.member_id
  WHERE s.token_hash = v_hash
    AND s.expires_at > NOW()
    AND COALESCE(m.is_active, TRUE) = TRUE
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION '세션이 만료되었습니다. 다시 로그인하세요.';
  END IF;

  RETURN v_member;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_request_idempotency_created
  ON public.request_idempotency (created_at);

CREATE OR REPLACE FUNCTION public.rpc_login(p_member_name TEXT, p_password TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_row public.app_members%ROWTYPE;
  v_ok BOOLEAN := FALSE;
  v_token TEXT;
  v_hash TEXT;
BEGIN
  -- 정리 작업은 로그인 시점에만 수행한다 (모든 RPC마다 DELETE하지 않도록).
  DELETE FROM public.app_sessions WHERE expires_at < NOW();
  DELETE FROM public.request_idempotency WHERE created_at < NOW() - INTERVAL '2 days';

  SELECT * INTO v_row
  FROM public.app_members
  WHERE member_name = TRIM(COALESCE(p_member_name, ''))
    AND COALESCE(is_active, TRUE) = TRUE
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false);
  END IF;

  IF v_row.password_hash LIKE '$2a$%'
     OR v_row.password_hash LIKE '$2b$%'
     OR v_row.password_hash LIKE '$2y$%' THEN
    v_ok := (extensions.crypt(COALESCE(p_password, ''), v_row.password_hash) = v_row.password_hash);
  ELSE
    v_ok := (v_row.password_hash IS NOT DISTINCT FROM p_password);
    IF v_ok THEN
      UPDATE public.app_members
      SET password_hash = extensions.crypt(p_password, extensions.gen_salt('bf', 10))
      WHERE id = v_row.id;
    END IF;
  END IF;

  IF NOT v_ok THEN
    RETURN jsonb_build_object('success', false);
  END IF;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_hash := public.fn_hash_session_token(v_token);

  INSERT INTO public.app_sessions (member_id, token_hash, expires_at)
  VALUES (v_row.id, v_hash, NOW() + INTERVAL '12 hours');

  RETURN jsonb_build_object(
    'success', true,
    'session_token', v_token,
    'expires_at', (NOW() + INTERVAL '12 hours'),
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

GRANT EXECUTE ON FUNCTION public.rpc_login(TEXT, TEXT) TO anon, authenticated, service_role;

-- 전표번호 정규화 표현식 인덱스: = 비교와 'YYYY/MM/DD-%' 접두 LIKE 모두 사용 가능 (text_pattern_ops)
CREATE INDEX IF NOT EXISTS idx_stock_transactions_invoice_norm
  ON public.stock_transactions (public.fn_normalize_invoice_no(invoice_no) text_pattern_ops, transaction_type);

-- PENDING FIFO 입고확정 / 서브창고 매트릭스 조회
CREATE INDEX IF NOT EXISTS idx_pending_orders_open_fifo
  ON public.pending_orders (from_warehouse, item_id, created_at)
  WHERE status IN ('PENDING', 'IN_TRANSIT');

-- 품목별 원장 조회 (item_id + 최신순)
CREATE INDEX IF NOT EXISTS idx_stock_transactions_item_created
  ON public.stock_transactions (item_id, created_at DESC);
