-- ==============================================================================
-- ?? ???? ???? ? ?? ??? ??? ??????
-- ==============================================================================

-- 1. ???(???) ???? ?? ?? ??? ?? ? partner_type NOT NULL ??
ALTER TABLE public.partners ADD COLUMN IF NOT EXISTS is_supplier BOOLEAN DEFAULT FALSE;
ALTER TABLE public.partners ADD COLUMN IF NOT EXISTS is_customer BOOLEAN DEFAULT FALSE;
ALTER TABLE public.partners ADD COLUMN IF NOT EXISTS is_branch BOOLEAN DEFAULT FALSE;
ALTER TABLE public.partners ADD COLUMN IF NOT EXISTS warehouse_code TEXT;
ALTER TABLE public.partners ALTER COLUMN partner_type DROP NOT NULL;

-- 2. ?? partner_type ?? ??? ??
UPDATE public.partners SET is_supplier = TRUE WHERE partner_type = 'INBOUND';
UPDATE public.partners SET is_customer = TRUE WHERE partner_type = 'OUTBOUND';

-- 3. ?? ??? ?? ??:
DO $$
DECLARE
  v_dup RECORD;
  v_keep_id UUID;
BEGIN
  FOR v_dup IN (
    SELECT name
    FROM public.partners
    GROUP BY name
    HAVING COUNT(*) > 1
  )
  LOOP
    SELECT id INTO v_keep_id FROM public.partners WHERE name = v_dup.name ORDER BY created_at ASC LIMIT 1;

    UPDATE public.partners
    SET is_supplier = TRUE, is_customer = TRUE, partner_type = 'BOTH'
    WHERE id = v_keep_id;

    DELETE FROM public.partners
    WHERE name = v_dup.name AND id <> v_keep_id;
  END LOOP;
END $$;

-- 4. ??? ????? (name)?? ???? ??
ALTER TABLE public.partners DROP CONSTRAINT IF EXISTS uniq_partner_type_name;
ALTER TABLE public.partners DROP CONSTRAINT IF EXISTS uniq_partner_name;
ALTER TABLE public.partners ADD CONSTRAINT uniq_partner_name UNIQUE (name);

-- 5. ??(????) ??? ??/???
INSERT INTO public.partners (name, partner_type, is_branch, warehouse_code, is_supplier, is_customer)
VALUES 
  ('PANTACO', 'BRANCH', TRUE, 'PANTACO', FALSE, FALSE),
  ('IKEA', 'BRANCH', TRUE, 'IKEA', FALSE, FALSE),
  ('LERMA', 'BRANCH', TRUE, 'LERMA', FALSE, FALSE),
  ('PINO', 'BRANCH', TRUE, 'PINO', FALSE, FALSE),
  ('YARE', 'BRANCH', TRUE, 'YARE', FALSE, FALSE),
  ('ALMINTER', 'BRANCH', TRUE, 'ALMINTER', FALSE, FALSE),
  ('TLANE', 'BRANCH', TRUE, 'TLANE', FALSE, FALSE),
  ('STAR', 'BRANCH', TRUE, 'STAR', FALSE, FALSE),
  ('???? (????)', 'BRANCH', TRUE, 'MAIN', FALSE, FALSE)
ON CONFLICT (name) DO UPDATE 
SET is_branch = TRUE, warehouse_code = EXCLUDED.warehouse_code;

-- 6. ???? ??? ?? ??
ALTER TABLE public.stock_transactions ADD COLUMN IF NOT EXISTS source_warehouse TEXT;
ALTER TABLE public.stock_transactions ADD COLUMN IF NOT EXISTS target_warehouse TEXT;

-- 7. ??? ???? RPC ????? (??? ???? ? ???? ??? ??)
CREATE OR REPLACE FUNCTION public.rpc_process_transaction(
  p_tx_type TEXT,
  p_warehouse TEXT,
  p_partner TEXT,
  p_handler TEXT,
  p_invoice TEXT,
  p_memo TEXT,
  p_items JSONB,
  p_target_warehouse TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_item RECORD;
  v_item_id UUID;
  v_box_qty INT;
  v_unit_qty INT;
  v_curr_box INT;
  v_curr_unit INT;
  v_target_box INT;
  v_target_unit INT;
  v_is_transfer BOOLEAN := FALSE;
  v_dest_wh TEXT;
BEGIN
  IF p_tx_type = 'MOVE' OR (p_target_warehouse IS NOT NULL AND p_target_warehouse <> '' AND p_target_warehouse <> p_warehouse) THEN
    v_is_transfer := TRUE;
    v_dest_wh := p_target_warehouse;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_to_recordset(p_items) AS x(item_id UUID, box_qty INT, unit_qty INT)
  LOOP
    v_item_id := v_item.item_id;
    v_box_qty := COALESCE(v_item.box_qty, 0);
    v_unit_qty := COALESCE(v_item.unit_qty, 0);

    IF v_is_transfer THEN
      -- ?? ?? ?? ?? ? ??
      SELECT box_qty, unit_qty INTO v_curr_box, v_curr_unit
      FROM public.inventory_stocks
      WHERE item_id = v_item_id AND warehouse_code = p_warehouse
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION '????(%)? ??(%) ?? ???? ????.', p_warehouse, v_item_id;
      END IF;

      IF v_curr_box < v_box_qty THEN
        RAISE EXCEPTION '?? ??: ????(%)? ?? ????? %??? %? ?? ???', p_warehouse, v_curr_box, v_box_qty;
      END IF;

      UPDATE public.inventory_stocks
      SET box_qty = box_qty - v_box_qty,
          unit_qty = unit_qty - v_unit_qty,
          updated_at = NOW()
      WHERE item_id = v_item_id AND warehouse_code = p_warehouse;

      -- ?? ?? ?? ?? ? ??
      SELECT box_qty, unit_qty INTO v_target_box, v_target_unit
      FROM public.inventory_stocks
      WHERE item_id = v_item_id AND warehouse_code = v_dest_wh
      FOR UPDATE;

      IF NOT FOUND THEN
        INSERT INTO public.inventory_stocks (item_id, warehouse_code, box_qty, unit_qty)
        VALUES (v_item_id, v_dest_wh, v_box_qty, v_unit_qty);
      ELSE
        UPDATE public.inventory_stocks
        SET box_qty = box_qty + v_box_qty,
            unit_qty = unit_qty + v_unit_qty,
            updated_at = NOW()
        WHERE item_id = v_item_id AND warehouse_code = v_dest_wh;
      END IF;

      INSERT INTO public.stock_transactions (
        transaction_type, item_id, warehouse_code, source_warehouse, target_warehouse,
        partner_name, box_qty, unit_qty, handler_name, invoice_no, memo
      ) VALUES (
        'MOVE', v_item_id, p_warehouse, p_warehouse, v_dest_wh,
        COALESCE(p_partner, v_dest_wh), v_box_qty, v_unit_qty, p_handler, p_invoice, p_memo
      );

    ELSIF p_tx_type = 'OUTBOUND' THEN
      SELECT box_qty, unit_qty INTO v_curr_box, v_curr_unit
      FROM public.inventory_stocks
      WHERE item_id = v_item_id AND warehouse_code = p_warehouse
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION '????(%)? ??(%) ?? ???? ????.', p_warehouse, v_item_id;
      END IF;

      IF v_curr_box < v_box_qty THEN
        RAISE EXCEPTION '?? ??: ????(%)? ?? ????? %??? %? ?? ???', p_warehouse, v_curr_box, v_box_qty;
      END IF;

      UPDATE public.inventory_stocks
      SET box_qty = box_qty - v_box_qty,
          unit_qty = unit_qty - v_unit_qty,
          updated_at = NOW()
      WHERE item_id = v_item_id AND warehouse_code = p_warehouse;

      INSERT INTO public.stock_transactions (
        transaction_type, item_id, warehouse_code, source_warehouse, target_warehouse,
        partner_name, box_qty, unit_qty, handler_name, invoice_no, memo
      ) VALUES (
        p_tx_type, v_item_id, p_warehouse, p_warehouse, NULL,
        p_partner, v_box_qty, v_unit_qty, p_handler, p_invoice, p_memo
      );

    ELSE
      SELECT box_qty, unit_qty INTO v_curr_box, v_curr_unit
      FROM public.inventory_stocks
      WHERE item_id = v_item_id AND warehouse_code = p_warehouse
      FOR UPDATE;

      IF NOT FOUND THEN
        INSERT INTO public.inventory_stocks (item_id, warehouse_code, box_qty, unit_qty)
        VALUES (v_item_id, p_warehouse, v_box_qty, v_unit_qty);
      ELSE
        UPDATE public.inventory_stocks
        SET box_qty = box_qty + v_box_qty,
            unit_qty = unit_qty + v_unit_qty,
            updated_at = NOW()
        WHERE item_id = v_item_id AND warehouse_code = p_warehouse;
      END IF;

      INSERT INTO public.stock_transactions (
        transaction_type, item_id, warehouse_code, source_warehouse, target_warehouse,
        partner_name, box_qty, unit_qty, handler_name, invoice_no, memo
      ) VALUES (
        p_tx_type, v_item_id, p_warehouse, NULL, p_warehouse,
        p_partner, v_box_qty, v_unit_qty, p_handler, p_invoice, p_memo
      );
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'message', '???? ?? ??');
END;
$$ LANGUAGE plpgsql;
