-- ==============================================================================
-- 핫픽스: 20260919090000에서 invoice_sequences의 anon 테이블 권한을 회수한 뒤
-- SECURITY INVOKER인 rpc_peek_next_invoice_seq가 "permission denied for table invoice_sequences"로 실패.
-- 읽기 전용 함수이므로 소유자 권한으로 실행한다. (이전에는 RLS 때문에 anon이 last_seq를 보지 못해
-- 화면에 표시되는 다음 전표번호가 실제 채번과 어긋날 수 있었는데, 이것도 함께 바로잡힌다.)
-- ==============================================================================

ALTER FUNCTION public.rpc_peek_next_invoice_seq(TEXT, DATE) SECURITY DEFINER;
GRANT EXECUTE ON FUNCTION public.rpc_peek_next_invoice_seq(TEXT, DATE) TO anon, authenticated, service_role;
