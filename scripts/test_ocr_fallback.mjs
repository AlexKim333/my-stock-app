// scripts/test_ocr_fallback.mjs
/**
 * api/ocr.js 모델 대체(fallback) 전략 회귀 테스트: npm run test:ocr:fallback
 * 네트워크 없이(모의 fetch) 돌아가므로 빠르고 비용이 없다. 실제 판독 정확도는 npm run test:ocr로 본다.
 *
 * 확인하는 것:
 *  - 5xx·429·시간 초과·빈 응답·JSON 깨짐·형식 누락이면 다음 모델로 넘어간다
 *  - API 키 오류(401/403)는 다른 모델을 시도하지 않고 즉시 중단한다
 *  - 없는 모델(404)은 다음 요청부터 건너뛴다
 *  - 전체 시간 예산을 넘기지 않는다
 *  - 실패 원인에 맞는 상태코드와 메시지를 돌려준다
 *  - API 키가 URL에 실리지 않는다
 */
process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
process.env.VITE_SUPABASE_ANON_KEY = 'anon-key'
process.env.GEMINI_API_KEY = 'gemini-secret-key'
process.env.OCR_CATALOG_HINT = 'off'
process.env.OCR_SAMPLE_COLLECT = 'off'

let pass = 0
let fail = 0
function check(label, cond, extra = '') {
  console.log(cond ? '✅' : '❌', label, cond ? '' : extra)
  cond ? pass++ : fail++
}

// 모델별 동작을 시나리오마다 바꿔 끼운다. 값: 함수(호출 순번) -> 'hang' | Response
let behaviors = {}
let calls = []
let sampleCalls = []
let sampleSave = () => new Response(JSON.stringify('11111111-2222-3333-4444-555555555555'), { status: 200 })
const okBody = (data, finishReason = 'STOP') => new Response(JSON.stringify({
  candidates: [{ content: { parts: [{ text: typeof data === 'string' ? data : JSON.stringify(data) }] }, finishReason }],
  usageMetadata: { promptTokenCount: 10 }
}), { status: 200 })
const errBody = (status, message = 'err') => new Response(JSON.stringify({ error: { code: status, message } }), { status })
const emptyBody = finishReason => new Response(JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason }] }), { status: 200 })

globalThis.fetch = (url, opts = {}) => {
  url = String(url)
  if (url.includes('/rpc/rpc_ocr_sample_create')) {
    sampleCalls.push(JSON.parse(opts.body))
    return Promise.resolve(sampleSave())
  }
  if (url.includes('/rpc/rpc_session_info')) {
    return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }))
  }
  const m = url.match(/models\/([^:]+):generateContent/)
  if (!m) return Promise.reject(new Error(`unexpected fetch ${url}`))
  const model = decodeURIComponent(m[1])
  calls.push({ model, url, headers: opts.headers || {} })
  const out = behaviors[model]?.(calls.filter(c => c.model === model).length)
  if (out === 'hang') {
    return new Promise((_, reject) => {
      opts.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })
  }
  return Promise.resolve(out || errBody(500, 'no behavior'))
}

const { default: handler } = await import('../api/ocr.js')

function run(type = 'handwritten') {
  return new Promise(resolve => {
    const res = {
      code: 200,
      status(c) { this.code = c; return this },
      json(body) { resolve({ status: this.code, body }) }
    }
    handler({ method: 'POST', headers: { 'x-wms-session': 't' }, body: { type, imageBase64: 'AAAA' } }, res)
  })
}

/** 시나리오마다 서로 다른 모델 이름을 써서 '없는 모델' 캐시가 다른 시나리오에 새지 않게 한다. */
function scenario(models, map, env = {}) {
  process.env.OCR_MODELS = models.join(',')
  delete process.env.OCR_DEADLINE_MS
  delete process.env.OCR_MODEL_TIMEOUT_MS
  Object.assign(process.env, env)
  behaviors = map
  calls = []
}

const goodOrder = { branch: 'X', requester: '', results: [{ modelo: 'CK928K', color: 'SURTIDO', raw_qty: '1', boxes: 1, pack_qty: 0, no_de_bultos: 1 }] }
const goodAudit = { date: '', warehouse: '', items: [{ modelo: 'CK928K', color: '', boxes: 1, piezas: 0, uncertain: false }] }

{
  scenario(['a1', 'a2'], { a1: () => errBody(503, 'overloaded'), a2: () => okBody(goodOrder) })
  const r = await run()
  check('503이면 다음 모델로 넘어가 성공', r.status === 200 && r.body.usedModel === 'a2', JSON.stringify(r))
  check('시도 기록에 실패·성공이 순서대로 남음', r.body.attempts?.map(a => a.outcome).join() === 'http-503,ok', JSON.stringify(r.body.attempts))
  check('API 키는 URL이 아니라 헤더로 전송', calls.every(c => !c.url.includes('gemini-secret-key') && c.headers['x-goog-api-key'] === 'gemini-secret-key'), JSON.stringify(calls))
}
{
  scenario(['b1', 'b2'], { b1: () => errBody(404, 'model not found'), b2: () => okBody(goodOrder) })
  const first = await run()
  calls = []
  const second = await run()
  check('404 모델 다음에 성공', first.status === 200 && first.body.usedModel === 'b2', JSON.stringify(first))
  check('404 모델은 다음 요청부터 호출하지 않음', second.status === 200 && !calls.some(c => c.model === 'b1') &&
    second.body.attempts[0].outcome === 'skipped-missing', JSON.stringify({ calls, attempts: second.body.attempts }))
}
{
  scenario(['c1', 'c2'], { c1: () => errBody(403, 'API key not valid'), c2: () => okBody(goodOrder) })
  const r = await run()
  check('키 오류(403)는 즉시 중단하고 다른 모델을 부르지 않음', r.status === 500 && calls.length === 1 && /키/.test(r.body.error), JSON.stringify({ r, calls }))
}
{
  scenario(['d1', 'd2'], { d1: () => errBody(429, 'quota'), d2: () => errBody(429, 'quota') })
  const r = await run()
  check('모든 모델이 429면 429와 한도 초과 안내', r.status === 429 && /한도/.test(r.body.error), JSON.stringify(r))
}
{
  scenario(['e1', 'e2', 'e3'], { e1: () => 'hang', e2: () => 'hang', e3: () => 'hang' },
    { OCR_DEADLINE_MS: '4000', OCR_MODEL_TIMEOUT_MS: '300' })
  const r = await run()
  check('모든 모델이 시간 초과면 504', r.status === 504 && r.body.attempts.length === 3 && r.body.attempts.every(a => a.outcome === 'timeout'), JSON.stringify(r))
}
{
  scenario(['f1', 'f2'], { f1: () => 'hang', f2: () => okBody(goodOrder) },
    { OCR_DEADLINE_MS: '3500', OCR_MODEL_TIMEOUT_MS: '1000' })
  const t0 = Date.now()
  const r = await run()
  const ms = Date.now() - t0
  check('남은 예산이 부족하면 다음 모델을 시도하지 않고 끝냄', r.status === 504 && !calls.some(c => c.model === 'f2') && ms < 3500, JSON.stringify({ r, ms }))
}
{
  scenario(['g1', 'g2'], { g1: () => emptyBody('SAFETY'), g2: () => emptyBody('SAFETY') })
  const r = await run()
  check('안전 필터로 빈 응답이면 422와 안내', r.status === 422 && /안전 필터/.test(r.body.error), JSON.stringify(r))
}
{
  scenario(['h1', 'h2', 'h3'], {
    h1: () => okBody('{"results": [ {"modelo": "CK9', 'MAX_TOKENS'),
    h2: () => okBody({ branch: 'X', requester: '' }),
    h3: () => okBody(goodOrder)
  })
  const r = await run()
  check('JSON 깨짐·목록 누락은 다음 모델로', r.status === 200 && r.body.usedModel === 'h3' &&
    r.body.attempts.map(a => a.outcome).join() === 'bad-json,bad-shape,ok', JSON.stringify(r.body.attempts))
}
{
  scenario(['i1'], { i1: () => okBody(goodAudit) })
  const r = await run('audit')
  check('실사표는 items 목록으로 형식을 확인', r.status === 200 && r.body.items?.length === 1, JSON.stringify(r))
}
{
  scenario(['j1', 'j2'], { j1: () => errBody(500, '{"secret":"x"}'.repeat(100)), j2: () => errBody(500, 'boom') })
  const r = await run()
  check('실패 메시지는 원문 JSON 전체가 아니라 요약', r.status === 502 && r.body.error.length < 300 && r.body.error.includes('j1: http-500'), r.body.error)
}

{
  // 정답 세트 사진 저장은 화면이 결과를 받은 뒤 백그라운드로 한다. 서버는 스캔 응답을 늦추지 않도록
  // 저장하지 않고, 수집을 켤지만 알려준다.
  process.env.OCR_SAMPLE_COLLECT = 'on'
  scenario(['k1'], { k1: () => okBody(goodOrder) })
  sampleCalls = []
  const r = await run()
  check('정답 세트: 서버는 사진을 저장하지 않음(응답 지연 방지)', r.status === 200 && sampleCalls.length === 0, JSON.stringify(sampleCalls))
  check('정답 세트: 수집이 켜져 있음을 화면에 알림', r.body.collectSample === true, JSON.stringify(r.body))

  process.env.OCR_SAMPLE_COLLECT = 'off'
  const off = await run()
  check('OCR_SAMPLE_COLLECT=off면 수집 꺼짐으로 알림', off.status === 200 && off.body.collectSample === false, JSON.stringify(off.body))
}

console.log(`\n${fail ? '❌' : '🎉'} OCR 대체 모델 전략: ${pass}개 통과, ${fail}개 실패`)
process.exit(fail ? 1 : 0)
