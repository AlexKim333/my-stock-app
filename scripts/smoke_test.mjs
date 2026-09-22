// scripts/smoke_test.mjs
/**
 * 🔥 WMS 핵심 흐름 스모크 테스트 (입고 / 출고 / 이동 / 재고조정)
 * ---------------------------------------------------------------------------
 * npm run verify(정적 분석)와 달리, 이 스크립트는 실제 프로덕션 Supabase에
 * 로그인해서 입고 → 이동 → 이동복귀 → 출고 → 재고부족 가드 → 재고조정까지
 * 실제 RPC를 호출하고 매 단계 재고 수치를 검증한다. 로컬/스테이징 DB가 없는
 * 프로젝트라(memory: stock-app-production-db 참고) 프로덕션 자체를 상대로
 * 돈다 — 그래서 반드시:
 *   1. 전용 테스트 창고(SMOKETEST)와 전용 테스트 품목(__SMOKETEST_ITEM__)만
 *      건드린다. 실제 품목/창고에는 절대 쓰기 않는다.
 *   2. 매 실행이 재고를 정확히 0으로 되돌리는 왕복(round-trip) 구조라, 반복
 *      실행해도 상태가 누적되지 않는다(idempotent).
 *   3. 실행 전 잔여 재고가 0이 아니면 즉시 중단한다 — 이전 실행이 비정상
 *      종료해 청소가 안 된 상태일 수 있으므로, 말없이 덮어쓰지 않고 사람이
 *      보게 한다.
 *
 * npm run verify처럼 항상 자동으로 도는 게 아니라, 입출고/이동/조정 로직을
 * 건드린 뒤 수동으로 `npm run smoke`로 실행하는 것을 전제로 한다(네트워크 +
 * 실 DB 쓰기가 있어 빠르지도, 오프라인이지도 않다).
 */
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

try {
  process.loadEnvFile('.env.local')
} catch {
  // .env.local이 없으면(CI 등) 이미 설정된 process.env를 그대로 쓴다.
}

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY
const MEMBER_NAME = process.env.SMOKE_TEST_MEMBER || 'ADMIN'
const MEMBER_PASSWORD = process.env.SMOKE_TEST_PASSWORD || 'admin'

const TEST_WAREHOUSE_CODE = 'SMOKETEST'
const TEST_ITEM_NAME = '__SMOKETEST_ITEM__'
const TEST_ITEM_COLOR = 'TEST'
const TEST_ITEM_PACK = 1

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('🚨 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY가 없습니다 (.env.local 확인).')
  process.exit(1)
}

let passCount = 0
let failCount = 0

async function step(label, fn) {
  process.stdout.write(`▶ ${label} ... `)
  try {
    await fn()
    console.log('✅')
    passCount += 1
  } catch (err) {
    console.log('❌')
    console.error(`   ${err.message || err}`)
    failCount += 1
    throw err // 이후 단계는 앞 단계 상태에 의존하므로 즉시 중단
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: 기대값 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)}`)
  }
}

async function readStock(db, itemId, warehouseCode) {
  const { data, error } = await db
    .from('inventory_stocks')
    .select('box_qty, unit_qty')
    .eq('item_id', itemId)
    .eq('warehouse_code', warehouseCode)
    .maybeSingle()
  if (error) throw error
  return { box_qty: data?.box_qty ?? 0, unit_qty: data?.unit_qty ?? 0 }
}

async function processTx(db, payload) {
  const { data, error } = await db.rpc('rpc_process_transaction', {
    p_tx_type: payload.txType,
    p_warehouse: payload.warehouse,
    p_partner: payload.partner ?? null,
    p_handler: payload.handler ?? MEMBER_NAME,
    p_invoice: null,
    p_memo: payload.memo ?? '스모크테스트 자동 실행',
    p_items: payload.items,
    p_target_warehouse: payload.targetWarehouse ?? null,
    p_pending_from_warehouse: null,
    p_idempotency_key: randomUUID()
  })
  if (error) throw error
  return data
}

async function main() {
  console.log('================================================================')
  console.log('🔥 [WMS 스모크 테스트] 입고/이동/출고/조정 핵심 흐름 검증 시작...')
  console.log('================================================================')

  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

  let session
  await step(`로그인 (${MEMBER_NAME})`, async () => {
    let { data, error } = await anon.rpc('rpc_login', {
      p_member_name: MEMBER_NAME,
      p_password: MEMBER_PASSWORD
    })
    if (error) throw error
    // 앱의 로그인 어댑터와 동일하게, 대문자 아이디가 실패하면 소문자로 한 번 더 시도한다
    // (예: 'ADMIN' 드롭다운 표시값 vs 실제 시드 데이터 'admin').
    if (!data?.success && MEMBER_NAME.toLowerCase() !== MEMBER_NAME) {
      ;({ data, error } = await anon.rpc('rpc_login', {
        p_member_name: MEMBER_NAME.toLowerCase(),
        p_password: MEMBER_PASSWORD
      }))
      if (error) throw error
    }
    if (!data?.success || !data?.session_token) throw new Error('로그인 실패: ' + JSON.stringify(data))
    session = data
  })

  // 이후 모든 RPC 호출은 세션 토큰을 x-wms-session 헤더로 실어 보낸다
  // (src/lib/supabase.js가 브라우저에서 하는 것과 동일한 방식).
  const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { 'x-wms-session': session.session_token } }
  })

  await step(`테스트 전용 창고 준비 (${TEST_WAREHOUSE_CODE})`, async () => {
    const { data: existing } = await db.from('warehouses').select('code').eq('code', TEST_WAREHOUSE_CODE).maybeSingle()
    if (existing) return
    const { error } = await db.rpc('rpc_upsert_warehouse', {
      p_code: TEST_WAREHOUSE_CODE,
      p_name: '스모크테스트 전용 창고 (자동 생성)',
      p_truck_capacity_boxes: 100,
      p_sort_order: null,
      p_is_active: false // 실제 UI 드롭다운/매트릭스에는 노출되지 않도록 비활성 유지
    })
    if (error) throw error
  })

  let itemId
  await step(`테스트 전용 품목 준비 (${TEST_ITEM_NAME})`, async () => {
    const { data: existing } = await db
      .from('items')
      .select('id')
      .eq('item_name', TEST_ITEM_NAME)
      .eq('color', TEST_ITEM_COLOR)
      .eq('box_packaging_qty', TEST_ITEM_PACK)
      .maybeSingle()
    if (existing) {
      itemId = existing.id
      return
    }
    const { data, error } = await db.rpc('rpc_register_item', {
      p_item_name: TEST_ITEM_NAME,
      p_color: TEST_ITEM_COLOR,
      p_box_packaging_qty: TEST_ITEM_PACK,
      p_barcode: null,
      p_brand_id: null,
      p_initial_boxes: 0,
      p_initial_units: 0,
      p_safe_stock: 0
    })
    if (error) throw error
    itemId = data.id
  })

  await step('실행 전 잔여 재고 0 확인 (이전 실행 잔재 검사)', async () => {
    const main = await readStock(db, itemId, 'MAIN')
    const sub = await readStock(db, itemId, TEST_WAREHOUSE_CODE)
    if (main.box_qty !== 0 || main.unit_qty !== 0 || sub.box_qty !== 0 || sub.unit_qty !== 0) {
      throw new Error(
        `잔여 재고가 0이 아닙니다 (MAIN ${main.box_qty}상자/${main.unit_qty}개, ${TEST_WAREHOUSE_CODE} ${sub.box_qty}상자/${sub.unit_qty}개). ` +
        `이전 스모크테스트 실행이 비정상 종료됐을 수 있습니다 — 수동으로 확인 후 재실행하세요.`
      )
    }
  })

  await step('TEST 1: 입고(INBOUND) +10상자 → MAIN', async () => {
    await processTx(db, { txType: 'INBOUND', warehouse: 'MAIN', items: [{ item_id: itemId, box_qty: 10, unit_qty: 0 }] })
    const main = await readStock(db, itemId, 'MAIN')
    assertEqual(main.box_qty, 10, 'MAIN 박스재고')
  })

  await step(`TEST 2: 이동(MOVE) MAIN → ${TEST_WAREHOUSE_CODE} 10상자`, async () => {
    await processTx(db, {
      txType: 'MOVE', warehouse: 'MAIN', targetWarehouse: TEST_WAREHOUSE_CODE,
      items: [{ item_id: itemId, box_qty: 10, unit_qty: 0 }]
    })
    const main = await readStock(db, itemId, 'MAIN')
    const sub = await readStock(db, itemId, TEST_WAREHOUSE_CODE)
    assertEqual(main.box_qty, 0, 'MAIN 박스재고')
    assertEqual(sub.box_qty, 10, `${TEST_WAREHOUSE_CODE} 박스재고`)
  })

  await step(`TEST 3: 이동(MOVE) ${TEST_WAREHOUSE_CODE} → MAIN 10상자 (복귀)`, async () => {
    await processTx(db, {
      txType: 'MOVE', warehouse: TEST_WAREHOUSE_CODE, targetWarehouse: 'MAIN',
      items: [{ item_id: itemId, box_qty: 10, unit_qty: 0 }]
    })
    const main = await readStock(db, itemId, 'MAIN')
    const sub = await readStock(db, itemId, TEST_WAREHOUSE_CODE)
    assertEqual(main.box_qty, 10, 'MAIN 박스재고')
    assertEqual(sub.box_qty, 0, `${TEST_WAREHOUSE_CODE} 박스재고`)
  })

  await step('TEST 4: 출고(OUTBOUND) -10상자 ← MAIN', async () => {
    await processTx(db, { txType: 'OUTBOUND', warehouse: 'MAIN', items: [{ item_id: itemId, box_qty: 10, unit_qty: 0 }] })
    const main = await readStock(db, itemId, 'MAIN')
    assertEqual(main.box_qty, 0, 'MAIN 박스재고')
  })

  await step('TEST 5: 재고 부족 가드 — 0상자에서 5상자 출고 시도는 반드시 실패해야 함', async () => {
    let threw = false
    try {
      await processTx(db, { txType: 'OUTBOUND', warehouse: 'MAIN', items: [{ item_id: itemId, box_qty: 5, unit_qty: 0 }] })
    } catch {
      threw = true
    }
    if (!threw) throw new Error('재고 부족인데 출고가 성공해버렸습니다 (음수 재고 가드 회귀 의심)')
    const main = await readStock(db, itemId, 'MAIN')
    assertEqual(main.box_qty, 0, 'MAIN 박스재고 (실패한 시도 후에도 변화 없어야 함)')
  })

  let adjustInvoice
  await step('TEST 6: 재고조정(ADJUST) — MAIN을 7상자로 치환', async () => {
    const { data, error } = await db.rpc('rpc_adjust_stock', {
      p_admin: MEMBER_NAME,
      p_items: [{ item_id: itemId, adj_mode: 'replace', box_qty: 7, unit_qty: 0, reason: '스모크테스트' }],
      p_warehouse: 'MAIN',
      p_invoice: null,
      p_memo: '스모크테스트 자동 실행',
      p_idempotency_key: randomUUID()
    })
    if (error) throw error
    adjustInvoice = data.invoice_no
    const main = await readStock(db, itemId, 'MAIN')
    assertEqual(main.box_qty, 7, 'MAIN 박스재고')
  })

  await step('TEST 7: 재고조정(ADJUST)으로 0상자 복귀 (정리)', async () => {
    const { error } = await db.rpc('rpc_adjust_stock', {
      p_admin: MEMBER_NAME,
      p_items: [{ item_id: itemId, adj_mode: 'replace', box_qty: 0, unit_qty: 0, reason: '스모크테스트 정리' }],
      p_warehouse: 'MAIN',
      p_invoice: null,
      p_memo: '스모크테스트 자동 실행 - 정리',
      p_idempotency_key: randomUUID()
    })
    if (error) throw error
    const main = await readStock(db, itemId, 'MAIN')
    assertEqual(main.box_qty, 0, 'MAIN 박스재고')
  })

  await step('TEST 8: stock_transactions 트리거가 handler_id를 자동 연결했는지 확인', async () => {
    const { data, error } = await db
      .from('stock_transactions')
      .select('handler_id, handler_name')
      .eq('invoice_no', adjustInvoice)
      .limit(1)
      .maybeSingle()
    if (error) throw error
    if (!data) throw new Error('방금 만든 ADJUST 전표를 찾을 수 없습니다')
    if (!data.handler_id) {
      throw new Error(`handler_id가 채워지지 않았습니다 (handler_name="${data.handler_name}") — 정합성 개선 트리거 회귀 의심`)
    }
  })

  console.log('================================================================')
  console.log(`🎉 [WMS 스모크 테스트] ${passCount}개 단계 전부 통과! 핵심 흐름 정상.`)
  console.log('================================================================')
}

main().catch(() => {
  console.log('================================================================')
  console.error(`❌ 스모크 테스트 실패 (통과 ${passCount} / 실패 ${failCount})`)
  console.log('================================================================')
  process.exitCode = 1
})
