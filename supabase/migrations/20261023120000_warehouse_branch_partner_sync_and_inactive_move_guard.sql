-- ==============================================================================
-- 창고 활성 상태 ↔ 지점 거래처 동기화 + 비활성 창고로의 이동 거절
--
-- 배경: 창고 간 이동은 출고 화면에서 "지점 거래처"(partners.is_branch, warehouse_code)를 출고처로 고르는 방식이다.
--       노드 관리에서 창고를 비활성화해도 지점 거래처는 활성으로 남아(ALMINTER/STAR/YARE), 화면에 안 보이는
--       창고로 재고를 옮길 수 있었다. 반대로 새 서브창고를 추가해도 지점 거래처가 없어 이동 도착지로 고를 수 없었다.
--
-- 조치:
--   1) rpc_upsert_warehouse — 창고를 저장할 때 그 창고의 지점 거래처 활성 여부를 창고에 맞춘다.
--      활성 창고에 지점 거래처가 없으면 기존 지점과 같은 형태(이름 = 창고 코드)로 만든다.
--      같은 이름의 다른 거래처가 이미 있으면 만들지 않고 branch_partner = 'name_conflict'로 알린다.
--   2) rpc_process_transaction_apply — 도착창고가 비활성이거나 없으면 이동을 거절한다(SMOKETEST 예외).
--      출발창고는 막지 않는다(비활성 창고의 남은 재고를 MAIN으로 되돌릴 수 있어야 한다).
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.rpc_upsert_warehouse(
  p_code TEXT,
  p_name TEXT,
  p_truck_capacity_boxes INTEGER DEFAULT 100,
  p_sort_order INTEGER DEFAULT NULL,
  p_is_active BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code TEXT := UPPER(TRIM(COALESCE(p_code, '')));
  v_name TEXT := TRIM(COALESCE(p_name, ''));
  v_sort INTEGER;
  v_exists BOOLEAN;
  v_active BOOLEAN;
  v_synced INTEGER := 0;
  v_branch TEXT := 'unchanged';
BEGIN
  PERFORM public.fn_require_admin();

  IF v_code = '' THEN
    RAISE EXCEPTION '창고 코드가 비어 있습니다.';
  END IF;
  IF v_code = 'MAIN' THEN
    RAISE EXCEPTION '메인 허브 창고는 이 화면에서 수정할 수 없습니다.';
  END IF;
  IF v_name = '' THEN
    RAISE EXCEPTION '창고 이름이 비어 있습니다.';
  END IF;

  SELECT EXISTS(SELECT 1 FROM public.warehouses WHERE code = v_code) INTO v_exists;

  IF v_exists THEN
    UPDATE public.warehouses
    SET name = v_name,
        truck_capacity_boxes = GREATEST(1, COALESCE(p_truck_capacity_boxes, truck_capacity_boxes)),
        sort_order = COALESCE(p_sort_order, sort_order),
        is_active = COALESCE(p_is_active, is_active)
    WHERE code = v_code;
  ELSE
    SELECT COALESCE(MAX(sort_order), 0) + 1 INTO v_sort
    FROM public.warehouses
    WHERE COALESCE(is_hub, FALSE) = FALSE;

    INSERT INTO public.warehouses (code, name, is_hub, sort_order, truck_capacity_boxes, is_active)
    VALUES (
      v_code, v_name, FALSE,
      COALESCE(p_sort_order, v_sort),
      GREATEST(1, COALESCE(p_truck_capacity_boxes, 100)),
      COALESCE(p_is_active, TRUE)
    );
  END IF;

  SELECT is_active INTO v_active FROM public.warehouses WHERE code = v_code;

  -- 지점 거래처(이동 도착지로 고르는 거래처)를 창고 활성 상태에 맞춘다.
  UPDATE public.partners
  SET is_active = v_active
  WHERE is_branch AND warehouse_code = v_code AND is_active IS DISTINCT FROM v_active;
  GET DIAGNOSTICS v_synced = ROW_COUNT;
  IF v_synced > 0 THEN
    v_branch := CASE WHEN v_active THEN 'activated' ELSE 'deactivated' END;
  END IF;

  IF v_active AND NOT EXISTS (
    SELECT 1 FROM public.partners WHERE is_branch AND warehouse_code = v_code
  ) THEN
    IF EXISTS (SELECT 1 FROM public.partners WHERE UPPER(TRIM(name)) = v_code) THEN
      -- 같은 이름의 기존 거래처(고객 등)는 건드리지 않는다
      v_branch := 'name_conflict';
    ELSE
      INSERT INTO public.partners (partner_type, name, is_active, is_supplier, is_customer, is_branch, warehouse_code)
      VALUES ('OUTBOUND', v_code, TRUE, TRUE, TRUE, TRUE, v_code);
      v_branch := 'created';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'code', v_code, 'name', v_name, 'is_active', v_active,
    'branch_partner', v_branch
  );
END;
$$;

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
