import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { supabase } from '../lib/supabase.js'
import { resolveBranchCode, takeIdempotencyKey, clearIdempotencyKey, shouldKeepIdempotencyKey, serverMethods, resolveActiveSubWarehouses } from '../lib/supabaseAdapter.js'
import FlexSearch from 'flexsearch'

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
  const gridHotkeys = ref([])     // is_grid_item 그룹 핫키
  const catalogItems = ref([])    // FlexSearch용 유효재고 카탈로그
  const pendingOrders = ref([])
  const dashboard = ref(null)
  const systemSettings = ref(null)
  const isLoading = ref(false)
  const isSubmitting = ref(false)
  const lastError = ref('')
  let searchSeq = 0
  let realtimeRefreshTimer = null
  let searchIndex = null
  let catalogById = new Map()

  function mapCatalogRow(it) {
    return {
      id: it.item_id,
      name: it.item_name,
      color: it.color || 'SURTIDO',
      pack_qty: Number(it.box_packaging_qty || 1),
      stock_box: Number(it.main_box_qty || 0),
      stock_each: Number(it.main_unit_qty || 0),
      effective_box: Number(it.effective_box_qty || 0),
      barcode: it.barcode || '',
      searchText: `${it.item_name || ''} ${it.color || ''} ${it.barcode || ''}`.toLowerCase()
    }
  }

  function scoreNameMatch(name, q) {
    const n = String(name || '').toLowerCase()
    if (!n.includes(q)) return 0
    if (n === q) return 1000
    let best = 100
    let from = 0
    while (from <= n.length) {
      const idx = n.indexOf(q, from)
      if (idx < 0) break
      const prev = idx > 0 ? n[idx - 1] : ''
      const next = idx + q.length < n.length ? n[idx + q.length] : ''
      if (n.endsWith(q) && idx === n.length - q.length) {
        best = Math.max(best, !prev || /[^0-9]/.test(prev) ? 900 : 250)
      } else if (prev && /[a-z-]/.test(prev) && (!next || /[^0-9]/.test(next))) {
        best = Math.max(best, 800)
      } else if (prev && /\d/.test(prev)) {
        best = Math.max(best, 150)
      } else {
        best = Math.max(best, 500)
      }
      from = idx + 1
    }
    return best
  }

  function rebuildSearchIndex(rows) {
    catalogById = new Map(rows.map(r => [r.id, r]))
    searchIndex = null
    try {
      const Document = FlexSearch.Document || FlexSearch
      const idx = new Document({
        document: {
          id: 'id',
          index: ['name', 'color', 'barcode'],
          store: false
        },
        tokenize: 'full',
        cache: true
      })
      rows.forEach(row => idx.add(row))
      searchIndex = idx
    } catch (err) {
      console.warn('[WMS Store] FlexSearch 인덱스 생략, 로컬 필터로 검색합니다:', err)
    }
  }

  function scheduleRealtimeRefresh() {
    clearTimeout(realtimeRefreshTimer)
    realtimeRefreshTimer = setTimeout(() => {
      Promise.all([loadTopHotkeys(), loadTruckGauges(), loadGridHotkeys(), loadCatalog()]).catch(err => {
        console.error('[WMS Store] realtime refresh error:', err)
      })
    }, 400)
  }

  // 1. 기초 마스터 데이터 로드 (거래처, 관리자, 창고)
  async function loadMasters() {
    try {
      isLoading.value = true
      lastError.value = ''

      const [partnersRes, membersRes, whRes] = await Promise.all([
        supabase.from('partners').select('*').order('name'),
        supabase.from('app_members_public').select('id, member_name, branch_name, access_level, is_active').order('member_name'),
        supabase.from('warehouses').select('*').order('sort_order')
      ])

      if (partnersRes.error) throw partnersRes.error
      if (membersRes.error) throw membersRes.error
      if (whRes.error) throw whRes.error

      const partners = partnersRes.data || []
      suppliers.value = partners.filter(p => p.is_supplier || p.partner_type === 'INBOUND' || p.partner_type === 'BOTH')
      destinations.value = partners.filter(p => p.is_customer || p.is_branch || p.partner_type === 'OUTBOUND' || p.partner_type === 'BOTH' || p.partner_type === 'BRANCH')
      managers.value = membersRes.data || []
      warehouses.value = whRes.data || []

      await loadSettings().catch(() => ({}))
      await Promise.all([loadTruckGauges(), loadTopHotkeys(), loadGridHotkeys(), loadCatalog()])
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
      const rows = data || []
      const active = resolveActiveSubWarehouses(systemSettings.value)
      truckGauges.value = rows.filter(row => {
        const code = String(row.warehouse_code || '').toUpperCase()
        if (!code || code === 'MAIN') return true
        return active.includes(code)
      })
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

  async function loadGridHotkeys() {
    try {
      const { data, error } = await supabase
        .from('items')
        .select('id, item_name, color, box_packaging_qty, grid_group_id, is_grid_item')
        .eq('is_active', true)
        .eq('is_grid_item', true)
        .order('item_name')
        .limit(200)

      if (error) throw error
      const rows = data || []
      if (!rows.length) {
        gridHotkeys.value = []
        return
      }

      const ids = rows.map(r => r.id)
      const { data: stocks, error: stockErr } = await supabase
        .from('inventory_stocks')
        .select('item_id, box_qty, unit_qty')
        .eq('warehouse_code', 'MAIN')
        .in('item_id', ids)
      if (stockErr) throw stockErr

      const stockMap = new Map((stocks || []).map(s => [s.item_id, s]))
      const groups = new Map()
      rows.forEach(it => {
        const groupId = it.grid_group_id || it.item_name
        if (!groups.has(groupId)) {
          groups.set(groupId, {
            id: groupId,
            group_name: it.item_name,
            pack_qty: it.box_packaging_qty || 1,
            total_box: 0,
            variants: []
          })
        }
        const st = stockMap.get(it.id)
        const box = Number(st?.box_qty || 0)
        const unit = Number(st?.unit_qty || 0)
        const group = groups.get(groupId)
        group.total_box += box
        group.variants.push({
          id: it.id,
          color: it.color || 'SURTIDO',
          pack_qty: it.box_packaging_qty || 1,
          stock_box: box,
          stock_each: unit,
          input_box: '',
          input_each: ''
        })
      })

      gridHotkeys.value = Array.from(groups.values())
        .sort((a, b) => b.total_box - a.total_box)
        .slice(0, 10)
    } catch (err) {
      console.error('[WMS Store] loadGridHotkeys error:', err)
      gridHotkeys.value = []
    }
  }

  async function loadCatalog() {
    try {
      const { data, error } = await supabase.rpc('rpc_list_effective_stocks')
      if (error) throw error
      const raw = Array.isArray(data) ? data : []
      const rows = raw.map(mapCatalogRow).filter(r => r.id && r.name)
      catalogItems.value = rows
      rebuildSearchIndex(rows)
    } catch (err) {
      console.error('[WMS Store] loadCatalog error:', err)
    }
  }

  // 4. 품목 실시간 검색 (10ms 인덱스 쿼리)
  async function searchItems(query = '') {
    const q = String(query || '').trim()
    if (!q) {
      searchSeq += 1
      searchResults.value = []
      return []
    }

    const seq = ++searchSeq
    if (!catalogItems.value.length) {
      await loadCatalog()
    }
    if (seq !== searchSeq) return searchResults.value

    const qLower = q.toLowerCase()
    let candidates = []

    if (searchIndex && typeof searchIndex.search === 'function') {
      try {
        const found = searchIndex.search(q, { limit: 40 })
        const ids = new Set()
        const walk = (value) => {
          if (value == null) return
          if (Array.isArray(value)) {
            value.forEach(walk)
            return
          }
          if (typeof value === 'object') {
            if (value.result) walk(value.result)
            else if (value.id) ids.add(value.id)
            return
          }
          ids.add(value)
        }
        walk(found)
        candidates = [...ids].map(id => catalogById.get(id)).filter(Boolean)
      } catch (err) {
        console.warn('[WMS Store] FlexSearch 실패, 로컬 필터로 전환:', err)
        candidates = []
      }
    }

    if (!candidates.length) {
      candidates = catalogItems.value.filter(it => it.searchText.includes(qLower))
    }

    const ranked = candidates
      .map((item, idx) => {
        let score = scoreNameMatch(item.name, qLower)
        if (String(item.barcode || '').toLowerCase().includes(qLower)) score = Math.max(score, 850)
        if (String(item.color || '').toLowerCase().includes(qLower)) score = Math.max(score, 300)
        return { item, idx, score }
      })
      .filter(row => row.score > 0)
      .sort((a, b) => b.score - a.score || a.idx - b.idx)
      .slice(0, 20)
      .map(row => row.item)

    if (seq !== searchSeq) return searchResults.value
    searchResults.value = ranked
    return ranked
  }

  // 5. 원자적 입출고 트랜잭션 실행 (RPC)
  async function submitTransaction({
    transactionType,
    warehouseCode = 'MAIN',
    partnerName,
    handlerName,
    invoiceNo = '',
    memo = '',
    cartItems = [],
    targetWarehouse = null,
    pendingFromWarehouse = null
  }) {
    if (!cartItems.length) {
      throw new Error('전표에 품목이 없습니다.')
    }
    if (isSubmitting.value) {
      throw new Error('이미 전표 처리가 진행 중입니다. 완료될 때까지 기다려주세요.')
    }

    isSubmitting.value = true
    try {
      const itemsPayload = cartItems
        .map(item => ({
          item_id: item.id,
          box_qty: Number(item.input_box) || 0,
          unit_qty: Number(item.input_each) || 0
        }))
        .filter(item => item.box_qty > 0 || item.unit_qty > 0)

      if (!itemsPayload.length) {
        throw new Error('수량이 0인 품목만 있어 전표를 제출할 수 없습니다.')
      }

      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      const invalid = itemsPayload.find(item => !uuidRe.test(String(item.item_id || '')))
      if (invalid) {
        throw new Error('실제 등록된 품목이 아닌 항목이 전표에 포함되어 있습니다. 검색 또는 핫키로 다시 담아주세요.')
      }

      const branchCode = resolveBranchCode(partnerName)
      let txType = transactionType
      let destWh = targetWarehouse
      let pendingWh = pendingFromWarehouse

      if (txType === 'OUTBOUND' && branchCode && branchCode !== 'MAIN' && branchCode !== warehouseCode) {
        txType = 'MOVE'
        destWh = branchCode
      }
      if (txType === 'INBOUND' && !pendingWh && branchCode && branchCode !== 'MAIN') {
        pendingWh = branchCode
      }

      const fingerprint = JSON.stringify({
        txType, warehouseCode, partnerName, itemsPayload, destWh, pendingWh, invoiceNo
      })
      const idemKey = takeIdempotencyKey('process_transaction', fingerprint)
      let data
      try {
        const res = await supabase.rpc('rpc_process_transaction', {
          p_tx_type: txType,
          p_warehouse: warehouseCode,
          p_partner: partnerName,
          p_handler: handlerName,
          p_invoice: invoiceNo || '',
          p_memo: memo || (txType === 'MOVE'
            ? `[지점간이동] ${warehouseCode} ➔ ${destWh}`
            : `${txType === 'INBOUND' ? '입고' : '출고'} POS (${warehouseCode})`),
          p_items: itemsPayload,
          p_target_warehouse: destWh,
          p_pending_from_warehouse: pendingWh,
          p_idempotency_key: idemKey
        })
        if (res.error) throw res.error
        data = res.data
        clearIdempotencyKey('process_transaction')
      } catch (err) {
        if (!shouldKeepIdempotencyKey(err)) clearIdempotencyKey('process_transaction')
        throw err
      }

      await Promise.all([loadTopHotkeys(), loadTruckGauges(), loadGridHotkeys(), loadCatalog()])

      return { success: true, data, invoiceNo: data?.invoice_no, txType: data?.tx_type || txType }
    } catch (err) {
      console.error('[WMS Store] submitTransaction error:', err)
      throw err
    } finally {
      isSubmitting.value = false
    }
  }

  async function reserveOutbound({
    partnerName,
    handlerName,
    cartItems = [],
    toWarehouse = null
  }) {
    if (!cartItems.length) {
      throw new Error('전표에 품목이 없습니다.')
    }
    if (isSubmitting.value) {
      throw new Error('이미 처리가 진행 중입니다.')
    }

    const itemsPayload = cartItems
      .map(item => ({
        item_id: item.id,
        box_qty: Number(item.input_box) || 0,
        unit_qty: Number(item.input_each) || 0
      }))
      .filter(item => item.box_qty > 0 || item.unit_qty > 0)

    if (!itemsPayload.length) {
      throw new Error('수량이 0인 품목만 있어 예약할 수 없습니다.')
    }

    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (itemsPayload.some(item => !uuidRe.test(String(item.item_id || '')))) {
      throw new Error('실제 등록된 품목이 아닌 항목이 전표에 포함되어 있습니다.')
    }

    const branchCode = resolveBranchCode(partnerName)
    const fingerprint = JSON.stringify({ partnerName, itemsPayload, toWarehouse, branchCode })
    const idemKey = takeIdempotencyKey('reserve_outbound', fingerprint)
    isSubmitting.value = true
    try {
      const { data, error } = await supabase.rpc('rpc_reserve_outbound', {
        p_partner: partnerName || '',
        p_handler: handlerName || 'ADMIN',
        p_items: itemsPayload,
        p_to_warehouse: toWarehouse || (branchCode && branchCode !== 'MAIN' ? branchCode : null),
        p_idempotency_key: idemKey
      })
      if (error) throw error
      clearIdempotencyKey('reserve_outbound')
      await Promise.all([loadTruckGauges(), loadCatalog(), loadPendingOrders()])
      return { success: true, count: data?.count || itemsPayload.length }
    } catch (err) {
      if (!shouldKeepIdempotencyKey(err)) clearIdempotencyKey('reserve_outbound')
      throw err
    } finally {
      isSubmitting.value = false
    }
  }

  async function loadPendingOrders() {
    try {
      const { data, error } = await supabase
        .from('pending_orders')
        .select('id, item_id, from_warehouse, to_warehouse, box_qty, unit_qty, status, requested_by, memo, created_at')
        .in('status', ['PENDING', 'IN_TRANSIT'])
        .order('created_at', { ascending: false })
        .limit(200)
      if (error) throw error
      pendingOrders.value = data || []
      return pendingOrders.value
    } catch (err) {
      console.error('[WMS Store] loadPendingOrders error:', err)
      pendingOrders.value = []
      return []
    }
  }

  async function loadDashboard() {
    dashboard.value = await serverMethods.getDashboardMetrics()
    return dashboard.value
  }

  async function upsertPartner({ id, name, role, warehouseCode, isActive }) {
    const { data, error } = await supabase.rpc('rpc_upsert_partner', {
      p_id: id || null,
      p_name: name,
      p_role: role,
      p_warehouse_code: warehouseCode || null,
      p_is_active: isActive !== false
    })
    if (error) throw error
    await loadMasters()
    return data
  }

  async function createMember({ memberName, password, accessLevel, branchName }) {
    const { data, error } = await supabase.rpc('rpc_create_member', {
      p_member_name: memberName,
      p_password: password,
      p_access_level: accessLevel || 'staff',
      p_branch_name: branchName || null
    })
    if (error) throw error
    await loadMasters()
    return data
  }

  async function updateMember({ id, branchName, accessLevel, password, isActive }) {
    const { data, error } = await supabase.rpc('rpc_update_member', {
      p_id: id,
      p_branch_name: branchName,
      p_access_level: accessLevel,
      p_password: password || null,
      p_is_active: typeof isActive === 'boolean' ? isActive : null
    })
    if (error) throw error
    await loadMasters()
    return data
  }

  async function loadSettings() {
    const { data, error } = await supabase.rpc('rpc_get_system_settings')
    if (error) throw error
    systemSettings.value = data?.settings || {}
    return systemSettings.value
  }

  async function saveSettings(settings) {
    const { data, error } = await supabase.rpc('rpc_save_system_settings', {
      p_settings: settings
    })
    if (error) throw error
    systemSettings.value = data?.settings || settings
    await loadTruckGauges()
    return data
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
          scheduleRealtimeRefresh()
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'pending_orders' },
        () => {
          console.log('[Realtime] 주문/PENDING 변경 감지 -> 트럭 게이지 갱신')
          scheduleRealtimeRefresh()
        }
      )
      .subscribe()

    return () => {
      clearTimeout(realtimeRefreshTimer)
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
    gridHotkeys,
    catalogItems,
    pendingOrders,
    dashboard,
    systemSettings,
    isLoading,
    isSubmitting,
    lastError,
    loadMasters,
    loadTruckGauges,
    loadTopHotkeys,
    loadGridHotkeys,
    loadCatalog,
    loadPendingOrders,
    loadDashboard,
    upsertPartner,
    createMember,
    updateMember,
    loadSettings,
    saveSettings,
    searchItems,
    submitTransaction,
    reserveOutbound,
    subscribeRealtime
  }
})
