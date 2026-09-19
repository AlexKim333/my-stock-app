-- ==============================================================================
-- 동시성·오래된 캐시 방어
--  1) 외부창고 발주: 서버에서 가용재고(실재고 − 진행 중 발주) 검증. 창고 재고 행을 잠가
--     동시 발주로 초과되지 않게 한다. 품목을 못 찾으면 새 품목을 만들지 않고 거부한다.
--  2) 비활성(병합·삭제) 품목에는 거래·발주 행을 새로 만들 수 없다 (오래된 품목 ID 캐시 방어)
--  3) 전표 수정 동시성: 불러온 시점의 전표 지문(signature)과 현재가 다르면 수정을 거부
-- ==============================================================================

-- 1) 외부창고 발주 가용재고 검증 ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_submit_warehouse_order_drafts_apply(
  p_by_warehouse JSONB,
  p_admin TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_row RECORD;
  v_item_id UUID;
  v_candidates INT;
  v_gross INT;
  v_committed BIGINT;
  v_label TEXT;
  v_inserted_count INT := 0;
BEGIN
  IF p_by_warehouse IS NULL OR p_by_warehouse = '{}'::JSONB THEN
    RETURN jsonb_build_object('success', true, 'count', 0, 'message', '발주할 품목이 없습니다.');
  END IF;

  -- 창고·품목 순서로 처리해 동시 발주 간 잠금 순서를 고정한다.
  FOR v_row IN
    SELECT
      UPPER(TRIM(e.key)) AS wh,
      x.item_id,
      TRIM(COALESCE(x.item_name, '')) AS item_name,
      TRIM(COALESCE(x.color, 'SURTIDO')) AS color,
      COALESCE(x.box_content, 0) AS box_content,
      ABS(COALESCE(x.box_qty, 0)) AS box_qty
    FROM jsonb_each(p_by_warehouse) AS e
    CROSS JOIN LATERAL jsonb_to_recordset(e.value) AS x(
      item_id UUID, item_name TEXT, color TEXT, box_content INT, box_qty INT
    )
    ORDER BY 1, x.item_id NULLS LAST, 3, 4
  LOOP
    CONTINUE WHEN v_row.box_qty <= 0;

    IF v_row.wh = 'MAIN' OR NOT EXISTS (SELECT 1 FROM public.warehouses WHERE code = v_row.wh) THEN
      RAISE EXCEPTION '발주 출발 창고가 올바르지 않습니다: %', v_row.wh;
    END IF;

    v_item_id := v_row.item_id;
    IF v_item_id IS NULL THEN
      IF v_row.box_content > 1 THEN
        SELECT id INTO v_item_id
        FROM public.items
        WHERE item_name = v_row.item_name
          AND color = v_row.color
          AND box_packaging_qty = v_row.box_content
          AND COALESCE(is_active, TRUE)
        LIMIT 1;
      ELSE
        -- 포장수량을 모르는 (이전 버전) 드래프트: 이 창고에 재고가 있는 동명 품목이 하나일 때만 허용
        SELECT count(*), (array_agg(i.id))[1] INTO v_candidates, v_item_id
        FROM public.items i
        JOIN public.inventory_stocks s ON s.item_id = i.id AND s.warehouse_code = v_row.wh AND s.box_qty > 0
        WHERE i.item_name = v_row.item_name
          AND i.color = v_row.color
          AND COALESCE(i.is_active, TRUE);
        IF v_candidates > 1 THEN
          RAISE EXCEPTION '품목을 특정할 수 없습니다 (포장수량이 다른 동명 품목 %개): % (%) — 매트릭스에서 다시 담아 주세요.',
            v_candidates, v_row.item_name, v_row.color;
        END IF;
      END IF;
    END IF;

    IF v_item_id IS NULL THEN
      RAISE EXCEPTION '발주할 품목을 찾을 수 없습니다: % (%)', v_row.item_name, v_row.color;
    END IF;

    SELECT box_qty INTO v_gross
    FROM public.inventory_stocks
    WHERE item_id = v_item_id AND warehouse_code = v_row.wh
    FOR UPDATE;
    v_gross := COALESCE(v_gross, 0);

    SELECT COALESCE(SUM(box_qty), 0) INTO v_committed
    FROM public.pending_orders
    WHERE item_id = v_item_id
      AND from_warehouse = v_row.wh
      AND to_warehouse = 'MAIN'
      AND status IN ('PENDING', 'IN_TRANSIT');

    IF v_committed + v_row.box_qty > v_gross THEN
      SELECT item_name || ' (' || COALESCE(color, 'SURTIDO') || ')' INTO v_label FROM public.items WHERE id = v_item_id;
      RAISE EXCEPTION '% 창고 % 가용재고 부족: 요청 %상자, 가용 %상자 (실재고 % − 발주진행 %)',
        v_row.wh, v_label, v_row.box_qty, GREATEST(v_gross - v_committed, 0), v_gross, v_committed;
    END IF;

    INSERT INTO public.pending_orders (
      item_id, from_warehouse, to_warehouse, box_qty, unit_qty, status, requested_by, memo
    ) VALUES (
      v_item_id, v_row.wh, 'MAIN', v_row.box_qty, 0, 'PENDING',
      COALESCE(p_admin, 'ADMIN'), '외부창고 100상자 발주 드래프트'
    );
    v_inserted_count := v_inserted_count + 1;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'count', v_inserted_count,
    'message', format('총 %s건의 서브창고 발주 드래프트가 성공적으로 등록되었습니다.', v_inserted_count));
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_submit_warehouse_order_drafts_apply(JSONB, TEXT) FROM PUBLIC, anon, authenticated;

-- 2) 비활성 품목 거래·발주 차단 ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_reject_inactive_item()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO public
AS $$
DECLARE
  v_name TEXT;
BEGIN
  SELECT item_name INTO v_name
  FROM public.items
  WHERE id = NEW.item_id AND NOT COALESCE(is_active, TRUE);
  IF FOUND THEN
    RAISE EXCEPTION '비활성(병합·삭제)된 품목에는 입출고·발주를 기록할 수 없습니다: % — 화면을 새로고침한 뒤 다시 선택하세요.', v_name;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reject_inactive_item_tx ON public.stock_transactions;
CREATE TRIGGER trg_reject_inactive_item_tx
BEFORE INSERT ON public.stock_transactions
FOR EACH ROW EXECUTE FUNCTION public.fn_reject_inactive_item();

DROP TRIGGER IF EXISTS trg_reject_inactive_item_po ON public.pending_orders;
CREATE TRIGGER trg_reject_inactive_item_po
BEFORE INSERT ON public.pending_orders
FOR EACH ROW EXECUTE FUNCTION public.fn_reject_inactive_item();

-- 3) 전표 수정 동시성 (지문 비교) ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_invoice_match_types(p_tx_type TEXT)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE UPPER(TRIM(COALESCE(p_tx_type, 'OUTBOUND')))
    WHEN 'INBOUND' THEN ARRAY['INBOUND']
    WHEN 'ADJUST' THEN ARRAY['ADJUST']
    ELSE ARRAY['OUTBOUND', 'MOVE']
  END;
$$;

-- 전표 행 구성(품목·수량)의 지문. 행 순서와 무관하다.
CREATE OR REPLACE FUNCTION public.fn_invoice_signature(p_invoice_no TEXT, p_tx_type TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path TO public
AS $$
  SELECT md5(COALESCE(string_agg(
    item_id::TEXT || ':' || box_qty || ':' || unit_qty, ','
    ORDER BY item_id::TEXT COLLATE "C", box_qty, unit_qty
  ), ''))
  FROM public.stock_transactions
  WHERE public.fn_normalize_invoice_no(invoice_no) = public.fn_normalize_invoice_no(p_invoice_no)
    AND transaction_type = ANY (public.fn_invoice_match_types(p_tx_type));
$$;

CREATE OR REPLACE FUNCTION public.rpc_invoice_signature(p_invoice_no TEXT, p_tx_type TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path TO public
AS $$
  SELECT public.fn_invoice_signature(p_invoice_no, p_tx_type);
$$;

GRANT EXECUTE ON FUNCTION public.fn_invoice_match_types(TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_invoice_signature(TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_invoice_signature(TEXT, TEXT) TO anon, authenticated, service_role;

-- 4인자 버전을 지문 인자(기본값 NULL)가 있는 5인자 버전으로 교체.
-- 같은 이름의 두 오버로드가 공존하면 PostgREST가 4인자 호출을 해석하지 못하므로 먼저 삭제한다.
-- (지문 없이 호출하는 이전 화면은 기존과 똑같이 동작)
DROP FUNCTION IF EXISTS public.rpc_update_transaction_records(TEXT, TEXT, JSONB, TEXT);

CREATE OR REPLACE FUNCTION public.rpc_update_transaction_records(
  p_invoice_no TEXT,
  p_tx_type TEXT,
  p_new_records JSONB,
  p_admin TEXT,
  p_expected_signature TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_member public.app_members%ROWTYPE;
BEGIN
  v_member := public.fn_require_session();

  -- 전표 행을 잠근 뒤 지문을 비교한다 (같은 트랜잭션의 apply가 이 잠금을 이어받는다).
  PERFORM 1
  FROM public.stock_transactions
  WHERE public.fn_normalize_invoice_no(invoice_no) = public.fn_normalize_invoice_no(p_invoice_no)
    AND transaction_type = ANY (public.fn_invoice_match_types(p_tx_type))
  ORDER BY item_id, id
  FOR UPDATE;

  IF NULLIF(TRIM(COALESCE(p_expected_signature, '')), '') IS NOT NULL
     AND p_expected_signature <> public.fn_invoice_signature(p_invoice_no, p_tx_type) THEN
    RAISE EXCEPTION '다른 사용자가 먼저 이 전표(%)를 수정했습니다. 전표를 다시 불러온 뒤 수정하세요.',
      public.fn_normalize_invoice_no(p_invoice_no);
  END IF;

  RETURN public.rpc_update_transaction_records_apply(
    p_invoice_no,
    p_tx_type,
    p_new_records,
    COALESCE(v_member.member_name, p_admin)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_update_transaction_records(TEXT, TEXT, JSONB, TEXT, TEXT) TO anon, authenticated;
