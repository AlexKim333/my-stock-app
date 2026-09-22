-- ==============================================================================
-- 🔗 stock_transactions 정합성 개선: partner_name/handler_name 텍스트 스냅샷에
--    partner_id/handler_id FK를 병행 저장 (노드 관리 UI 3단계 후속 작업)
--
-- partner_name/handler_name 컬럼은 발생 시점의 이름을 그대로 보존하는 감사용
-- 스냅샷으로 유지한다(과거 전표는 그 당시 이름으로 보여야 하므로). 대신 FK를
-- 추가로 채워 두면 이름이 바뀌거나 비활성화된 노드라도 실제 거래처/담당자
-- 레코드와의 연결이 끊기지 않고, 향후 거래처별 집계·필터링이 가능해진다.
--
-- 기존에 stock_transactions를 INSERT/UPDATE하는 RPC가 여러 마이그레이션에
-- 걸쳐 재정의되어 왔으므로, 그 RPC들을 일일이 고치는 대신 트리거 하나로
-- 모든 쓰기 경로(과거·현재·향후)를 한곳에서 처리한다.
-- ==============================================================================

-- 1. FK 컬럼 추가 (노드가 삭제되어도 과거 전표 행 자체는 보존 — ON DELETE SET NULL)
ALTER TABLE public.stock_transactions
  ADD COLUMN IF NOT EXISTS partner_id UUID REFERENCES public.partners(id) ON DELETE SET NULL;
ALTER TABLE public.stock_transactions
  ADD COLUMN IF NOT EXISTS handler_id UUID REFERENCES public.app_members(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_stock_transactions_partner_id ON public.stock_transactions(partner_id);
CREATE INDEX IF NOT EXISTS idx_stock_transactions_handler_id ON public.stock_transactions(handler_id);

-- 2. 기존 데이터 백필 (이름 대소문자/공백 무시 정확 매칭, 매칭 안 되면 NULL로 유지)
UPDATE public.stock_transactions t
SET partner_id = p.id
FROM public.partners p
WHERE t.partner_id IS NULL
  AND t.partner_name IS NOT NULL
  AND lower(trim(t.partner_name)) = lower(trim(p.name));

UPDATE public.stock_transactions t
SET handler_id = m.id
FROM public.app_members m
WHERE t.handler_id IS NULL
  AND t.handler_name IS NOT NULL
  AND lower(trim(t.handler_name)) = lower(trim(m.member_name));

-- 3. 쓰기 시점 자동 연결 트리거 (신규 RPC를 포함한 모든 INSERT/UPDATE 경로에 공통 적용)
CREATE OR REPLACE FUNCTION public.fn_resolve_stock_transaction_refs()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO public
AS $$
BEGIN
  IF NEW.partner_id IS NULL AND NEW.partner_name IS NOT NULL AND TRIM(NEW.partner_name) <> '' THEN
    SELECT id INTO NEW.partner_id
    FROM public.partners
    WHERE lower(trim(name)) = lower(trim(NEW.partner_name))
    LIMIT 1;
  END IF;

  IF NEW.handler_id IS NULL AND NEW.handler_name IS NOT NULL AND TRIM(NEW.handler_name) <> '' THEN
    SELECT id INTO NEW.handler_id
    FROM public.app_members
    WHERE lower(trim(member_name)) = lower(trim(NEW.handler_name))
    LIMIT 1;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_resolve_stock_transaction_refs ON public.stock_transactions;
CREATE TRIGGER trg_resolve_stock_transaction_refs
BEFORE INSERT OR UPDATE ON public.stock_transactions
FOR EACH ROW EXECUTE FUNCTION public.fn_resolve_stock_transaction_refs();
