export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      aliases: {
        Row: {
          alias: string
          created_at: string | null
          target_item_name: string
        }
        Insert: {
          alias: string
          created_at?: string | null
          target_item_name: string
        }
        Update: {
          alias?: string
          created_at?: string | null
          target_item_name?: string
        }
        Relationships: []
      }
      app_members: {
        Row: {
          access_level: string
          branch_name: string | null
          created_at: string | null
          id: string
          is_active: boolean | null
          member_name: string
          password_hash: string
          preferred_language: string
        }
        Insert: {
          access_level?: string
          branch_name?: string | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          member_name: string
          password_hash: string
          preferred_language?: string
        }
        Update: {
          access_level?: string
          branch_name?: string | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          member_name?: string
          password_hash?: string
          preferred_language?: string
        }
        Relationships: []
      }
      app_sessions: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          member_id: string
          token_hash: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          id?: string
          member_id: string
          token_hash: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          member_id?: string
          token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "app_sessions_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "app_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "app_sessions_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "app_members_public"
            referencedColumns: ["id"]
          },
        ]
      }
      app_settings: {
        Row: {
          id: string
          updated_at: string
          updated_by: string | null
          value: Json
        }
        Insert: {
          id: string
          updated_at?: string
          updated_by?: string | null
          value?: Json
        }
        Update: {
          id?: string
          updated_at?: string
          updated_by?: string | null
          value?: Json
        }
        Relationships: []
      }
      brands: {
        Row: {
          created_at: string | null
          description: string | null
          id: string
          is_active: boolean | null
          name: string
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean | null
          name: string
        }
        Update: {
          created_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
        }
        Relationships: []
      }
      inventory_stocks: {
        Row: {
          box_qty: number
          id: string
          item_id: string
          safe_stock_boxes: number
          unit_qty: number
          updated_at: string | null
          warehouse_code: string
        }
        Insert: {
          box_qty?: number
          id?: string
          item_id: string
          safe_stock_boxes?: number
          unit_qty?: number
          updated_at?: string | null
          warehouse_code: string
        }
        Update: {
          box_qty?: number
          id?: string
          item_id?: string
          safe_stock_boxes?: number
          unit_qty?: number
          updated_at?: string | null
          warehouse_code?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_stocks_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_stocks_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "view_effective_stocks"
            referencedColumns: ["item_id"]
          },
          {
            foreignKeyName: "inventory_stocks_warehouse_code_fkey"
            columns: ["warehouse_code"]
            isOneToOne: false
            referencedRelation: "view_truck_gauge_summary"
            referencedColumns: ["warehouse_code"]
          },
          {
            foreignKeyName: "inventory_stocks_warehouse_code_fkey"
            columns: ["warehouse_code"]
            isOneToOne: false
            referencedRelation: "warehouses"
            referencedColumns: ["code"]
          },
        ]
      }
      invoice_sequences: {
        Row: {
          biz_date: string
          last_seq: number
          tx_group: string
          updated_at: string | null
        }
        Insert: {
          biz_date: string
          last_seq?: number
          tx_group: string
          updated_at?: string | null
        }
        Update: {
          biz_date?: string
          last_seq?: number
          tx_group?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      items: {
        Row: {
          barcode: string | null
          box_packaging_qty: number | null
          brand_id: string | null
          color: string | null
          created_at: string | null
          grid_group_id: string | null
          id: string
          initial_stock_boxes: number | null
          initial_stock_units: number | null
          is_active: boolean | null
          is_grid_item: boolean | null
          item_code: string | null
          item_name: string
          name_number: number | null
        }
        Insert: {
          barcode?: string | null
          box_packaging_qty?: number | null
          brand_id?: string | null
          color?: string | null
          created_at?: string | null
          grid_group_id?: string | null
          id?: string
          initial_stock_boxes?: number | null
          initial_stock_units?: number | null
          is_active?: boolean | null
          is_grid_item?: boolean | null
          item_code?: string | null
          item_name: string
          name_number?: number | null
        }
        Update: {
          barcode?: string | null
          box_packaging_qty?: number | null
          brand_id?: string | null
          color?: string | null
          created_at?: string | null
          grid_group_id?: string | null
          id?: string
          initial_stock_boxes?: number | null
          initial_stock_units?: number | null
          is_active?: boolean | null
          is_grid_item?: boolean | null
          item_code?: string | null
          item_name?: string
          name_number?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "items_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "brands"
            referencedColumns: ["id"]
          },
        ]
      }
      partners: {
        Row: {
          created_at: string | null
          id: string
          is_active: boolean | null
          is_branch: boolean | null
          is_customer: boolean | null
          is_supplier: boolean | null
          name: string
          partner_type: string | null
          warehouse_code: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          is_branch?: boolean | null
          is_customer?: boolean | null
          is_supplier?: boolean | null
          name: string
          partner_type?: string | null
          warehouse_code?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          is_branch?: boolean | null
          is_customer?: boolean | null
          is_supplier?: boolean | null
          name?: string
          partner_type?: string | null
          warehouse_code?: string | null
        }
        Relationships: []
      }
      pending_orders: {
        Row: {
          box_qty: number
          created_at: string | null
          from_warehouse: string | null
          id: string
          item_id: string
          memo: string | null
          requested_by: string | null
          status: string
          to_warehouse: string | null
          unit_qty: number
          updated_at: string | null
        }
        Insert: {
          box_qty?: number
          created_at?: string | null
          from_warehouse?: string | null
          id?: string
          item_id: string
          memo?: string | null
          requested_by?: string | null
          status?: string
          to_warehouse?: string | null
          unit_qty?: number
          updated_at?: string | null
        }
        Update: {
          box_qty?: number
          created_at?: string | null
          from_warehouse?: string | null
          id?: string
          item_id?: string
          memo?: string | null
          requested_by?: string | null
          status?: string
          to_warehouse?: string | null
          unit_qty?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pending_orders_from_warehouse_fkey"
            columns: ["from_warehouse"]
            isOneToOne: false
            referencedRelation: "view_truck_gauge_summary"
            referencedColumns: ["warehouse_code"]
          },
          {
            foreignKeyName: "pending_orders_from_warehouse_fkey"
            columns: ["from_warehouse"]
            isOneToOne: false
            referencedRelation: "warehouses"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "pending_orders_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pending_orders_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "view_effective_stocks"
            referencedColumns: ["item_id"]
          },
          {
            foreignKeyName: "pending_orders_to_warehouse_fkey"
            columns: ["to_warehouse"]
            isOneToOne: false
            referencedRelation: "view_truck_gauge_summary"
            referencedColumns: ["warehouse_code"]
          },
          {
            foreignKeyName: "pending_orders_to_warehouse_fkey"
            columns: ["to_warehouse"]
            isOneToOne: false
            referencedRelation: "warehouses"
            referencedColumns: ["code"]
          },
        ]
      }
      request_idempotency: {
        Row: {
          created_at: string
          id: string
          result: Json
        }
        Insert: {
          created_at?: string
          id: string
          result?: Json
        }
        Update: {
          created_at?: string
          id?: string
          result?: Json
        }
        Relationships: []
      }
      stock_transactions: {
        Row: {
          box_qty: number
          created_at: string | null
          handler_name: string | null
          id: string
          invoice_no: string | null
          item_id: string
          memo: string | null
          partner_name: string | null
          source_warehouse: string | null
          target_warehouse: string | null
          transaction_type: string
          unit_qty: number
          warehouse_code: string | null
        }
        Insert: {
          box_qty?: number
          created_at?: string | null
          handler_name?: string | null
          id?: string
          invoice_no?: string | null
          item_id: string
          memo?: string | null
          partner_name?: string | null
          source_warehouse?: string | null
          target_warehouse?: string | null
          transaction_type: string
          unit_qty?: number
          warehouse_code?: string | null
        }
        Update: {
          box_qty?: number
          created_at?: string | null
          handler_name?: string | null
          id?: string
          invoice_no?: string | null
          item_id?: string
          memo?: string | null
          partner_name?: string | null
          source_warehouse?: string | null
          target_warehouse?: string | null
          transaction_type?: string
          unit_qty?: number
          warehouse_code?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stock_transactions_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_transactions_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "view_effective_stocks"
            referencedColumns: ["item_id"]
          },
          {
            foreignKeyName: "stock_transactions_warehouse_code_fkey"
            columns: ["warehouse_code"]
            isOneToOne: false
            referencedRelation: "view_truck_gauge_summary"
            referencedColumns: ["warehouse_code"]
          },
          {
            foreignKeyName: "stock_transactions_warehouse_code_fkey"
            columns: ["warehouse_code"]
            isOneToOne: false
            referencedRelation: "warehouses"
            referencedColumns: ["code"]
          },
        ]
      }
      warehouses: {
        Row: {
          code: string
          created_at: string | null
          is_hub: boolean | null
          name: string
          sort_order: number | null
          truck_capacity_boxes: number | null
        }
        Insert: {
          code: string
          created_at?: string | null
          is_hub?: boolean | null
          name: string
          sort_order?: number | null
          truck_capacity_boxes?: number | null
        }
        Update: {
          code?: string
          created_at?: string | null
          is_hub?: boolean | null
          name?: string
          sort_order?: number | null
          truck_capacity_boxes?: number | null
        }
        Relationships: []
      }
    }
    Views: {
      app_members_public: {
        Row: {
          access_level: string | null
          branch_name: string | null
          created_at: string | null
          id: string | null
          is_active: boolean | null
          member_name: string | null
          preferred_language: string | null
        }
        Insert: {
          access_level?: string | null
          branch_name?: string | null
          created_at?: string | null
          id?: string | null
          is_active?: boolean | null
          member_name?: string | null
          preferred_language?: string | null
        }
        Update: {
          access_level?: string | null
          branch_name?: string | null
          created_at?: string | null
          id?: string | null
          is_active?: boolean | null
          member_name?: string | null
          preferred_language?: string | null
        }
        Relationships: []
      }
      view_effective_stocks: {
        Row: {
          barcode: string | null
          box_packaging_qty: number | null
          color: string | null
          effective_box_qty: number | null
          item_code: string | null
          item_id: string | null
          item_name: string | null
          main_box_qty: number | null
          main_unit_qty: number | null
          pending_in_boxes: number | null
          pending_out_boxes: number | null
          safe_stock_boxes: number | null
        }
        Relationships: []
      }
      view_truck_gauge_summary: {
        Row: {
          current_boxes: number | null
          gauge_percentage: number | null
          sort_order: number | null
          truck_capacity_boxes: number | null
          warehouse_code: string | null
          warehouse_name: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      fn_apply_stock_units: {
        Args: {
          p_check_enough: boolean
          p_ctx?: string
          p_delta_units: number
          p_item_id: string
          p_warehouse: string
        }
        Returns: undefined
      }
      fn_ensure_stock_row: {
        Args: { p_item_id: string; p_warehouse: string }
        Returns: undefined
      }
      fn_fifo_complete_pending: {
        Args: {
          p_from_warehouse: string
          p_item_id: string
          p_qty_units: number
        }
        Returns: number
      }
      fn_hash_session_token: { Args: { p_token: string }; Returns: string }
      fn_idempotency_lock: { Args: { p_key: string }; Returns: Json }
      fn_idempotency_store: {
        Args: { p_key: string; p_result: Json }
        Returns: undefined
      }
      fn_invoice_tx_group: { Args: { p_tx_type: string }; Returns: string }
      fn_item_pack_qty: { Args: { p_item_id: string }; Returns: number }
      fn_normalize_invoice_no: { Args: { p_invoice: string }; Returns: string }
      fn_parse_invoice_seq: { Args: { p_invoice: string }; Returns: number }
      fn_request_session_token: { Args: never; Returns: string }
      fn_require_admin: {
        Args: never
        Returns: {
          access_level: string
          branch_name: string | null
          created_at: string | null
          id: string
          is_active: boolean | null
          member_name: string
          password_hash: string
          preferred_language: string
        }
        SetofOptions: {
          from: "*"
          to: "app_members"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      fn_require_session: {
        Args: never
        Returns: {
          access_level: string
          branch_name: string | null
          created_at: string | null
          id: string
          is_active: boolean | null
          member_name: string
          password_hash: string
          preferred_language: string
        }
        SetofOptions: {
          from: "*"
          to: "app_members"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      fn_stock_units: {
        Args: { p_box: number; p_pack: number; p_unit: number }
        Returns: number
      }
      rpc_adjust_stock: {
        Args: {
          p_admin: string
          p_idempotency_key?: string
          p_invoice?: string
          p_items: Json
          p_memo?: string
          p_warehouse?: string
        }
        Returns: Json
      }
      rpc_adjust_stock_apply: {
        Args: {
          p_admin: string
          p_invoice?: string
          p_items: Json
          p_memo?: string
          p_warehouse?: string
        }
        Returns: Json
      }
      rpc_apply_recommended_safe_stock: {
        Args: { p_recommendations: Json }
        Returns: Json
      }
      rpc_apply_recommended_safe_stock_apply: {
        Args: { p_recommendations: Json }
        Returns: Json
      }
      rpc_complete_inbound_pending_orders: {
        Args: { p_items: Json; p_source_warehouse: string }
        Returns: Json
      }
      rpc_create_brand: { Args: { p_name: string }; Returns: Json }
      rpc_create_member: {
        Args: {
          p_access_level?: string
          p_branch_name?: string
          p_member_name: string
          p_password: string
        }
        Returns: Json
      }
      rpc_ensure_items: { Args: { p_items: Json }; Returns: Json }
      rpc_execute_color_normalization: {
        Args: { p_items: Json }
        Returns: Json
      }
      rpc_execute_color_normalization_apply: {
        Args: { p_items: Json }
        Returns: Json
      }
      rpc_execute_stock_normalization: {
        Args: { p_groups: Json }
        Returns: Json
      }
      rpc_execute_stock_normalization_apply: {
        Args: { p_groups: Json }
        Returns: Json
      }
      rpc_get_system_settings: { Args: never; Returns: Json }
      rpc_list_effective_stocks: { Args: never; Returns: Json }
      rpc_login: {
        Args: { p_member_name: string; p_password: string }
        Returns: Json
      }
      rpc_logout: { Args: never; Returns: Json }
      rpc_next_invoice_no: {
        Args: { p_biz_date?: string; p_tx_type: string }
        Returns: string
      }
      rpc_peek_next_invoice_seq: {
        Args: { p_biz_date?: string; p_tx_type: string }
        Returns: number
      }
      rpc_process_transaction: {
        Args: {
          p_handler: string
          p_idempotency_key?: string
          p_invoice: string
          p_items: Json
          p_memo: string
          p_partner: string
          p_pending_from_warehouse?: string
          p_target_warehouse?: string
          p_tx_type: string
          p_warehouse: string
        }
        Returns: Json
      }
      rpc_process_transaction_apply: {
        Args: {
          p_handler: string
          p_invoice: string
          p_items: Json
          p_memo: string
          p_partner: string
          p_pending_from_warehouse?: string
          p_target_warehouse?: string
          p_tx_type: string
          p_warehouse: string
        }
        Returns: Json
      }
      rpc_register_item: {
        Args: {
          p_barcode?: string
          p_box_packaging_qty?: number
          p_brand_id?: string
          p_color?: string
          p_initial_boxes?: number
          p_initial_units?: number
          p_item_name: string
          p_safe_stock?: number
        }
        Returns: Json
      }
      rpc_reserve_outbound: {
        Args: {
          p_handler: string
          p_idempotency_key?: string
          p_items: Json
          p_partner: string
          p_to_warehouse?: string
        }
        Returns: Json
      }
      rpc_save_system_settings: { Args: { p_settings: Json }; Returns: Json }
      rpc_session_info: { Args: never; Returns: Json }
      rpc_submit_warehouse_order_drafts: {
        Args: { p_admin: string; p_by_warehouse: Json }
        Returns: Json
      }
      rpc_submit_warehouse_order_drafts_apply: {
        Args: { p_admin: string; p_by_warehouse: Json }
        Returns: Json
      }
      rpc_update_member: {
        Args: {
          p_access_level?: string
          p_branch_name?: string
          p_id: string
          p_is_active?: boolean
          p_password?: string
        }
        Returns: Json
      }
      rpc_update_transaction_records: {
        Args: {
          p_admin: string
          p_invoice_no: string
          p_new_records: Json
          p_tx_type: string
        }
        Returns: Json
      }
      rpc_update_transaction_records_apply: {
        Args: {
          p_admin: string
          p_invoice_no: string
          p_new_records: Json
          p_tx_type: string
        }
        Returns: Json
      }
      rpc_upsert_aliases: { Args: { p_aliases: Json }; Returns: Json }
      rpc_upsert_partner: {
        Args: {
          p_id?: string
          p_is_active?: boolean
          p_name: string
          p_role?: string
          p_warehouse_code?: string
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
