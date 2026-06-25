-- [1단계] items 테이블: 바코드 단일 UNIQUE 제거 + 복합 UNIQUE 추가
-- Supabase SQL Editor 또는 `supabase db push` 로 실행

-- 타사 제품 바코드 중복 허용: barcode 단일 UNIQUE 제약 제거
ALTER TABLE items DROP CONSTRAINT IF EXISTS items_barcode_key;

-- [품명 + 컬러 + 포장수량] 동시 중복 방지
ALTER TABLE items DROP CONSTRAINT IF EXISTS uniq_item_name_color_pkg;
ALTER TABLE items ADD CONSTRAINT uniq_item_name_color_pkg
  UNIQUE (item_name, color, box_packaging_qty);
