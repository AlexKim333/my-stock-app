-- ==============================================================================
-- 🚀 WMS 올인원 마이그레이션 스키마 (Complete WMS Schema)
-- 멕시코 센트로 물류 환경 최적화: 8대 서브창고, 100상자 FTL 게이지, 유효재고 계산 뷰, 원자적 입출고 RPC
-- ==============================================================================

-- 1. 확장 기능 활성화
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. 브랜드 / 메이커 (brands)
CREATE TABLE IF NOT EXISTS public.brands (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. 상품 품목 마스터 (items)
CREATE TABLE IF NOT EXISTS public.items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  item_name TEXT NOT NULL,
  color TEXT DEFAULT 'SURTIDO',
  box_packaging_qty NUMERIC DEFAULT 1,
  initial_stock_boxes NUMERIC DEFAULT 0,
  initial_stock_units NUMERIC DEFAULT 0,
  barcode TEXT,
  brand_id UUID REFERENCES public.brands(id) ON DELETE SET NULL,
  grid_group_id TEXT,
  is_grid_item BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  item_code TEXT,
  name_number INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uniq_item_name_color_pkg UNIQUE (item_name, color, box_packaging_qty)
);

CREATE INDEX IF NOT EXISTS idx_items_item_name ON public.items USING btree (item_name);
CREATE INDEX IF NOT EXISTS idx_items_barcode ON public.items USING btree (barcode);
CREATE INDEX IF NOT EXISTS idx_items_name_number ON public.items USING btree (name_number);
CREATE INDEX IF NOT EXISTS idx_items_grid_group ON public.items USING btree (grid_group_id);

-- 4. 품목코드 자동 생성 및 숫자 추출 트리거
CREATE OR REPLACE FUNCTION fn_generate_item_code() RETURNS TRIGGER AS $$
DECLARE
  extracted_num TEXT;
BEGIN
  NEW.item_code := NEW.item_name || '-' || COALESCE(NEW.color, 'NoColor') || '-' || COALESCE(NEW.box_packaging_qty, 1)::TEXT;
  IF NEW.grid_group_id IS NULL OR NEW.grid_group_id = '' THEN
    NEW.grid_group_id := NEW.item_name;
  END IF;
  extracted_num := regexp_replace(NEW.item_name, '[^0-9]', '', 'g');
  IF extracted_num <> '' THEN
    NEW.name_number := extracted_num::INTEGER;
  ELSE
    NEW.name_number := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_generate_item_code ON public.items;
CREATE TRIGGER trg_generate_item_code
BEFORE INSERT OR UPDATE ON public.items
FOR EACH ROW EXECUTE FUNCTION fn_generate_item_code();

-- 5. 작업자 및 관리자 계정 (app_members)
CREATE TABLE IF NOT EXISTS public.app_members (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  member_name TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  branch_name TEXT,
  access_level TEXT NOT NULL DEFAULT 'staff',
  preferred_language TEXT NOT NULL DEFAULT 'es',
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_members_name ON public.app_members USING btree (member_name);

-- 6. 멕시코 센트로 8대 서브창고 및 메인 허브 (warehouses)
CREATE TABLE IF NOT EXISTS public.warehouses (
  code TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  is_hub BOOLEAN DEFAULT FALSE,
  sort_order INTEGER DEFAULT 0,
  truck_capacity_boxes INTEGER DEFAULT 100,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. 창고별 실시간 재고 (inventory_stocks)
CREATE TABLE IF NOT EXISTS public.inventory_stocks (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  item_id UUID NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
  warehouse_code TEXT NOT NULL REFERENCES public.warehouses(code) ON DELETE CASCADE,
  box_qty INTEGER NOT NULL DEFAULT 0,
  unit_qty INTEGER NOT NULL DEFAULT 0,
  safe_stock_boxes INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uniq_item_warehouse UNIQUE (item_id, warehouse_code)
);

CREATE INDEX IF NOT EXISTS idx_inventory_stocks_item ON public.inventory_stocks(item_id);
CREATE INDEX IF NOT EXISTS idx_inventory_stocks_wh ON public.inventory_stocks(warehouse_code);

-- 8. 거래처 목록 (partners - 입고처/출고처)
CREATE TABLE IF NOT EXISTS public.partners (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  partner_type TEXT NOT NULL, -- 'INBOUND', 'OUTBOUND'
  name TEXT NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uniq_partner_type_name UNIQUE (partner_type, name)
);

-- 9. 별명사전 (aliases - 상품 별칭 매핑)
CREATE TABLE IF NOT EXISTS public.aliases (
  alias TEXT NOT NULL PRIMARY KEY,
  target_item_name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 10. 이동중 PENDING 및 서브창고 주문 (pending_orders)
CREATE TABLE IF NOT EXISTS public.pending_orders (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  item_id UUID NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
  from_warehouse TEXT REFERENCES public.warehouses(code),
  to_warehouse TEXT REFERENCES public.warehouses(code),
  box_qty INTEGER NOT NULL DEFAULT 0,
  unit_qty INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'IN_TRANSIT', 'LISTO', 'COMPLETED', 'CANCELLED'
  requested_by TEXT,
  memo TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pending_orders_status ON public.pending_orders(status);
CREATE INDEX IF NOT EXISTS idx_pending_orders_item ON public.pending_orders(item_id);
CREATE INDEX IF NOT EXISTS idx_pending_orders_from ON public.pending_orders(from_warehouse);
CREATE INDEX IF NOT EXISTS idx_pending_orders_to ON public.pending_orders(to_warehouse);

-- 11. 입출고 트랜잭션 및 감사 이력 (stock_transactions)
CREATE TABLE IF NOT EXISTS public.stock_transactions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  transaction_type TEXT NOT NULL, -- 'INBOUND', 'OUTBOUND', 'MOVE', 'ADJUST'
  item_id UUID NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
  warehouse_code TEXT REFERENCES public.warehouses(code),
  partner_name TEXT,
  box_qty INTEGER NOT NULL DEFAULT 0,
  unit_qty INTEGER NOT NULL DEFAULT 0,
  handler_name TEXT,
  invoice_no TEXT,
  memo TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_created ON public.stock_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON public.stock_transactions(transaction_type);
CREATE INDEX IF NOT EXISTS idx_transactions_item ON public.stock_transactions(item_id);

-- 12. ⚡ [실시간 계산 뷰 1] 유효재고 계산 뷰 (view_effective_stocks)
-- 유효재고 = 실재고 + 이동중(Pending In) - 출고예정(Pending Out)
CREATE OR REPLACE VIEW public.view_effective_stocks AS
SELECT
  i.id AS item_id,
  i.item_name,
  i.color,
  i.box_packaging_qty,
  i.item_code,
  i.barcode,
  COALESCE(s.box_qty, 0) AS main_box_qty,
  COALESCE(s.unit_qty, 0) AS main_unit_qty,
  COALESCE(s.safe_stock_boxes, 0) AS safe_stock_boxes,
  COALESCE(p_in.pending_in_boxes, 0) AS pending_in_boxes,
  COALESCE(p_out.pending_out_boxes, 0) AS pending_out_boxes,
  (COALESCE(s.box_qty, 0) + COALESCE(p_in.pending_in_boxes, 0) - COALESCE(p_out.pending_out_boxes, 0)) AS effective_box_qty
FROM public.items i
LEFT JOIN public.inventory_stocks s 
  ON i.id = s.item_id AND s.warehouse_code = 'MAIN'
LEFT JOIN (
  SELECT item_id, SUM(box_qty) AS pending_in_boxes
  FROM public.pending_orders
  WHERE to_warehouse = 'MAIN' AND status IN ('PENDING', 'IN_TRANSIT')
  GROUP BY item_id
) p_in ON i.id = p_in.item_id
LEFT JOIN (
  SELECT item_id, SUM(box_qty) AS pending_out_boxes
  FROM public.pending_orders
  WHERE from_warehouse = 'MAIN' AND status IN ('PENDING', 'IN_TRANSIT')
  GROUP BY item_id
) p_out ON i.id = p_out.item_id;

-- 13. ⚡ [실시간 계산 뷰 2] 8대 서브창고별 100상자 트럭 달성률 (view_truck_gauge_summary)
CREATE OR REPLACE VIEW public.view_truck_gauge_summary AS
SELECT
  w.code AS warehouse_code,
  w.name AS warehouse_name,
  w.sort_order,
  w.truck_capacity_boxes,
  COALESCE(SUM(po.box_qty), 0) AS current_boxes,
  ROUND(
    (COALESCE(SUM(po.box_qty), 0)::NUMERIC / NULLIF(w.truck_capacity_boxes, 0) * 100), 
    1
  ) AS gauge_percentage
FROM public.warehouses w
LEFT JOIN public.pending_orders po 
  ON w.code = po.from_warehouse AND po.status IN ('PENDING', 'IN_TRANSIT')
WHERE w.is_hub = FALSE
GROUP BY w.code, w.name, w.sort_order, w.truck_capacity_boxes
ORDER BY w.sort_order ASC;

-- 14. 🛡️ [원자적 RPC] 올인원 입출고 처리 함수 (rpc_process_transaction)
-- 단 1회 호출로 재고 증감 + 트랜잭션 로그를 원자적(ACID) 일괄 실행
CREATE OR REPLACE FUNCTION public.rpc_process_transaction(
  p_tx_type TEXT,
  p_warehouse TEXT,
  p_partner TEXT,
  p_handler TEXT,
  p_invoice TEXT,
  p_memo TEXT,
  p_items JSONB
) RETURNS JSONB AS $$
DECLARE
  v_item RECORD;
  v_item_id UUID;
  v_box_qty INT;
  v_unit_qty INT;
  v_curr_box INT;
  v_curr_unit INT;
BEGIN
  -- 각 품목 순회 처리
  FOR v_item IN SELECT * FROM jsonb_to_recordset(p_items) AS x(item_id UUID, box_qty INT, unit_qty INT)
  LOOP
    v_item_id := v_item.item_id;
    v_box_qty := COALESCE(v_item.box_qty, 0);
    v_unit_qty := COALESCE(v_item.unit_qty, 0);

    -- 재고 레코드 존재 확인 및 행 락(Row Lock)
    SELECT box_qty, unit_qty INTO v_curr_box, v_curr_unit
    FROM public.inventory_stocks
    WHERE item_id = v_item_id AND warehouse_code = p_warehouse
    FOR UPDATE;

    IF NOT FOUND THEN
      -- 첫 입고 시 기본 레코드 생성
      INSERT INTO public.inventory_stocks (item_id, warehouse_code, box_qty, unit_qty)
      VALUES (v_item_id, p_warehouse, 0, 0)
      RETURNING box_qty, unit_qty INTO v_curr_box, v_curr_unit;
    END IF;

    -- 출고 시 재고 부족 검증 (음수 재고 방어)
    IF p_tx_type = 'OUTBOUND' THEN
      IF v_curr_box < v_box_qty THEN
        RAISE EXCEPTION '재고 부족: 품목(%)의 현재 박스재고는 %개이나 %개 출고 시도됨', v_item_id, v_curr_box, v_box_qty;
      END IF;
      
      UPDATE public.inventory_stocks
      SET box_qty = box_qty - v_box_qty,
          unit_qty = unit_qty - v_unit_qty,
          updated_at = NOW()
      WHERE item_id = v_item_id AND warehouse_code = p_warehouse;
    ELSE
      -- 입고(INBOUND) 또는 보정
      UPDATE public.inventory_stocks
      SET box_qty = box_qty + v_box_qty,
          unit_qty = unit_qty + v_unit_qty,
          updated_at = NOW()
      WHERE item_id = v_item_id AND warehouse_code = p_warehouse;
    END IF;

    -- 트랜잭션 로그 기록
    INSERT INTO public.stock_transactions (
      transaction_type, item_id, warehouse_code, partner_name, 
      box_qty, unit_qty, handler_name, invoice_no, memo
    ) VALUES (
      p_tx_type, v_item_id, p_warehouse, p_partner, 
      v_box_qty, v_unit_qty, p_handler, p_invoice, p_memo
    );
  END LOOP;

  RETURN jsonb_build_object('success', true, 'message', '트랜잭션 처리 완료');
END;
$$ LANGUAGE plpgsql;

-- 15. 🔓 RLS (Row Level Security) 설정 및 완전 개방
ALTER TABLE public.brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warehouses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_stocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pending_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Enable all access for all users on brands" ON public.brands;
CREATE POLICY "Enable all access for all users on brands" ON public.brands FOR ALL TO public USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Enable all access for all users on items" ON public.items;
CREATE POLICY "Enable all access for all users on items" ON public.items FOR ALL TO public USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Enable all access for all users on app_members" ON public.app_members;
CREATE POLICY "Enable all access for all users on app_members" ON public.app_members FOR ALL TO public USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Enable all access for all users on warehouses" ON public.warehouses;
CREATE POLICY "Enable all access for all users on warehouses" ON public.warehouses FOR ALL TO public USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Enable all access for all users on inventory_stocks" ON public.inventory_stocks;
CREATE POLICY "Enable all access for all users on inventory_stocks" ON public.inventory_stocks FOR ALL TO public USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Enable all access for all users on partners" ON public.partners;
CREATE POLICY "Enable all access for all users on partners" ON public.partners FOR ALL TO public USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Enable all access for all users on aliases" ON public.aliases;
CREATE POLICY "Enable all access for all users on aliases" ON public.aliases FOR ALL TO public USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Enable all access for all users on pending_orders" ON public.pending_orders;
CREATE POLICY "Enable all access for all users on pending_orders" ON public.pending_orders FOR ALL TO public USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Enable all access for all users on stock_transactions" ON public.stock_transactions;
CREATE POLICY "Enable all access for all users on stock_transactions" ON public.stock_transactions FOR ALL TO public USING (true) WITH CHECK (true);

-- 16. 🌱 기초 시드 데이터 주입 (Seed Data)
-- 8대 서브창고 및 메인 허브
INSERT INTO public.warehouses (code, name, is_hub, sort_order, truck_capacity_boxes) VALUES
  ('MAIN', '메인 허브 창고 (CENTRO)', TRUE, 0, 0),
  ('PANTACO', 'PANTACO 창고', FALSE, 1, 100),
  ('IKEA', 'IKEA 창고', FALSE, 2, 100),
  ('LERMA', 'LERMA 창고', FALSE, 3, 100),
  ('PINO', 'PINO 창고', FALSE, 4, 100),
  ('YARE', 'YARE 창고', FALSE, 5, 100),
  ('ALMINTER', 'ALMINTER 창고', FALSE, 6, 100),
  ('TLANE', 'TLANE 창고', FALSE, 7, 100),
  ('STAR', 'STAR 창고', FALSE, 8, 100)
ON CONFLICT (code) DO NOTHING;

-- 기본 관리자 및 작업자 계정
INSERT INTO public.app_members (member_name, password_hash, branch_name, access_level, preferred_language) VALUES
  ('admin', 'admin', 'CENTRO', 'admin', 'ko'),
  ('operador', '1234', 'CENTRO', 'staff', 'es')
ON CONFLICT (member_name) DO NOTHING;

-- 기본 입출고 거래처 예시
INSERT INTO public.partners (partner_type, name) VALUES
  ('INBOUND', '공장 직입고'),
  ('INBOUND', '수입 컨테이너'),
  ('OUTBOUND', 'CENTRO 매장 1호점'),
  ('OUTBOUND', 'BODEGA 도매 출고')
ON CONFLICT (partner_type, name) DO NOTHING;
