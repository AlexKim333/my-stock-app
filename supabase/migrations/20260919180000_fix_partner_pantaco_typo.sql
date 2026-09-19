-- ==============================================================================
-- 입고 거래처 오타 통합 및 삭제: PANTANCO -> PANTACO
--  1) PANTACO 거래처를 입고 공급처(is_supplier = TRUE) 및 지점(is_branch = TRUE)으로 활성화
--  2) 중복 오타 레코드 PANTANCO 삭제
-- ==============================================================================

UPDATE public.partners
SET is_supplier = TRUE,
    is_branch = TRUE,
    warehouse_code = 'PANTACO'
WHERE name = 'PANTACO';

DELETE FROM public.partners
WHERE name = 'PANTANCO';
