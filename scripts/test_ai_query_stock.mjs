// scripts/test_ai_query_stock.mjs
/**
 * AI 주문서 초안(api/ai-query.js DRAFT_ORDER)의 재고 판정·SQL 입력 처리 회귀 테스트.
 * 네트워크·DB 없이(모의 fetch) 돌아가므로 빠르고 안전하다: npm run test:ai
 *
 * 재현했던 결함:
 *  - 재고 0개에서 낱개 99개 주문이 "충분"으로 판정됨 (낱개 미비교)
 *  - 같은 품명의 다른 색상 재고(빨강 100상자)로 파랑(0상자) 주문이 "충분"으로 판정됨 (색상 무시)
 *  - DB 조회가 실패해도 "충분·등록 품목"으로 처리됨
 *  - AI가 반환한 창고명이 SQL 조건에 그대로 삽입됨
 */
process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
process.env.VITE_SUPABASE_ANON_KEY = 'anon-key'
process.env.GEMINI_API_KEY = 'gemini-key'

const mod = await import('../api/ai-query.js')
const handler = mod.default
const { evaluateDraftStock, buildDraftStockSql, isValidWarehouseCode } = mod

let pass = 0
let fail = 0
function check(label, cond, extra = '') {
  console.log(cond ? '✅' : '❌', label, cond ? '' : extra)
  cond ? pass++ : fail++
}

const row = (name, color, pack, box, unit = 0, whExists = true) => ({
  id: `${name}-${color}`, item_name: name, color, box_packaging_qty: pack,
  current_box_qty: box, current_unit_qty: unit, wh_exists: whExists
})
const one = (items, rows, wh = 'MAIN') => evaluateDraftStock(items, rows, wh)[0]

// ---------------------------------------------------------------------------
// 1) 순수 판정 로직
// ---------------------------------------------------------------------------
{
  const r = one([{ model: 'PT88', color: 'SURTIDO', boxQty: 0, unitQty: 99 }], [row('PT88', 'SURTIDO', 72, 0, 0)])
  check('재고 0에서 낱개 99개 주문은 재고부족', r.stockStatus === 'SHORT' && r.isSufficient === false, JSON.stringify(r))
}
{
  const r = one([{ model: 'PT88', color: 'SURTIDO', boxQty: 0, unitQty: 100 }], [row('PT88', 'SURTIDO', 72, 1, 0)])
  check('재고 1상자(72개)에서 낱개 100개 주문은 재고부족', r.stockStatus === 'SHORT', JSON.stringify(r))
}
{
  const r = one([{ model: 'PT88', color: 'SURTIDO', boxQty: 1, unitQty: 20 }], [row('PT88', 'SURTIDO', 72, 5, 0)])
  check('상자+낱개는 개수로 환산해 비교 (92개 ≤ 360개 → 충분)', r.stockStatus === 'OK' && r.requiredUnits === 92 && r.currentUnits === 360, JSON.stringify(r))
}
{
  const r = one([{ model: 'PT88', color: 'SURTIDO', boxQty: 1, unitQty: 0 }], [row('PT88', 'SURTIDO', 72, 0, 60)])
  check('재고 낱개(60개)만 있고 1상자(72개) 주문은 재고부족', r.stockStatus === 'SHORT', JSON.stringify(r))
}
{
  const rows = [row('PT88', 'AZUL', 72, 0), row('PT88', 'ROJO', 72, 100)]
  const blue = one([{ model: 'PT88', color: 'azul', boxQty: 2, unitQty: 0 }], rows)
  const red = one([{ model: 'pt88', color: 'ROJO', boxQty: 2, unitQty: 0 }], rows)
  check('색상별 판정: 파랑 0상자에서 2상자 주문은 재고부족 (빨강 재고 무시)', blue.stockStatus === 'SHORT' && blue.color === 'AZUL' && blue.currentStock === 0, JSON.stringify(blue))
  check('색상별 판정: 빨강 100상자에서 2상자 주문은 충분 (대소문자 무관)', red.stockStatus === 'OK' && red.currentStock === 100, JSON.stringify(red))
  const none = one([{ model: 'PT88', color: 'VERDE', boxQty: 1, unitQty: 0 }], rows)
  check('없는 색상은 NOT_FOUND (등록된 색상 안내)', none.stockStatus === 'NOT_FOUND' && /AZUL/.test(none.statusNote) && none.isSufficient === false, JSON.stringify(none))
  const noColor = one([{ model: 'PT88', boxQty: 1, unitQty: 0 }], rows)
  check('색상이 여러 개인데 지정하지 않으면 AMBIGUOUS (임의로 하나를 고르지 않음)', noColor.stockStatus === 'AMBIGUOUS' && noColor.isSufficient === false, JSON.stringify(noColor))
}
{
  const one1 = one([{ model: 'PT88', boxQty: 1, unitQty: 0 }], [row('PT88', 'SURTIDO', 72, 3)])
  check('색상 미지정이라도 색상이 하나뿐이면 그 품목으로 판정', one1.stockStatus === 'OK' && one1.color === 'SURTIDO', JSON.stringify(one1))
  const dup = one([{ model: 'PT88', color: 'SURTIDO', boxQty: 1, unitQty: 0 }], [row('PT88', 'SURTIDO', 72, 3), row('PT88', 'SURTIDO', 100, 3)])
  check('같은 품명·색상에 포장수량이 다른 품목이 둘이면 AMBIGUOUS', dup.stockStatus === 'AMBIGUOUS', JSON.stringify(dup))
  const missing = one([{ model: 'NOPE-1', color: 'SURTIDO', boxQty: 1, unitQty: 0 }], [row('PT88', 'SURTIDO', 72, 3)])
  check('미등록 품목은 NOT_FOUND', missing.stockStatus === 'NOT_FOUND' && missing.isCatalogMatch === false && missing.isSufficient === false, JSON.stringify(missing))
  const noWh = one([{ model: 'PT88', color: 'SURTIDO', boxQty: 1, unitQty: 0 }], [row('PT88', 'SURTIDO', 72, 0, 0, false)], 'NOWHERE')
  check('존재하지 않는 출발 창고는 UNVERIFIED (재고 0으로 오해하지 않음)', noWh.stockStatus === 'UNVERIFIED' && noWh.isSufficient === false, JSON.stringify(noWh))
  const failed = one([{ model: 'PT88', color: 'SURTIDO', boxQty: 1, unitQty: 0 }], null)
  check('조회 실패(null)는 UNVERIFIED — 충분·등록 품목으로 처리하지 않음', failed.stockStatus === 'UNVERIFIED' && failed.isSufficient === false && failed.isCatalogMatch === null, JSON.stringify(failed))
  const neg = one([{ model: 'PT88', color: 'SURTIDO', boxQty: -5, unitQty: 'abc' }], [row('PT88', 'SURTIDO', 72, 1)])
  check('음수·비숫자 수량은 0으로 정규화', neg.boxQty === 0 && neg.unitQty === 0, JSON.stringify(neg))
}

// ---------------------------------------------------------------------------
// 2) SQL 생성/창고 코드 검증
// ---------------------------------------------------------------------------
{
  check('창고 코드 검증: 정상', isValidWarehouseCode('MAIN') && isValidWarehouseCode('PANTACO') && isValidWarehouseCode('SMOKE_TEST1'))
  const bad = ["MAIN' OR '1'='1", "MAIN'; DROP TABLE items;--", '', "a b", 'x'.repeat(31), "MAIN')--"]
  check('창고 코드 검증: 따옴표·공백·세미콜론·과도한 길이 거부', bad.every(c => !isValidWarehouseCode(c)), bad.filter(c => isValidWarehouseCode(c)).join(' | '))
  const sql = buildDraftStockSql([{ model: "O'NEIL" }, { model: "o'neil" }, { model: 'PT88' }, { model: '  ' }], 'MAIN')
  check("품명의 작은따옴표는 이중화된다 ('O''NEIL')", sql.includes("'O''NEIL'"), sql)
  check('중복 품명은 한 번만, 빈 품명은 제외', (sql.match(/'O''NEIL'/g) || []).length === 1 && !/'\s*'/.test(sql.replace(/''/g, '')))
  check('창고 조건이 문자열 리터럴로 들어간다', sql.includes("w.code = 'MAIN'") && sql.includes("s.warehouse_code = 'MAIN'"), sql)
  check('활성 품목만 조회', /COALESCE\(i\.is_active, TRUE\)/.test(sql))
  check('품목이 하나도 없으면 SQL을 만들지 않는다', buildDraftStockSql([{ model: '' }], 'MAIN') === '')
}

// ---------------------------------------------------------------------------
// 3) 핸들러 통합 (모의 Gemini / 모의 DB)
// ---------------------------------------------------------------------------
const TOKEN = 'test-session-token'
let aiDraft = null
let dbMode = 'ok' // ok | http503 | success_false | throw
let dbRows = []
const rpcCalls = []
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url)
  const json = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj, text: async () => JSON.stringify(obj) })
  if (u.includes('rpc_session_info')) return json({ success: true, user: { name: 'tester' } })
  if (u.includes('generativelanguage')) {
    return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(aiDraft) }] } }], usageMetadata: {} })
  }
  if (u.includes('rpc_exec_readonly_query')) {
    rpcCalls.push({ headers: opts.headers, sql: JSON.parse(opts.body).p_sql })
    if (dbMode === 'throw') throw new Error('network down')
    if (dbMode === 'http503') return json({ message: 'service unavailable' }, 503)
    if (dbMode === 'success_false') return json({ success: false, error: 'permission denied', data: [] })
    return json({ success: true, data: dbRows, row_count: dbRows.length })
  }
  throw new Error('unexpected fetch ' + u)
}

async function draft(items, sourceWarehouse = 'MAIN') {
  aiDraft = { intent: 'DRAFT_ORDER', orderType: 'out', targetPage: '출고입력', location: 'TIENDA', sourceWarehouse, items, explanation: 'x', title: 't' }
  rpcCalls.length = 0
  let out = null
  const res = { statusCode: 0, status(c) { this.statusCode = c; return this }, json(o) { out = o; return this } }
  await handler({ method: 'POST', headers: { 'x-wms-session': TOKEN }, body: { question: 'test' } }, res)
  return { status: res.statusCode, body: out }
}

{
  dbMode = 'ok'; dbRows = [row('PT88', 'AZUL', 72, 0), row('PT88', 'ROJO', 72, 100)]
  const { status, body } = await draft([{ model: 'PT88', color: 'AZUL', boxQty: 2, unitQty: 0 }, { model: 'PT88', color: 'ROJO', boxQty: 2, unitQty: 0 }])
  const [blue, red] = body.draft.items
  check('핸들러: 색상별 판정이 응답에 반영 (파랑 부족 / 빨강 충분)', status === 200 && blue.stockStatus === 'SHORT' && red.stockStatus === 'OK', JSON.stringify(body.draft?.items))
  check('핸들러: 세션 토큰을 재고 조회 RPC에 전달', rpcCalls.length === 1 && rpcCalls[0].headers['x-wms-session'] === TOKEN)
}
for (const mode of ['http503', 'success_false', 'throw']) {
  dbMode = mode
  const { status, body } = await draft([{ model: 'PT88', color: 'AZUL', boxQty: 2, unitQty: 0 }])
  const it = body?.draft?.items?.[0]
  check(`핸들러: DB 조회 실패(${mode})는 UNVERIFIED — 재고 충분으로 처리하지 않음`, status === 200 && it?.stockStatus === 'UNVERIFIED' && it.isSufficient === false && it.isCatalogMatch === null, JSON.stringify(it))
}
{
  dbMode = 'ok'; dbRows = []
  const { body } = await draft([{ model: 'GHOST', color: 'SURTIDO', boxQty: 1, unitQty: 0 }])
  check('핸들러: 카탈로그에 없는 품목은 NOT_FOUND', body.draft.items[0].stockStatus === 'NOT_FOUND')
}
{
  dbMode = 'ok'; dbRows = [row('PT88', 'SURTIDO', 72, 9)]
  const { status, body } = await draft([{ model: 'PT88', color: 'SURTIDO', boxQty: 1, unitQty: 0 }], "MAIN' OR '1'='1")
  check('핸들러: 따옴표가 든 창고명은 400으로 거부되고 DB 호출이 없다', status === 400 && rpcCalls.length === 0 && /창고/.test(body.error || ''), `status=${status} calls=${rpcCalls.length}`)
  const lower = await draft([{ model: 'PT88', color: 'SURTIDO', boxQty: 1, unitQty: 0 }], 'pantaco')
  check('핸들러: 소문자 창고 코드는 대문자로 정규화해 조회', lower.status === 200 && rpcCalls[0].sql.includes("w.code = 'PANTACO'"), rpcCalls[0]?.sql)
  const many = await draft(Array.from({ length: 150 }, (_, i) => ({ model: `P${i}`, color: 'SURTIDO', boxQty: 1, unitQty: 0 })))
  check('핸들러: 품목은 최대 100개까지만 처리', many.body.draft.items.length === 100)
}

console.log(`\n결과: 통과 ${pass} / 실패 ${fail}`)
process.exit(fail ? 1 : 0)
