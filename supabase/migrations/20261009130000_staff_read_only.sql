-- ============================================================================
-- 직원(staff)은 재고 조회만 할 수 있다. 쓰기는 관리자(admin)만.
--
-- 아래 쓰기 RPC는 지금까지 fn_require_session()으로 "로그인한 누구나"를 허용했다.
-- 본문 안의 그 한 줄을 fn_require_admin()으로 바꾼다. fn_require_admin()은 같은 세션 확인 후
-- access_level = 'admin'까지 확인하고, 같은 app_members 행을 돌려주므로 본문의 나머지는 그대로다.
--
-- 본문을 이 파일에 다시 적지 않고 운영 DB의 현재 정의(pg_get_functiondef)에서 바꾸는 이유:
-- 옛 마이그레이션 본문으로 함수가 퇴행한 사고(20260919 재실행)를 반복하지 않기 위해서다.
-- 대상 함수에 바꿀 줄이 정확히 한 번 없으면 전체를 중단한다.
--
-- 직원에게 계속 허용하는 것(조회): rpc_session_info, rpc_get_system_settings,
-- rpc_exec_readonly_query(AI 재고 조회), 테이블 읽기(20261009120000의 세션 RLS).
-- ============================================================================

DO $$
DECLARE
  v_name TEXT;
  v_oid OID;
  v_def TEXT;
  v_hits INT;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'rpc_process_transaction',
    'rpc_adjust_stock',
    'rpc_reserve_outbound',
    'rpc_submit_warehouse_order_drafts',
    'rpc_adjust_pending_inbound_orders',
    'rpc_cancel_pending_inbound_orders',
    'rpc_update_transaction_records',
    'rpc_register_item',
    'rpc_ensure_items',
    'rpc_create_brand',
    'rpc_upsert_aliases',
    'rpc_ocr_sample_create',
    'rpc_ocr_sample_confirm'
  ]
  LOOP
    -- 오버로드가 생기면 어느 것을 바꿔야 할지 모호하므로 중단한다.
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = v_name) <> 1 THEN
      RAISE EXCEPTION '% 함수가 정확히 하나가 아닙니다.', v_name;
    END IF;

    SELECT p.oid INTO v_oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_name;

    v_def := pg_get_functiondef(v_oid);
    v_hits := (length(v_def) - length(replace(v_def, 'public.fn_require_session()', '')))
              / length('public.fn_require_session()');

    IF v_hits <> 1 THEN
      RAISE EXCEPTION '% 본문에서 public.fn_require_session() 호출이 % 번 발견되었습니다(1번이어야 함).', v_name, v_hits;
    END IF;

    EXECUTE replace(v_def, 'public.fn_require_session()', 'public.fn_require_admin()');
  END LOOP;
END;
$$;
