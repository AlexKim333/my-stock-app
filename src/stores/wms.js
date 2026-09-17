import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { supabase } from '../lib/supabase.js'

export const useWmsStore = defineStore('wms', () => {
  // 상태
  const items = ref([])
  const searchResults = ref([])
  const suppliers = ref([])       // INBOUND 거래처
  const destinations = ref([])    // OUTBOUND 거래처
  const managers = ref([])        // 담당자 (app_members)
  const warehouses = ref([])      // 창고 목록
  const truckGauges = ref([])     // 8대 창고 100상자 트럭 게이지
  const hotkeyItems = ref([])     // 실재고 기반 상위 10종 핫키
  const isLoading = ref(false)
  const isSubmitting = ref(false)
  const lastError = ref('')

  // 1. 기초 마스터 데이터 로드 (거래처, 관리자, 창고)
  async function loadMasters() {
    try {
      isLoading.value = true
      lastError.value = ''

      const [partnersRes, membersRes, whRes] = await Promise.all([
        supabase.from('partners').select('*').order('name'),
        supabase.from('app_members').select('id, member_name, branch_name, access_level').order('member_name'),
        supabase.from('warehouses').select('*').order('sort_order')
      ])

      if (partnersRes.error) throw partnersRes.error
      if (membersRes.error) throw membersRes.error
      if (whRes.error) throw whRes.error

      const partners = partnersRes.data || []
      suppliers.value = partners.filter(p => p.partner_type === 'INBOUND')
      destinations.value = partners.filter(p => p.partner_type === 'OUTBOUND')
      managers.value = membersRes.data || []
      warehouses.value = whRes.data || []

      // 핫키 및 트럭 게이지도 동시 로드
      await Promise.all([loadTruckGauges(), loadTopHotkeys()])
    } catch (err) {
      console.error('[WMS Store] loadMasters error:', err)
      lastError.value = err.message
    } finally {
      isLoading.value = false
    }
  }

  // 2. 8대 서브창고 100상자 FTL 트럭 게이지 로드
  async function loadTruckGauges() {
    try {
      const { data, error } = await supabase
        .from('view_truck_gauge_summary')
        .select('*')
        .order('sort_order')

      if (error) throw error
      truckGauges.value = data || []
    } catch (err) {
      console.error('[WMS Store] loadTruckGauges error:', err)
    }
  }

  // 3. 실재고 기반 Top 10 핫키 로드
  async function loadTopHotkeys() {
    try {
      const { data, error } = await supabase
        .from('view_effective_stocks')
        .select('item_id, item_name, color, box_packaging_qty, main_box_qty, main_unit_qty, effective_box_qty')
        .gt('main_box_qty', 0)
        .order('main_box_qty', { ascending: false })
        .limit(10)

      if (error) throw error

      hotkeyItems.value = (data || []).map((it, idx) => ({
        id: it.item_id,
        name: it.item_name,
        color: it.color || 'SURTIDO',
        pack_qty: it.box_packaging_qty || 1,
        stock_box: it.main_box_qty || 0,
        stock_each: it.main_unit_qty || 0,
        effective_box: it.effective_box_qty || 0
      }))
    } catch (err) {
      console.error('[WMS Store] loadTopHotkeys error:', err)
    }
  }

  // 4. 품목 실시간 검색 (10ms 인덱스 쿼리)
  async function searchItems(query = '') {
    const q = (query || '').trim()
    if (!q) {
      searchResults.value = []
      return []
    }

    try {
      const { data, error } = await supabase
        .from('view_effective_stocks')
        .select('item_id, item_name, color, box_packaging_qty, main_box_qty, main_unit_qty, effective_box_qty, barcode')
        .or(`item_name.ilike.%${q}%,barcode.ilike.%${q}%`)
        .limit(20)

      if (error) throw error

      searchResults.value = (data || []).map(it => ({
        id: it.item_id,
        name: it.item_name,
        color: it.color || 'SURTIDO',
        pack_qty: it.box_packaging_qty || 1,
        stock_box: it.main_box_qty || 0,
        stock_each: it.main_unit_qty || 0,
        effective_box: it.effective_box_qty || 0,
        barcode: it.barcode || ''
      }))

      return searchResults.value
    } catch (err) {
      console.error('[WMS Store] searchItems error:', err)
      return []
    }
  }

  // 5. 원자적 입출고 트랜잭션 실행 (RPC)
  async function submitTransaction({
    transactionType, // 'INBOUND' | 'OUTBOUND'
    warehouseCode = 'MAIN',
    partnerName,
    handlerName,
    invoiceNo = '',
    memo = '',
    cartItems = []
  }) {
    if (!cartItems.length) {
      throw new Error('전표에 품목이 없습니다.')
    }

    isSubmitting.value = true
    try {
      // 품목 페이로드 구성
      const itemsPayload = cartItems.map(item => ({
        item_id: item.id,
        box_qty: Number(item.input_box) || 0,
        unit_qty: Number(item.input_each) || 0
      }))

      const { data, error } = await supabase.rpc('rpc_process_transaction', {
        p_tx_type: transactionType,
        p_warehouse: warehouseCode,
        p_partner: partnerName,
        p_handler: handlerName,
        p_invoice: invoiceNo || `INV-${Date.now().toString().slice(-6)}`,
        p_memo: memo || '',
        p_items: itemsPayload
      })

      if (error) throw error

      // 갱신 후 최신 재고 및 게이지 재로드
      await Promise.all([loadTopHotkeys(), loadTruckGauges()])

      return { success: true, data }
    } catch (err) {
      console.error('[WMS Store] submitTransaction error:', err)
      throw err
    } finally {
      isSubmitting.value = false
    }
  }

  // 6. Supabase Realtime 웹소켓 구독
  function subscribeRealtime() {
    const channel = supabase
      .channel('wms_changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'inventory_stocks' },
        () => {
          console.log('[Realtime] 재고 변경 감지 -> 실시간 갱신')
          loadTopHotkeys()
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'pending_orders' },
        () => {
          console.log('[Realtime] 주문/PENDING 변경 감지 -> 트럭 게이지 갱신')
          loadTruckGauges()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }

  return {
    items,
    searchResults,
    suppliers,
    destinations,
    managers,
    warehouses,
    truckGauges,
    hotkeyItems,
    isLoading,
    isSubmitting,
    lastError,
    loadMasters,
    loadTruckGauges,
    loadTopHotkeys,
    searchItems,
    submitTransaction,
    subscribeRealtime
  }
})
