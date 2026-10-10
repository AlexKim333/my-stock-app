-- ==============================================================================
-- 출고 보류를 서버에 저장하고, 보류 수량을 가용재고에서 예약한다
--
-- 문제: 출고 보류는 브라우저(localStorage)에만 있었다. 그 기기에서 입력하는 출고만 보류 수량을 피했고,
--       다른 기기의 출고, 외부창고 발주(IKEA→MAIN 등), 서버 검사는 보류를 몰랐다. 그래서 보류해 둔 물건이
--       다른 출고나 발주로 빠져나가고, 나중에 보류를 제출하면 재고 부족으로 실패했다.
--
-- 조치:
--  1) outbound_holds(보류 문서) / outbound_hold_items(창고·품목별 예약 수량) 테이블. 모든 기기가 같은 목록을 본다.
--     직접 읽기/쓰기는 막고 RPC로만 다룬다.
--  2) 가용재고 = 실재고 − (서브창고만) MAIN행 열린 발주 − 출고 보류.
--     - 보류 저장(rpc_save_outbound_hold): 가용재고를 넘으면 저장하지 않는다.
--     - 출고/이동(rpc_process_transaction_apply), 전표 수정(rpc_update_transaction_records_apply):
--       fn_assert_warehouse_atp가 보류까지 빼고 검사한다(MAIN 포함).
--     - 외부창고 발주 등록/보류 수정(rpc_submit_warehouse_order_drafts_apply, rpc_adjust_pending_inbound_orders):
--       보류 수량도 빼고 검사한다.
--  3) 보류를 불러와 제출하면 rpc_process_transaction(p_hold_refs)이 같은 트랜잭션에서 그 보류를 지운 뒤 처리한다.
--     처리가 실패하면 보류도 그대로 남는다. 보류마다 version이 있어, 다른 기기가 다시 불러가거나 고친 보류를
--     예전 장바구니로 제출/재보류하면 거절한다(같은 보류를 두 번 출고하지 않게).
--  4) 포장수량 변경(rpc_change_item_pack_qty)은 출고 보류에 걸린 품목이면 막는다(OUTBOUND_HOLDS).
--  5) 보류 예약도 재고 변경 신호(stock_change_signals)를 내 다른 기기 화면이 갱신되게 한다.
--
-- 기존 함수 수정은 20261009130000과 같은 방식으로 운영 DB의 현재 정의(pg_get_functiondef)에서 정확히 한 번
-- 나오는 문장만 바꾼다. 바꿀 문장이 정확히 한 번이 아니면 전체를 중단한다.
-- 만료 없음: 보류는 제출·삭제할 때까지 예약을 유지한다(화면에 경과일 표시).
-- ==============================================================================

-- 1) 테이블 ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.outbound_holds (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  warehouse_code TEXT NOT NULL REFERENCES public.warehouses(code),
  partner_name TEXT,
  admin_name TEXT,
  hold_date TEXT,
  created_label TEXT,
  records JSONB NOT NULL DEFAULT '[]'::JSONB,
  version INTEGER NOT NULL DEFAULT 1,
  loaded_by TEXT,
  loaded_at TIMESTAMPTZ,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.outbound_hold_items (
  id BIGSERIAL PRIMARY KEY,
  hold_id UUID NOT NULL REFERENCES public.outbound_holds(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
  warehouse_code TEXT NOT NULL REFERENCES public.warehouses(code),
  box_qty INTEGER NOT NULL DEFAULT 0 CHECK (box_qty >= 0),
  unit_qty INTEGER NOT NULL DEFAULT 0 CHECK (unit_qty >= 0)
);

CREATE INDEX IF NOT EXISTS idx_outbound_hold_items_item_wh ON public.outbound_hold_items (item_id, warehouse_code);
CREATE INDEX IF NOT EXISTS idx_outbound_hold_items_hold ON public.outbound_hold_items (hold_id);
CREATE INDEX IF NOT EXISTS idx_outbound_holds_created ON public.outbound_holds (created_at);

ALTER TABLE public.outbound_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbound_hold_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.outbound_holds FROM anon, authenticated;
REVOKE ALL ON public.outbound_hold_items FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.outbound_hold_items_id_seq FROM anon, authenticated;

-- 예약 변경도 다른 기기의 가용재고 표시를 갱신하게 신호를 낸다 (warehouse_code/item_id 컬럼 사용).
DROP TRIGGER IF EXISTS trg_stock_change_signal ON public.outbound_hold_items;
CREATE TRIGGER trg_stock_change_signal
  AFTER INSERT OR UPDATE OR DELETE ON public.outbound_hold_items
  FOR EACH ROW EXECUTE FUNCTION public.fn_emit_stock_change_signal();

DROP TRIGGER IF EXISTS trg_prune_stock_change_signals ON public.outbound_hold_items;
CREATE TRIGGER trg_prune_stock_change_signals
  AFTER INSERT OR UPDATE OR DELETE ON public.outbound_hold_items
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_prune_stock_change_signals();

-- 2) 가용재고 계산 ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_outbound_held_units(p_item_id UUID, p_warehouse TEXT)
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public
AS $$
  SELECT COALESCE(SUM(public.fn_stock_units(h.box_qty, h.unit_qty, public.fn_item_pack_qty(h.item_id))), 0)::BIGINT
  FROM public.outbound_hold_items h
  WHERE h.item_id = p_item_id
    AND h.warehouse_code = UPPER(TRIM(COALESCE(p_warehouse, 'MAIN')));
$$;
REVOKE ALL ON FUNCTION public.fn_outbound_held_units(UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- p_always = FALSE(입출고): 발주·보류가 하나도 없으면 실재고 검사는 fn_apply_stock_units의 기존 메시지에 맡긴다.
-- p_always = TRUE(보류 저장): 재고를 실제로 빼지 않으므로 여기서 실재고까지 검사한다.
CREATE OR REPLACE FUNCTION public.fn_assert_warehouse_atp_core(
  p_item_id UUID,
  p_warehouse TEXT,
  p_req_units BIGINT,
  p_ctx TEXT,
  p_always BOOLEAN
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_wh TEXT := UPPER(TRIM(COALESCE(p_warehouse, 'MAIN')));
  v_pack INTEGER;
  v_box INTEGER;
  v_unit INTEGER;
  v_gross BIGINT;
  v_committed BIGINT := 0;
  v_held BIGINT;
  v_avail BIGINT;
  v_label TEXT;
  v_parts TEXT;
BEGIN
  IF v_wh = '' OR COALESCE(p_req_units, 0) <= 0 THEN
    RETURN;
  END IF;

  v_pack := public.fn_item_pack_qty(p_item_id);
  PERFORM public.fn_ensure_stock_row(p_item_id, v_wh);

  -- 발주 등록/조정·보류 저장과 같은 행을 먼저 잠가, 동시에 들어온 요청이 같은 재고를 이중으로 쓰지 못하게 한다.
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

  IF NOT COALESCE(p_always, FALSE) AND v_committed + v_held <= 0 THEN
    RETURN;
  END IF;

  v_avail := GREATEST(v_gross - v_committed - v_held, 0);
  IF p_req_units > v_avail THEN
    SELECT item_name || ' (' || COALESCE(color, 'SURTIDO') || ')' INTO v_label
    FROM public.items WHERE id = p_item_id;
    v_parts := format('실재고 %s상자 %s개', v_gross / v_pack, v_gross % v_pack);
    IF v_committed > 0 THEN
      v_parts := v_parts || format(' − MAIN 입고 예정 발주 %s상자 %s개', v_committed / v_pack, v_committed % v_pack);
    END IF;
    IF v_held > 0 THEN
      v_parts := v_parts || format(' − 출고 보류 %s상자 %s개', v_held / v_pack, v_held % v_pack);
    END IF;
    RAISE EXCEPTION '% 불가: 창고 % % 가용재고 부족 — 요청 %상자 %개, 가용 %상자 %개 (%).%',
      COALESCE(NULLIF(TRIM(p_ctx), ''), '출고'), v_wh, COALESCE(v_label, p_item_id::TEXT),
      p_req_units / v_pack, p_req_units % v_pack,
      v_avail / v_pack, v_avail % v_pack,
      v_parts,
      CASE
        WHEN v_committed > 0 AND v_held > 0 THEN ' 발주나 출고 보류를 먼저 줄이거나 취소하세요.'
        WHEN v_committed > 0 THEN ' 발주를 먼저 줄이거나 취소하세요.'
        WHEN v_held > 0 THEN ' 출고 보류를 먼저 줄이거나 삭제하세요.'
        ELSE ''
      END;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.fn_assert_warehouse_atp_core(UUID, TEXT, BIGINT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;

-- 출고·이동·전표 수정이 부르는 기존 이름. 이제 MAIN에서도 보류 수량을 뺀다.
CREATE OR REPLACE FUNCTION public.fn_assert_warehouse_atp(
  p_item_id UUID,
  p_warehouse TEXT,
  p_req_units BIGINT,
  p_ctx TEXT DEFAULT '출고'
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
BEGIN
  PERFORM public.fn_assert_warehouse_atp_core(p_item_id, p_warehouse, p_req_units, p_ctx, FALSE);
END;
$$;
REVOKE ALL ON FUNCTION public.fn_assert_warehouse_atp(UUID, TEXT, BIGINT, TEXT) FROM PUBLIC, anon, authenticated;

-- 3) 보류 소진(제출·재보류 시) ------------------------------------------------------
-- p_refs: [{id, version}] — 장바구니가 불러온 보류들. 하나라도 없거나 version이 다르면 전체를 중단한다.
-- 반환: 가장 먼저 만든 보류의 created_at / created_label (재보류 때 원래 발주 일시를 유지하려고)
CREATE OR REPLACE FUNCTION public.fn_consume_outbound_holds(p_refs JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_ref RECORD;
  v_hold public.outbound_holds%ROWTYPE;
  v_first_at TIMESTAMPTZ;
  v_first_label TEXT;
  v_count INTEGER := 0;
BEGIN
  IF p_refs IS NULL OR jsonb_typeof(p_refs) <> 'array' OR jsonb_array_length(p_refs) = 0 THEN
    RETURN jsonb_build_object('count', 0);
  END IF;

  FOR v_ref IN
    SELECT DISTINCT ON (x.id) x.id, x.version
    FROM jsonb_to_recordset(p_refs) AS x(id UUID, version INTEGER)
    WHERE x.id IS NOT NULL
    ORDER BY x.id
  LOOP
    SELECT * INTO v_hold FROM public.outbound_holds WHERE id = v_ref.id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION '불러온 출고 보류가 이미 제출되었거나 삭제되었습니다. 같은 주문이 두 번 처리되지 않도록 중단했습니다. 보류 목록을 확인하세요.';
    END IF;
    IF v_ref.version IS NULL OR v_hold.version <> v_ref.version THEN
      RAISE EXCEPTION '이 출고 보류를 다른 곳(%)에서 다시 불러갔거나 수정했습니다. 같은 주문이 두 번 처리되지 않도록 중단했습니다. 보류 목록을 확인하세요.',
        COALESCE(NULLIF(v_hold.loaded_by, ''), '다른 기기');
    END IF;
    IF v_first_at IS NULL OR v_hold.created_at < v_first_at THEN
      v_first_at := v_hold.created_at;
      v_first_label := v_hold.created_label;
    END IF;
    DELETE FROM public.outbound_holds WHERE id = v_ref.id;
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('count', v_count, 'created_at', v_first_at, 'created_label', v_first_label);
END;
$$;
REVOKE ALL ON FUNCTION public.fn_consume_outbound_holds(JSONB) FROM PUBLIC, anon, authenticated;

-- 4) 보류 RPC --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_list_outbound_holds()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public
AS $$
BEGIN
  PERFORM public.fn_assert_read_session();
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', h.id,
      'version', h.version,
      'warehouse', h.warehouse_code,
      'partner', h.partner_name,
      'admin', h.admin_name,
      'holdDate', h.hold_date,
      'createdLabel', h.created_label,
      'createdAt', h.created_at,
      'createdBy', h.created_by,
      'loadedBy', h.loaded_by,
      'loadedAt', h.loaded_at,
      'records', h.records
    ) ORDER BY h.created_at, h.id)
    FROM public.outbound_holds h
  ), '[]'::JSONB);
END;
$$;
REVOKE ALL ON FUNCTION public.rpc_list_outbound_holds() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_list_outbound_holds() TO anon, authenticated, service_role;

-- 매트릭스(외부창고 발주 화면)용: 창고·품목별 보류 예약 합계(낱개 환산)
CREATE OR REPLACE FUNCTION public.rpc_outbound_hold_reservations()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public
AS $$
BEGIN
  PERFORM public.fn_assert_read_session();
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object('item_id', t.item_id, 'warehouse', t.warehouse_code, 'units', t.units))
    FROM (
      SELECT h.item_id, h.warehouse_code,
             SUM(public.fn_stock_units(h.box_qty, h.unit_qty, public.fn_item_pack_qty(h.item_id)))::BIGINT AS units
      FROM public.outbound_hold_items h
      GROUP BY h.item_id, h.warehouse_code
    ) t
  ), '[]'::JSONB);
END;
$$;
REVOKE ALL ON FUNCTION public.rpc_outbound_hold_reservations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_outbound_hold_reservations() TO anon, authenticated, service_role;

-- 보류 저장(새 보류, 또는 불러온 보류들을 하나로 다시 저장). p_items: [{item_id, box_qty, unit_qty}]
CREATE OR REPLACE FUNCTION public.rpc_save_outbound_hold(
  p_replace JSONB,
  p_warehouse TEXT,
  p_partner TEXT,
  p_admin TEXT,
  p_hold_date TEXT,
  p_created_label TEXT,
  p_records JSONB,
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
  v_wh TEXT := UPPER(TRIM(COALESCE(p_warehouse, '')));
  v_consumed JSONB;
  v_id UUID;
  v_created_at TIMESTAMPTZ;
  v_item RECORD;
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

  -- item_id 순서로 잠가 동시 처리 간 교착을 방지한다.
  FOR v_item IN
    SELECT x.item_id,
           SUM(ABS(COALESCE(x.box_qty, 0)))::INTEGER AS box_qty,
           SUM(ABS(COALESCE(x.unit_qty, 0)))::INTEGER AS unit_qty
    FROM jsonb_to_recordset(p_items) AS x(item_id UUID, box_qty INT, unit_qty INT)
    GROUP BY x.item_id
    ORDER BY x.item_id
  LOOP
    IF v_item.item_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.items WHERE id = v_item.item_id) THEN
      RAISE EXCEPTION '등록되지 않은 품목이 있어 보류할 수 없습니다.';
    END IF;
    CONTINUE WHEN v_item.box_qty = 0 AND v_item.unit_qty = 0;

    v_pack := public.fn_item_pack_qty(v_item.item_id);
    PERFORM public.fn_assert_warehouse_atp_core(
      v_item.item_id, v_wh, public.fn_stock_units(v_item.box_qty, v_item.unit_qty, v_pack), '보류', TRUE
    );
    INSERT INTO public.outbound_hold_items (hold_id, item_id, warehouse_code, box_qty, unit_qty)
    VALUES (v_id, v_item.item_id, v_wh, v_item.box_qty, v_item.unit_qty);
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
$$;
REVOKE ALL ON FUNCTION public.rpc_save_outbound_hold(JSONB, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_save_outbound_hold(JSONB, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT) TO anon, authenticated, service_role;

-- 보류 불러오기: 예약은 그대로 두고 version을 올린다(이전에 불러간 장바구니의 제출·재보류는 거절됨).
CREATE OR REPLACE FUNCTION public.rpc_load_outbound_hold(p_id UUID, p_version INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_member public.app_members%ROWTYPE;
  v_hold public.outbound_holds%ROWTYPE;
BEGIN
  v_member := public.fn_require_admin();

  SELECT * INTO v_hold FROM public.outbound_holds WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '이미 제출되었거나 삭제된 보류입니다. 보류 목록을 다시 열어 확인하세요.';
  END IF;
  IF p_version IS NULL OR v_hold.version <> p_version THEN
    RAISE EXCEPTION '보류 목록이 바뀌었습니다(다른 곳에서 불러가거나 수정함). 보류 목록을 다시 열어 확인하세요.';
  END IF;

  UPDATE public.outbound_holds
  SET version = version + 1,
      loaded_by = v_member.member_name,
      loaded_at = NOW(),
      updated_at = NOW()
  WHERE id = p_id
  RETURNING * INTO v_hold;

  RETURN jsonb_build_object(
    'id', v_hold.id,
    'version', v_hold.version,
    'warehouse', v_hold.warehouse_code,
    'partner', v_hold.partner_name,
    'admin', v_hold.admin_name,
    'holdDate', v_hold.hold_date,
    'createdLabel', v_hold.created_label,
    'createdAt', v_hold.created_at,
    'records', v_hold.records
  );
END;
$$;
REVOKE ALL ON FUNCTION public.rpc_load_outbound_hold(UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_load_outbound_hold(UUID, INTEGER) TO anon, authenticated, service_role;

-- 보류 삭제: 이미 없으면 성공으로 본다(재시도 안전). 그 사이 다른 곳에서 불러가거나 고쳤으면 거절한다.
CREATE OR REPLACE FUNCTION public.rpc_delete_outbound_hold(p_id UUID, p_version INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_member public.app_members%ROWTYPE;
  v_hold public.outbound_holds%ROWTYPE;
BEGIN
  v_member := public.fn_require_admin();

  SELECT * INTO v_hold FROM public.outbound_holds WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', true, 'already_deleted', true);
  END IF;
  IF p_version IS NULL OR v_hold.version <> p_version THEN
    RAISE EXCEPTION '보류 목록이 바뀌었습니다(다른 곳에서 불러가거나 수정함). 보류 목록을 다시 열어 확인하세요.';
  END IF;

  DELETE FROM public.outbound_holds WHERE id = p_id;
  RETURN jsonb_build_object('success', true, 'already_deleted', false);
END;
$$;
REVOKE ALL ON FUNCTION public.rpc_delete_outbound_hold(UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_delete_outbound_hold(UUID, INTEGER) TO anon, authenticated, service_role;

-- 5) 입출고 래퍼: 불러온 보류를 같은 트랜잭션에서 소진한 뒤 처리 --------------------------------
-- 파라미터가 늘어나 옛 시그니처와 같이 두면 호출이 모호해지므로 옛 함수를 지운다(기존 호출은 이름 기반이라 그대로 동작).
DROP FUNCTION IF EXISTS public.rpc_process_transaction(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.rpc_process_transaction(
  p_tx_type TEXT,
  p_warehouse TEXT,
  p_partner TEXT,
  p_handler TEXT,
  p_invoice TEXT,
  p_memo TEXT,
  p_items JSONB,
  p_target_warehouse TEXT DEFAULT NULL,
  p_pending_from_warehouse TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL,
  p_hold_refs JSONB DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_member public.app_members%ROWTYPE;
  v_cached JSONB;
  v_result JSONB;
  v_consumed JSONB;
BEGIN
  v_member := public.fn_require_admin();
  v_cached := public.fn_idempotency_lock(p_idempotency_key);
  IF v_cached IS NOT NULL THEN
    RETURN v_cached || jsonb_build_object('idempotent_replay', true);
  END IF;

  -- 제출하는 장바구니의 보류를 먼저 지워 자기 예약에 막히지 않게 한다. 처리 실패 시 함께 롤백된다.
  v_consumed := public.fn_consume_outbound_holds(p_hold_refs);

  v_result := public.rpc_process_transaction_apply(
    p_tx_type,
    p_warehouse,
    p_partner,
    COALESCE(NULLIF(TRIM(v_member.member_name), ''), p_handler),
    p_invoice,
    p_memo,
    p_items,
    p_target_warehouse,
    p_pending_from_warehouse
  );
  v_result := v_result || jsonb_build_object('consumed_holds', COALESCE((v_consumed->>'count')::INT, 0));

  PERFORM public.fn_idempotency_store(p_idempotency_key, v_result);
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.rpc_process_transaction(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_process_transaction(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, JSONB) TO anon, authenticated, service_role;

-- 6) 기존 함수에 보류 반영 (운영 정의에서 정확히 한 번 나오는 문장만 교체) -------------------------
DO $$
DECLARE
  v_patch RECORD;
  v_def TEXT;
  v_hits INT;
BEGIN
  FOR v_patch IN
    SELECT * FROM (VALUES
      -- 외부창고 발주 등록: 상자 기준 검사에 보류(올림 상자)를 더한다.
      ('public.rpc_submit_warehouse_order_drafts_apply(jsonb,text)'::regprocedure,
       E'    IF v_committed + v_row.box_qty > v_gross THEN',
       E'    v_committed := v_committed + CEIL(public.fn_outbound_held_units(v_item_id, v_row.wh)::NUMERIC / public.fn_item_pack_qty(v_item_id))::BIGINT;\n    IF v_committed + v_row.box_qty > v_gross THEN'),
      ('public.rpc_submit_warehouse_order_drafts_apply(jsonb,text)'::regprocedure,
       E'(실재고 % − 발주진행 %)',
       E'(실재고 % − 발주진행·출고보류 %)'),
      -- 보류 수정으로 발주를 늘릴 때: 낱개 기준 검사에 보류를 더한다.
      ('public.rpc_adjust_pending_inbound_orders(text,jsonb,text,text)'::regprocedure,
       E'      IF v_committed + v_delta > v_gross THEN',
       E'      v_committed := v_committed + public.fn_outbound_held_units(v_item.item_id, v_wh);\n      IF v_committed + v_delta > v_gross THEN'),
      ('public.rpc_adjust_pending_inbound_orders(text,jsonb,text,text)'::regprocedure,
       E'(실재고 %개 − 발주진행 %개)',
       E'(실재고 %개 − 발주진행·출고보류 %개)'),
      -- 포장수량 변경: 출고 보류에 걸린 품목이면 막는다.
      ('public.rpc_change_item_pack_qty(uuid,integer,boolean,boolean,text)'::regprocedure,
       E'    v_blockers := array_append(v_blockers, ''PENDING_ORDERS'');\n  END IF;',
       E'    v_blockers := array_append(v_blockers, ''PENDING_ORDERS'');\n  END IF;\n\n  IF EXISTS (SELECT 1 FROM public.outbound_hold_items WHERE item_id = v_item.id) THEN\n    v_blockers := array_append(v_blockers, ''OUTBOUND_HOLDS'');\n  END IF;')
    ) AS t(fn, old_text, new_text)
  LOOP
    v_def := pg_get_functiondef(v_patch.fn);
    v_hits := (length(v_def) - length(replace(v_def, v_patch.old_text, ''))) / length(v_patch.old_text);
    IF v_hits <> 1 THEN
      RAISE EXCEPTION '% 본문에서 바꿀 문장이 % 번 발견되었습니다(1번이어야 함): %', v_patch.fn, v_hits, v_patch.old_text;
    END IF;
    EXECUTE replace(v_def, v_patch.old_text, v_patch.new_text);
  END LOOP;
END;
$$;
