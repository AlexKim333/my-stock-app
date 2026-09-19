// src/lib/supabaseAdapter.js
// google.script.run 호환 초고속 Supabase 어댑터 (sub-50ms)
import { supabase, readWmsSessionToken } from './supabase.js'

// 품목 ID 캐시 (item_name_color_pkg -> item_id). 활성 품목만 담는다.
let itemIdCache = new Map()

// 전표 수정 동시성: 검색 시점의 전표 지문 (key: `${txType}|${정규화 전표번호}`)
const invoiceSignatures = new Map()

/**
 * PostgREST 기본 1000행 한도를 넘어 전건 조회.
 * range 페이징은 정렬이 고정되지 않으면 페이지 사이에 행이 중복·누락될 수 있으므로
 * 유일 키(orderBy)로 항상 정렬한다. 뷰처럼 id가 없는 대상은 orderBy를 지정한다.
 */
async function fetchAllRows(buildQuery, { orderBy = 'id', pageSize = 1000 } = {}) {
  const all = []
  let from = 0
  for (;;) {
    const { data, error } = await buildQuery()
      .order(orderBy, { ascending: true })
      .range(from, from + pageSize - 1)
    if (error) throw error
    const rows = data || []
    all.push(...rows)
    if (rows.length < pageSize) break
    from += pageSize
  }
  return all
}

function assertNoError(error, context) {
  if (error) {
    throw new Error(`${context}: ${error.message || error}`)
  }
}

export async function preloadItemIdCache() {
  try {
    const all = await fetchAllRows(() =>
      supabase.from('items').select('id, item_name, color, box_packaging_qty').eq('is_active', true)
    )
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

/** OCR 서버리스 함수 호출 (로그인 세션 토큰으로 인증) */
async function postOcr(type, imageBase64, label) {
  const res = await fetch('/api/ocr', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-wms-session': readWmsSessionToken()
    },
    body: JSON.stringify({ type, imageBase64 })
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: '서버 오류' }))
    const e = new Error(err.error || `${label} 실패 (${res.status})`)
    if (res.status === 401) notifySessionExpired(e)
    throw e
  }
  return await res.json()
}

function formatDate(d) {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}/${month}/${day}`
}

const IDEM_TTL_MS = 15 * 60 * 1000

export function takeIdempotencyKey(scope, fingerprint) {
  const storageKey = `wms_idem_${scope}`
  try {
    const raw = sessionStorage.getItem(storageKey)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed.fingerprint === fingerprint && parsed.key && (Date.now() - parsed.ts) < IDEM_TTL_MS) {
        return parsed.key
      }
    }
  } catch {}
  const key = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  try {
    sessionStorage.setItem(storageKey, JSON.stringify({ key, fingerprint, ts: Date.now() }))
  } catch {}
  return key
}

export function clearIdempotencyKey(scope) {
  try {
    sessionStorage.removeItem(`wms_idem_${scope}`)
  } catch {}
}

export function shouldKeepIdempotencyKey(err) {
  const msg = String(err?.message || err || '')
  return /timeout|network|failed to fetch|abort|fetch/i.test(msg)
}

export const SUB_WAREHOUSES = ['PANTACO', 'IKEA', 'LERMA', 'PINO', 'YARE', 'ALMINTER', 'TLANE', 'STAR']

export function resolveActiveSubWarehouses(settings) {
  const list = settings?.activeSubWarehouses
  if (Array.isArray(list) && list.length) {
    const wanted = new Set(list.map(code => String(code || '').toUpperCase().trim()).filter(Boolean))
    return SUB_WAREHOUSES.filter(code => wanted.has(code))
  }
  return [...SUB_WAREHOUSES]
}

export const BRANCH_MAP = {
  MAIN: 'MAIN', '메인허브 (알라르꼰)': 'MAIN', 메인허브: 'MAIN', 알라르꼰: 'MAIN',
  PANTACO: 'PANTACO', 판타코: 'PANTACO',
  IKEA: 'IKEA', 이케아: 'IKEA',
  LERMA: 'LERMA', 레르마: 'LERMA',
  PINO: 'PINO', 피노: 'PINO',
  YARE: 'YARE', 야레: 'YARE',
  ALMINTER: 'ALMINTER', 알민테르: 'ALMINTER',
  TLANE: 'TLANE', 틀라네: 'TLANE',
  STAR: 'STAR', 스타: 'STAR'
}

export function resolveBranchCode(partner) {
  const raw = String(partner || '').trim()
  if (!raw) return null
  const clean = raw.replace(/^🏢\s*(\[지점\]\s*)?/, '').trim()
  return BRANCH_MAP[clean.toUpperCase()]
    || BRANCH_MAP[clean]
    || BRANCH_MAP[raw.toUpperCase()]
    || BRANCH_MAP[raw]
    || SUB_WAREHOUSES.find(w => clean.toUpperCase().includes(w) || raw.toUpperCase().includes(w))
    || null
}

export function normalizeInvoiceNo(raw) {
  const s = String(raw || '').trim()
  const m = s.match(/^(\d{4})[/-](\d{2})[/-](\d{2})-(.+)$/)
  if (m) return `${m[1]}/${m[2]}/${m[3]}-${m[4]}`
  return s
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
    const { data, error } = await supabase.rpc('rpc_list_effective_stocks')
    if (error) throw error
    const all = Array.isArray(data) ? data : []
    const freshIdCache = new Map()
    const list = all.map(row => {
      const name = String(row.item_name || '').trim()
      const color = String(row.color || 'SURTIDO').trim()
      const boxContent = Number(row.box_packaging_qty || 1)
      const key = `${name}_${color}_${boxContent}`
      freshIdCache.set(key, row.item_id)

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
    // rpc_list_effective_stocks는 활성 품목 전체를 돌려주므로 캐시를 교체해도 빠지는 활성 품목이 없다.
    itemIdCache = freshIdCache
    return list
  },

  /**
   * 2. 작업자 / 관리자 명단
   */
  async getAdminList() {
    const { data, error } = await supabase
      .from('app_members_public')
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

  async login(memberName, password) {
    const rawName = String(memberName || '').trim()
    let res = await supabase.rpc('rpc_login', {
      p_member_name: rawName,
      p_password: password
    })
    if (!res.data?.success && rawName.toLowerCase() !== rawName) {
      res = await supabase.rpc('rpc_login', {
        p_member_name: rawName.toLowerCase(),
        p_password: password
      })
    }
    if (res.error) throw res.error
    return res.data
  },

  async sessionInfo() {
    const { data, error } = await supabase.rpc('rpc_session_info')
    if (error) throw error
    return data
  },

  async logout() {
    const { data, error } = await supabase.rpc('rpc_logout')
    if (error) throw error
    return data
  },

  /**
   * 3. 내부 창고 목록 (DB warehouses 마스터)
   */
  async getWarehouses() {
    const { data, error } = await supabase
      .from('warehouses')
      .select('code, name, is_hub, sort_order, truck_capacity_boxes')
      .order('sort_order', { ascending: true })

    if (error) throw error
    return data || []
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
    const txTypes = this._normalizeTxTypes(type)
    const { data, error } = await supabase.rpc('rpc_peek_next_invoice_seq', {
      p_tx_type: txTypes[0]
    })
    if (error) throw error
    return String(data || 1).padStart(3, '0')
  },

  async getMaxSequentialNumber(date, type) {
    const txTypes = this._normalizeTxTypes(type)
    let bizDate = null
    if (date) {
      const canon = normalizeInvoiceNo(`${String(date).replace(/-/g, '/')}-0`).slice(0, 10)
      bizDate = canon.replace(/\//g, '-')
    }
    const { data, error } = await supabase.rpc('rpc_peek_next_invoice_seq', {
      p_tx_type: txTypes[0],
      p_biz_date: bizDate
    })
    if (error) throw error
    return Math.max(0, Number(data || 1) - 1)
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

    const { error } = await supabase.rpc('rpc_upsert_aliases', {
      p_aliases: [{ alias, target_item_name: target }]
    })

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

    const { data, error } = await supabase.rpc('rpc_upsert_aliases', {
      p_aliases: rows
    })

    if (error) throw error
    const count = data?.count ?? rows.length
    return { success: true, count, message: `총 ${count}건의 별명이 별명사전에 영구 등록되었습니다.` }
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

      const { data: rpcRes, error: itemErr } = await supabase.rpc('rpc_register_item', {
        p_item_name: name,
        p_color: color,
        p_box_packaging_qty: boxContent,
        p_initial_boxes: initialStock,
        p_initial_units: 0,
        p_safe_stock: safeStock
      })

      if (itemErr) {
        console.error('registerProduct error:', itemErr)
        throw itemErr
      }

      const itemId = rpcRes?.id
      const key = `${name}_${color}_${boxContent}`
      if (itemId) itemIdCache.set(key, itemId)

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
    const partnerBranchCode = resolveBranchCode(partner)

    let txType = mode === 'in' ? 'INBOUND' : 'OUTBOUND'
    let effectiveTargetWarehouse = targetWh
    let pendingFromWarehouse = null

    if (mode === 'out' && partnerBranchCode && partnerBranchCode !== 'MAIN') {
      if (sourceWh === partnerBranchCode) {
        throw new Error(`출발창고(${sourceWh})와 도착지점(${partnerBranchCode})이 동일할 수 없습니다.`)
      }
      txType = 'MOVE'
      effectiveTargetWarehouse = partnerBranchCode
    } else if (mode === 'in') {
      sourceWh = firstRow.warehouse || firstRow.targetWarehouse || 'MAIN'
      if (partnerBranchCode && partnerBranchCode !== 'MAIN') {
        pendingFromWarehouse = partnerBranchCode
        if (sourceWh === partnerBranchCode) {
          sourceWh = 'MAIN'
        }
      }
    }

    const itemsPayload = []
    const updatedItems = []
    const unresolved = []

    for (const record of tableData) {
      const name = String(record.itemName || '').trim()
      const color = String(record.color || 'SURTIDO').trim()
      const boxContent = Number(record.boxContent || 1)
      const key = `${name}_${color}_${boxContent}`
      const row = {
        name,
        color,
        boxContent,
        key,
        boxQty: Math.abs(Number(record.boxQty || 0)),
        unitQty: Math.abs(Number(record.individualQty || 0)),
        itemId: itemIdCache.get(key) || null
      }
      if (row.itemId) {
        itemsPayload.push({ item_id: row.itemId, box_qty: row.boxQty, unit_qty: row.unitQty })
        updatedItems.push({ name, color, boxContent, key })
      } else {
        unresolved.push(row)
      }
    }

    if (unresolved.length > 0) {
      const names = [...new Set(unresolved.map(r => r.name))]
      const { data: foundRows, error: findErr } = await supabase
        .from('items')
        .select('id, item_name, color, box_packaging_qty')
        .in('item_name', names)
        .eq('is_active', true)
      if (findErr) throw findErr

      const foundMap = new Map()
      ;(foundRows || []).forEach(it => {
        foundMap.set(`${String(it.item_name).trim()}_${String(it.color || 'SURTIDO').trim()}_${Number(it.box_packaging_qty || 1)}`, it.id)
      })

      const stillMissing = []
      for (const row of unresolved) {
        const itemId = foundMap.get(row.key)
        if (itemId) {
          itemIdCache.set(row.key, itemId)
          itemsPayload.push({ item_id: itemId, box_qty: row.boxQty, unit_qty: row.unitQty })
          updatedItems.push({ name: row.name, color: row.color, boxContent: row.boxContent, key: row.key })
        } else {
          stillMissing.push(row)
        }
      }

      if (stillMissing.length > 0) {
        if (mode !== 'in') {
          const first = stillMissing[0]
          throw new Error(`등록되지 않은 상품입니다: ${first.name} (${first.color})`)
        }
        const { data: ensured, error: ensureErr } = await supabase.rpc('rpc_ensure_items', {
          p_items: stillMissing.map(r => ({
            item_name: r.name,
            color: r.color,
            box_packaging_qty: r.boxContent
          }))
        })
        if (ensureErr) throw ensureErr
        const ensuredMap = new Map()
        ;(ensured || []).forEach(it => {
          const k = `${String(it.item_name).trim()}_${String(it.color || 'SURTIDO').trim()}_${Number(it.box_packaging_qty || 1)}`
          ensuredMap.set(k, it.item_id)
        })
        for (const row of stillMissing) {
          const itemId = ensuredMap.get(row.key)
          if (!itemId) {
            throw new Error(`등록되지 않은 상품입니다: ${row.name} (${row.color})`)
          }
          itemIdCache.set(row.key, itemId)
          itemsPayload.push({ item_id: itemId, box_qty: row.boxQty, unit_qty: row.unitQty })
          updatedItems.push({ name: row.name, color: row.color, boxContent: row.boxContent, key: row.key })
        }
      }
    }

    const fingerprint = JSON.stringify({
      txType, sourceWh, partner, itemsPayload, effectiveTargetWarehouse, pendingFromWarehouse
    })
    const idemKey = takeIdempotencyKey('process_transaction', fingerprint)

    let rpcResult
    try {
      const { data, error: rpcErr } = await supabase.rpc('rpc_process_transaction', {
        p_tx_type: txType,
        p_warehouse: sourceWh,
        p_partner: partner,
        p_handler: handler,
        p_invoice: '',
        p_memo: txType === 'MOVE'
          ? `[지점간이동] ${sourceWh} ➔ ${effectiveTargetWarehouse}`
          : `${mode === 'in' ? '입고' : '출고'} 웹앱 처리 (${sourceWh})`,
        p_items: itemsPayload,
        p_target_warehouse: effectiveTargetWarehouse,
        p_pending_from_warehouse: pendingFromWarehouse,
        p_idempotency_key: idemKey
      })

      if (rpcErr) {
        console.error('rpc_process_transaction 실패:', rpcErr)
        throw new Error(rpcErr.message || '재고 트랜잭션 처리 실패')
      }
      rpcResult = data
      clearIdempotencyKey('process_transaction')
    } catch (err) {
      if (!shouldKeepIdempotencyKey(err)) clearIdempotencyKey('process_transaction')
      throw err
    }

    const invoiceNumber = rpcResult?.invoice_no || ''
    const seq = invoiceNumber.includes('-') ? invoiceNumber.split('-').pop() : ''

    // 화면 재고 캐시는 MAIN 기준이므로 출발창고와 무관하게 방금 커밋된 MAIN 재고를 다시 읽는다.
    // 재조회에 실패하면 추정값(0)을 내보내지 않고 빈 목록을 돌려 화면이 전체 재동기화하도록 한다.
    const itemIds = itemsPayload.map(i => i.item_id)
    const { data: freshStocks, error: freshErr } = await supabase
      .from('inventory_stocks')
      .select('item_id, box_qty, unit_qty')
      .in('item_id', itemIds)
      .eq('warehouse_code', 'MAIN')
    if (freshErr) console.warn('[SupabaseAdapter] 처리 후 재고 재조회 실패:', freshErr)

    const stockMap = new Map((freshStocks || []).map(s => [s.item_id, s]))
    const authoritativeItems = freshErr ? [] : updatedItems.map((up, idx) => {
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
      txType: rpcResult?.tx_type || txType,
      sourceWarehouse: sourceWh,
      targetWarehouse: effectiveTargetWarehouse,
      partner: partner,
      updatedItems: authoritativeItems,
      stockVerified: !freshErr,
      integrity: {
        checkedCount: itemsPayload.length,
        discrepancyCount: 0,
        isClean: !freshErr
      }
    }
  },

  /**
   * 11. 퀵 재고 조정 (processQuickStockAdjustment)
   */
  async processQuickStockAdjustment(adjustments, admin) {
    if (!adjustments || adjustments.length === 0) return { success: true }
    const handler = String(admin || 'ADMIN').trim()
    const payload = []

    for (const adj of adjustments) {
      const name = String(adj.itemName || '').trim()
      const color = String(adj.color || 'SURTIDO').trim()
      const boxContent = Number(adj.boxContent || 1)
      const key = `${name}_${color}_${boxContent}`
      const itemId = itemIdCache.get(key)
      if (!itemId) {
        throw new Error(`등록되지 않은 상품입니다: ${name} (${color})`)
      }
      const targetBox = Number(adj.targetBoxQty ?? adj.targetBox)
      const targetUnit = Number(adj.targetIndividualQty ?? adj.targetIndividual ?? 0)
      if (!Number.isFinite(targetBox) || targetBox < 0 || !Number.isFinite(targetUnit) || targetUnit < 0) {
        throw new Error(`[${name}(${color})] 조정 수량이 올바르지 않습니다.`)
      }
      payload.push({
        item_id: itemId,
        adj_mode: 'replace',
        box_qty: targetBox,
        unit_qty: targetUnit,
        reason: adj.reason || '실사'
      })
    }

    const fingerprint = JSON.stringify({ handler, payload, kind: 'quick' })
    const idemKey = takeIdempotencyKey('adjust_stock', fingerprint)
    let data
    try {
      const res = await supabase.rpc('rpc_adjust_stock', {
        p_admin: handler,
        p_items: payload,
        p_warehouse: 'MAIN',
        p_memo: '퀵재고조정',
        p_idempotency_key: idemKey
      })
      if (res.error) throw new Error(res.error.message || '재고 조정에 실패했습니다.')
      data = res.data
      clearIdempotencyKey('adjust_stock')
    } catch (err) {
      if (!shouldKeepIdempotencyKey(err)) clearIdempotencyKey('adjust_stock')
      throw err
    }
    const { data: freshStocks, error: freshErr } = await supabase
      .from('inventory_stocks')
      .select('item_id, box_qty, unit_qty')
      .in('item_id', payload.map(p => p.item_id))
      .eq('warehouse_code', 'MAIN')
    if (freshErr) console.warn('[SupabaseAdapter] 조정 후 재고 재조회 실패:', freshErr)
    const stockMap = new Map((freshStocks || []).map(st => [st.item_id, st]))

    return {
      success: true,
      invoiceNumber: data?.invoice_no,
      message: '재고 조정이 완료되었습니다.',
      stockVerified: !freshErr,
      updatedItems: adjustments.map((adj, idx) => {
        const fresh = stockMap.get(payload[idx].item_id)
        return {
          name: String(adj.itemName || '').trim(),
          color: String(adj.color || 'SURTIDO').trim(),
          boxContent: Number(adj.boxContent || 1),
          stockBox: fresh ? Number(fresh.box_qty || 0) : payload[idx].box_qty,
          stockIndividual: fresh ? Number(fresh.unit_qty || 0) : payload[idx].unit_qty
        }
      })
    }
  },

  /**
   * 12. 전표 검색 및 수정 (SearchModify 연동)
   */
  async searchRecords(type, invoiceNumber) {
    const rawInv = String(invoiceNumber || '').trim()
    const canonical = normalizeInvoiceNo(rawInv)
    const dashInv = canonical.replace(/\//g, '-')
    const txTypes = this._normalizeTxTypes(type)

    const sigRes = await supabase.rpc('rpc_invoice_signature', { p_invoice_no: canonical, p_tx_type: txTypes[0] })
    if (sigRes.error) {
      console.warn('[SupabaseAdapter] 전표 지문 조회 실패 (동시 수정 검사 없이 진행):', sigRes.error)
      invoiceSignatures.delete(`${txTypes[0]}|${canonical}`)
    } else {
      invoiceSignatures.set(`${txTypes[0]}|${canonical}`, sigRes.data)
    }

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
      .in('invoice_no', [...new Set([canonical, rawInv, dashInv])])
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
    const targetInv = normalizeInvoiceNo(invoiceNumber)

    // 재고조정 전표는 부호 있는 증감(Δ)을 그대로 보낸다. 입·출고는 절대값.
    const toQty = v => {
      const n = Number(v || 0)
      return txType === 'ADJUST' ? Math.trunc(n) : Math.abs(n)
    }

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
            .eq('is_active', true)
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
        box_qty: toQty(rec.boxQty ?? rec.box_qty),
        unit_qty: toQty(rec.individualQty ?? rec.unit_qty),
        partner_name: String(rec.location || rec.partner_name || '').trim()
      })
    }

    // 2. 원자적 롤백 & 재반영 RPC 실행
    const sigKey = `${txType}|${targetInv}`
    const { data, error } = await supabase.rpc('rpc_update_transaction_records', {
      p_invoice_no: targetInv,
      p_tx_type: txType,
      p_new_records: payloadRecords,
      p_admin: admin || 'ADMIN',
      p_expected_signature: invoiceSignatures.get(sigKey) || null
    })

    if (error) {
      console.error('[SupabaseAdapter] updatePendingRecords 실패:', error)
      throw new Error(error.message || '전표 수정에 실패했습니다.')
    }

    // 같은 화면에서 이어서 다시 수정할 수 있도록 방금 저장한 상태의 지문으로 갱신
    const newSig = await supabase.rpc('rpc_invoice_signature', { p_invoice_no: targetInv, p_tx_type: txType })
    if (newSig.error) invoiceSignatures.delete(sigKey)
    else invoiceSignatures.set(sigKey, newSig.data)

    return data || { success: true, message: '전표가 성공적으로 수정되었습니다.' }
  },

  /**
   * 13. 재고조사 일괄 처리 (processStockAdjustmentForm) - 실사 치환/추가 & 인라인 정합성 검증
   */
  async processStockAdjustmentForm(tableData, admin) {
    if (!tableData || tableData.length === 0) {
      throw new Error('처리할 재고조사 데이터가 없습니다.')
    }

    const handler = String(admin || 'ADMIN').trim()
    const payload = []
    const updatedKeys = []

    // 조정 창고: 한 전표는 한 창고만 조정한다 (행에 창고가 없으면 MAIN)
    const warehouses = [...new Set(tableData.map(r => String(r.warehouse || 'MAIN').trim().toUpperCase() || 'MAIN'))]
    if (warehouses.length > 1) {
      throw new Error(`한 번에 한 창고만 재고조정할 수 있습니다. (섞인 창고: ${warehouses.join(', ')})`)
    }
    const warehouse = warehouses[0]

    for (const record of tableData) {
      const name = String(record.itemName || '').trim()
      const color = String(record.color || 'SURTIDO').trim()
      const boxContent = Number(record.boxContent || 1)
      const key = `${name}_${color}_${boxContent}`

      let itemId = itemIdCache.get(key)
      if (!itemId) {
        const { data: found, error: findErr } = await supabase
          .from('items')
          .select('id')
          .eq('item_name', name)
          .eq('color', color)
          .eq('box_packaging_qty', boxContent)
          .eq('is_active', true)
          .maybeSingle()
        if (findErr) throw findErr
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

      payload.push({
        item_id: itemId,
        adj_mode: adjType,
        box_qty: inputBox,
        unit_qty: inputIndiv,
        reason: '재고조사'
      })
      updatedKeys.push({ key, name, color, boxContent, adjType, itemId })
    }

    const fingerprint = JSON.stringify({ handler, payload, warehouse, kind: 'audit' })
    const idemKey = takeIdempotencyKey('adjust_stock', fingerprint)
    let data
    try {
      const res = await supabase.rpc('rpc_adjust_stock', {
        p_admin: handler,
        p_items: payload,
        p_warehouse: warehouse,
        p_idempotency_key: idemKey
      })
      if (res.error) throw new Error(res.error.message || '재고조사 처리에 실패했습니다.')
      data = res.data
      clearIdempotencyKey('adjust_stock')
    } catch (err) {
      if (!shouldKeepIdempotencyKey(err)) clearIdempotencyKey('adjust_stock')
      throw err
    }

    const itemIds = payload.map(p => p.item_id)
    const { data: freshStocks, error: freshErr } = await supabase
      .from('inventory_stocks')
      .select('item_id, box_qty, unit_qty')
      .in('item_id', itemIds)
      .eq('warehouse_code', warehouse)
    if (freshErr) console.warn('[SupabaseAdapter] 재고조사 후 재고 재조회 실패:', freshErr)
    const stockMap = new Map((freshStocks || []).map(s => [s.item_id, s]))

    return {
      success: true,
      invoiceNumber: data?.invoice_no || '',
      warehouse,
      adjustedCount: tableData.length,
      updatedItems: updatedKeys.map(up => {
        const fresh = stockMap.get(up.itemId)
        return {
          ...up,
          box: fresh ? Number(fresh.box_qty || 0) : 0,
          individual: fresh ? Number(fresh.unit_qty || 0) : 0
        }
      }),
      integrity: {
        checkedCount: updatedKeys.length,
        discrepancyCount: 0,
        isClean: true
      }
    }
  },

  /**
   * 13-1. 특정 창고의 품목별 실재고 (재고조정 화면의 현재고/예상 표시용)
   * 반환 key는 getStockData와 같은 `품명_컬러_박스당수량` 형식
   */
  async getWarehouseStockList(warehouse) {
    const wh = String(warehouse || 'MAIN').trim().toUpperCase() || 'MAIN'
    const rows = await fetchAllRows(() =>
      supabase
        .from('inventory_stocks')
        .select('item_id, box_qty, unit_qty, items(item_name, color, box_packaging_qty)')
        .eq('warehouse_code', wh)
    )
    return {
      warehouse: wh,
      items: rows
        .filter(r => r.items)
        .map(r => {
          const name = String(r.items.item_name || '').trim()
          const color = String(r.items.color || 'SURTIDO').trim()
          const boxContent = Number(r.items.box_packaging_qty || 1)
          return {
            key: `${name}_${color}_${boxContent}`,
            itemId: r.item_id,
            stockBox: Number(r.box_qty || 0),
            stockIndividual: Number(r.unit_qty || 0)
          }
        })
    }
  },

  /**
   * 14. 재고 정합성 자동 검사기 (전 창고 전수 대사)
   * 집계·대조는 서버(rpc_verify_stock_integrity)에서 수행한다.
   *  - 기준(기초)재고 + 기준시각 이후 거래 = 현재고 대조
   *  - 창고별 음수 재고, 유령 보류(재고보다 많은 진행 중 발주) 검사
   */
  async verifyStockIntegrity(warehouse) {
    const { data, error } = await supabase.rpc('rpc_verify_stock_integrity', {
      p_warehouse: warehouse ? String(warehouse).toUpperCase().trim() : null
    })
    if (error) throw error
    return data || { success: false, error: '검사 결과가 비어 있습니다.' }
  },

  /**
   * 14-1. 현재 재고를 정합성 검사 기준(기초재고)으로 확정 (관리자)
   * 시트 이관·수동 수정 등 거래 기록이 없는 과거분을 기준선으로 고정한다.
   */
  async setStockBaseline(warehouse, memo) {
    const { data, error } = await supabase.rpc('rpc_set_stock_baseline', {
      p_warehouse: warehouse ? String(warehouse).toUpperCase().trim() : null,
      p_memo: memo || null
    })
    if (error) throw error
    return data
  },

  /**
   * 15. 재고시트 데이터 정규화 사전 분석 (중복 코드 및 포장단위 분산 전수 분석)
   */
  async analyzeStockNormalization() {
    const allStocks = await fetchAllRows(
      () => supabase.from('view_effective_stocks').select('*'),
      { orderBy: 'item_id' }
    )
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

    const groups = (analysis.duplicateGroups || [])
      .map(group => {
        const originalItems = group.originalItems || []
        const canonicalItemId = originalItems[0]?.itemId
        return {
          canonical_item_id: canonicalItemId,
          canonical_name: group.canonicalName,
          color: group.color,
          box_packaging_qty: group.repBoxContent,
          members: originalItems.map(it => ({
            item_id: it.itemId,
            box_content: it.boxContent
          }))
        }
      })
      .filter(g => g.canonical_item_id && (g.members || []).length > 1)

    const { data, error } = await supabase.rpc('rpc_execute_stock_normalization', {
      p_groups: groups
    })
    if (error) throw error

    await preloadItemIdCache()

    return {
      success: true,
      backupSheetName: backupSheetName,
      originalRowCount: analysis.totalOriginalRows,
      finalRowCount: analysis.estimatedFinalRows,
      reducedRowsCount: analysis.reducedRowsCount,
      mergedGroups: data?.merged_groups ?? groups.length,
      mergedItems: data?.merged_items ?? analysis.reducedRowsCount,
      analysis: analysis
    }
  },

  /**
   * 14. 8대 서브창고 주문 매트릭스 조회 (PANTACO, IKEA, LERMA, PINO, YARE, ALMINTER, TLANE, STAR)
   * ⚡ In-Transit(이동 중 수량) 실시간 동적 집계 반영
   */
  async getSubWarehouseStockMatrix(forceRefresh) {
    const settings = await this.getSystemSettings()
    const whList = resolveActiveSubWarehouses(settings)

    // 1. 전체 유효 재고, 8대 서브창고 재고 및 이동 중(PENDING) 주문 병렬 조회 (sub-50ms)
    const [allMainItems, subStocks, pendingOrders] = await Promise.all([
      fetchAllRows(() => supabase.from('view_effective_stocks').select('*'), { orderBy: 'item_id' }),
      fetchAllRows(() =>
        supabase.from('inventory_stocks').select('warehouse_code, box_qty, item_id').in('warehouse_code', whList)
      ),
      fetchAllRows(() =>
        supabase.from('pending_orders').select('item_id, from_warehouse, box_qty').eq('to_warehouse', 'MAIN').in('status', ['PENDING', 'IN_TRANSIT'])
      )
    ])

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
        itemId: row.item_id,
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
        item_id: it.itemId || it.item_id || null,
        item_name: String(it.itemName || it.item_name || it.name || '').trim(),
        color: String(it.color || 'SURTIDO').trim(),
        box_content: Number(it.boxContent || it.box_packaging_qty || 0),
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
    // 1. 전체 품목 마스터 및 품목·일자별 출고 합계(서버 집계, 멕시코시티 날짜 기준) 병렬 조회
    const [allStocks, dailyRes] = await Promise.all([
      fetchAllRows(() => supabase.from('view_effective_stocks').select('*'), { orderBy: 'item_id' }),
      supabase.rpc('rpc_outbound_daily_boxes')
    ])
    if (dailyRes.error) throw dailyRes.error
    const dailyRows = dailyRes.data || []

    // 2. 일자별 / 품목별 출고 수량 집계
    const itemDailyMap = new Map()
    const itemNovBoxes = new Map()
    const itemDecBoxes = new Map()
    const itemWinterTotal = new Map()
    let validTxCount = 0

    dailyRows.forEach(row => {
      const b = Number(row.boxes || 0)
      if (b <= 0) return

      const dateStr = String(row.day)
      const m = Number(dateStr.slice(5, 7))

      validTxCount += Number(row.tx_count || 0)
      const itemId = row.item_id
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

    const allItems = await fetchAllRows(() =>
      supabase.from('items').select('id, item_name, color, box_packaging_qty').eq('is_active', true)
    )

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
    const payload = (analysis.modifiedItems || []).map(mod => ({
      item_id: mod.itemId,
      normalized_name: mod.normalizedName,
      normalized_color: mod.normalizedColor,
      box_content: mod.boxContent
    }))

    const { data, error } = await supabase.rpc('rpc_execute_color_normalization', {
      p_items: payload
    })
    if (error) throw error

    await preloadItemIdCache()

    return {
      success: true,
      totalExecuted: data?.updated ?? payload.length,
      skippedCount: data?.skipped ?? 0,
      analysis: analysis
    }
  },

  /**
   * 15. Gemini 비전 OCR 손글씨 주문서 분석
   */
  async analyzeHandwrittenOrder(imageBase64) {
    return postOcr('handwritten', imageBase64, '손글씨 분석')
  },

  /**
   * 16. Gemini 비전 OCR 화물운송장(Carta de Porte) 분석
   */
  async analyzeCartaDePorte(imageBase64) {
    return postOcr('cartadeporte', imageBase64, '송장 분석')
  },

  /**
   * 17. Gemini 비전 OCR 재고실사표 분석
   */
  async analyzeStockAuditSheet(imageBase64) {
    return postOcr('audit', imageBase64, '실사표 분석')
  },

  /**
   * 18. 통합 관제 대시보드 지표 실시간 집계 (getDashboardMetrics)
   */
  async getDashboardMetrics() {
    const todaySlash = formatDate(new Date())
    const todayDash = todaySlash.replace(/\//g, '-')

    const [allStocks, todayTxRows, pendingOrders, recentTxs] = await Promise.all([
      fetchAllRows(
        () => supabase.from('view_effective_stocks').select('item_id, item_name, color, main_box_qty, box_packaging_qty, safe_stock_boxes, pending_in_boxes'),
        { orderBy: 'item_id' }
      ),
      fetchAllRows(() =>
        supabase.from('stock_transactions')
          .select('transaction_type, box_qty, unit_qty, invoice_no')
          .or(`invoice_no.like.${todaySlash}%,invoice_no.like.${todayDash}%`)
      ),
      fetchAllRows(() =>
        supabase.from('pending_orders')
          .select('item_id, from_warehouse, to_warehouse, box_qty, status')
          .in('status', ['PENDING', 'IN_TRANSIT'])
      ),
      supabase.from('stock_transactions')
        .select('item_id, transaction_type, box_qty, unit_qty, created_at, items(item_name, color)')
        .in('transaction_type', ['INBOUND', 'OUTBOUND', 'MOVE'])
        .order('created_at', { ascending: false })
        .limit(1000)
    ])

    if (recentTxs.error) throw recentTxs.error

    const recentTxRows = recentTxs.data || []

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

    todayTxRows.forEach(tx => {
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
      const dStr = formatDate(d).replaceAll('/', '-')
      const label = `${d.getMonth() + 1}/${d.getDate()}`
      dailyMap[dStr] = { date: dStr, label: label, inBoxes: 0, outBoxes: 0 }
    }

    recentTxRows.forEach(tx => {
      if (!tx.created_at) return
      // created_at(UTC)을 라벨과 같은 로컬 날짜로 버킷팅한다.
      const dStr = formatDate(new Date(tx.created_at)).replaceAll('/', '-')
      if (dailyMap[dStr]) {
        const b = Math.abs(Number(tx.box_qty || 0))
        if (tx.transaction_type === 'INBOUND') dailyMap[dStr].inBoxes += b
        if (tx.transaction_type === 'OUTBOUND' || tx.transaction_type === 'MOVE') dailyMap[dStr].outBoxes += b
      }
    })

    // 5. 최근 최다 출고 베스트셀러 Top 5
    const itemOutMap = new Map()
    recentTxRows.forEach(tx => {
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
      const { data, error } = await supabase.rpc('rpc_get_system_settings')
      if (error) throw error
      return { ...defaultSettings, ...(data?.settings || {}) }
    } catch (e) {
      try {
        const localSaved = localStorage.getItem('wms_system_settings')
        if (localSaved) return { ...defaultSettings, ...JSON.parse(localSaved) }
      } catch {}
      return defaultSettings
    }
  },

  async saveSystemSettings(settings) {
    if (!settings || typeof settings !== 'object') throw new Error('유효하지 않은 설정값입니다.')
    const { data, error } = await supabase.rpc('rpc_save_system_settings', {
      p_settings: settings
    })
    if (error) throw error
    try {
      localStorage.setItem('wms_system_settings', JSON.stringify(data?.settings || settings))
    } catch {}
    return data || { success: true, message: '설정이 저장되었습니다.' }
  },

  async listInvoices(type, date) {
    const txTypes = this._normalizeTxTypes(type)
    const rawDate = String(date || '').trim()
    const slash = rawDate.replace(/-/g, '/')
    const dash = rawDate.replace(/\//g, '-')
    let query = supabase
      .from('stock_transactions')
      .select('invoice_no, transaction_type, partner_name, handler_name, created_at, box_qty, unit_qty')
      .in('transaction_type', txTypes)
      .order('created_at', { ascending: false })
      .limit(800)

    if (slash) {
      query = query.or(`invoice_no.like.${slash}%,invoice_no.like.${dash}%`)
    }

    const { data, error } = await query
    if (error) throw error

    const grouped = new Map()
    ;(data || []).forEach(row => {
      const key = row.invoice_no || ''
      if (!key) return
      if (!grouped.has(key)) {
        grouped.set(key, {
          invoice_no: key,
          transaction_type: row.transaction_type,
          partner_name: row.partner_name || '',
          handler_name: row.handler_name || '',
          created_at: row.created_at,
          lines: 0,
          boxes: 0
        })
      }
      const g = grouped.get(key)
      g.lines += 1
      g.boxes += Math.abs(Number(row.box_qty || 0))
    })
    return Array.from(grouped.values())
  },

  /**
   * 20. AI 품명 매핑 & 마이그레이션 제안 (matchAliasesWithAI)
   */
  async matchAliasesWithAI(rawItems) {
    if (!Array.isArray(rawItems) || rawItems.length === 0) return []

    const catalog = await fetchAllRows(() =>
      supabase.from('items').select('id, item_name, color, box_packaging_qty').eq('is_active', true)
    )
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

    if (effStockRes.error) throw effStockRes.error
    if (whStockRes.error) throw whStockRes.error
    if (allTxRes.error) throw allTxRes.error

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

    // 3. 트랜잭션 수불 잔고(Running Balance) 역산 계산 — MAIN 창고 기준, 개수 단위로 계산
    //    서브창고에서 일어난 출고·조정·이동은 MAIN 잔고를 바꾸지 않으며, 서브창고→MAIN 이동은 입고로 본다.
    const pack = Math.max(1, Math.round(Number(item.box_packaging_qty || 1)))
    const whOf = v => String(v || '').trim().toUpperCase()
    const mainDeltaUnits = tx => {
      const type = (tx.transaction_type || '').toUpperCase()
      const units = Number(tx.box_qty || 0) * pack + Number(tx.unit_qty || 0)
      const wh = whOf(tx.warehouse_code) || 'MAIN'
      const src = whOf(tx.source_warehouse) || wh
      const dst = whOf(tx.target_warehouse)
      if (type === 'INBOUND' || type === '재고추가') return (dst || wh) === 'MAIN' ? units : 0
      if (type === 'OUTBOUND') return src === 'MAIN' ? -units : 0
      if (type === 'MOVE') {
        if (src === 'MAIN' && dst !== 'MAIN') return -units
        if (dst === 'MAIN' && src !== 'MAIN') return units
        return 0
      }
      if (type === 'ADJUST') return wh === 'MAIN' ? units : 0
      return 0
    }

    let runningTotal = currentMainBoxes * pack + currentMainUnits

    const enrichedTxs = allTxs.map(tx => {
      const balanceAfterBoxes = Math.floor(runningTotal / pack)
      const balanceAfterUnits = runningTotal - balanceAfterBoxes * pack

      // 다음(더 과거) 트랜잭션 이전 잔고로 롤백
      const delta = mainDeltaUnits(tx)
      runningTotal -= delta

      return {
        ...tx,
        main_delta_units: delta,
        balance_after_boxes: balanceAfterBoxes,
        balance_after_units: balanceAfterUnits
      }
    })

    // 4. 사용자 필터 적용 (startDate, endDate, transactionType, partnerName)
    // 날짜 필터는 사용자가 보는 현지 날짜 기준 (UTC 'Z'로 자르면 멕시코 시간과 6시간 어긋난다)
    const startDate = options.startDate ? new Date(options.startDate + 'T00:00:00') : null
    const endDate = options.endDate ? new Date(options.endDate + 'T23:59:59.999') : null
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


const SESSION_ERROR_RE = /세션이 만료|로그인이 필요/

function isSessionError(err) {
  return SESSION_ERROR_RE.test(String(err?.message || err || ''))
}

/** 서버가 세션 만료를 알리면 화면이 로그인 창으로 돌아갈 수 있도록 이벤트를 보낸다. */
function notifySessionExpired(err) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('wms-session-expired', { detail: { message: String(err?.message || err || '') } }))
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
        const usesCallbacks = typeof successCb === 'function' || typeof failureCb === 'function'
        let result
        try {
          result = await fn.apply(serverMethods, args)
        } catch (err) {
          console.error(`[SupabaseAdapter] ${fnName} 오류:`, err)
          if (typeof failureCb === 'function') {
            try { failureCb(err) } catch (cbErr) { console.error(`[SupabaseAdapter] ${fnName} 실패 핸들러 오류:`, cbErr) }
          }
          if (isSessionError(err)) notifySessionExpired(err)
          // google.script.run 방식(콜백) 호출자는 반환 Promise를 기다리지 않으므로 다시 던지지 않는다.
          if (usesCallbacks) return undefined
          throw err
        }
        // 성공 핸들러의 UI 오류가 실패 핸들러로 번지지 않도록 분리한다.
        if (typeof successCb === 'function') {
          try { successCb(result) } catch (cbErr) { console.error(`[SupabaseAdapter] ${fnName} 성공 핸들러 오류:`, cbErr) }
        }
        // 재고 동기화(stockSync.js)가 쓰기 성공을 감지해 다른 화면·탭을 갱신한다.
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('wms-bridge-success', { detail: { fnName, args, result } }))
        }
        return result
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
