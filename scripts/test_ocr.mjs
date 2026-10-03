// scripts/test_ocr.mjs
/**
 * OCR 정답 세트 평가: npm run test:ocr
 *
 * api/ocr.js(프롬프트·스키마·모델)를 바꿨을 때 실제로 좋아졌는지 숫자로 비교하기 위한 평가 도구다.
 * test:ai와 달리 실제 Gemini를 호출하므로 .env.local의 GEMINI_API_KEY가 필요하고, 장당 소액의 비용이 든다.
 * (로그인 세션 확인만 모의 처리한다. Supabase에는 아무것도 쓰지 않는다.)
 *
 * 정답 세트 위치
 *  - tests/ocr/cases/<이름>/   : 저장소에 커밋되는 합성(가짜) 샘플
 *  - tests/ocr/private/<이름>/ : 실제 고객 주문서 사진 등. .gitignore로 커밋되지 않는다.
 *  각 폴더에 image.jpg(앱과 같이 긴 변 1600px 이하 JPEG 권장)와 expected.json을 둔다.
 *
 * expected.json
 *  {
 *    "type": "handwritten" | "audit" | "cartadeporte",
 *    "note": "무엇을 확인하는 케이스인지",
 *    "header": { "branch": "Fernando" },              // 선택. 적은 필드만 비교
 *    "items": [
 *      { "modelo": "CK928K", "color": "SURTIDO", "boxes": 1, "uncertain": true }
 *    ]                                                // color/boxes/piezas/pack_qty/uncertain은 적은 것만 비교
 *  }
 *
 * 옵션
 *  --filter=<문자열>   케이스 이름에 포함된 것만 실행
 *  --runs=<N>          케이스마다 N번 실행해 안정성 확인 (기본 1)
 *  --update-baseline   이번 결과를 기준선(tests/ocr/.baseline.json, 커밋 안 됨)으로 저장
 *  --min-f1=<0~1>      전체 행 F1이 이 값보다 낮으면 종료코드 1
 *  --no-catalog        카탈로그 품번 힌트 없이 실행 (힌트 효과 비교용, OCR_CATALOG_HINT=off와 같음)
 *
 * 기준선이 있으면 케이스별 점수를 기준선과 나란히 보여주므로, 프롬프트 수정 전에 한 번
 * --update-baseline으로 저장해 두고 수정 후 다시 돌려 비교하면 된다.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CASE_DIRS = ['tests/ocr/cases', 'tests/ocr/private'].map(d => path.join(ROOT, d))
const BASELINE_PATH = path.join(ROOT, 'tests/ocr/.baseline.json')

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=')
  return [k, v === undefined ? true : v]
}))
const runs = Math.max(1, parseInt(args.runs, 10) || 1)

try { process.loadEnvFile(path.join(ROOT, '.env.local')) } catch { /* 환경변수로 직접 줘도 된다 */ }
if (!process.env.GEMINI_API_KEY) {
  console.error('❌ GEMINI_API_KEY가 없습니다. .env.local에 넣거나 환경변수로 지정하세요.')
  process.exit(1)
}

if (args['no-catalog']) process.env.OCR_CATALOG_HINT = 'off'
// 평가 실행이 프로덕션 정답 세트 테이블(ocr_samples)에 표본을 남기지 않게 한다.
process.env.OCR_SAMPLE_COLLECT = 'off'

// 세션 확인만 통과시키고 Gemini 호출은 실제로 보낸다.
process.env.VITE_SUPABASE_URL ||= 'https://example.supabase.co'
process.env.VITE_SUPABASE_ANON_KEY ||= 'anon-key'
const realFetch = globalThis.fetch
globalThis.fetch = (url, opts) => String(url).includes('/rpc/rpc_session_info')
  ? Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }))
  : realFetch(url, opts)
const { default: handler } = await import(pathToFileURL(path.join(ROOT, 'api/ocr.js')).href)

function callOcr(type, imageBase64) {
  return new Promise(resolve => {
    const res = {
      code: 200,
      status(c) { this.code = c; return this },
      json(body) { resolve({ status: this.code, body }) }
    }
    handler({ method: 'POST', headers: { 'x-wms-session': 'test' }, body: { type, imageBase64 } }, res)
  })
}

// ---------------------------------------------------------------------------
// 비교 규칙
// ---------------------------------------------------------------------------
const normModel = s => String(s || '').toUpperCase().replace(/[\s_\-\/.,#]/g, '')
const normText = s => String(s || '').trim().toUpperCase()

/** 기대 행마다 같은 품번(+기대에 색상이 있으면 색상까지)인 실제 행을 하나씩 짝지어 비교한다. */
function scoreCase(expected, body) {
  const actual = (body.results || body.items || []).map(r => ({ ...r }))
  const used = new Set()
  const rows = []
  let qtyChecked = 0, qtyOk = 0, uncertainExpected = 0, uncertainCaught = 0

  for (const exp of expected.items) {
    const idx = actual.findIndex((a, i) => !used.has(i) &&
      normModel(a.modelo) === normModel(exp.modelo) &&
      (!exp.color || normText(a.color) === normText(exp.color)))
    if (idx === -1) {
      rows.push({ exp, act: null, problems: ['누락'] })
      if (exp.uncertain) uncertainExpected++
      continue
    }
    used.add(idx)
    const act = actual[idx]
    const problems = []
    for (const f of ['boxes', 'piezas', 'pack_qty']) {
      if (exp[f] === undefined) continue
      qtyChecked++
      if (Number(act[f]) === Number(exp[f])) qtyOk++
      else problems.push(`${f} ${act[f]}≠${exp[f]}`)
    }
    // 원문(modelo_raw)은 띄어쓰기·하이픈 차이를 무시하고 비교한다. 카탈로그로 보정되지 않았는지 확인하는 용도.
    if (exp.modelo_raw !== undefined) {
      qtyChecked++
      if (normModel(act.modelo_raw) === normModel(exp.modelo_raw)) qtyOk++
      else problems.push(`원문 "${act.modelo_raw ?? ''}"≠"${exp.modelo_raw}"`)
    }
    if (exp.uncertain === true) {
      uncertainExpected++
      if (act.uncertain === true) uncertainCaught++
      else problems.push('불확실 표시 누락')
    }
    rows.push({ exp, act, problems })
  }

  const extras = actual.filter((_, i) => !used.has(i))
  const matched = rows.filter(r => r.act).length
  const precision = actual.length ? matched / actual.length : (expected.items.length ? 0 : 1)
  const recall = expected.items.length ? matched / expected.items.length : 1
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0

  const headerProblems = []
  for (const [k, v] of Object.entries(expected.header || {})) {
    if (normText(body[k]) !== normText(v)) headerProblems.push(`${k} "${body[k] ?? ''}"≠"${v}"`)
  }

  return {
    f1, precision, recall,
    expectedRows: expected.items.length, actualRows: actual.length, matched,
    qtyChecked, qtyOk, uncertainExpected, uncertainCaught,
    headerChecked: Object.keys(expected.header || {}).length, headerOk: Object.keys(expected.header || {}).length - headerProblems.length,
    rows, extras, headerProblems
  }
}

// ---------------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------------
const cases = []
for (const dir of CASE_DIRS) {
  if (!fs.existsSync(dir)) continue
  for (const name of fs.readdirSync(dir).sort()) {
    const caseDir = path.join(dir, name)
    const expectedPath = path.join(caseDir, 'expected.json')
    if (!fs.existsSync(expectedPath)) continue
    if (args.filter && !name.includes(args.filter)) continue
    const image = fs.readdirSync(caseDir).find(f => /^image\.jpe?g$/i.test(f))
    if (!image) { console.warn(`⚠️ ${name}: image.jpg가 없어 건너뜀`); continue }
    cases.push({
      name: `${path.basename(dir) === 'private' ? 'private/' : ''}${name}`,
      expected: JSON.parse(fs.readFileSync(expectedPath, 'utf8')),
      imageBase64: fs.readFileSync(path.join(caseDir, image)).toString('base64')
    })
  }
}
if (cases.length === 0) {
  console.error('❌ 실행할 케이스가 없습니다. tests/ocr/cases 또는 tests/ocr/private에 케이스를 추가하세요.')
  process.exit(1)
}

const baseline = fs.existsSync(BASELINE_PATH) ? JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) : null
const pct = x => `${Math.round(x * 100)}%`
const totals = { expectedRows: 0, actualRows: 0, matched: 0, qtyChecked: 0, qtyOk: 0, uncertainExpected: 0, uncertainCaught: 0, headerChecked: 0, headerOk: 0 }
const latencies = []
const tokens = { prompt: 0, cached: 0, thoughts: 0, output: 0, calls: 0 }
let catalogSize = 0
const models = {}
const caseF1 = {}
let apiErrors = 0

console.log(`🧪 OCR 정답 세트 평가: ${cases.length}개 케이스 × ${runs}회\n`)

for (const c of cases) {
  const f1s = []
  for (let run = 1; run <= runs; run++) {
    const t0 = Date.now()
    const { status, body } = await callOcr(c.expected.type, c.imageBase64)
    const ms = Date.now() - t0
    const tag = runs > 1 ? ` (${run}/${runs})` : ''
    if (status !== 200) {
      apiErrors++
      console.log(`❌ ${c.name}${tag}: API ${status} ${body?.error || ''}`)
      continue
    }
    latencies.push(ms)
    models[body.usedModel] = (models[body.usedModel] || 0) + 1
    const u = body.usageMetadata || {}
    tokens.prompt += u.promptTokenCount || 0
    tokens.cached += u.cachedContentTokenCount || 0
    catalogSize = body.catalogHintSize || 0
    tokens.thoughts += u.thoughtsTokenCount || 0
    tokens.output += u.candidatesTokenCount || 0
    tokens.calls++

    const s = scoreCase(c.expected, body)
    f1s.push(s.f1)
    for (const k of Object.keys(totals)) totals[k] += s[k]

    const perfect = s.f1 === 1 && s.qtyOk === s.qtyChecked && s.uncertainCaught === s.uncertainExpected && !s.headerProblems.length
    console.log(`${perfect ? '✅' : '⚠️'} ${c.name}${c.expected.needs_review ? ' (검토 전)' : ''}${tag}  행 F1 ${pct(s.f1)} (${s.matched}/${s.expectedRows}, 추출 ${s.actualRows}행)  필드 ${s.qtyOk}/${s.qtyChecked}  ${ms}ms`)
    for (const r of s.rows) {
      if (r.problems.length) console.log(`     - ${r.exp.modelo}${r.exp.color ? ' ' + r.exp.color : ''}: ${r.problems.join(', ')}`)
    }
    for (const x of s.extras) console.log(`     + 정답에 없는 행: ${x.modelo} ${x.color || ''} boxes=${x.boxes}`)
    for (const h of s.headerProblems) console.log(`     - 헤더 ${h}`)
  }
  if (f1s.length) caseF1[c.name] = f1s.reduce((a, b) => a + b, 0) / f1s.length
}

// ---------------------------------------------------------------------------
// 요약
// ---------------------------------------------------------------------------
const precision = totals.actualRows ? totals.matched / totals.actualRows : 0
const recall = totals.expectedRows ? totals.matched / totals.expectedRows : 0
const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0
latencies.sort((a, b) => a - b)
const median = latencies.length ? latencies[Math.floor(latencies.length / 2)] : 0

console.log('\n================================================================')
console.log(`행 F1          ${pct(f1)}  (정밀도 ${pct(precision)}, 재현율 ${pct(recall)})`)
console.log(`필드 정확도    ${totals.qtyChecked ? pct(totals.qtyOk / totals.qtyChecked) : '-'}  (${totals.qtyOk}/${totals.qtyChecked}, 짝지어진 행의 수량·원문)`)
console.log(`불확실 표시    ${totals.uncertainExpected ? `${totals.uncertainCaught}/${totals.uncertainExpected}` : '-'}  (정답에 uncertain:true로 적은 행 중 표시된 수)`)
console.log(`헤더 정확도    ${totals.headerChecked ? `${totals.headerOk}/${totals.headerChecked}` : '-'}`)
console.log(`응답 시간      중앙값 ${median}ms, 최대 ${latencies.at(-1) || 0}ms`)
if (tokens.calls) {
  console.log(`토큰(호출당)   입력 ${Math.round(tokens.prompt / tokens.calls)} (캐시 적중 ${Math.round(tokens.cached / tokens.calls)}), 사고 ${Math.round(tokens.thoughts / tokens.calls)}, 출력 ${Math.round(tokens.output / tokens.calls)}`)
}
console.log(`카탈로그 힌트  ${catalogSize ? `${catalogSize}개 품번` : '없음'}`)
console.log(`사용 모델      ${Object.entries(models).map(([m, n]) => `${m}×${n}`).join(', ') || '-'}`)
if (apiErrors) console.log(`API 오류       ${apiErrors}건`)

if (baseline) {
  console.log(`\n📊 기준선(${baseline.savedAt}) 대비 케이스별 행 F1`)
  // --filter로 일부만 돌렸으면 전체 점수는 비교 대상이 달라 의미가 없다.
  if (!args.filter) console.log(`   전체 ${pct(baseline.f1)} → ${pct(f1)}`)
  for (const [name, now] of Object.entries(caseF1)) {
    const before = baseline.caseF1?.[name]
    const mark = before === undefined ? '🆕' : now > before ? '⬆️' : now < before ? '⬇️' : '  '
    console.log(`   ${mark} ${name}: ${before === undefined ? '-' : pct(before)} → ${pct(now)}`)
  }
}

if (args['update-baseline']) {
  fs.writeFileSync(BASELINE_PATH, JSON.stringify({ savedAt: new Date().toISOString(), f1, caseF1 }, null, 2))
  console.log(`\n💾 기준선 저장: ${path.relative(ROOT, BASELINE_PATH)}`)
}

const minF1 = args['min-f1'] !== undefined ? Number(args['min-f1']) : null
if (apiErrors || (minF1 !== null && f1 < minF1)) {
  if (minF1 !== null && f1 < minF1) console.log(`\n❌ 행 F1 ${pct(f1)}가 기준 ${pct(minF1)}보다 낮습니다.`)
  process.exit(1)
}
