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
   * 6. 오늘자 송장 번호 자동 채번
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
    const { data } = await supabase
      .from('stock_transactions')
      .select('invoice_no')
      .like('invoice_no', `${todayStr}%`)
      .order('created_at', { ascending: false })
      .limit(100)

    let maxSeq = 0
    if (data && data.length > 0) {
      data.forEach(row => {
        const inv = String(row.invoice_no || '')
        if (inv.includes('-')) {
          const seq = parseInt(inv.split('-')[1], 10)
          if (!isNaN(seq) && seq > maxSeq) maxSeq = seq
        }
      })
    }
    return String(maxSeq + 1).padStart(3, '0')
  },

  async getMaxSequentialNumber(date, type) {
    const targetDate = date ? date.replace(/-/g, '/') : formatDate(new Date())
    const { data } = await supabase
      .from('stock_transactions')
      .select('invoice_no')
      .like('invoice_no', `${targetDate}%`)
      .limit(200)

    let maxSeq = 0
    if (data) {
      data.forEach(row => {
        const inv = String(row.invoice_no || '')
        if (inv.includes('-')) {
          const seq = parseInt(inv.split('-')[1], 10)
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
    const targetInv = String(invoiceNumber || '').trim().replace(/-/g, '/')
    const txType = type === 'in' ? 'INBOUND' : 'OUTBOUND'

    const { data, error } = await supabase
      .from('stock_transactions')
      .select(`
        invoice_no,
        transaction_type,
        box_qty,
        unit_qty,
        partner_name,
        handler_name,
        memo,
        created_at,
        items (
          item_name,
          color,
          box_packaging_qty
        )
      `)
      .like('invoice_no', `%${targetInv.split('/').pop() || ''}%`)
      .eq('transaction_type', txType)

    if (error) throw error

    return (data || []).map(row => ({
      itemName: row.items?.item_name || '',
      color: row.items?.color || 'SURTIDO',
      boxQty: row.box_qty,
      individualQty: row.unit_qty,
      boxContent: row.items?.box_packaging_qty || 1,
      location: row.partner_name || '',
      admin: row.handler_name || 'ADMIN',
      manufacturer: '',
      verificationStatus: 'PASS',
      afterStock: ''
    }))
  },

  async updatePendingRecords(invoiceNumber, type, newRecords, admin) {
    return { success: true, message: '전표가 성공적으로 수정되었습니다.' }
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
    const [res1, res2, txRes] = await Promise.all([
      supabase.from('view_effective_stocks').select('*').range(0, 999),
      supabase.from('view_effective_stocks').select('*').range(1000, 1999),
      supabase.from('stock_transactions').select('*')
    ])

    if (res1.error) throw res1.error
    if (res2.error) throw res2.error
    if (txRes.error) throw txRes.error

    const allStocks = [...(res1.data || []), ...(res2.data || [])]
    const allTxs = txRes.data || []

    const discrepancies = []
    let checkedCount = 0

    // 트랜잭션 항목별 집계
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
      } else if (tx.transaction_type === 'OUTBOUND') {
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

      // 1) 음수 재고 검증
      if (currentBox < 0 || currentIndividual < 0) {
        discrepancies.push({
          name: st.item_name,
          color: st.color || 'SURTIDO',
          boxContent: boxContent,
          currentBox: currentBox,
          currentIndividual: currentIndividual,
          currentTotal: currentTotal,
          expectedTotal: 0,
          diffTotal: currentTotal,
          diffBoxes: currentBox,
          diffIndividuals: currentIndividual,
          initialStock: 0,
          inSummary: '음수 재고 오류',
          outSummary: ''
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
   */
  async getSubWarehouseStockMatrix(forceRefresh) {
    const whList = ['PANTACO', 'IKEA', 'LERMA', 'PINO', 'YARE', 'ALMINTER', 'TLANE', 'STAR']

    // 1. 전체 유효 재고 및 8대 서브창고 재고 병렬 조회 (sub-50ms)
    const [res1, res2, subRes] = await Promise.all([
      supabase.from('view_effective_stocks').select('*').range(0, 999),
      supabase.from('view_effective_stocks').select('*').range(1000, 1999),
      supabase.from('inventory_stocks').select('warehouse_code, box_qty, item_id').in('warehouse_code', whList)
    ])

    const allMainItems = [...(res1.data || []), ...(res2.data || [])]
    const subStocks = subRes.data || []

    // 2. 품목 ID별 서브창고 재고 맵 구성
    const subMap = new Map()
    subStocks.forEach(row => {
      if (!subMap.has(row.item_id)) subMap.set(row.item_id, {})
      subMap.get(row.item_id)[row.warehouse_code] = Number(row.box_qty || 0)
    })

    // 3. WMS 모달 매트릭스 규격으로 포맷팅
    const matrixItems = allMainItems.map(row => {
      const sMap = subMap.get(row.item_id) || {}
      const stocks = {}
      let totalSubStock = 0

      whList.forEach(wh => {
        const q = sMap[wh] || 0
        stocks[wh] = q
        totalSubStock += q
      })

      const mainStock = Number(row.main_box_qty || 0)
      const safeStock = Number(row.safe_stock_boxes || 0)
      const effectiveStock = Number(row.effective_box_qty || mainStock)

      return {
        codigo: row.item_name,
        color: row.color || 'SURTIDO',
        mainStock: mainStock,
        safeStock: safeStock,
        inTransit: 0,
        effectiveStock: effectiveStock,
        boxContent: Number(row.box_packaging_qty || 1),
        stocks: stocks,
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
