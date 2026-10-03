// api/ocr.js
// Vercel Serverless Function: Gemini OCR with Token Circuit Breaker (thinking_budget: 1024)

// 같은 출처(웹앱)에서만 호출하므로 CORS 허용 헤더를 두지 않는다.
// Gemini 쿼터 보호를 위해 WMS 로그인 세션을 확인하고, 모델 호출마다 시간 상한을 둔다.

const MAX_IMAGE_BASE64_CHARS = 6 * 1024 * 1024
const MODEL_TIMEOUT_MS = 25000
const SESSION_CHECK_TIMEOUT_MS = 5000
const CATALOG_TIMEOUT_MS = 5000
const CATALOG_TTL_MS = 10 * 60 * 1000
const SAMPLE_SAVE_TIMEOUT_MS = 4000

// Gemini response_schema(OpenAPI 부분집합). 필드 누락·형식 깨짐을 막고 상자 수를 정수로 강제한다.
// propertyOrdering을 주지 않으면 모델이 알파벳 순으로 생성하므로, 품번을 수량보다 먼저 읽도록 순서를 고정한다.
const STR = { type: 'STRING' }
const INT = { type: 'INTEGER' }

const ORDER_SCHEMA = {
  type: 'OBJECT',
  properties: {
    branch: STR,
    requester: STR,
    results: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { modelo_raw: STR, modelo: STR, color: STR, raw_qty: STR, boxes: INT, pack_qty: INT, no_de_bultos: INT },
        required: ['modelo_raw', 'modelo', 'color', 'raw_qty', 'boxes', 'pack_qty', 'no_de_bultos'],
        propertyOrdering: ['modelo_raw', 'modelo', 'color', 'raw_qty', 'boxes', 'pack_qty', 'no_de_bultos']
      }
    }
  },
  required: ['branch', 'requester', 'results'],
  propertyOrdering: ['branch', 'requester', 'results']
}

const CARTA_SCHEMA = {
  type: 'OBJECT',
  properties: {
    document_type: STR,
    date: STR,
    origin_raw: STR,
    origin_warehouse: STR,
    destination_raw: STR,
    destination_warehouse: STR,
    transport: STR,
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { modelo_raw: STR, modelo: STR, color: STR, boxes: INT, piezas: INT },
        required: ['modelo_raw', 'modelo', 'color', 'boxes', 'piezas'],
        propertyOrdering: ['modelo_raw', 'modelo', 'color', 'boxes', 'piezas']
      }
    },
    total_boxes: INT
  },
  required: ['items'],
  propertyOrdering: ['document_type', 'date', 'origin_raw', 'origin_warehouse', 'destination_raw', 'destination_warehouse', 'transport', 'items', 'total_boxes']
}

const AUDIT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    date: STR,
    warehouse: STR,
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { modelo_raw: STR, modelo: STR, color: STR, boxes: INT, piezas: INT, uncertain: { type: 'BOOLEAN' } },
        required: ['modelo_raw', 'modelo', 'color', 'boxes', 'piezas', 'uncertain'],
        propertyOrdering: ['modelo_raw', 'modelo', 'color', 'boxes', 'piezas', 'uncertain']
      }
    }
  },
  required: ['items'],
  propertyOrdering: ['date', 'warehouse', 'items']
}

function headerValue(req, name) {
  const v = req.headers?.[name] ?? req.headers?.[name.toLowerCase()]
  return Array.isArray(v) ? v[0] : (v || '')
}

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** Supabase rpc_session_info로 세션 토큰을 검증한다. */
async function verifyWmsSession(token) {
  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  if (!supabaseUrl || !anonKey) {
    return { ok: false, status: 500, error: '서버에 Supabase 환경변수가 설정되지 않았습니다.' }
  }
  if (!token) {
    return { ok: false, status: 401, error: '로그인이 필요합니다.' }
  }
  try {
    const resp = await fetchWithTimeout(`${supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/rpc_session_info`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        'x-wms-session': token
      },
      body: '{}'
    }, SESSION_CHECK_TIMEOUT_MS)
    if (!resp.ok) {
      return { ok: false, status: 401, error: '세션이 만료되었습니다. 다시 로그인하세요.' }
    }
    const data = await resp.json().catch(() => null)
    if (!data?.success) {
      return { ok: false, status: 401, error: '세션이 만료되었습니다. 다시 로그인하세요.' }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, status: 503, error: `세션 확인 실패: ${e.message}` }
  }
}

// 최근 입출고가 있었던 품목의 품번 목록. 손글씨 판독이 애매할 때(5/S, 0/O, O/A 등) 실제 품번 쪽으로 읽게 하는 힌트로 쓴다.
// 전체 카탈로그(약 1,400개)를 보내면 스캔마다 입력이 약 8,600 토큰 늘어나므로, 최근 OCR_CATALOG_DAYS일(기본 90일)
// 안에 움직인 품목(약 370개, 약 2,300 토큰)만 보낸다. 목록에 없는 품목도 화면 매칭은 전체 카탈로그로 한다.
// 서버리스 인스턴스가 살아 있는 동안 메모리에 캐시하고, 불러오지 못하면 힌트 없이 진행한다(OCR 자체는 막지 않음).
let catalogCache = { codes: null, at: 0 }

async function loadCatalogCodes() {
  if (process.env.OCR_CATALOG_HINT === 'off') return null
  if (catalogCache.codes && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.codes

  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  if (!supabaseUrl || !anonKey) return null
  const since = new Date(Date.now() - envInt('OCR_CATALOG_DAYS', 90) * 24 * 60 * 60 * 1000).toISOString()
  try {
    const names = new Set()
    for (let offset = 0; offset < 50000; offset += 1000) {
      const resp = await fetchWithTimeout(
        `${supabaseUrl.replace(/\/+$/, '')}/rest/v1/stock_transactions?select=items(item_name,is_active)` +
          `&created_at=gte.${encodeURIComponent(since)}&order=id&limit=1000&offset=${offset}`,
        { headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` } },
        CATALOG_TIMEOUT_MS
      )
      if (!resp.ok) throw new Error(`stock_transactions ${resp.status}`)
      const rows = await resp.json()
      for (const r of rows) {
        if (r.items?.is_active === false) continue
        const name = String(r.items?.item_name || '').trim()
        // 스모크 테스트 품목(__SMOKETEST_ITEM__) 같은 내부용 이름은 제외
        if (name && !name.startsWith('__')) names.add(name)
      }
      if (rows.length < 1000) break
    }
    // 정렬 고정: 매 호출 프롬프트 앞부분이 같아야 Gemini 암묵적 캐시가 적중한다.
    catalogCache = { codes: [...names].sort(), at: Date.now() }
    return catalogCache.codes
  } catch (e) {
    console.warn('OCR catalog hint skipped:', e.message)
    return catalogCache.codes // 만료된 캐시라도 있으면 사용
  }
}

function catalogHintText(codes) {
  return `Product codes that moved in this store recently are listed below. This is NOT the full catalog: many valid products are missing from it.
Use the list ONLY to resolve ambiguous handwriting in "modelo" (never in "modelo_raw", which is always the literal handwriting):
- If the written code plausibly matches a listed code and differs only by commonly confused characters (5/S, 0/O, O/A, 1/I/L, 8/B, 2/Z) or a missing hyphen/space, output the listed code exactly as listed.
- If the written code is clearly not in the list, transcribe it exactly as written. Do NOT replace it with a different similar-looking listed code: codes that are not in the list are common and valid.
- Keep a written variant suffix letter (e.g. "CK928 K" -> "CK928K") even if that variant is not listed.

RECENT PRODUCT CODES:
${codes.join(', ')}`
}

// ---------------------------------------------------------------------------
// 모델 대체(fallback) 전략
//  - 모델 목록은 OCR_MODELS(쉼표 구분)로 바꿀 수 있다. 앞에서부터 시도한다.
//  - 전체 시간 예산(OCR_DEADLINE_MS) 안에서만 시도한다. 함수 최대 실행시간(vercel.json의 maxDuration)보다
//    짧아야 강제 종료 대신 정상적인 오류 응답을 돌려줄 수 있다.
//  - 첫 모델은 OCR_MODEL_TIMEOUT_MS까지 기다리고, 대체 모델은 남은 예산 안에서만 기다린다.
//  - API 키 오류(401/403)는 어느 모델로 바꿔도 같으므로 즉시 중단한다.
//  - 없는 모델(404)은 이 인스턴스에서 1시간 동안 건너뛴다(매 요청마다 왕복 낭비 방지).
//  - 한도 초과(429)·서버 오류(5xx)·시간 초과·빈 응답·JSON 깨짐은 다음 모델로 넘어간다.
// ---------------------------------------------------------------------------
const DEFAULT_MODELS = ['gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-2.5-flash']
const MISSING_MODEL_SKIP_MS = 60 * 60 * 1000
const MIN_ATTEMPT_MS = 3000
const missingModels = new Map() // model -> 다시 시도해도 되는 시각

function envInt(name, fallback) {
  const v = parseInt(process.env[name], 10)
  return Number.isFinite(v) && v > 0 ? v : fallback
}

function modelList() {
  const fromEnv = String(process.env.OCR_MODELS || '').split(',').map(s => s.trim()).filter(Boolean)
  return fromEnv.length ? fromEnv : DEFAULT_MODELS
}

/** Gemini 오류 본문에서 사람이 읽을 한 줄만 뽑는다(원문 JSON 전체를 사용자에게 보여주지 않음). */
async function briefError(resp) {
  const text = await resp.text().catch(() => '')
  try {
    const msg = JSON.parse(text)?.error?.message
    if (msg) return String(msg).slice(0, 200)
  } catch { /* JSON이 아니면 원문 일부 */ }
  return text.slice(0, 200)
}

async function generateWithFallback({ apiKey, body, listKey, startedAt }) {
  // 예산은 요청 도착 시점부터 센다(세션 확인·카탈로그 로딩 시간 포함).
  const deadline = startedAt + envInt('OCR_DEADLINE_MS', 50000)
  const firstTimeout = envInt('OCR_MODEL_TIMEOUT_MS', MODEL_TIMEOUT_MS)
  const attempts = []
  const payload = JSON.stringify(body)

  for (const model of modelList()) {
    const skipUntil = missingModels.get(model)
    if (skipUntil && skipUntil > Date.now()) {
      attempts.push({ model, outcome: 'skipped-missing', ms: 0 })
      continue
    }
    const remaining = deadline - Date.now()
    if (remaining < MIN_ATTEMPT_MS) break

    const t0 = Date.now()
    const record = (outcome, detail) => {
      const a = { model, outcome, ms: Date.now() - t0 }
      if (detail) a.detail = detail
      attempts.push(a)
      console.warn(`OCR model ${model}: ${outcome}${detail ? ` - ${detail}` : ''}`)
    }

    let resp
    try {
      resp = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        // 키를 URL이 아닌 헤더로 보내 로그·오류 메시지에 남지 않게 한다.
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: payload },
        Math.min(firstTimeout, remaining)
      )
    } catch (e) {
      record(e.name === 'AbortError' ? 'timeout' : 'network', e.name === 'AbortError' ? '' : e.message)
      continue
    }

    if (!resp.ok) {
      const detail = await briefError(resp)
      if (resp.status === 401 || resp.status === 403) {
        record(`http-${resp.status}`, detail)
        return { ok: false, status: 500, error: 'Gemini API 키가 유효하지 않거나 권한이 없습니다. 관리자에게 문의하세요.', attempts }
      }
      if (resp.status === 404) missingModels.set(model, Date.now() + MISSING_MODEL_SKIP_MS)
      record(`http-${resp.status}`, detail)
      continue
    }

    const json = await resp.json().catch(() => null)
    const candidate = json?.candidates?.[0]
    const text = candidate?.content?.parts?.find(p => typeof p.text === 'string' && !p.thought)?.text
    if (!text) {
      record('empty', candidate?.finishReason || json?.promptFeedback?.blockReason || 'no candidates')
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      record('bad-json', candidate?.finishReason || '')
      continue
    }
    if (!parsed || !Array.isArray(parsed[listKey])) {
      record('bad-shape', `missing ${listKey}`)
      continue
    }

    attempts.push({ model, outcome: 'ok', ms: Date.now() - t0 })
    return { ok: true, parsed, model, usageMetadata: json.usageMetadata || null, attempts }
  }

  return { ok: false, ...failureResponse(attempts), attempts }
}

/** 시도 기록을 보고 사용자에게 보여줄 상태코드와 메시지를 정한다. */
function failureResponse(attempts) {
  const tried = attempts.filter(a => a.outcome !== 'skipped-missing')
  const summary = tried.map(a => `${a.model}: ${a.outcome}`).join(', ') || '시도한 모델 없음'
  if (tried.length && tried.every(a => a.outcome === 'http-429')) {
    return { status: 429, error: `AI 사용량 한도를 초과했습니다. 1~2분 뒤 다시 시도하세요. (${summary})` }
  }
  if (tried.length && tried.every(a => a.outcome === 'timeout')) {
    return { status: 504, error: `AI 분석이 시간 안에 끝나지 않았습니다. 사진 영역을 좁혀 다시 시도하세요. (${summary})` }
  }
  if (tried.some(a => a.outcome === 'empty' && /SAFETY|PROHIBITED|BLOCK/i.test(a.detail || ''))) {
    return { status: 422, error: `AI가 이 이미지를 처리하지 않았습니다(안전 필터). 주문서 부분만 잘라 다시 시도하세요. (${summary})` }
  }
  return { status: 502, error: `AI 분석에 실패했습니다. 잠시 뒤 다시 시도하세요. (${summary})` }
}

/**
 * OCR 정답 세트 자동 수집(ocr_samples). 실패해도 OCR 결과는 그대로 돌려준다.
 * OCR_SAMPLE_COLLECT=off로 끌 수 있다. 저장 정책은 supabase/migrations/20261003120000_ocr_samples.sql 참고.
 */
async function saveOcrSample({ token, scanType, imageB64, ocrResult, usedModel, deadline }) {
  if (process.env.OCR_SAMPLE_COLLECT === 'off') return null
  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  const remaining = Math.min(SAMPLE_SAVE_TIMEOUT_MS, deadline - Date.now())
  if (!supabaseUrl || !anonKey || remaining < 500) return null
  try {
    const resp = await fetchWithTimeout(`${supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/rpc_ocr_sample_create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        'x-wms-session': token
      },
      body: JSON.stringify({ p_scan_type: scanType, p_image_b64: imageB64, p_ocr_result: ocrResult, p_used_model: usedModel })
    }, remaining)
    if (!resp.ok) {
      console.warn('OCR sample save skipped:', resp.status, (await resp.text().catch(() => '')).slice(0, 200))
      return null
    }
    const id = await resp.json().catch(() => null)
    return typeof id === 'string' ? id : null
  } catch (e) {
    console.warn('OCR sample save skipped:', e.message)
    return null
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' })
  }

  const startedAt = Date.now()
  try {
    // 카탈로그는 공개 읽기 데이터라 세션 확인과 동시에 불러와 대기 시간을 줄인다.
    const catalogPromise = loadCatalogCodes()
    const sessionToken = headerValue(req, 'x-wms-session').trim()
    const session = await verifyWmsSession(sessionToken)
    if (!session.ok) {
      return res.status(session.status).json({ error: session.error })
    }

    const { type, imageBase64 } = req.body || {}
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return res.status(400).json({ error: '전달된 이미지 데이터가 없습니다.' })
    }
    if (imageBase64.length > MAX_IMAGE_BASE64_CHARS) {
      return res.status(413).json({ error: '이미지가 너무 큽니다. 해상도를 낮춰 다시 시도하세요.' })
    }

    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      return res.status(500).json({ error: '서버에 GEMINI_API_KEY 환경변수가 설정되지 않았습니다.' })
    }

    let cleanB64 = imageBase64
    if (cleanB64.indexOf(',') > -1) {
      cleanB64 = cleanB64.split(',')[1]
    }

    const isCarta = (type === 'cartadeporte')
    const isAudit = (type === 'audit')

    let promptText = ''
    if (isCarta) {
      promptText = `Analyze this Mexican freight delivery document ("Carta de Porte" / "Nota de Remisión" / transport invoice).
Extract the following:
1. "document_type": Document title, e.g. "Carta de Porte".
2. "date": Date of loading (e.g. "2026-09-09").
3. "origin_raw": Origin text.
4. "origin_warehouse": Warehouse name ('PANTACO', 'IKEA', 'LERMA', 'PINO', 'YARE', 'ALMINTER', 'TLANE', 'STAR').
5. "destination_raw": Destination text.
6. "destination_warehouse": "ALARCON" or warehouse name.
7. "transport": Carrier info.
8. "items": Array of { "modelo_raw": string, "modelo": string, "color": string, "boxes": number, "piezas": number }.
   - "modelo_raw": The product code exactly as written on the page for this item, uppercase, keeping spaces and hyphens, with NO correction (e.g. "YES016", "CCAK999 C", "P-l60" read as "P-L60"). For a split multi-variant row, use the base code plus that item's variant (e.g. "CK928 K").
   - Disambiguation: Letter 'O' often looks like 'A' in Mexican handwriting. If loop without right leg, transcribe as 'O', not 'A'.
   - Multi-Variant Splitting: If a row lists multiple variants or colors (e.g., 'CK928 K, J' with 2 boxes), split into separate items with divided box quantities (e.g., 'CK928K' 1 box, 'CK928J' 1 box).
9. "total_boxes": Total boxes number.

Directly extract visible text without excessive deliberation. Return ONLY valid JSON.`
    } else if (isAudit) {
      promptText = `Analyze this warehouse stock count sheet ("Inventario" / physical inventory count, often handwritten).
Each written row is one counted product.
Extract:
1. "date": Count date if visible (e.g. "2026-09-09"), else "".
2. "warehouse": Warehouse/location name if written, else "".
3. "items": Array of { "modelo_raw": string, "modelo": string, "color": string, "boxes": number, "piezas": number, "uncertain": boolean }.
   - "modelo_raw": The product code exactly as written on the page for this item, uppercase, keeping spaces and hyphens, with NO correction (e.g. "YES016", "CCAK999 C", "P-l60" read as "P-L60"). For a split multi-variant row, use the base code plus that item's variant (e.g. "CK928 K").
   - "modelo": Product code (clean uppercase code, e.g. "CK928K", "CECIK999C", "YE5015"). Mexican handwritten '5' may resemble 'S' and '0' may resemble 'O'; letter 'O' may look like 'A'.
   - "color": Color word if written (Negro, Blanco, Azul, Surtido, etc.), else "".
   - "boxes": Counted full boxes (integer, 0 if none).
   - "piezas": Counted loose pieces (integer, 0 if none). If the sheet has a single count column, treat it as boxes unless it is labeled as pieces (pz, pzas, piezas).
   - "uncertain": true if the code or any count is hard to read, else false. Never invent a count; give your best reading and mark it uncertain.
   - Skip header rows, total rows, and crossed-out rows. Do NOT merge rows.
   - Multi-Variant / Multi-Color rows: a row may bundle several letter variants or colors
     (e.g. "CK928 J, K", "CK928 J/K", "CECIK999 C, D, K", "P-160 negro, blanco"; connectors can be comma, slash, space, hyphen, "y", "&").
     Split it into one item per variant: letter variants are appended to the code with color "SURTIDO" ("CK928J", "CK928K");
     color words stay as color with the same code ("P-160" NEGRO, "P-160" BLANCO).
     * If a count is written per variant (e.g. "negro 2, blanco 1" or "J 3 K 4"), use those exact counts and keep "uncertain" as read.
     * If only one combined count is written for the row, divide it equally as integers (give any remainder to the first variants)
       and set "uncertain": true on EVERY item from that row, because the real per-variant count is unknown.

Directly extract visible text without excessive deliberation. Return ONLY valid JSON.`
    } else {
      promptText = `Extract all handwritten order rows from the image.
Rules:
1. Header:
   - "branch": Customer or store name at top header (e.g. "william", "Fernando", "CARMEN", "Abelardo", "Tienda"). Standalone top name is customer/branch!
   - "requester": Internal salesperson name only if underlined or explicitly marked.
2. Category vs Model: Do NOT prepend category titles (e.g. "Termico niños") to model name. If row has only "60", extract "60".
3. Row Parsing:
   - "modelo_raw": The product code exactly as written on the page for this item, uppercase, keeping spaces and hyphens, with NO correction (e.g. "YES016", "CCAK999 C", "P-l60" read as "P-L60"). For a split multi-variant row, use the base code plus that item's variant (e.g. "CK928 K").
   - "modelo": Product code (clean uppercase code, e.g. "CK928K", "CECIK999C", "MIS0081", "SLT1205", "5015", "YE5015"). Note: Mexican handwritten digits often have curved '5' resembling 'S' and '0' resembling 'O'. Transcribe numeric model codes accurately.
   - "color": Color word (Negro, Blanco, Azul, Surtido, etc.). If letter variant like CK928O, append letter to model and color="SURTIDO".
   - "raw_qty": Exact quantity string (e.g. "5", "3 x 72", "2 x 120", "10P").
   - "boxes": Integer boxes count.
   - "pack_qty": Pieces per box (if "3 x 72" then 72, if "2 x 120" then 120, else 0).
   - "no_de_bultos": Same as boxes.
4. 💥 Multi-Variant / Multi-Color Auto-Splitting (CRITICAL):
   - When a handwritten row bundles multiple variants or colors into a single line:
     * Model with letter variants: e.g. "CK928 K, J", "CK928 K J", "CK928 K/J", "CK928 K y J" with quantity "2 x 120":
       DO NOT return as a single "CK928 K, J" row!
       You MUST split them into separate distinct rows in the "results" array, dividing the box quantity equally:
       Row 1: {"modelo": "CK928K", "color": "SURTIDO", "raw_qty": "1 x 120", "boxes": 1, "pack_qty": 120, "no_de_bultos": 1}
       Row 2: {"modelo": "CK928J", "color": "SURTIDO", "raw_qty": "1 x 120", "boxes": 1, "pack_qty": 120, "no_de_bultos": 1}
     * Model with multiple color words: e.g. "P-160 negro, blanco" with quantity "2 x 100" (or 2 boxes):
       Row 1: {"modelo": "P-160", "color": "NEGRO", "raw_qty": "1 x 100", "boxes": 1, "pack_qty": 100, "no_de_bultos": 1}
       Row 2: {"modelo": "P-160", "color": "BLANCO", "raw_qty": "1 x 100", "boxes": 1, "pack_qty": 100, "no_de_bultos": 1}
     * If 3 variants listed (e.g. "CECIK999 C, D, K" with "3 x 72" or 3 boxes):
       Split into 3 rows with 1 box each: CECIK999C (1 box), CECIK999D (1 box), CECIK999K (1 box).
     * If specific quantities are written per variant (e.g. "negro 2, blanco 1"), assign those exact counts.
   - Connectors can be comma (,), slash (/), space ( ), hyphen (-), or Spanish "y" / "&".
5. Fast Extraction: Read along baseline grid directly without excessive deliberation.
6. Use "" for any header field that is not on the page.`
    }

    const responseSchema = isCarta ? CARTA_SCHEMA : (isAudit ? AUDIT_SCHEMA : ORDER_SCHEMA)

    // 카탈로그 힌트를 맨 앞 파트에 둔다. 같은 앞부분이 반복되어야 Gemini 암묵적 캐시가 적중한다.
    const catalogCodes = await catalogPromise
    const parts = []
    if (catalogCodes && catalogCodes.length) parts.push({ text: catalogHintText(catalogCodes) })
    parts.push({ text: promptText })
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: cleanB64 } })

    const result = await generateWithFallback({
      apiKey,
      body: {
        contents: [{ parts }],
        generationConfig: {
          response_mime_type: 'application/json',
          response_schema: responseSchema,
          temperature: 0.1,
          thinking_config: {
            thinking_budget: 1024
          }
        }
      },
      listKey: isCarta || isAudit ? 'items' : 'results',
      startedAt
    })

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, attempts: result.attempts })
    }
    const parsed = result.parsed
    parsed.usedModel = result.model
    parsed.usageMetadata = result.usageMetadata
    parsed.catalogHintSize = catalogCodes ? catalogCodes.length : 0
    parsed.attempts = result.attempts
    // 정답 세트 수집: 사진과 판독 결과를 저장하고 id를 화면에 넘긴다(제출 때 확정 품목을 붙임).
    const { usageMetadata, attempts, ...ocrResult } = parsed
    parsed.ocrSampleId = await saveOcrSample({
      token: sessionToken,
      scanType: isCarta ? 'cartadeporte' : (isAudit ? 'audit' : 'handwritten'),
      imageB64: cleanB64,
      ocrResult,
      usedModel: result.model,
      deadline: startedAt + envInt('OCR_DEADLINE_MS', 50000) + 5000
    })
    return res.status(200).json(parsed)
  } catch (err) {
    console.error('OCR API Handler error:', err)
    return res.status(500).json({ error: err.message || '서버 오류' })
  }
}
