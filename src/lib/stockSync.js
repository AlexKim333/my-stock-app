// src/lib/stockSync.js
// 재고 변경 자동 동기화: 아래 네 가지 신호를 모아(0.5초 단위) 하나의 `wms-stock-changed` 이벤트로 알린다.
//   1) local     이 탭에서 성공한 쓰기 RPC (브릿지의 `wms-bridge-success` 이벤트)
//   2) tab       같은 브라우저의 다른 탭/창에서 성공한 쓰기 (BroadcastChannel)
//   3) realtime  다른 기기·사용자의 변경 (Supabase Realtime: stock_change_signals ← inventory_stocks, pending_orders 트리거)
//   4) resume    백그라운드에서 오래 있다 돌아왔거나 Realtime이 재연결됨 → 전체 새로고침
// 화면 코드는 window.addEventListener('wms-stock-changed', e => ...) 로 받아 필요한 부분만 다시 읽는다.
//   e.detail = { all, warehouses: string[], itemIds: string[], sources: string[] }
import { supabase } from './supabase.js'

const EVENT_NAME = 'wms-stock-changed'
const CHANNEL_NAME = 'wms-stock-sync'
const BATCH_MS = 500
const RESUME_REFRESH_MS = 60 * 1000

// 쓰기 메서드 → 영향받는 창고 ('*' = 전체)
const WRITE_METHODS = {
  processInForm: () => ['*'],
  processOutForm: () => ['*'],
  processForm: () => ['*'],
  processQuickStockAdjustment: (args, result) => [String(result?.warehouse || 'MAIN').toUpperCase()],
  processStockAdjustmentForm: (args, result) => [String(result?.warehouse || 'MAIN').toUpperCase()],
  updatePendingRecords: () => ['*'],
  submitSubWarehouseOrderDrafts: () => ['*'],
  cancelPendingInboundOrders: () => ['*'],
  adjustPendingInboundOrders: () => ['*'],
  registerProduct: () => ['MAIN'],
  executeStockNormalization: () => ['*'],
  executeColorNormalization: () => ['*'],
  applyRecommendedSafeStockToMaster: () => ['MAIN'],
  saveSystemSettings: () => ['*']
}

let pending = null

function queue(warehouses, itemIds, source) {
  if (!pending) {
    pending = { warehouses: new Set(), itemIds: new Set(), sources: new Set() }
    setTimeout(flush, BATCH_MS)
  }
  ;(warehouses || ['*']).forEach(w => pending.warehouses.add(String(w || '*').toUpperCase()))
  ;(itemIds || []).forEach(id => id && pending.itemIds.add(id))
  pending.sources.add(source)
}

function flush() {
  const batch = pending
  pending = null
  if (!batch) return
  const all = batch.warehouses.has('*')
  batch.warehouses.delete('*')
  window.dispatchEvent(new CustomEvent(EVENT_NAME, {
    detail: {
      all,
      warehouses: [...batch.warehouses],
      itemIds: [...batch.itemIds],
      sources: [...batch.sources]
    }
  }))
}

function whList(...codes) {
  const list = codes.filter(Boolean).map(c => String(c).trim().toUpperCase())
  return list.length ? list : ['*']
}

function subscribeRealtime() {
  let wasDown = false
  const channel = supabase.channel('wms-stock-changes')

  // 재고 테이블은 로그인 세션이 있어야 읽을 수 있는데 Realtime은 세션 헤더를 보낼 수 없으므로,
  // DB 트리거가 남기는 수량 없는 변경 신호(품목 id·창고 코드)를 구독하고 실제 값은 화면이 다시 읽는다.
  channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'stock_change_signals' }, payload => {
    const row = payload.new || {}
    const warehouses = Array.isArray(row.warehouses) ? row.warehouses : []
    // 발주 상태는 MAIN 유효재고(이동중)와 출발 창고 가용재고에 모두 영향
    const extra = row.source === 'pending_orders' ? ['MAIN'] : []
    queue(whList(...warehouses, ...extra), [row.item_id], 'realtime')
  })

  channel.subscribe(status => {
    window.__wmsRealtimeStatus = status
    if (status === 'SUBSCRIBED') {
      // 끊겨 있던 동안의 변경은 알림이 오지 않으므로 재연결 시 전체를 다시 읽는다.
      if (wasDown) queue(['*'], [], 'resume')
      wasDown = false
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      wasDown = true
      console.warn(`[StockSync] Realtime 상태: ${status} (재연결되면 전체 새로고침)`)
    }
  })
}

export function initStockSync() {
  if (typeof window === 'undefined' || window.__wmsStockSyncStarted) return
  window.__wmsStockSyncStarted = true

  const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL_NAME) : null
  if (bc) {
    bc.onmessage = e => queue(e.data?.warehouses, e.data?.itemIds, 'tab')
  }

  window.addEventListener('wms-bridge-success', e => {
    const { fnName, args, result } = e.detail || {}
    const resolve = WRITE_METHODS[fnName]
    if (!resolve) return
    const warehouses = resolve(args, result)
    queue(warehouses, [], 'local')
    if (bc) {
      try { bc.postMessage({ warehouses, itemIds: [] }) } catch {}
    }
  })

  let hiddenAt = 0
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = Date.now()
    } else if (hiddenAt && Date.now() - hiddenAt > RESUME_REFRESH_MS) {
      queue(['*'], [], 'resume')
    }
  })

  try {
    subscribeRealtime()
  } catch (err) {
    console.warn('[StockSync] Realtime 구독 실패 (탭 간 동기화만 사용):', err)
  }
}
