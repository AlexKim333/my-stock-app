-- ==============================================================================
-- AI 조회용 rpc_exec_readonly_query 잠금
--
-- 문제: 이 RPC는 SECURITY DEFINER(소유자 postgres 권한)이면서 anon 에게 실행 권한이 있고 세션 검증이
--       없어, 화면 번들에 들어 있는 공개 anon 키만으로 RLS를 우회해 모든 테이블을 읽을 수 있었다
--       (app_members / app_sessions 등 RLS가 직접 조회를 막는 테이블 포함). "SELECT만 허용" 문자열
--       검사는 이를 막지 못한다.
--
-- 조치 (계층 방어):
--  1) 로그인 세션 필수 — fn_require_session(). 서버 API가 사용자 세션 토큰(x-wms-session)을 그대로 넘긴다.
--  2) 조회 샌드박스 — 쿼리를 소유자가 아니라 전용 역할(ai_readonly)로 실행한다. 이 역할은 조회를 허용한
--     테이블/뷰 SELECT 권한만 있고(직원 계정·세션 등은 권한 자체가 없음), 함수 소유자를 이 역할로 두어
--     SET ROLE 없이 그 권한으로 실행되게 한다.
--  3) 입력 방어 — 앱 함수(rpc_/fn_) 호출, pg_* 시스템 함수, current_setting/set_config 등 차단(기존 키워드 검사 유지).
--  4) 자원 제한 — 강제 READ ONLY 트랜잭션, 10초 statement_timeout, 결과 2000행 상한.
-- ==============================================================================

-- 1) 전용 역할 ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_readonly') THEN
    CREATE ROLE ai_readonly NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

-- 함수 소유자를 이 역할로 바꾸려면 postgres 가 이 역할로 SET ROLE 할 수 있어야 한다.
GRANT ai_readonly TO postgres;

GRANT USAGE ON SCHEMA public TO ai_readonly;

-- 조회를 허용할 테이블/뷰 (AI 프롬프트 스키마 + 발주 조회에 필요한 것). 존재하는 것만 부여한다.
DO $$
DECLARE
  v_name TEXT;
  v_kind "char";
  v_rls BOOLEAN;
BEGIN
  -- 이전 실행에서 넓게 열렸을 수 있는 권한을 먼저 모두 회수한다.
  EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ai_readonly';
  EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ai_readonly';

  FOREACH v_name IN ARRAY ARRAY[
    'items', 'inventory_stocks', 'stock_transactions', 'partners', 'warehouses', 'pending_orders',
    'view_effective_stocks', 'view_truck_gauge_summary', 'view_branch_stocks'
  ]
  LOOP
    SELECT c.relkind, c.relrowsecurity INTO v_kind, v_rls
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = v_name;

    IF v_kind IS NULL THEN
      CONTINUE; -- 없는 객체는 건너뜀
    END IF;

    EXECUTE format('GRANT SELECT ON public.%I TO ai_readonly', v_name);

    -- RLS 가 켜진 테이블은 이 역할용 SELECT 정책이 있어야 행이 보인다 (뷰는 소유자 권한으로 기반 테이블을 읽는다).
    IF v_kind IN ('r', 'p') AND v_rls THEN
      EXECUTE format('DROP POLICY IF EXISTS ai_readonly_select ON public.%I', v_name);
      EXECUTE format('CREATE POLICY ai_readonly_select ON public.%I FOR SELECT TO ai_readonly USING (true)', v_name);
    END IF;
  END LOOP;
END
$$;

-- 2) 샌드박스 실행기: 소유자를 ai_readonly 로 둔 SECURITY DEFINER 함수 ---------------------
CREATE OR REPLACE FUNCTION public.fn_ai_exec_readonly(p_wrapped_sql TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_result JSONB;
BEGIN
  EXECUTE p_wrapped_sql INTO v_result;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_ai_exec_readonly(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ai_exec_readonly(TEXT) TO postgres;

-- 소유자 변경 (잠깐만 CREATE 권한을 주었다가 회수한다)
GRANT CREATE ON SCHEMA public TO ai_readonly;
ALTER FUNCTION public.fn_ai_exec_readonly(TEXT) OWNER TO ai_readonly;
REVOKE CREATE ON SCHEMA public FROM ai_readonly;

-- 3) 공개 진입점 ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_exec_readonly_query(p_sql TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_member public.app_members%ROWTYPE;
  v_clean_sql TEXT;
  v_wrapped_sql TEXT;
  v_result JSONB;
BEGIN
  -- 로그인 세션 필수 (실패는 오류로 그대로 전파해 익명 호출이 데이터 없이 거부되게 한다)
  v_member := public.fn_require_session();

  BEGIN
    v_clean_sql := TRIM(p_sql);

    -- 1. 후행 세미콜론 정리
    IF RIGHT(v_clean_sql, 1) = ';' THEN
      v_clean_sql := TRIM(SUBSTRING(v_clean_sql FROM 1 FOR LENGTH(v_clean_sql) - 1));
    END IF;

    -- 2. 다중 쿼리(내부 세미콜론) 차단
    IF v_clean_sql ~ ';' THEN
      RAISE EXCEPTION '다중 쿼리는 허용되지 않습니다 (세미콜론 사용 금지).';
    END IF;

    -- 3. 오직 SELECT 또는 WITH ... SELECT 구문만 허용
    IF NOT (v_clean_sql ~* '^\s*(SELECT|WITH\s+.*\s+SELECT)\s+') THEN
      RAISE EXCEPTION '오직 SELECT 조회 쿼리만 실행할 수 있습니다.';
    END IF;

    -- 4. 위험 DDL/DML/관리자 명령 키워드 차단
    IF v_clean_sql ~* '\m(DROP|ALTER|TRUNCATE|GRANT|REVOKE|EXECUTE|CALL|COPY|CREATE|INSERT|UPDATE|DELETE|MERGE|SET|RESET|LISTEN|NOTIFY|VACUUM|ANALYZE|DO)\M' THEN
      RAISE EXCEPTION '데이터 변경(DML)·정의(DDL)·권한 변경 명령은 허용되지 않습니다.';
    END IF;

    -- 5. 앱 내부 함수(rpc_/fn_), pg_* 시스템 함수, 설정 조회/변경, 메타 스키마 접근 차단
    IF v_clean_sql ~* '\m(rpc_[a-z0-9_]*|fn_[a-z0-9_]*|pg_[a-z0-9_]*|current_setting|set_config|dblink[a-z0-9_]*|lo_[a-z0-9_]*|information_schema|auth|storage|vault|extensions|supabase_[a-z0-9_]*)\M' THEN
      RAISE EXCEPTION '허용되지 않는 함수 또는 스키마 참조가 포함되어 있습니다.';
    END IF;

    -- 6. 강제 읽기 전용 + 실행 시간 제한
    PERFORM set_config('transaction_read_only', 'on', true);
    PERFORM set_config('statement_timeout', '10s', true);

    -- 7. 결과를 2000행으로 제한한 JSON 배열로 감싸서 샌드박스(ai_readonly 소유 함수)에서 실행
    v_wrapped_sql := 'SELECT COALESCE(jsonb_agg(row_to_json(sub)), ''[]''::jsonb) FROM (SELECT * FROM ('
      || v_clean_sql || ') q LIMIT 2000) sub';

    v_result := public.fn_ai_exec_readonly(v_wrapped_sql);

    RETURN jsonb_build_object(
      'success', true,
      'data', COALESCE(v_result, '[]'::jsonb),
      'row_count', jsonb_array_length(COALESCE(v_result, '[]'::jsonb))
    );
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', SQLERRM,
      'data', '[]'::jsonb,
      'row_count', 0
    );
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_exec_readonly_query(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_exec_readonly_query(TEXT) TO anon, authenticated, service_role;
