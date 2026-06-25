-- 1. Brands 및 Items 테이블 RLS (보안 정책) 완전 개방
DROP POLICY IF EXISTS "Enable all access for all users on brands" ON brands;
CREATE POLICY "Enable all access for all users on brands" ON brands FOR ALL TO public USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Enable all access for all users on items" ON items;
CREATE POLICY "Enable all access for all users on items" ON items FOR ALL TO public USING (true) WITH CHECK (true);

-- 2. 상품명 숫자 추출용 컬럼 및 검색 속도 향상 인덱스 추가
ALTER TABLE items ADD COLUMN IF NOT EXISTS name_number INTEGER;
CREATE INDEX IF NOT EXISTS idx_items_name_number ON items (name_number);
CREATE INDEX IF NOT EXISTS idx_items_item_name ON public.items USING btree (item_name);

-- 3. 품목코드 생성 및 숫자 자동 추출 트리거 함수
CREATE OR REPLACE FUNCTION fn_generate_item_code() RETURNS TRIGGER AS $$
DECLARE
    extracted_num TEXT;
BEGIN
    NEW.item_code := NEW.item_name || '-' || COALESCE(NEW.color, 'NoColor') || '-' || NEW.box_packaging_qty::TEXT;
    IF NEW.grid_group_id IS NULL THEN NEW.grid_group_id := NEW.item_name; END IF;
    extracted_num := regexp_replace(NEW.item_name, '[^0-9]', '', 'g');
    IF extracted_num <> '' THEN NEW.name_number := extracted_num::INTEGER; ELSE NEW.name_number := NULL; END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 4. [최적화 버전] is_grid_item 상태 자동 업데이트 트리거
DROP TRIGGER IF EXISTS trg_auto_update_grid_status ON items;
CREATE OR REPLACE FUNCTION fn_update_grid_status_on_sibling() RETURNS TRIGGER AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM items WHERE item_name = NEW.item_name AND id != NEW.id) THEN
    UPDATE items SET is_grid_item = TRUE WHERE item_name = NEW.item_name AND is_grid_item = FALSE;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_auto_update_grid_status AFTER INSERT OR UPDATE ON items FOR EACH ROW EXECUTE FUNCTION fn_update_grid_status_on_sibling();

-- 5. 앱 권한 및 접근 관리를 위한 회원(app_members) 테이블 생성
create table public.app_members (
  id uuid not null default extensions.uuid_generate_v4 (),
  member_name text not null,
  password_hash text not null,
  branch_name text null,
  access_level text not null default 'staff',
  preferred_language text not null default 'es',
  is_active boolean null default true,
  created_at timestamp with time zone null default now(),
  constraint app_members_pkey primary key (id),
  constraint app_members_name_key unique (member_name)
) TABLESPACE pg_default;

create index IF not exists idx_app_members_name on public.app_members using btree (member_name) TABLESPACE pg_default;
create index IF not exists idx_app_members_branch on public.app_members using btree (branch_name) TABLESPACE pg_default;

CREATE TRIGGER trg_generate_item_code BEFORE INSERT OR UPDATE ON items FOR EACH ROW EXECUTE FUNCTION fn_generate_item_code();

-- 누락되었던 품목코드 자동 생성 트리거 부착
DROP TRIGGER IF EXISTS trg_generate_item_code ON items;
CREATE TRIGGER trg_generate_item_code
BEFORE INSERT OR UPDATE ON items
FOR EACH ROW
EXECUTE FUNCTION fn_generate_item_code();