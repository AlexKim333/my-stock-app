-- ==============================================================================
-- 🚀 AI 자연어 질의 전용 안전한 읽기 전용(SELECT) 쿼리 실행 RPC
--  * 자연어로 질문한 내용을 Gemini가 생성한 SELECT 집계 쿼리로 초고속 실행합니다.
--  * DML(INSERT, UPDATE, DELETE) 및 DDL(DROP, ALTER, CREATE 등)을 원천 차단하고
--    트랜잭션을 강제 READ ONLY로 격리하여 데이터베이스 무결성을 100% 보장합니다.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.rpc_exec_readonly_query(p_sql TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_clean_sql TEXT;
  v_wrapped_sql TEXT;
  v_result JSONB;
BEGIN
  v_clean_sql := TRIM(p_sql);

  -- 1. 후행 세미콜론 정리
  IF RIGHT(v_clean_sql, 1) = ';' THEN
    v_clean_sql := TRIM(SUBSTRING(v_clean_sql FROM 1 FOR LENGTH(v_clean_sql) - 1));
  END IF;

  -- 2. 다중 쿼리(내부 세미콜론) 원천 차단
  IF v_clean_sql ~ ';' THEN
    RAISE EXCEPTION '다중 쿼리는 허용되지 않습니다 (세미콜론 사용 금지).';
  END IF;

  -- 3. 오직 SELECT 또는 WITH ... SELECT 구문만 허용
  IF NOT (v_clean_sql ~* '^\s*(SELECT|WITH\s+.*\s+SELECT)\s+') THEN
    RAISE EXCEPTION '오직 SELECT 조회 쿼리만 실행할 수 있습니다.';
  END IF;

  -- 4. 위험 DDL 및 관리자 명령 키워드 차단
  IF v_clean_sql ~* '\m(DROP|ALTER|TRUNCATE|GRANT|REVOKE|EXECUTE|CALL|COPY|CREATE)\M' THEN
    RAISE EXCEPTION '데이터 정의(DDL) 및 권한 변경 명령은 허용되지 않습니다.';
  END IF;

  -- 5. 세션 트랜잭션을 강제 읽기 전용(READ ONLY)으로 설정
  PERFORM set_config('transaction_read_only', 'on', true);

  -- 6. jsonb_agg로 감싸서 행 목록을 안전한 JSON 배열로 반환
  v_wrapped_sql := 'SELECT COALESCE(jsonb_agg(row_to_json(sub)), ''[]''::jsonb) FROM (' || v_clean_sql || ') sub';

  EXECUTE v_wrapped_sql INTO v_result;

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
$$;

GRANT EXECUTE ON FUNCTION public.rpc_exec_readonly_query(TEXT) TO anon, authenticated, service_role;
