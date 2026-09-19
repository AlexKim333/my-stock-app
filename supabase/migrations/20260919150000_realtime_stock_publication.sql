-- ==============================================================================
-- 재고 변경 실시간 알림: inventory_stocks / pending_orders 를 Supabase Realtime 발행에 추가.
-- 프론트엔드(src/lib/stockSync.js)가 변경을 구독해 다른 기기·다른 사용자의 입출고/조정/발주를
-- 새로고침 없이 화면(메인 재고, 서브창고 매트릭스, 조정 창고 재고, 대시보드)에 반영한다.
-- 두 테이블 모두 anon/authenticated SELECT 정책이 있어 구독자에게 행 변경이 전달된다.
-- ==============================================================================

DO $$
DECLARE
  v_table TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE NOTICE 'supabase_realtime publication 없음 - 건너뜀';
    RETURN;
  END IF;

  FOREACH v_table IN ARRAY ARRAY['inventory_stocks', 'pending_orders'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = v_table
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_table);
    END IF;
  END LOOP;
END $$;
