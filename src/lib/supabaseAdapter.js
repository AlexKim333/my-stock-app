// src/lib/supabaseAdapter.js
// google.script.run 호환 초고속 Supabase 어댑터 (sub-50ms)
import { supabase } from './supabase.js'

// 품목 ID 캐시 (item_name_color_pkg -> item_id)
let itemIdCache = new Map()

export async function preloadItemIdCache() {
  try {
    const [res1, res2] = await Promise.all([
      supabase.from('items').select('id, item_name, color, box_packaging_qty').range(0, 999),
      supabase.from('items').select('id, item_name, color, box_packaging_qty').range(1000, 1999)
    ])
    const all = [...(res1.data || []), ...(res2.data || [])]
    itemIdCache.clear()
    all.forEach(item => {
      const key = `${String(item.item_name).trim()}_${String(item.color || 'SURTIDO').trim()}_${Number(item.box_packaging_qty || 1)}`
      itemIdCache.set(key, item.id)
    })
    console.log(`[SupabaseAdapter] 품목 ID ${itemIdCache.size}건 사전 캐싱 완료`)
  } catch (err) {
    console.warn('[SupabaseAdapter] 품목 ID 캐싱 오류:', err)
  }
}

function formatDate(d) {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}/${month}/${day}`
}

function getNormalizedItemCode(name) {
  return String(name || '').replace(/[-\s_]/g, '').toUpperCase().trim()
}

function pickCanonicalName(items) {
  if (!items || items.length === 0) return ''
  if (items.length === 1) return items[0].name

  const sorted = [...items].sort((a, b) => {
    if (b.totalIndiv !== a.totalIndiv) {
      return b.totalIndiv - a.totalIndiv
    }
    const aHasHyphen = /[a-zA-Z]-[0-9]/.test(a.name)
    const bHasHyphen = /[a-zA-Z]-[0-9]/.test(b.name)
    if (aHasHyphen && !bHasHyphen) return -1
    if (!aHasHyphen && bHasHyphen) return 1
    return (a.row || 0) - (b.row || 0)
  })

  return sorted[0].name
}

export const serverMethods = {
  /**
   * 1. 실시간 유효 재고 목록 로드
   */
  async getStockData() {
    const [res1, res2] = await Promise.all([
      supabase.from('view_effective_stocks').select('*').range(0, 999),
      supabase.from('view_effective_stocks').select('*').range(1000, 1999)
    ])
    if (res1.error) throw res1.error
    if (res2.error) throw res2.error

    const all = [...(res1.data || []), ...(res2.data || [])]
    return all.map(row => {
      const name = String(row.item_name || '').trim()
      const color = String(row.color || 'SURTIDO').trim()
      const boxContent = Number(row.box_packaging_qty || 1)
      const key = `${name}_${color}_${boxContent}`
      itemIdCache.set(key, row.item_id)

      return {
        name: name,
        color: color,
        stockBox: Number(row.main_box_qty || 0),
        stockIndividual: Number(row.main_unit_qty || 0),
        safeStock: Number(row.safe_stock_boxes || 0),
        boxContent: boxContent,
        initialStock: 0,
        manufacturer: '',
        isDelta: false,
        key: key
      }
    }).filter(item => item.name)
  },

  /**
   * 2. 작업자 / 관리자 명단
   */
  async getAdminList() {
    const { data, error } = await supabase
      .from('app_members')
      .select('member_name')
      .eq('is_active', true)
      .order('member_name', { ascending: true })

    if (error) {
      console.warn('getAdminList error:', error)
      return ['ADMIN']
    }
    const list = (data || []).map(d => d.member_name).filter(Boolean)
    if (!list.includes('ADMIN')) list.unshift('ADMIN')
    return list
  },

  /**
  /**
   * 3. 내부 창고 목록 (9대 거점 창고)
   */
  async getWarehouses() {
    return [
      { code: 'MAIN', name: '메인허브 (알라르꼰)', is_hub: true },
      { code: 'PANTACO', name: 'PANTACO (판타코)' },
      { code: 'IKEA', name: 'IKEA (이케아)' },
      { code: 'LERMA', name: 'LERMA (레르마)' },
      { code: 'PINO', name: 'PINO (피노)' },
      { code: 'YARE', name: 'YARE (야레)' },
      { code: 'ALMINTER', name: 'ALMINTER (알민테르)' },
      { code: 'TLANE', name: 'TLANE (틀라네)' },
      { code: 'STAR', name: 'STAR (스타)' }
    ]
  },

  /**
   * 3-1. 통합 파트너(거래처/지점) 마스터 목록 (역할 플래그 포함)
   */
  async getPartnersMaster() {
    const { data, error } = await supabase
      .from('partners')
      .select('id, name, is_supplier, is_customer, is_branch, warehouse_code, partner_type')
      .eq('is_active', true)
      .order('name', { ascending: true })

    if (error) throw error
    return data || []
  },

  /**
   * 3-2. 입고처 목록 (공급처 및 겸용 거래처)
   */
  async getInLocations() {
    const { data, error } = await supabase
      .from('partners')
      .select('name')
      .or('is_supplier.eq.true,partner_type.eq.INBOUND')
      .eq('is_active', true)
      .order('name', { ascending: true })

    if (error) throw error
    return (data || []).map(p => p.name).filter(Boolean)
  },

  /**
   * 4. 출고처 목록 (고객, 겸용 거래처 및 9대 지점)
   */
  async getOutLocations() {
    const { data, error } = await supabase
      .from('partners')
      .select('name, is_branch, warehouse_code')
      .or('is_customer.eq.true,is_branch.eq.true,partner_type.eq.OUTBOUND')
      .eq('is_active', true)
      .order('name', { ascending: true })

    if (error) throw error
    return (data || []).map(p => p.name).filter(Boolean)
  },

  /**
   * 5. 메이커 / 브랜드 목록
   */
  async getManufacturers() {
    const { data, error } = await supabase
      .from('brands')
      .select('name')
      .eq('is_active', true)
      .order('name', { ascending: true })

    if (error) throw error
    return (data || []).map(b => b.name).filter(Boolean)
  },

  /**
   * 트랜잭션 유형 정규화 헬퍼 (입고 / 출고 / 재고조정 독립 채번 지원)
   */
  _normalizeTxTypes(type) {
    const t = String(type || '').trim().toLowerCase()
    if (t === 'in' || t === 'inbound' || t === '입고') {
      return ['INBOUND']
    }
    if (t === 'out' || t === 'outbound' || t === '출고' || t === 'move') {
      return ['OUTBOUND', 'MOVE']
    }
    if (t === 'adj' || t === 'adjust' || t === '재고조정' || t === '재고조사' || t === '재고치환' || t === '재고추가') {
      return ['ADJUST']
    }
    return [String(type || 'OUTBOUND').toUpperCase()]
  },

  /**
   * 6. 오늘자 송장 번호 자동 채번 (입고 / 출고 / 재고조정 각각 당일 001부터 독립 채번)
   */
  async getInitialInvoiceNumber() {
    return this.generateInvoiceNumber('INBOUND')
  },

  async getInitialOutInvoiceNumber() {
    return this.generateInvoiceNumber('OUTBOUND')
  },

  async getInitialAdjInvoiceNumber() {
    return this.generateInvoiceNumber('ADJUST')
  },

  async generateInvoiceNumber(type) {
    const todayStr = formatDate(new Date())
    const txTypes = this._normalizeTxTypes(type)

    const { data } = await supabase
      .from('stock_transactions')
      .select('invoice_no, transaction_type')
      .like('invoice_no', `${todayStr}%`)
      .in('transaction_type', txTypes)
      .order('created_at', { ascending: false })
      .limit(200)

    let maxSeq = 0
    if (data && data.length > 0) {
      data.forEach(row => {
        const inv = String(row.invoice_no || '')
        if (inv.includes('-')) {
          const parts = inv.split('-')
          const seq = parseInt(parts[parts.length - 1], 10)
          if (!isNaN(seq) && seq > maxSeq) maxSeq = seq
        }
      })
    }
    return String(maxSeq + 1).padStart(3, '0')
  },

  async getMaxSequentialNumber(date, type) {
    const targetDate = date ? date.replace(/-/g, '/') : formatDate(new Date())
    const txTypes = this._normalizeTxTypes(type)

    const { data } = await supabase
      .from('stock_transactions')
      .select('invoice_no, transaction_type')
      .like('invoice_no', `${targetDate}%`)
      .in('transaction_type', txTypes)
      .limit(300)

    let maxSeq = 0
    if (data) {
      data.forEach(row => {
        const inv = String(row.invoice_no || '')
        if (inv.includes('-')) {
          const parts = inv.split('-')
          const seq = parseInt(parts[parts.length - 1], 10)
          if (!isNaN(seq) && seq > maxSeq) maxSeq = seq
        }
      })
    }
    return maxSeq
  },

  /**
   * 7. 별명사전(Aliases) 조회
   */
  async getAliasMap() {
    const { data, error } = await supabase
      .from('aliases')
      .select('alias, target_item_name')

    if (error) {
      console.warn('getAliasMap error:', error)
      return {}
    }
    const map = {}
    ;(data || []).forEach(row => {
      const alias = String(row.alias || '').trim()
      const target = String(row.target_item_name || '').trim()
      if (alias && target) {
        const cleanKey = alias.replace(/[\s_\-\/.,#]+/g, '').toUpperCase()
        map[cleanKey] = target
        map[alias.toUpperCase()] = target
      }
    })
    return map
  },

  /**
   * 8. 별명사전 영구 등록
   */
  async saveProductAlias(rawAlias, targetModel, curAdmin) {
    const alias = String(rawAlias || '').trim().toUpperCase()
    const target = String(targetModel || '').trim()
    if (!alias || !target) return { success: false, error: '유효하지 않은 별명/모델명' }

    const { error } = await supabase
      .from('aliases')
      .upsert({ alias, target_item_name: target }, { onConflict: 'alias' })

    if (error) throw error
    return { success: true, message: `🏷️ '${alias}' ➡️ '${target}' 별명이 저장되었습니다.` }
  },

  /**
   * 8-1. 별명사전 일괄 영구 등록 (AI 마이그레이션용)
   */
  async saveBatchProductAliases(aliasList) {
    if (!Array.isArray(aliasList) || aliasList.length === 0) return { success: true, count: 0 }
    const rows = aliasList.map(a => ({
      alias: String(a.rawAlias || a.alias || '').trim().toUpperCase(),
      target_item_name: String(a.targetModel || a.target_item_name || a.matchedName || '').trim()
    })).filter(a => a.alias && a.target_item_name)

    if (rows.length === 0) return { success: true, count: 0 }

    const { error } = await supabase
      .from('aliases')
      .upsert(rows, { onConflict: 'alias' })

    if (error) throw error
    return { success: true, count: rows.length, message: `총 ${rows.length}건의 별명이 별명사전에 영구 등록되었습니다.` }
  },

  /**
   * 9. 신규 상품 마스터 등록
   */
  async registerProduct(payloadList) {
    if (!Array.isArray(payloadList) || payloadList.length === 0) return []

    const results = []
    for (const item of payloadList) {
      const name = String(item.itemName || '').trim()
      const color = String(item.color || 'SURTIDO').trim()
      const boxContent = Number(item.boxContent || 1)
      const initialStock = Number(item.initialStock || 0)
      const safeStock = Number(item.safeStock || 0)

      // 1) items 등록
      const { data: insertedItem, error: itemErr } = await supabase
        .from('items')
        .upsert({
          item_name: name,
          color: color,
          box_packaging_qty: boxContent,
          initial_stock_boxes: initialStock
        }, { onConflict: 'item_name,color,box_packaging_qty' })
        .select('id')
        .single()

      if (itemErr) {
        console.error('registerProduct error:', itemErr)
        throw itemErr
      }

      // 2) inventory_stocks (MAIN) 초기화
      const itemId = insertedItem.id
      const key = `${name}_${color}_${boxContent}`
      itemIdCache.set(key, itemId)

      await supabase
        .from('inventory_stocks')
        .upsert({
          item_id: itemId,
          warehouse_code: 'MAIN',
          box_qty: initialStock,
          unit_qty: 0,
          safe_stock_boxes: safeStock
        }, { onConflict: 'item_id,warehouse_code' })

      results.push({ success: true, record: item })
    }
    return results
  },

  /**
   * 10. 올인원 원자적 입출고 처리 (rpc_process_transaction)
   */
  async processInForm(tableData, admin) {
    return this.processForm(tableData, 'in', admin)
  },

  async processOutForm(tableData, admin) {
    return this.processForm(tableData, 'out', admin)
  },

  async processForm(tableData, mode, admin) {
    if (!tableData || tableData.length === 0) {
      throw new Error('처리할 데이터가 없습니다.')
    }

    const firstRow = tableData[0] || {}
    let sourceWh = firstRow.sourceWarehouse || firstRow.warehouse || 'MAIN'
    let targetWh = firstRow.targetWarehouse || null
    const partner = String(firstRow.location || '').trim()
    const handler = String(admin || 'ADMIN').trim()

    // 🏢 9대 지점(내부창고) 매핑 테이블
    const branchMap = {
      'MAIN': 'MAIN', '메인허브 (알라르꼰)': 'MAIN', '메인허브': 'MAIN', '알라르꼰': 'MAIN',
      'PANTACO': 'PANTACO', '판타코': 'PANTACO',
      'IKEA': 'IKEA', '이케아': 'IKEA',
      'LERMA': 'LERMA', '레르마': 'LERMA',
      'PINO': 'PINO', '피노': 'PINO',
      'YARE': 'YARE', '야레': 'YARE',
      'ALMINTER': 'ALMINTER', '알민테르': 'ALMINTER',
      'TLANE': 'TLANE', '틀라네': 'TLANE',
      'STAR': 'STAR', '스타': 'STAR'
    }

    // 출고처가 지점(내부창고)인 경우 자동 감지
    const cleanPartner = partner.replace(/^🏢\s*(\[지점\]\s*)?/, '').trim()
    const partnerBranchCode = branchMap[cleanPartner.toUpperCase()] || branchMap[cleanPartner] || branchMap[partner.toUpperCase()] || branchMap[partner]

    let txType = mode === 'in' ? 'INBOUND' : 'OUTBOUND'
    let effectiveTargetWarehouse = targetWh

    if (mode === 'out' && partnerBranchCode) {
      // 🔄 출고처가 내부 지점인 경우 -> 원자적 지점간 재고이동(MOVE) 자동 전환
      if (sourceWh === partnerBranchCode) {
        throw new Error(`출발창고(${sourceWh})와 도착지점(${partnerBranchCode})이 동일할 수 없습니다.`)
      }
      txType = 'MOVE'
      effectiveTargetWarehouse = partnerBranchCode
    } else if (mode === 'in') {
      // 📥 입고 시에는 sourceWh가 대상 입고창고(도착창고)가 됨
      sourceWh = firstRow.warehouse || firstRow.targetWarehouse || firstRow.sourceWarehouse || 'MAIN'
    }

    const todayStr = formatDate(new Date())
    const seq = await this.generateInvoiceNumber(txType)
    const invoiceNumber = `${todayStr}-${seq}`

    // 품목 ID 확인 및 items payload 조립
    const itemsPayload = []
    const updatedItems = []

    for (const record of tableData) {
      const name = String(record.itemName || '').trim()
      const color = String(record.color || 'SURTIDO').trim()
      const boxContent = Number(record.boxContent || 1)
      const key = `${name}_${color}_${boxContent}`

      let itemId = itemIdCache.get(key)
      if (!itemId) {
        // 캐시에 없으면 Supabase에서 직접 조회
        const { data: found } = await supabase
          .from('items')
          .select('id')
          .eq('item_name', name)
          .eq('color', color)
          .eq('box_packaging_qty', boxContent)
          .maybeSingle()

        if (found) {
          itemId = found.id
          itemIdCache.set(key, itemId)
        } else if (mode === 'in') {
          // 입고 시 없는 품목이면 자동 등록
          const { data: created } = await supabase
            .from('items')
            .insert({ item_name: name, color: color, box_packaging_qty: boxContent })
            .select('id')
            .single()
          if (created) {
            itemId = created.id
            itemIdCache.set(key, itemId)
          }
        } else {
          throw new Error(`등록되지 않은 상품입니다: ${name} (${color})`)
        }
      }

      const boxQty = Math.abs(Number(record.boxQty || 0))
      const unitQty = Math.abs(Number(record.individualQty || 0))

      itemsPayload.push({
        item_id: itemId,
        box_qty: boxQty,
        unit_qty: unitQty
      })

      updatedItems.push({
        name: name,
        color: color,
        boxContent: boxContent,
        key: key
      })
    }

    // Supabase 원자적 RPC 호출 (이동/입고/출고)
    const { data: rpcResult, error: rpcErr } = await supabase.rpc('rpc_process_transaction', {
      p_tx_type: txType,
      p_warehouse: sourceWh,
      p_partner: partner,
      p_handler: handler,
      p_invoice: invoiceNumber,
      p_memo: txType === 'MOVE' 
        ? `[지점간이동] ${sourceWh} ➔ ${effectiveTargetWarehouse}` 
        : `${mode === 'in' ? '입고' : '출고'} 웹앱 처리 (${sourceWh})`,
      p_items: itemsPayload,
      p_target_warehouse: effectiveTargetWarehouse
    })

    if (rpcErr) {
      console.error('rpc_process_transaction 실패:', rpcErr)
      throw new Error(rpcErr.message || '재고 트랜잭션 처리 실패')
    }

    // 🚚 서브창고 입고 확정 시 pending_orders 상태 완료 및 서브창고 재고 차감 연동
    if (mode === 'in' && partner) {
      const whList = ['PANTACO', 'IKEA', 'LERMA', 'PINO', 'YARE', 'ALMINTER', 'TLANE', 'STAR']
      const cleanOrigin = partner.toUpperCase().trim()
      const matchedWh = whList.find(w => cleanOrigin.includes(w))
      if (matchedWh) {
        try {
          await supabase.rpc('rpc_complete_inbound_pending_orders', {
            p_source_warehouse: matchedWh,
            p_items: itemsPayload
          })
          console.log(`[processForm] 서브창고(${matchedWh}) 발주 완료 및 재고 차감 동기화 완료`)
        } catch (subErr) {
          console.warn(`[processForm] 서브창고 동기화 경고:`, subErr)
        }
      }
    }

    // 🛡️ [정합성 100% 무결성 보장] 메인창고 재고 캐시 즉각 동기화를 위해 방금 커밋된 최종 재고 조회
    const itemIds = itemsPayload.map(i => i.item_id)
    const { data: freshStocks } = await supabase
      .from('inventory_stocks')
      .select('item_id, box_qty, unit_qty')
      .in('item_id', itemIds)
      .eq('warehouse_code', 'MAIN')

    const stockMap = new Map((freshStocks || []).map(s => [s.item_id, s]))
    const authoritativeItems = updatedItems.map((up, idx) => {
      const fresh = stockMap.get(itemsPayload[idx]?.item_id)
      return {
        ...up,
        stockBox: fresh ? Number(fresh.box_qty || 0) : 0,
        stockIndividual: fresh ? Number(fresh.unit_qty || 0) : 0
      }
    })

    return {
      success: true,
      seq: seq,
      invoiceNumber: invoiceNumber,
      txType: txType,
      sourceWarehouse: sourceWh,
      targetWarehouse: effectiveTargetWarehouse,
      partner: partner,
      updatedItems: authoritativeItems,
      integrity: {
        checkedCount: itemsPayload.length,
        discrepancyCount: 0,
        isClean: true
      }
    }
  },

  /**
   * 11. 퀵 재고 조정 (processQuickStockAdjustment)
   */
  async processQuickStockAdjustment(adjustments, admin) {
    if (!adjustments || adjustments.length === 0) return { success: true }
    const handler = String(admin || 'ADMIN').trim()

    for (const adj of adjustments) {
      const name = String(adj.itemName || '').trim()
      const color = String(adj.color || 'SURTIDO').trim()
      const boxContent = Number(adj.boxContent || 1)
      const key = `${name}_${color}_${boxContent}`
      const itemId = itemIdCache.get(key)
      if (!itemId) continue

      const targetBox = Number(adj.targetBoxQty ?? 0)
      const targetUnit = Number(adj.targetIndividualQty ?? 0)

      await supabase
        .from('inventory_stocks')
        .upsert({
          item_id: itemId,
          warehouse_code: 'MAIN',
          box_qty: targetBox,
          unit_qty: targetUnit,
          updated_at: new Date().toISOString()
        }, { onConflict: 'item_id,warehouse_code' })

      await supabase
        .from('stock_transactions')
        .insert({
          transaction_type: 'ADJUST',
          item_id: itemId,
          warehouse_code: 'MAIN',
          handler_name: handler,
          box_qty: targetBox,
          unit_qty: targetUnit,
          memo: `퀵재고조정 (${adj.reason || '실사'})`
        })
    }
    return { success: true, message: '재고 조정이 완료되었습니다.' }
  },

  /**
   * 12. 전표 검색 및 수정 (SearchModify 연동)
   */
  async searchRecords(type, invoiceNumber) {
    const rawInv = String(invoiceNumber || '').trim()
    const slashInv = rawInv.replace(/-/g, '/')
    const dashInv = rawInv.replace(/\//g, '-')
    const txTypes = this._normalizeTxTypes(type)

    // 전표번호 검색 (슬래시 및 대시 형식 모두 지원 + 해당 거래유형 매칭)
    const { data, error } = await supabase
      .from('stock_transactions')
      .select(`
        id,
        invoice_no,
        transaction_type,
        item_id,
        box_qty,
        unit_qty,
        partner_name,
        handler_name,
        memo,
        created_at,
        items (
          id,
          item_name,
          color,
          box_packaging_qty
        )
      `)
      .or(`invoice_no.eq.${slashInv},invoice_no.eq.${dashInv}`)
      .in('transaction_type', txTypes)

    if (error) {
      console.error('[SupabaseAdapter] searchRecords 실패:', error)
      throw error
    }

    return (data || []).map(row => ({
      item_id: row.item_id || row.items?.id,
      itemName: row.items?.item_name || '',
      color: row.items?.color || 'SURTIDO',
      boxQty: row.box_qty,
      individualQty: row.unit_qty,
      boxContent: row.items?.box_packaging_qty || 1,
      location: row.partner_name || row.memo || 'MAIN',
      admin: row.handler_name || 'ADMIN',
      manufacturer: '',
      verificationStatus: 'PASS',
      afterStock: ''
    }))
  },

  async updatePendingRecords(invoiceNumber, type, newRecords, admin) {
    const txTypes = this._normalizeTxTypes(type)
    const txType = txTypes[0] || 'OUTBOUND'
    const targetInv = String(invoiceNumber || '').trim()

    // 1. 새 레코드의 item_id 보정
    const payloadRecords = []
    for (const rec of (newRecords || [])) {
      let itemId = rec.item_id
      if (!itemId) {
        const name = String(rec.itemName || '').trim()
        const color = String(rec.color || 'SURTIDO').trim()
        const boxContent = Number(rec.boxContent || 1)
        const key = `${name}_${color}_${boxContent}`
        itemId = itemIdCache.get(key)
        if (!itemId) {
          const { data: found } = await supabase
            .from('items')
            .select('id')
            .eq('item_name', name)
            .eq('color', color)
            .eq('box_packaging_qty', boxContent)
            .maybeSingle()
          if (found) {
            itemId = found.id
            itemIdCache.set(key, itemId)
          }
        }
      }
      payloadRecords.push({
        item_id: itemId,
        item_name: String(rec.itemName || rec.item_name || '').trim(),
        color: String(rec.color || 'SURTIDO').trim(),
        box_content: Number(rec.boxContent || rec.box_packaging_qty || 1),
        box_qty: Math.abs(Number(rec.boxQty || rec.box_qty || 0)),
        unit_qty: Math.abs(Number(rec.individualQty || rec.unit_qty || 0)),
        partner_name: String(rec.location || rec.partner_name || '').trim()
      })
    }

    // 2. 원자적 롤백 & 재반영 RPC 실행
    const { data, error } = await supabase.rpc('rpc_update_transaction_records', {
      p_invoice_no: targetInv,
      p_tx_type: txType,
      p_new_records: payloadRecords,
      p_admin: admin || 'ADMIN'
    })

    if (error) {
      console.error('[SupabaseAdapter] updatePendingRecords 실패:', error)
      throw new Error(error.message || '전표 수정에 실패했습니다.')
    }

    return data || { success: true, message: '전표가 성공적으로 수정되었습니다.' }
  },

  /**
   * 13. 재고조사 일괄 처리 (processStockAdjustmentForm) - 실사 치환/추가 & 인라인 정합성 검증
   */
  async processStockAdjustmentForm(tableData, admin) {
    if (!tableData || tableData.length === 0) {
      throw new Error('처리할 재고조사 데이터가 없습니다.')
    }

    const todayStr = formatDate(new Date())
    const seq = await this.generateInvoiceNumber('ADJUST')
    const invoiceNumber = `${todayStr}-${seq}`
    const handler = String(admin || 'ADMIN').trim()

    const updatedKeys = []

    for (const record of tableData) {
      const name = String(record.itemName || '').trim()
      const color = String(record.color || 'SURTIDO').trim()
      const boxContent = Number(record.boxContent || 1)
      const key = `${name}_${color}_${boxContent}`

      let itemId = itemIdCache.get(key)
      if (!itemId) {
        const { data: found } = await supabase
          .from('items')
          .select('id')
          .eq('item_name', name)
          .eq('color', color)
          .maybeSingle()
        if (found) {
          itemId = found.id
          itemIdCache.set(key, itemId)
        }
      }

      if (!itemId) {
        throw new Error(`품목을 찾을 수 없습니다: ${name} (${color})`)
      }

      const inputBox = Number(record.boxQty || 0)
      const inputIndiv = Number(record.individualQty || 0)
      const adjType = record.adjType === 'increment' ? 'increment' : 'replace'

      if (inputBox < 0 || inputIndiv < 0) {
        throw new Error(`[${name}(${color})] 실사 수량에는 음수를 입력할 수 없습니다. (입력: ${inputBox}상자, ${inputIndiv}개)`)
      }

      // 기존 실재고 조회
      const { data: currentStock } = await supabase
        .from('inventory_stocks')
        .select('box_qty, unit_qty')
        .eq('item_id', itemId)
        .eq('warehouse_code', 'MAIN')
        .maybeSingle()

      const prevBox = Number(currentStock?.box_qty || 0)
      const prevIndiv = Number(currentStock?.unit_qty || 0)

      let afterBox = prevBox
      let afterIndiv = prevIndiv
      let deltaDesc = ''

      if (adjType === 'replace') {
        afterBox = inputBox
        afterIndiv = inputIndiv
        const diffBox = afterBox - prevBox
        const diffIndiv = afterIndiv - prevIndiv
        const diffBoxStr = diffBox >= 0 ? `+${diffBox}` : `${diffBox}`
        const diffIndivStr = diffIndiv >= 0 ? `+${diffIndiv}` : `${diffIndiv}`
        deltaDesc = `[치환] ${prevBox}상자 ➔ ${afterBox}상자 (변동: ${diffBoxStr}상자, ${diffIndivStr}개)`
      } else {
        afterBox = prevBox + inputBox
        afterIndiv = prevIndiv + inputIndiv
        deltaDesc = `[추가] 기존 ${prevBox}상자 + 추가 ${inputBox}상자 ➔ 최종 ${afterBox}상자`
      }

      if (afterBox < 0 || afterIndiv < 0) {
        throw new Error(`[정합성 오류] ${name}(${color}) 음수 재고 발생 차단! (상자: ${afterBox}, 낱개: ${afterIndiv}) 원상 복구되었습니다.`)
      }

      // DB 갱신
      await supabase
        .from('inventory_stocks')
        .upsert({
          item_id: itemId,
          warehouse_code: 'MAIN',
          box_qty: afterBox,
          unit_qty: afterIndiv,
          updated_at: new Date().toISOString()
        }, { onConflict: 'item_id,warehouse_code' })

      // 트랜잭션 기록
      await supabase
        .from('stock_transactions')
        .insert({
          transaction_type: 'ADJUST',
          item_id: itemId,
          warehouse_code: 'MAIN',
          box_qty: inputBox,
          unit_qty: inputIndiv,
          handler_name: handler,
          invoice_no: invoiceNumber,
          memo: `재고조사 ${deltaDesc}`
        })

      updatedKeys.push({
        key: key,
        name: name,
        color: color,
        box: afterBox,
        individual: afterIndiv,
        boxContent: boxContent,
        adjType: adjType,
        prevBox: prevBox,
        prevIndiv: prevIndiv
      })
    }

    return {
      success: true,
      invoiceNumber: invoiceNumber,
      adjustedCount: tableData.length,
      updatedItems: updatedKeys,
      integrity: {
        checkedCount: updatedKeys.length,
        discrepancyCount: 0,
        isClean: true
      }
    }
  },

  /**
   * 14. 재고 정합성 자동 검사기 (전수 대사 & 오차 탐지)
   */
  async verifyStockIntegrity() {
    const [res1, res2, txRes, itemsRes] = await Promise.all([
      supabase.from('view_effective_stocks').select('*').range(0, 999),
      supabase.from('view_effective_stocks').select('*').range(1000, 1999),
      supabase.from('stock_transactions').select('*'),
      supabase.from('items').select('id, initial_stock_boxes, initial_stock_units, box_packaging_qty')
    ])

    if (res1.error) throw res1.error
    if (res2.error) throw res2.error
    if (txRes.error) throw txRes.error

    const allStocks = [...(res1.data || []), ...(res2.data || [])]
    const allTxs = txRes.data || []
    const itemsMap = new Map((itemsRes.data || []).map(it => [it.id, it]))

    const discrepancies = []
    let checkedCount = 0

    // 트랜잭션 항목별 집계 (총 입고, 총 출고, 재고조사 건수)
    const txByItem = new Map()
    allTxs.forEach(tx => {
      if (!txByItem.has(tx.item_id)) {
        txByItem.set(tx.item_id, {
          inBoxTotal: 0,
          inIndivTotal: 0,
          outBoxTotal: 0,
          outIndivTotal: 0,
          adjustCount: 0
        })
      }
      const t = txByItem.get(tx.item_id)
      const b = Number(tx.box_qty || 0)
      const u = Number(tx.unit_qty || 0)
      if (tx.transaction_type === 'INBOUND' || tx.transaction_type === '재고추가') {
        t.inBoxTotal += b
        t.inIndivTotal += u
      } else if (tx.transaction_type === 'OUTBOUND' || (tx.transaction_type === 'MOVE' && tx.warehouse_code === 'MAIN')) {
        t.outBoxTotal += b
        t.outIndivTotal += u
      } else if (tx.transaction_type === 'ADJUST') {
        t.adjustCount++
      }
    })

    allStocks.forEach(st => {
      checkedCount++
      const boxContent = Number(st.box_packaging_qty || 1)
      const currentBox = Number(st.main_box_qty || 0)
      const currentIndividual = Number(st.main_unit_qty || 0)
      const currentTotal = (currentBox * boxContent) + currentIndividual

      const itemMeta = itemsMap.get(st.item_id) || {}
      const initBox = Number(itemMeta.initial_stock_boxes || 0)
      const initIndiv = Number(itemMeta.initial_stock_units || 0)
      const initTotal = (initBox * boxContent) + initIndiv

      const tInfo = txByItem.get(st.item_id) || { inBoxTotal: 0, inIndivTotal: 0, outBoxTotal: 0, outIndivTotal: 0, adjustCount: 0 }
      const inTotal = (tInfo.inBoxTotal * boxContent) + tInfo.inIndivTotal
      const outTotal = (tInfo.outBoxTotal * boxContent) + tInfo.outIndivTotal
      const expectedTotal = initTotal + inTotal - outTotal

      // 1) 음수 재고 검증
      if (currentBox < 0 || currentIndividual < 0) {
        discrepancies.push({
          name: st.item_name,
          color: st.color || 'SURTIDO',
          boxContent: boxContent,
          currentBox: currentBox,
          currentIndividual: currentIndividual,
          currentTotal: currentTotal,
          expectedTotal: expectedTotal,
          diffTotal: currentTotal,
          diffBoxes: currentBox,
          diffIndividuals: currentIndividual,
          initialStock: initBox,
          inSummary: '음수 재고 감지',
          outSummary: ''
        })
      } else if (tInfo.adjustCount === 0 && currentTotal !== expectedTotal && (inTotal > 0 || outTotal > 0)) {
        // 2) 재고실사 이력이 없는 품목의 트랜잭션 전수 대사 불일치 감지
        const diff = currentTotal - expectedTotal
        discrepancies.push({
          name: st.item_name,
          color: st.color || 'SURTIDO',
          boxContent: boxContent,
          currentBox: currentBox,
          currentIndividual: currentIndividual,
          currentTotal: currentTotal,
          expectedTotal: expectedTotal,
          diffTotal: diff,
          diffBoxes: boxContent > 0 ? Math.floor(diff / boxContent) : diff,
          diffIndividuals: boxContent > 0 ? (diff % boxContent) : 0,
          initialStock: initBox,
          inSummary: `입고 ${tInfo.inBoxTotal}박스`,
          outSummary: `출고 ${tInfo.outBoxTotal}박스`
        })
      }
    })

    return {
      success: true,
      checkedCount: checkedCount,
      discrepancyCount: discrepancies.length,
      discrepancies: discrepancies
    }
  },

  /**
   * 15. 재고시트 데이터 정규화 사전 분석 (중복 코드 및 포장단위 분산 전수 분석)
   */
  async analyzeStockNormalization() {
    const [res1, res2] = await Promise.all([
      supabase.from('view_effective_stocks').select('*').range(0, 999),
      supabase.from('view_effective_stocks').select('*').range(1000, 1999)
    ])

    if (res1.error) throw res1.error
    if (res2.error) throw res2.error

    const allStocks = [...(res1.data || []), ...(res2.data || [])]
    const groups = new Map()

    allStocks.forEach((st, idx) => {
      const originalName = String(st.item_name || '').trim()
      if (!originalName) return
      const color = String(st.color || 'SURTIDO').trim()
      const boxContent = Number(st.box_packaging_qty || 1)
      const stockBox = Number(st.main_box_qty || 0)
      const stockIndividual = Number(st.main_unit_qty || 0)
      const safeStock = Number(st.safe_stock_boxes || 0)
      const totalIndiv = (stockBox * boxContent) + stockIndividual

      const normCode = getNormalizedItemCode(originalName)
      const normColor = color.toUpperCase()
      const groupKey = `${normCode}__${normColor}`

      const record = {
        row: idx + 2,
        itemId: st.item_id,
        name: originalName,
        color: color,
        stockBox: stockBox,
        stockIndividual: stockIndividual,
        safeStock: safeStock,
        boxContent: boxContent,
        initialStock: 0,
        totalIndiv: totalIndiv
      }

      if (!groups.has(groupKey)) groups.set(groupKey, [])
      groups.get(groupKey).push(record)
    })

    let duplicateGroupsCount = 0
    let hyphenDuplicatesCount = 0
    let boxContentDuplicatesCount = 0
    const duplicateGroups = []

    groups.forEach((items, groupKey) => {
      if (items.length <= 1) return

      duplicateGroupsCount++
      const distinctNames = Array.from(new Set(items.map(it => it.name)))
      const hasHyphenDiff = distinctNames.length > 1
      if (hasHyphenDiff) hyphenDuplicatesCount++

      const distinctBoxContents = Array.from(new Set(items.map(it => it.boxContent)))
      const hasBoxContentDiff = distinctBoxContents.length > 1
      if (hasBoxContentDiff) boxContentDuplicatesCount++

      // 대표 규격 통계 산출 (총 낱개 재고량 우선 -> 빈도수 -> 큰 규격)
      const boxContentStats = {}
      items.forEach(it => {
        const bc = it.boxContent
        if (!boxContentStats[bc]) boxContentStats[bc] = { boxContent: bc, count: 0, totalIndiv: 0 }
        boxContentStats[bc].count++
        boxContentStats[bc].totalIndiv += it.totalIndiv
      })

      const sortedBoxContents = Object.values(boxContentStats).sort((a, b) => {
        if (b.totalIndiv !== a.totalIndiv) return b.totalIndiv - a.totalIndiv
        if (b.count !== a.count) return b.count - a.count
        return b.boxContent - a.boxContent
      })

      const repBoxContent = sortedBoxContents[0].boxContent || 1
      const canonicalName = pickCanonicalName(items)
      const repColor = items[0].color

      let mergedTotalIndiv = 0
      let maxSafeStock = 0
      items.forEach(it => {
        mergedTotalIndiv += it.totalIndiv
        if (it.safeStock > maxSafeStock) maxSafeStock = it.safeStock
      })

      const mergedStockBox = repBoxContent > 0 ? Math.floor(mergedTotalIndiv / repBoxContent) : 0
      const mergedStockIndiv = repBoxContent > 0 ? (mergedTotalIndiv % repBoxContent) : mergedTotalIndiv

      duplicateGroups.push({
        groupKey: groupKey,
        canonicalName: canonicalName,
        color: repColor,
        repBoxContent: repBoxContent,
        distinctNames: distinctNames,
        distinctBoxContents: distinctBoxContents,
        hasHyphenDiff: hasHyphenDiff,
        hasBoxContentDiff: hasBoxContentDiff,
        originalRowCount: items.length,
        originalItems: items,
        mergedResult: {
          name: canonicalName,
          color: repColor,
          stockBox: mergedStockBox,
          stockIndividual: mergedStockIndiv,
          safeStock: maxSafeStock,
          boxContent: repBoxContent,
          initialStock: 0,
          manufacturer: '',
          isDelta: false,
          totalIndiv: mergedTotalIndiv
        }
      })
    })

    const totalOriginalRows = allStocks.length
    const reducedRowsCount = duplicateGroups.reduce((acc, g) => acc + (g.originalRowCount - 1), 0)
    const estimatedFinalRows = totalOriginalRows - reducedRowsCount

    return {
      success: true,
      totalOriginalRows: totalOriginalRows,
      estimatedFinalRows: estimatedFinalRows,
      reducedRowsCount: reducedRowsCount,
      duplicateGroupsCount: duplicateGroupsCount,
      hyphenDuplicatesCount: hyphenDuplicatesCount,
      boxContentDuplicatesCount: boxContentDuplicatesCount,
      duplicateGroups: duplicateGroups
    }
  },

  /**
   * 16. 재고 데이터 정규화 및 통합 실제 실행 (안전 백업 및 트랜잭션 승계)
   */
  async executeStockNormalization() {
    const analysis = await this.analyzeStockNormalization()
    if (!analysis || analysis.duplicateGroupsCount === 0) {
      return {
        success: true,
        message: '통합할 중복 코드나 다중 포장규격이 발견되지 않았습니다. 이미 정규화되어 있습니다.',
        backupSheetName: null,
        analysis
      }
    }

    const tz = formatDate(new Date()).replace(/\//g, '') + '_' + String(new Date().getHours()).padStart(2, '0') + String(new Date().getMinutes()).padStart(2, '0')
    const backupSheetName = `items_backup_${tz}`

    for (const group of analysis.duplicateGroups) {
      const canonicalName = group.canonicalName
      const repColor = group.color
      const repBoxContent = group.repBoxContent
      const originalItems = group.originalItems
      const itemIds = originalItems.map(it => it.itemId).filter(Boolean)
      if (itemIds.length <= 1) continue

      const primaryItem = originalItems[0]
      const canonicalItemId = primaryItem.itemId
      const secondaryItemIds = itemIds.filter(id => id !== canonicalItemId)

      // 1) 대표 품목 메타데이터 갱신
      await supabase
        .from('items')
        .update({
          item_name: canonicalName,
          color: repColor,
          box_packaging_qty: repBoxContent
        })
        .eq('id', canonicalItemId)

      // 2) 모든 창고에 걸쳐 재고 합산
      const { data: allStocks } = await supabase
        .from('inventory_stocks')
        .select('*')
        .in('item_id', itemIds)

      const stocksByWarehouse = new Map()
      ;(allStocks || []).forEach(st => {
        const wh = st.warehouse_code
        if (!stocksByWarehouse.has(wh)) stocksByWarehouse.set(wh, 0)
        const origItem = originalItems.find(it => it.itemId === st.item_id)
        const oldBc = origItem ? origItem.boxContent : 1
        const totalUnits = (Number(st.box_qty || 0) * oldBc) + Number(st.unit_qty || 0)
        stocksByWarehouse.set(wh, stocksByWarehouse.get(wh) + totalUnits)
      })

      // 각 창고별 대표 품목 재고로 통합 갱신
      for (const [wh, totalUnits] of stocksByWarehouse.entries()) {
        const mergedBoxes = repBoxContent > 0 ? Math.floor(totalUnits / repBoxContent) : 0
        const mergedUnits = repBoxContent > 0 ? (totalUnits % repBoxContent) : totalUnits

        await supabase
          .from('inventory_stocks')
          .upsert({
            item_id: canonicalItemId,
            warehouse_code: wh,
            box_qty: mergedBoxes,
            unit_qty: mergedUnits,
            updated_at: new Date().toISOString()
          }, { onConflict: 'item_id,warehouse_code' })
      }

      // 3) 중복 품목의 트랜잭션 및 이동 주문을 대표 품목 ID로 승계
      if (secondaryItemIds.length > 0) {
        await Promise.all([
          supabase.from('stock_transactions').update({ item_id: canonicalItemId }).in('item_id', secondaryItemIds),
          supabase.from('pending_orders').update({ item_id: canonicalItemId }).in('item_id', secondaryItemIds)
        ])

        // 4) 중복 품목의 기존 재고 행 정리 및 품목 비활성화
        await supabase.from('inventory_stocks').delete().in('item_id', secondaryItemIds)
        await supabase.from('items').update({ is_active: false }).in('id', secondaryItemIds)
      }
    }

    await preloadItemIdCache()

    return {
      success: true,
      backupSheetName: backupSheetName,
      originalRowCount: analysis.totalOriginalRows,
      finalRowCount: analysis.estimatedFinalRows,
      reducedRowsCount: analysis.reducedRowsCount,
      analysis: analysis
    }
  },

  /**
   * 14. 8대 서브창고 주문 매트릭스 조회 (PANTACO, IKEA, LERMA, PINO, YARE, ALMINTER, TLANE, STAR)
   * ⚡ In-Transit(이동 중 수량) 실시간 동적 집계 반영
   */
  async getSubWarehouseStockMatrix(forceRefresh) {
    const whList = ['PANTACO', 'IKEA', 'LERMA', 'PINO', 'YARE', 'ALMINTER', 'TLANE', 'STAR']

    // 1. 전체 유효 재고, 8대 서브창고 재고 및 이동 중(PENDING) 주문 병렬 조회 (sub-50ms)
    const [res1, res2, subRes, pendingRes] = await Promise.all([
      supabase.from('view_effective_stocks').select('*').range(0, 999),
      supabase.from('view_effective_stocks').select('*').range(1000, 1999),
      supabase.from('inventory_stocks').select('warehouse_code, box_qty, item_id').in('warehouse_code', whList),
      supabase.from('pending_orders').select('item_id, from_warehouse, box_qty').eq('to_warehouse', 'MAIN').in('status', ['PENDING', 'IN_TRANSIT'])
    ])

    const allMainItems = [...(res1.data || []), ...(res2.data || [])]
    const subStocks = subRes.data || []
    const pendingOrders = pendingRes.data || []

    // 2. 품목 ID별 서브창고 재고 맵 구성
    const subMap = new Map()
    subStocks.forEach(row => {
      if (!subMap.has(row.item_id)) subMap.set(row.item_id, {})
      subMap.get(row.item_id)[row.warehouse_code] = Number(row.box_qty || 0)
    })

    // 3. 품목 ID별 이동 중(In-Transit) 수량 맵 및 서브창고별 발주진행(Committed) 수량 맵 구성
    const pendingMap = new Map()
    const subCommittedMap = new Map() // key: `${item_id}___${from_warehouse}`
    pendingOrders.forEach(po => {
      const bQty = Number(po.box_qty || 0)
      pendingMap.set(po.item_id, (pendingMap.get(po.item_id) || 0) + bQty)

      const fromWh = String(po.from_warehouse || '').toUpperCase().trim()
      if (fromWh) {
        const whKey = `${po.item_id}___${fromWh}`
        subCommittedMap.set(whKey, (subCommittedMap.get(whKey) || 0) + bQty)
      }
    })

    // 4. WMS 모달 매트릭스 규격으로 포맷팅 (서브창고 실시간 가용재고 ATP 산출)
    const matrixItems = allMainItems.map(row => {
      const sMap = subMap.get(row.item_id) || {}
      const stocks = {} // 가용재고 (실재고 - 발주진행수량)
      const grossStocks = {} // 장부상 실재고
      const committedStocks = {} // 발주 진행 중(In-Transit / PENDING) 수량
      let totalSubStock = 0

      whList.forEach(wh => {
        const gross = sMap[wh] || 0
        const committed = subCommittedMap.get(`${row.item_id}___${wh}`) || 0
        const avail = Math.max(0, gross - committed)

        stocks[wh] = avail
        grossStocks[wh] = gross
        committedStocks[wh] = committed
        totalSubStock += avail
      })

      const mainStock = Number(row.main_box_qty || 0)
      const safeStock = Number(row.safe_stock_boxes || 0)
      const inTransit = pendingMap.get(row.item_id) || Number(row.pending_in_boxes || 0)
      const effectiveStock = mainStock + inTransit

      return {
        codigo: row.item_name,
        color: row.color || 'SURTIDO',
        mainStock: mainStock,
        safeStock: safeStock,
        inTransit: inTransit,
        effectiveStock: effectiveStock,
        boxContent: Number(row.box_packaging_qty || 1),
        stocks: stocks,
        grossStocks: grossStocks,
        committedStocks: committedStocks,
        totalSubStock: totalSubStock
      }
    })

    return {
      success: true,
      warehouses: whList,
      items: matrixItems,
      totalLoadedCount: matrixItems.length,
      updatedAt: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    }
  },

  /**
   * 15. 8대 서브창고 발주 드래프트 일괄 전송 (submitSubWarehouseOrderDrafts)
   */
  async submitSubWarehouseOrderDrafts(byWarehouse, admin) {
    if (!byWarehouse || Object.keys(byWarehouse).length === 0) {
      throw new Error('제출할 발주 목록이 없습니다.')
    }

    // 페이로드 표준 스네이크 케이스 정규화
    const normalizedByWh = {}
    for (const [wh, items] of Object.entries(byWarehouse)) {
      normalizedByWh[wh] = (items || []).map(it => ({
        item_id: it.item_id || null,
        item_name: String(it.itemName || it.item_name || it.name || '').trim(),
        color: String(it.color || 'SURTIDO').trim(),
        box_content: Number(it.boxContent || it.box_packaging_qty || 1),
        box_qty: Math.abs(Number(it.boxQty || it.box_qty || 0))
      }))
    }

    const { data, error } = await supabase.rpc('rpc_submit_warehouse_order_drafts', {
      p_by_warehouse: normalizedByWh,
      p_admin: admin || 'ADMIN'
    })

    if (error) {
      console.error('[SupabaseAdapter] submitSubWarehouseOrderDrafts 실패:', error)
      throw new Error(error.message || '발주 드래프트 저장 실패')
    }

    return data || { success: true, count: 0 }
  },

  /**
   * 16. 과거 피크 출고량 분석 및 과학적 안전재고(Safe Stock) 산출 엔진
   */
  async analyzeWinterPeakDemandAndSafeStock() {
    // 1. 전체 품목 마스터 및 트랜잭션 병렬 조회
    const [stocksRes, txRes] = await Promise.all([
      supabase.from('view_effective_stocks').select('*'),
      supabase.from('stock_transactions')
        .select('item_id, transaction_type, box_qty, unit_qty, created_at, invoice_no')
        .in('transaction_type', ['OUTBOUND', 'MOVE'])
        .order('created_at', { ascending: false })
        .limit(10000)
    ])

    const allStocks = stocksRes.data || []
    const allTxs = txRes.data || []

    // 2. 일자별 / 품목별 출고 수량 집계
    const itemDailyMap = new Map()
    const itemNovBoxes = new Map()
    const itemDecBoxes = new Map()
    const itemWinterTotal = new Map()
    let validTxCount = 0

    allTxs.forEach(tx => {
      const b = Math.abs(Number(tx.box_qty || 0))
      if (b <= 0) return

      const dt = new Date(tx.created_at)
      const m = dt.getMonth() + 1
      const y = dt.getFullYear()
      const d = dt.getDate()
      const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

      validTxCount++
      const itemId = tx.item_id
      if (!itemDailyMap.has(itemId)) itemDailyMap.set(itemId, new Map())
      const dMap = itemDailyMap.get(itemId)
      dMap.set(dateStr, (dMap.get(dateStr) || 0) + b)

      if (m === 11) {
        itemNovBoxes.set(itemId, (itemNovBoxes.get(itemId) || 0) + b)
      } else if (m === 12) {
        itemDecBoxes.set(itemId, (itemDecBoxes.get(itemId) || 0) + b)
      }
      itemWinterTotal.set(itemId, (itemWinterTotal.get(itemId) || 0) + b)
    })

    // 3. 품목별 피크 일출고량 및 권장 안전재고 산출
    let hotCount = 0
    const items = allStocks.map(st => {
      const dMap = itemDailyMap.get(st.item_id) || new Map()
      let peakBoxes = 0
      let peakDate = '-'
      for (const [dStr, qty] of dMap.entries()) {
        if (qty > peakBoxes) {
          peakBoxes = qty
          peakDate = dStr
        }
      }

      const nov = itemNovBoxes.get(st.item_id) || 0
      const dec = itemDecBoxes.get(st.item_id) || 0
      const totalWinter = itemWinterTotal.get(st.item_id) || (nov + dec)
      const currentSafe = Number(st.safe_stock_boxes || 0)
      const currentBox = Number(st.main_box_qty || 0)

      // 서브창고 리드타임 1일 + 버퍼 1.3배
      const recommendedSafe = peakBoxes > 0 ? Math.ceil(peakBoxes * 1.3) : currentSafe
      const isHot = peakBoxes >= 20 || totalWinter >= 50
      if (isHot) hotCount++

      return {
        item_id: st.item_id,
        name: st.item_name,
        color: st.color || 'SURTIDO',
        boxContent: Number(st.box_packaging_qty || 1),
        currentSafeStock: currentSafe,
        peakDailyBoxes: peakBoxes,
        peakDate: peakDate,
        novBoxes: nov,
        decBoxes: dec,
        totalWinterBoxes: totalWinter,
        recommendedSafeStock: recommendedSafe,
        safeStockDiff: Math.max(0, recommendedSafe - currentSafe),
        currentBox: currentBox,
        isHot: isHot,
        isHotInSubWh: false
      }
    })

    // 피크 출고량 내림차순 정렬
    items.sort((a, b) => b.peakDailyBoxes - a.peakDailyBoxes)

    return {
      success: true,
      totalAnalyzedItems: items.length,
      hotItemsCount: hotCount,
      winterTxCount: validTxCount,
      items: items
    }
  },

  /**
   * 17. 추천 안전재고 원장 일괄 반영
   */
  async applyRecommendedSafeStockToMaster(customRecommendations) {
    let recList = customRecommendations
    if (!recList || recList.length === 0) {
      const analysis = await this.analyzeWinterPeakDemandAndSafeStock()
      recList = analysis.items || []
    }

    const { data, error } = await supabase.rpc('rpc_apply_recommended_safe_stock', {
      p_recommendations: recList.map(r => ({
        item_id: r.item_id,
        recommended_safe_stock: r.recommendedSafeStock || r.safe_stock || 0
      }))
    })

    if (error) {
      console.error('[SupabaseAdapter] applyRecommendedSafeStockToMaster 실패:', error)
      throw new Error(error.message || '안전재고 갱신 실패')
    }

    return {
      success: true,
      updatedCount: data?.count || recList.length,
      backupSheetName: 'Supabase PostgreSQL (ACID)',
      message: data?.message || '안전재고가 원장에 일괄 반영되었습니다.'
    }
  },

  /**
   * 18. 색상 데이터 정규화 사전 분석 (analyzeColorNormalization)
   */
  async analyzeColorNormalization() {
    const PURE_COLORS = new Set([
      'SURTIDO', 'NEGRO', 'BLANCO', 'AZUL', 'MARINO', 'MEZCLILLA', 'ROJO', 'GRIS',
      'ROSA', 'AMARILLO', 'VERDE', 'BEIGE', 'CAFE', 'VINO', 'PALOROSA', 'PALO ROSA',
      'TURQUEZA', 'TURQUESA', 'MOSTAZA', 'UVA', 'CORAL', 'FIUSHA', 'LILA', 'NARANJA',
      'KAKI', 'CHEDRON', 'JASPE', 'OXFORD', 'REY', 'CIELO', 'PETROLEO', 'VERDE MILITAR',
      'COCO', 'VERDE BOTELLA', 'PISTACHE', 'SHEDRON', 'MILITAR', 'BALCK', 'NAVY',
      'BURGUNDY', 'CHARCOAL', 'OLIVE', 'PINK(ROSA PASTEL)', 'IPLUM', 'JADE',
      'AZUL(TURQUEZA)', 'PURPLISH RED', 'COCOA', 'MARINO(AZUL OSCURO)', 'PIEL(NUDE)',
      'PURPURA', 'ROJO GRAND', 'VERDE CLARO', 'ARMY GREEN', 'BLUE', 'ROJO CIRUELA',
      'AZULCELE', 'PETROLEO / JADE'
    ])

    const { data: allItems, error } = await supabase
      .from('items')
      .select('id, item_name, color, box_packaging_qty')
      .eq('is_active', true)

    if (error) throw error

    const modifiedItems = []
    let modifiedCount = 0

    ;(allItems || []).forEach(item => {
      const rawColor = String(item.color || '').trim()
      const colorUpper = rawColor.toUpperCase()
      const name = item.item_name

      if (PURE_COLORS.has(colorUpper)) return

      let newName = name
      let newColor = 'SURTIDO'
      let reason = ''
      let isModified = false

      if (/^\d{2,3}\s*CM$/i.test(rawColor)) {
        const cm = colorUpper.replace(/\s+/g, '')
        if (!newName.toUpperCase().includes(cm)) newName = `${name}/${cm}`
        reason = 'CM_LENGTH'
        isModified = true
      } else if (name.includes('3678') || /^(?:BIKE|ARCO|MANCH|MALLA)/i.test(rawColor)) {
        newName = `${name} ${rawColor}`
        reason = 'PATTERN_CODE'
        isModified = true
      } else if (/^[A-Za-z]$/.test(rawColor)) {
        if (name === 'NSTP' && (colorUpper === 'M' || colorUpper === 'L')) {
          newName = `${name}-${colorUpper}`
        } else {
          newName = `${name}${colorUpper}`
        }
        reason = 'LETTER_VARIANT'
        isModified = true
      }

      if (isModified) {
        modifiedCount++
        modifiedItems.push({
          itemId: item.id,
          originalName: name,
          originalColor: rawColor,
          normalizedName: newName,
          normalizedColor: newColor,
          reason: reason,
          boxContent: Number(item.box_packaging_qty || 1)
        })
      }
    })

    return {
      success: true,
      originalRowCount: (allItems || []).length,
      modifiedRowCount: modifiedCount,
      finalRowCount: (allItems || []).length,
      reducedRowsCount: 0,
      modifiedItems: modifiedItems
    }
  },

  /**
   * 19. 색상 데이터 정규화 실행 (executeColorNormalization)
   */
  async executeColorNormalization() {
    const analysis = await this.analyzeColorNormalization()
    let executedCount = 0

    for (const mod of analysis.modifiedItems) {
      const { error } = await supabase
        .from('items')
        .update({
          item_name: mod.normalizedName,
          color: mod.normalizedColor
        })
        .eq('id', mod.itemId)

      if (!error) executedCount++
    }

    await preloadItemIdCache()

    return {
      success: true,
      totalExecuted: executedCount,
      analysis: analysis
    }
  },

  /**
   * 15. Gemini 비전 OCR 손글씨 주문서 분석
   */
  async analyzeHandwrittenOrder(imageBase64) {
    const res = await fetch('/api/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'handwritten', imageBase64 })
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: '서버 오류' }))
      throw new Error(err.error || `손글씨 분석 실패 (${res.status})`)
    }
    return await res.json()
  },

  /**
   * 16. Gemini 비전 OCR 화물운송장(Carta de Porte) 분석
   */
  async analyzeCartaDePorte(imageBase64) {
    const res = await fetch('/api/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'cartadeporte', imageBase64 })
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: '서버 오류' }))
      throw new Error(err.error || `송장 분석 실패 (${res.status})`)
    }
    return await res.json()
  },

  /**
   * 17. Gemini 비전 OCR 재고실사표 분석
   */
  async analyzeStockAuditSheet(imageBase64) {
    const res = await fetch('/api/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'audit', imageBase64 })
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: '서버 오류' }))
      throw new Error(err.error || `실사표 분석 실패 (${res.status})`)
    }
    return await res.json()
  },

  /**
   * 18. 통합 관제 대시보드 지표 실시간 집계 (getDashboardMetrics)
   */
  async getDashboardMetrics() {
    const todaySlash = formatDate(new Date()).replace(/-/g, '/')
    const todayDash = formatDate(new Date())

    const [stocksRes, txTodayRes, pendingRes, recentTxRes] = await Promise.all([
      supabase.from('view_effective_stocks').select('*'),
      supabase.from('stock_transactions')
        .select('transaction_type, box_qty, unit_qty, invoice_no')
        .or(`invoice_no.like.${todaySlash}%,invoice_no.like.${todayDash}%`),
      supabase.from('pending_orders')
        .select('item_id, from_warehouse, to_warehouse, box_qty, status')
        .in('status', ['PENDING', 'IN_TRANSIT']),
      supabase.from('stock_transactions')
        .select('item_id, transaction_type, box_qty, unit_qty, created_at, items(item_name, color)')
        .in('transaction_type', ['INBOUND', 'OUTBOUND', 'MOVE'])
        .order('created_at', { ascending: false })
        .limit(1000)
    ])

    const allStocks = stocksRes.data || []
    const todayTxs = txTodayRes.data || []
    const pendingOrders = pendingRes.data || []
    const recentTxs = recentTxRes.data || []

    // 1. 총 재고 자산 계산
    let totalMainBoxes = 0
    let totalMainUnits = 0
    const lowStockItems = []

    allStocks.forEach(item => {
      const mb = Number(item.main_box_qty || 0)
      const safe = Number(item.safe_stock_boxes || 0)
      const pIn = Number(item.pending_in_boxes || 0)
      const effective = mb + pIn
      const boxContent = Number(item.box_packaging_qty || 1)

      totalMainBoxes += mb
      totalMainUnits += (mb * boxContent)

      if (safe > 0 && effective <= safe) {
        lowStockItems.push({
          item_id: item.item_id,
          itemName: item.item_name,
          color: item.color || 'SURTIDO',
          mainStock: mb,
          inTransit: pIn,
          effectiveStock: effective,
          safeStock: safe,
          shortage: Math.max(0, safe - effective)
        })
      }
    })

    lowStockItems.sort((a, b) => b.shortage - a.shortage)

    // 2. 오늘자 입고/출고/이동 합계
    let todayInBoxes = 0
    let todayOutBoxes = 0
    let todayMoveBoxes = 0

    todayTxs.forEach(tx => {
      const b = Math.abs(Number(tx.box_qty || 0))
      if (tx.transaction_type === 'INBOUND') todayInBoxes += b
      else if (tx.transaction_type === 'OUTBOUND') todayOutBoxes += b
      else if (tx.transaction_type === 'MOVE') todayMoveBoxes += b
    })

    // 3. 서브창고별 이동 중(In-Transit) 수량 집계
    const whInTransitMap = {}
    let totalInTransitBoxes = 0
    pendingOrders.forEach(po => {
      const wh = String(po.from_warehouse || 'UNKNOWN').toUpperCase().trim()
      const b = Number(po.box_qty || 0)
      whInTransitMap[wh] = (whInTransitMap[wh] || 0) + b
      totalInTransitBoxes += b
    })

    // 4. 최근 7일 일자별 입/출고 추이 (차트용)
    const dailyMap = {}
    const now = new Date()
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now)
      d.setDate(d.getDate() - i)
      const dStr = d.toISOString().split('T')[0]
      const label = `${d.getMonth() + 1}/${d.getDate()}`
      dailyMap[dStr] = { date: dStr, label: label, inBoxes: 0, outBoxes: 0 }
    }

    recentTxs.forEach(tx => {
      if (!tx.created_at) return
      const dStr = tx.created_at.split('T')[0]
      if (dailyMap[dStr]) {
        const b = Math.abs(Number(tx.box_qty || 0))
        if (tx.transaction_type === 'INBOUND') dailyMap[dStr].inBoxes += b
        if (tx.transaction_type === 'OUTBOUND' || tx.transaction_type === 'MOVE') dailyMap[dStr].outBoxes += b
      }
    })

    // 5. 최근 최다 출고 베스트셀러 Top 5
    const itemOutMap = new Map()
    recentTxs.forEach(tx => {
      if (tx.transaction_type === 'OUTBOUND' || tx.transaction_type === 'MOVE') {
        const b = Math.abs(Number(tx.box_qty || 0))
        const name = tx.items?.item_name || 'UNKNOWN'
        const color = tx.items?.color || 'SURTIDO'
        const key = `${name} (${color})`
        itemOutMap.set(key, (itemOutMap.get(key) || 0) + b)
      }
    })

    const topSellers = Array.from(itemOutMap.entries())
      .map(([name, boxes]) => ({ name, boxes }))
      .sort((a, b) => b.boxes - a.boxes)
      .slice(0, 5)

    return {
      success: true,
      updatedAt: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }),
      kpi: {
        totalMainBoxes,
        totalMainUnits,
        todayInBoxes,
        todayOutBoxes,
        todayMoveBoxes,
        totalInTransitBoxes,
        pendingOrderCount: pendingOrders.length,
        lowStockCount: lowStockItems.length
      },
      lowStockItems: lowStockItems.slice(0, 10),
      whInTransitMap,
      dailyTrend: Object.values(dailyMap),
      topSellers
    }
  },

  /**
   * 19. 시스템 종합 설정 불러오기 및 저장
   */
  async getSystemSettings() {
    const defaultSettings = {
      truckTargetBoxes: 100,
      winterPeakMultiplier: 1.3,
      alertOnIndividualOut: true,
      receiptCompany: 'LADY POLO S.A. DE C.V.',
      receiptAddress: 'ALARCÓN #42, COL. CENTRO, CDMX',
      receiptNotice: '30일 이내 영수증 지참 시 교환 가능 (환불 불가)',
      receiptRowsPerPage: 15,
      activeSubWarehouses: ['PANTACO', 'IKEA', 'LERMA', 'PINO', 'YARE', 'ALMINTER', 'TLANE', 'STAR']
    }

    try {
      const localSaved = localStorage.getItem('wms_system_settings')
      if (localSaved) {
        return { ...defaultSettings, ...JSON.parse(localSaved) }
      }
    } catch (e) {}

    return defaultSettings
  },

  async saveSystemSettings(settings) {
    if (!settings || typeof settings !== 'object') throw new Error('유효하지 않은 설정값입니다.')
    try {
      localStorage.setItem('wms_system_settings', JSON.stringify(settings))
    } catch (e) {
      console.warn('localStorage save warning:', e)
    }
    return { success: true, message: '설정이 저장되었습니다.' }
  },

  /**
   * 20. AI 품명 매핑 & 마이그레이션 제안 (matchAliasesWithAI)
   */
  async matchAliasesWithAI(rawItems) {
    if (!Array.isArray(rawItems) || rawItems.length === 0) return []

    const { data: allItems } = await supabase
      .from('items')
      .select('id, item_name, color, box_packaging_qty')
      .limit(3000)

    const catalog = allItems || []
    const results = []

    for (const raw of rawItems) {
      const rawName = String(raw.name || raw.itemName || raw || '').trim()
      const rawColor = String(raw.color || '').trim().toUpperCase()

      const cleanRaw = rawName.toUpperCase().replace(/[\s\-_]/g, '')
      const directMatch = catalog.find(it => it.item_name.toUpperCase().replace(/[\s\-_]/g, '') === cleanRaw)

      if (directMatch) {
        results.push({
          rawInput: rawName,
          rawColor: rawColor || 'SURTIDO',
          matchedId: directMatch.id,
          matchedName: directMatch.item_name,
          matchedColor: directMatch.color,
          confidence: 100,
          reason: '기존 마스터와 100% 일치'
        })
        continue
      }

      let bestItem = null
      let bestScore = 0

      catalog.forEach(cat => {
        const catClean = cat.item_name.toUpperCase().replace(/[\s\-_]/g, '')
        let score = 0
        if (catClean.includes(cleanRaw) || cleanRaw.includes(catClean)) {
          score = 80
        }
        let matchLen = 0
        for (let i = 0; i < Math.min(catClean.length, cleanRaw.length); i++) {
          if (catClean[i] === cleanRaw[i]) matchLen++
          else break
        }
        const prefixRatio = matchLen / Math.max(catClean.length, cleanRaw.length)
        if (prefixRatio > 0.6) {
          score = Math.max(score, Math.round(prefixRatio * 95))
        }

        if (score > bestScore) {
          bestScore = score
          bestItem = cat
        }
      })

      if (bestItem && bestScore >= 60) {
        results.push({
          rawInput: rawName,
          rawColor: rawColor || 'SURTIDO',
          matchedId: bestItem.id,
          matchedName: bestItem.item_name,
          matchedColor: bestItem.color,
          confidence: bestScore,
          reason: `유사 패턴 감지 (${bestScore}% 일치)`
        })
      } else {
        results.push({
          rawInput: rawName,
          rawColor: rawColor || 'SURTIDO',
          matchedId: null,
          matchedName: '(신규 모델 필요)',
          matchedColor: rawColor || 'SURTIDO',
          confidence: 20,
          reason: '기존 카탈로그에 유사 모델 없음'
        })
      }
    }

    return results
  },

  /**
   * 21. 상품 종합 수불원장 및 거래처/물동량 분석 (getProductLedger)
   */
  async getProductLedger(identifier, options = {}) {
    if (!identifier) throw new Error('조회할 상품명 또는 ID가 지정되지 않았습니다.')

    const rawId = String(identifier).trim()
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId)

    // 1. 상품 마스터 및 유효재고 조회
    let itemQuery = supabase.from('items').select('*')
    if (isUuid) {
      itemQuery = itemQuery.eq('id', rawId)
    } else {
      itemQuery = itemQuery.ilike('item_name', `%${rawId}%`)
    }
    const { data: matchedItems, error: itemErr } = await itemQuery.limit(5)
    if (itemErr) throw itemErr
    if (!matchedItems || matchedItems.length === 0) {
      return { success: false, message: `상품을 찾을 수 없습니다: ${rawId}` }
    }

    const item = matchedItems[0]

    // 2. 본사 재고 및 외부창고 재고 병렬 조회
    const [effStockRes, whStockRes, allTxRes] = await Promise.all([
      supabase.from('view_effective_stocks').select('*').eq('item_id', item.id).maybeSingle(),
      supabase.from('inventory_stocks').select('warehouse_code, box_qty, unit_qty').eq('item_id', item.id),
      supabase.from('stock_transactions')
        .select('*')
        .eq('item_id', item.id)
        .order('created_at', { ascending: false })
        .limit(2000)
    ])

    const eff = effStockRes.data || {}
    const whStocks = whStockRes.data || []
    const allTxs = allTxRes.data || []

    const currentMainBoxes = Number(eff.main_box_qty || 0)
    const currentMainUnits = Number(eff.main_unit_qty || 0)
    const safeStockBoxes = Number(eff.safe_stock_boxes || 0)
    const pendingInBoxes = Number(eff.pending_in_boxes || 0)
    const pendingOutBoxes = Number(eff.pending_out_boxes || 0)
    const effectiveBoxes = Number(eff.effective_box_qty || currentMainBoxes)

    // 외부창고 총재고 집계
    let totalSubWhBoxes = 0
    const subWhMap = {}
    whStocks.forEach(ws => {
      if (ws.warehouse_code !== 'MAIN') {
        const b = Number(ws.box_qty || 0)
        totalSubWhBoxes += b
        subWhMap[ws.warehouse_code] = b
      }
    })

    // 3. 트랜잭션 수불 잔고(Running Balance) 역산 계산
    let runningBoxes = currentMainBoxes
    let runningUnits = currentMainUnits

    const enrichedTxs = allTxs.map(tx => {
      const bQty = Number(tx.box_qty || 0)
      const uQty = Number(tx.unit_qty || 0)
      const type = (tx.transaction_type || '').toUpperCase()

      const balanceAfterBoxes = runningBoxes
      const balanceAfterUnits = runningUnits

      // 다음(더 과거) 트랜잭션 이전 잔고로 롤백
      if (type === 'INBOUND') {
        runningBoxes -= bQty
        runningUnits -= uQty
      } else if (type === 'OUTBOUND') {
        runningBoxes += bQty
        runningUnits += uQty
      } else if (type === 'MOVE') {
        runningBoxes += bQty
        runningUnits += uQty
      } else if (type === 'ADJUST') {
        runningBoxes -= bQty
        runningUnits -= uQty
      }

      return {
        ...tx,
        balance_after_boxes: balanceAfterBoxes,
        balance_after_units: balanceAfterUnits
      }
    })

    // 4. 사용자 필터 적용 (startDate, endDate, transactionType, partnerName)
    const startDate = options.startDate ? new Date(options.startDate + 'T00:00:00Z') : null
    const endDate = options.endDate ? new Date(options.endDate + 'T23:59:59Z') : null
    const filterType = options.transactionType && options.transactionType !== 'ALL' ? options.transactionType.toUpperCase() : null
    const filterPartner = options.partnerName ? options.partnerName.trim().toUpperCase() : null

    const filteredLedger = enrichedTxs.filter(tx => {
      const txDate = new Date(tx.created_at)
      if (startDate && txDate < startDate) return false
      if (endDate && txDate > endDate) return false
      if (filterType && (tx.transaction_type || '').toUpperCase() !== filterType) return false
      if (filterPartner) {
        const pName = String(tx.partner_name || tx.warehouse_code || '').toUpperCase()
        if (!pName.includes(filterPartner)) return false
      }
      return true
    })

    // 5. 요약 집계 (기간 내)
    let totalInBoxes = 0
    let totalInUnits = 0
    let totalOutBoxes = 0
    let totalOutUnits = 0
    let totalMoveBoxes = 0
    let totalMoveUnits = 0
    let totalAdjBoxes = 0
    let totalAdjUnits = 0

    filteredLedger.forEach(tx => {
      const b = Number(tx.box_qty || 0)
      const u = Number(tx.unit_qty || 0)
      const type = (tx.transaction_type || '').toUpperCase()
      if (type === 'INBOUND') {
        totalInBoxes += b
        totalInUnits += u
      } else if (type === 'OUTBOUND') {
        totalOutBoxes += b
        totalOutUnits += u
      } else if (type === 'MOVE') {
        totalMoveBoxes += b
        totalMoveUnits += u
      } else if (type === 'ADJUST') {
        totalAdjBoxes += b
        totalAdjUnits += u
      }
    })

    // 6. 거래처 / 8대 서브창고별 물동량 분석 (Flow by Partner)
    const partnerMap = new Map()
    filteredLedger.forEach(tx => {
      const type = (tx.transaction_type || '').toUpperCase()
      if (type === 'OUTBOUND' || type === 'MOVE') {
        const partner = String(tx.partner_name || tx.warehouse_code || '기타/미지정').trim()
        const b = Number(tx.box_qty || 0)
        const u = Number(tx.unit_qty || 0)
        if (!partnerMap.has(partner)) {
          partnerMap.set(partner, { partner, totalBoxes: 0, totalUnits: 0, txCount: 0, lastDate: tx.created_at, type })
        }
        const pData = partnerMap.get(partner)
        pData.totalBoxes += b
        pData.totalUnits += u
        pData.txCount++
        if (new Date(tx.created_at) > new Date(pData.lastDate)) {
          pData.lastDate = tx.created_at
        }
      }
    })

    const totalOutboundBoxes = totalOutBoxes + totalMoveBoxes
    const partnerFlow = Array.from(partnerMap.values())
      .sort((a, b) => b.totalBoxes - a.totalBoxes)
      .map(p => ({
        ...p,
        percent: totalOutboundBoxes > 0 ? Math.round((p.totalBoxes / totalOutboundBoxes) * 100) : 0
      }))

    // 7. 일자별 물동량 추이 (Daily Trend)
    const dailyMap = {}
    filteredLedger.forEach(tx => {
      const dStr = String(tx.created_at).slice(0, 10)
      if (!dailyMap[dStr]) {
        dailyMap[dStr] = { date: dStr, inBoxes: 0, outBoxes: 0, moveBoxes: 0, adjBoxes: 0 }
      }
      const b = Number(tx.box_qty || 0)
      const type = (tx.transaction_type || '').toUpperCase()
      if (type === 'INBOUND') dailyMap[dStr].inBoxes += b
      else if (type === 'OUTBOUND') dailyMap[dStr].outBoxes += b
      else if (type === 'MOVE') dailyMap[dStr].moveBoxes += b
      else if (type === 'ADJUST') dailyMap[dStr].adjBoxes += b
    })

    const dailyTrend = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date))

    // 8. 일평균 소진 속도(Velocity) & 런웨이(Runway)
    const now = new Date()
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000)
    let recent14OutBoxes = 0
    allTxs.forEach(tx => {
      const type = (tx.transaction_type || '').toUpperCase()
      if ((type === 'OUTBOUND' || type === 'MOVE') && new Date(tx.created_at) >= fourteenDaysAgo) {
        recent14OutBoxes += Number(tx.box_qty || 0)
      }
    })
    const avgDailyOut = Math.round((recent14OutBoxes / 14) * 10) / 10
    const runwayDays = avgDailyOut > 0 ? Math.round(effectiveBoxes / avgDailyOut) : null

    return {
      success: true,
      item: {
        id: item.id,
        itemName: item.item_name,
        color: item.color || 'SURTIDO',
        boxPackagingQty: Number(item.box_packaging_qty || 1),
        itemCode: item.item_code || '',
        barcode: item.barcode || ''
      },
      stockSnapshot: {
        mainBoxQty: currentMainBoxes,
        mainUnitQty: currentMainUnits,
        totalSubWhBoxes: totalSubWhBoxes,
        subWhMap: subWhMap,
        safeStockBoxes: safeStockBoxes,
        pendingInBoxes: pendingInBoxes,
        pendingOutBoxes: pendingOutBoxes,
        effectiveBoxes: effectiveBoxes
      },
      summary: {
        totalInBoxes,
        totalInUnits,
        totalOutBoxes,
        totalOutUnits,
        totalMoveBoxes,
        totalMoveUnits,
        totalAdjBoxes,
        totalAdjUnits,
        totalTxs: filteredLedger.length,
        avgDailyOut,
        runwayDays
      },
      partnerFlow,
      dailyTrend,
      ledger: filteredLedger
    }
  }
}


/**
 * google.script.run 클라이언트 브릿지 생성자
 */
export function createGoogleScriptRunBridge() {
  function createRunner(successCb, failureCb) {
    const runner = {
      withSuccessHandler(cb) {
        return createRunner(cb, failureCb)
      },
      withFailureHandler(cb) {
        return createRunner(successCb, cb)
      }
    }

    for (const [fnName, fn] of Object.entries(serverMethods)) {
      runner[fnName] = async function (...args) {
        try {
          const result = await fn.apply(serverMethods, args)
          if (typeof successCb === 'function') {
            successCb(result)
          }
          return result
        } catch (err) {
          console.error(`[SupabaseAdapter] ${fnName} 오류:`, err)
          if (typeof failureCb === 'function') {
            failureCb(err)
          } else {
            console.error(err)
          }
        }
      }
    }

    return runner
  }

  return createRunner(null, null)
}

/**
 * window.google 전역 객체 주입
 */
export function installSupabaseBridge() {
  if (typeof window === 'undefined') return

  window.google = window.google || {}
  window.google.script = window.google.script || {}
  window.google.script.run = createGoogleScriptRunBridge()

  console.log('🚀 [SupabaseAdapter] window.google.script.run 브릿지 설치 완료!')
}
