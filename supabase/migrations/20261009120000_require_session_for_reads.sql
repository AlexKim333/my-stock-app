-- ============================================================================
-- 로그인하지 않은 사람은 재고·전표·마스터 데이터를 조회할 수 없게 한다.
--
-- 지금까지 읽기 RLS가 `TO anon USING (true)`라서 앱에 들어 있는 anon 키만 있으면
-- 로그인 없이 REST로 재고·전표를 그대로 읽을 수 있었다. 쓰기는 이미 RPC 안의
-- fn_require_session()/fn_require_admin()으로 막혀 있으므로, 읽기도 같은 세션
-- 토큰(x-wms-session 헤더, src/lib/supabase.js가 모든 요청에 실어 보냄)을 요구한다.
--
-- 세션이 없으면 빈 결과(= 재고 0으로 보이는 사고) 대신 '로그인이 필요합니다.' 오류를 낸다.
-- 브릿지(supabaseAdapter.js)는 이 문구를 세션 오류로 인식해 로그인 창을 띄운다.
--
-- 로그인 전에도 필요한 것은 그대로 둔다:
--   - rpc_login / app_members_public(로그인 드롭다운의 작업자 이름)
--   - Realtime 변경 신호: 헤더를 보낼 수 없는 Realtime 대신 수량이 없는
--     stock_change_signals(품목 id·창고 코드만)를 구독한다.
-- ============================================================================

-- 1. 세션 확인 (읽기 전용: fn_require_session과 달리 만료 세션 정리 DELETE를 하지 않으므로 STABLE)
CREATE OR REPLACE FUNCTION public.fn_assert_read_session()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_token TEXT := public.fn_request_session_token();
BEGIN
  IF v_token IS NULL OR v_token = '' THEN
    RAISE EXCEPTION '로그인이 필요합니다.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.app_sessions s
    JOIN public.app_members m ON m.id = s.member_id
    WHERE s.token_hash = public.fn_hash_session_token(v_token)
      AND s.expires_at > NOW()
      AND COALESCE(m.is_active, TRUE) = TRUE
  ) THEN
    RAISE EXCEPTION '세션이 만료되었습니다. 다시 로그인하세요.';
  END IF;

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_assert_read_session() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_assert_read_session() TO anon, authenticated, service_role;

-- 2. 읽기 RLS: (SELECT ...)로 감싸 쿼리당 한 번만 평가되게 한다(행마다 세션 조회 방지).
DO $$
DECLARE
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'aliases', 'brands', 'inventory_stocks', 'items', 'partners',
    'pending_orders', 'stock_baselines', 'stock_transactions', 'warehouses'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_table || '_select', v_table);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO anon, authenticated USING ((SELECT public.fn_assert_read_session()))',
      v_table || '_select', v_table
    );
  END LOOP;
END;
$$;

-- 3. 소유자 권한으로 돌던 뷰는 RLS를 우회하므로 호출자 권한으로 바꾼다.
--    (ai_readonly는 기초 테이블마다 자체 SELECT 정책이 있어 영향 없음)
ALTER VIEW public.view_effective_stocks SET (security_invoker = true);
ALTER VIEW public.view_truck_gauge_summary SET (security_invoker = true);

-- 4. RLS를 우회하던 SECURITY DEFINER 조회 함수
--    rpc_list_effective_stocks: 호출자 권한으로 바꾸면 위 RLS가 그대로 적용된다.
ALTER FUNCTION public.rpc_list_effective_stocks() SECURITY INVOKER;

--    rpc_peek_next_invoice_seq: invoice_sequences 직접 권한이 없어 DEFINER가 필요하므로 세션 확인만 추가.
CREATE OR REPLACE FUNCTION public.rpc_peek_next_invoice_seq(p_tx_type text, p_biz_date date DEFAULT NULL::date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_group TEXT := public.fn_invoice_tx_group(p_tx_type);
  v_date DATE := COALESCE(
    p_biz_date,
    (timezone('America/Mexico_City', now()))::date
  );
  v_seq INTEGER := 0;
  v_seed INTEGER := 0;
  v_types TEXT[];
BEGIN
  PERFORM public.fn_assert_read_session();

  IF v_group = 'INBOUND' THEN
    v_types := ARRAY['INBOUND'];
  ELSIF v_group = 'ADJUST' THEN
    v_types := ARRAY['ADJUST'];
  ELSE
    v_types := ARRAY['OUTBOUND', 'MOVE'];
  END IF;

  SELECT last_seq INTO v_seq
  FROM public.invoice_sequences
  WHERE biz_date = v_date AND tx_group = v_group;

  v_seq := COALESCE(v_seq, 0);

  SELECT COALESCE(MAX(public.fn_parse_invoice_seq(invoice_no)), 0)
  INTO v_seed
  FROM public.stock_transactions
  WHERE transaction_type = ANY (v_types)
    AND public.fn_normalize_invoice_no(invoice_no) LIKE (
      to_char(v_date, 'YYYY/MM/DD') || '-%'
    );

  RETURN GREATEST(v_seq, v_seed) + 1;
END;
$function$;

-- 5. 로그인 없이 호출되던 쓰기 함수
--    rpc_normalize_safe_stock_units: 안전재고를 일괄 변경하는 유지보수 함수. 관리자 전용으로 막는다.
CREATE OR REPLACE FUNCTION public.rpc_normalize_safe_stock_units()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_updated_count INT := 0;
  v_details JSONB := '[]'::JSONB;
  v_row RECORD;
  v_new_box INT;
BEGIN
  PERFORM public.fn_require_admin();

  -- 대상: 메인 창고 재고 중,
  -- 1) 안전재고가 박스당 포장수량 이상이거나,
  -- 2) 안전재고가 50 이상이면서 박스당 포장수량이 1보다 큰 품목
  -- (단, 사용자 요청에 따라 실제 피크 상자 출고 품목인 LIGA1204는 보존)
  FOR v_row IN
    SELECT
      s.id AS stock_row_id,
      s.item_id,
      i.item_name,
      i.color,
      i.box_packaging_qty,
      s.safe_stock_boxes,
      s.warehouse_code
    FROM public.inventory_stocks s
    JOIN public.items i ON s.item_id = i.id
    WHERE s.warehouse_code = 'MAIN'
      AND s.safe_stock_boxes > 0
      AND i.item_name <> 'LIGA1204'
      AND (
        s.safe_stock_boxes >= i.box_packaging_qty
        OR (s.safe_stock_boxes >= 50 AND i.box_packaging_qty > 1)
      )
  LOOP
    -- 포장수량 기준 올림(CEIL)하여 최소 1상자 이상으로 환산
    v_new_box := GREATEST(1, CEIL(v_row.safe_stock_boxes::NUMERIC / NULLIF(v_row.box_packaging_qty, 0)::NUMERIC)::INT);

    UPDATE public.inventory_stocks
    SET safe_stock_boxes = v_new_box,
        updated_at = NOW()
    WHERE id = v_row.stock_row_id;

    v_updated_count := v_updated_count + 1;
    v_details := v_details || jsonb_build_array(jsonb_build_object(
      'item_name', v_row.item_name,
      'color', v_row.color,
      'pkg', v_row.box_packaging_qty,
      'old_safe_stock', v_row.safe_stock_boxes,
      'new_safe_stock', v_new_box
    ));
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'updated_count', v_updated_count,
    'details', v_details
  );
END;
$function$;

--    멱등 키 저장소는 쓰기 RPC(SECURITY DEFINER) 내부에서만 쓴다. 직접 호출하면 남의 처리 결과를 읽을 수 있었다.
REVOKE EXECUTE ON FUNCTION public.fn_idempotency_lock(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_idempotency_store(TEXT, JSONB) FROM PUBLIC, anon, authenticated;

-- 6. Realtime 변경 신호
--    Realtime 구독은 x-wms-session 헤더를 보낼 수 없어 위 RLS를 통과하지 못한다.
--    수량 없이 "어느 창고의 어느 품목이 바뀌었다"만 담은 신호 테이블을 대신 공개 구독하고,
--    화면은 신호를 받으면 로그인 세션으로 실제 데이터를 다시 읽는다(stockSync.js).
CREATE TABLE IF NOT EXISTS public.stock_change_signals (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source TEXT NOT NULL,
  item_id UUID,
  warehouses TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_change_signals_created_at
  ON public.stock_change_signals USING btree (created_at);

ALTER TABLE public.stock_change_signals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "stock_change_signals_select" ON public.stock_change_signals;
CREATE POLICY "stock_change_signals_select"
  ON public.stock_change_signals FOR SELECT TO anon, authenticated USING (true);

REVOKE ALL ON public.stock_change_signals FROM anon, authenticated;
GRANT SELECT ON public.stock_change_signals TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_emit_stock_change_signal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_row RECORD;
  v_warehouses TEXT[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row := OLD;
  ELSE
    v_row := NEW;
  END IF;

  IF TG_TABLE_NAME = 'pending_orders' THEN
    v_warehouses := ARRAY[v_row.from_warehouse, v_row.to_warehouse];
    IF TG_OP = 'UPDATE' THEN
      v_warehouses := v_warehouses || ARRAY[OLD.from_warehouse, OLD.to_warehouse];
    END IF;
  ELSE
    v_warehouses := ARRAY[v_row.warehouse_code];
  END IF;

  INSERT INTO public.stock_change_signals (source, item_id, warehouses)
  VALUES (
    TG_TABLE_NAME,
    v_row.item_id,
    ARRAY(SELECT DISTINCT w FROM unnest(v_warehouses) AS w WHERE w IS NOT NULL)
  );
  RETURN NULL;
END;
$$;

-- 신호는 실시간 알림용이라 오래 보관할 필요가 없다. 문장 단위로 한 번만 정리한다.
CREATE OR REPLACE FUNCTION public.fn_prune_stock_change_signals()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
BEGIN
  DELETE FROM public.stock_change_signals WHERE created_at < NOW() - INTERVAL '1 hour';
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_emit_stock_change_signal() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_prune_stock_change_signals() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_stock_change_signal ON public.inventory_stocks;
CREATE TRIGGER trg_stock_change_signal
  AFTER INSERT OR UPDATE OR DELETE ON public.inventory_stocks
  FOR EACH ROW EXECUTE FUNCTION public.fn_emit_stock_change_signal();

DROP TRIGGER IF EXISTS trg_stock_change_signal ON public.pending_orders;
CREATE TRIGGER trg_stock_change_signal
  AFTER INSERT OR UPDATE OR DELETE ON public.pending_orders
  FOR EACH ROW EXECUTE FUNCTION public.fn_emit_stock_change_signal();

DROP TRIGGER IF EXISTS trg_prune_stock_change_signals ON public.inventory_stocks;
CREATE TRIGGER trg_prune_stock_change_signals
  AFTER INSERT OR UPDATE OR DELETE ON public.inventory_stocks
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_prune_stock_change_signals();

DROP TRIGGER IF EXISTS trg_prune_stock_change_signals ON public.pending_orders;
CREATE TRIGGER trg_prune_stock_change_signals
  AFTER INSERT OR UPDATE OR DELETE ON public.pending_orders
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_prune_stock_change_signals();

-- Realtime 발행 대상 교체: 수량이 담긴 원본 테이블은 빼고 신호 테이블만 발행한다.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'inventory_stocks') THEN
      ALTER PUBLICATION supabase_realtime DROP TABLE public.inventory_stocks;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'pending_orders') THEN
      ALTER PUBLICATION supabase_realtime DROP TABLE public.pending_orders;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'stock_change_signals') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.stock_change_signals;
    END IF;
  END IF;
END;
$$;
