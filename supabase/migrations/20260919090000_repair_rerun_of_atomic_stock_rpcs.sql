-- ==============================================================================
-- 복구: 20260918140000을 (이미 이후 마이그레이션이 수동 적용된) 운영 DB에 다시 실행해서 생긴 퇴행 되돌리기
--  * invoice_sequences 전체 허용 정책 재생성 → 제거 (anon 키로 전표 채번 조작 가능했음)
--  * 되살아난 구버전 오버로드 제거: rpc_process_transaction(9인자), rpc_adjust_stock(5인자),
--    fn_fifo_complete_pending(INTEGER)
--  * 구버전 본문으로 덮어써진 rpc_update_transaction_records 래퍼(세션 검증) 복원
-- 새 DB에서는 이미 올바른 상태이므로 모든 문장이 무해하게 통과한다.
-- ==============================================================================

DROP POLICY IF EXISTS "Enable all access for all users on invoice_sequences" ON public.invoice_sequences;
REVOKE ALL ON TABLE public.invoice_sequences FROM anon, authenticated;

DROP FUNCTION IF EXISTS public.rpc_process_transaction(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.rpc_adjust_stock(TEXT, JSONB, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.fn_fifo_complete_pending(TEXT, UUID, INTEGER);

-- 20260918150000에서 지정했던 SECURITY DEFINER가 재실행으로 풀렸던 함수들
ALTER FUNCTION public.rpc_next_invoice_no(TEXT, DATE) SECURITY DEFINER;
ALTER FUNCTION public.rpc_complete_inbound_pending_orders(TEXT, JSONB) SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.rpc_update_transaction_records(
  p_invoice_no TEXT,
  p_tx_type TEXT,
  p_new_records JSONB,
  p_admin TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_member public.app_members%ROWTYPE;
BEGIN
  v_member := public.fn_require_session();
  RETURN public.rpc_update_transaction_records_apply(
    p_invoice_no,
    p_tx_type,
    p_new_records,
    COALESCE(v_member.member_name, p_admin)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_update_transaction_records(TEXT, TEXT, JSONB, TEXT) TO anon, authenticated;
