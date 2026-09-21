// api/ai-query.js
// Vercel Serverless Function: AI Natural Language Inventory Query & Order Auto-Drafting (Chat BI)
// Token Circuit Breaker (thinking_budget: 0) & 3-Tier Token Breakdown

const MODEL_TIMEOUT_MS = 15000
const SESSION_CHECK_TIMEOUT_MS = 10000
const DB_TIMEOUT_MS = 15000

// 세션 토큰 60초 메모리 캐시 (불필요한 Tokyo 왕복 지연 방지)
const sessionCache = new Map()
const SESSION_CACHE_TTL_MS = 60 * 1000

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
async function verifyWmsSession(token, supabaseUrl, anonKey) {
  if (!token) {
    return { ok: false, status: 401, error: '로그인이 필요합니다.' }
  }

  // 1. 메모리 캐시 확인
  const cached = sessionCache.get(token)
  if (cached && cached.expiry > Date.now()) {
    return { ok: true, user: cached.user }
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
      sessionCache.delete(token)
      return { ok: false, status: 401, error: '세션이 만료되었습니다. 다시 로그인하세요.' }
    }
    const data = await resp.json().catch(() => null)
    if (!data?.success) {
      sessionCache.delete(token)
      return { ok: false, status: 401, error: '세션이 만료되었습니다. 다시 로그인하세요.' }
    }

    // 캐시 저장
    sessionCache.set(token, { user: data.user, expiry: Date.now() + SESSION_CACHE_TTL_MS })
    return { ok: true, user: data.user }
  } catch (e) {
    return { ok: false, status: 503, error: `세션 확인 실패: ${e.message}` }
  }
}

const SYSTEM_SCHEMA_PROMPT = `You are an expert PostgreSQL DBA and Logistics Operations AI for a high-volume WMS (Warehouse Management System).
Analyze the user's natural language request and determine whether it is a "QUERY" (viewing/analyzing data) or a "DRAFT_ORDER" (creating/drafting an outbound, inbound, or stock move order).

### DATABASE SCHEMA:
1. public.items (id UUID, item_name TEXT, color TEXT, box_packaging_qty INT, is_active BOOLEAN, memo TEXT, created_at TIMESTAMPTZ)
2. public.inventory_stocks (id UUID, item_id UUID, warehouse_code TEXT, box_qty INT, unit_qty INT, safe_stock_boxes INT, updated_at TIMESTAMPTZ)
   - Warehouses: 'MAIN' (Main Hub), 'PANTACO', 'IKEA', 'TLANE', 'PINO', 'LERMA', 'ALMINTER', 'YARE'
3. public.stock_transactions (id UUID, transaction_type TEXT, item_id UUID, warehouse_code TEXT, source_warehouse TEXT, target_warehouse TEXT, partner_name TEXT, invoice_no TEXT, box_qty INT, unit_qty INT, memo TEXT, created_at TIMESTAMPTZ)
   - transaction_type: 'INBOUND', 'OUTBOUND', 'MOVE', 'ADJUST'
4. public.partners (id UUID, name TEXT, is_supplier BOOLEAN, is_customer BOOLEAN, is_branch BOOLEAN, warehouse_code TEXT, memo TEXT)
   - Partners: 'TIENDA', 'GUILLEN', 'CHINCONCUAC (SR.KIM)', 'PANTACO', 'IKEA', '공장 직입고', '수입 컨테이너', etc.
5. public.view_effective_stocks (item_id UUID, item_name TEXT, color TEXT, box_packaging_qty INT, main_box_qty INT, safe_stock_boxes INT, pending_in_boxes INT, effective_box_qty INT)
   - Real-time effective available stock view.

### INTENT DETECTION RULES:
1. If the user asks to VIEW, COUNT, SUM, PIVOT, RANK, LIST, or CHECK data:
   - "intent": "QUERY"
   - Output valid PostgreSQL SELECT SQL, explanation, title, suggested_chart_type.
   - ONLY produce SELECT statements (no INSERT/UPDATE/DELETE/DROP). Add LIMIT 100 for non-aggregated lists.
2. If the user asks to DRAFT, PREPARE, CREATE, WRITE, or FILL an ORDER / MOVEMENT (e.g. "티엔다로 PT88 3상자 출고서 짜줘", "판타코로 PT146 5상자 이동 주문서 작성해줘", "공장 직입고 입고서 작성해줘", "출고 탭에 담아줘"):
   - "intent": "DRAFT_ORDER"
   - "orderType": "out" (for outbound shipping or branch transfer) | "in" (for inbound receiving) | "adj" (for inventory audit/adjustment)
   - "targetPage": "출고입력" (for out) | "입고입력" (for in) | "재고조정" (for adj)
   - "location": Partner/branch name extracted from query (e.g. "TIENDA", "PANTACO", "GUILLEN", etc. If unspecified, use "미지정")
   - "sourceWarehouse": "MAIN" (default unless specified)
   - "targetWarehouse": Target warehouse if move, else null
   - "items": Array of { "model": string, "color": string, "boxQty": number, "unitQty": number }
   - "explanation": Korean summary of the drafted order.
   - "title": Korean title (e.g. "TIENDA 지점 출고 주문서 초안")

### OUTPUT FORMAT:
Return ONLY valid JSON with NO markdown fences:
{
  "intent": "QUERY" | "DRAFT_ORDER",
  "sql": "SELECT ... (if QUERY)",
  "orderType": "out" | "in" | "adj" (if DRAFT_ORDER),
  "targetPage": "출고입력" | "입고입력" | "재고조정" (if DRAFT_ORDER),
  "location": "..." (if DRAFT_ORDER),
  "sourceWarehouse": "MAIN",
  "targetWarehouse": null,
  "items": [ {"model": "...", "color": "SURTIDO", "boxQty": 3, "unitQty": 0} ] (if DRAFT_ORDER),
  "explanation": "...",
  "title": "...",
  "suggested_chart_type": "table"
}
Directly output the JSON without unnecessary conversational fluff or overthinking.`

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' })
  }

  const startTime = Date.now()

  try {
    const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
    const anonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
    const apiKey = process.env.GEMINI_API_KEY

    if (!supabaseUrl || !anonKey) {
      return res.status(500).json({ error: '서버에 Supabase 환경변수가 설정되지 않았습니다.' })
    }
    if (!apiKey) {
      return res.status(500).json({ error: '서버에 GEMINI_API_KEY 환경변수가 설정되지 않았습니다.' })
    }

    // 1. 세션 토큰 검증
    const token = headerValue(req, 'x-wms-session').trim()
    const session = await verifyWmsSession(token, supabaseUrl, anonKey)
    if (!session.ok) {
      return res.status(session.status).json({ error: session.error })
    }

    const { question } = req.body || {}
    if (!question || typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ error: '질문 내용을 입력해주세요.' })
    }

    const cleanQuestion = question.trim()

    // 2. Gemini 호출 (Fast Intent & Query Generator with thinking_budget: 0)
    const models = ['gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-2.5-flash']
    let lastError = null
    let aiParsed = null
    let usedModel = null
    let usageMeta = null

    for (const model of models) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
      const payload = {
        contents: [
          {
            role: 'user',
            parts: [
              { text: SYSTEM_SCHEMA_PROMPT },
              { text: `User Request: "${cleanQuestion}"\nGenerate the JSON output now:` }
            ]
          }
        ],
        generationConfig: {
          response_mime_type: 'application/json',
          temperature: 0.1,
          thinking_config: {
            thinking_budget: 0 // 토큰 두꺼비집: 챗봇 즉답 모드
          }
        }
      }

      try {
        const resp = await fetchWithTimeout(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }, MODEL_TIMEOUT_MS)

        if (resp.ok) {
          const json = await resp.json()
          const candidate = json.candidates?.[0]
          const textPart = candidate?.content?.parts?.[0]?.text
          if (textPart) {
            aiParsed = JSON.parse(textPart)
            usedModel = model
            usageMeta = json.usageMetadata || null
            break
          }
        } else {
          const errData = await resp.text()
          lastError = `Model ${model} returned ${resp.status}: ${errData}`
          console.warn(lastError)
        }
      } catch (callErr) {
        lastError = `Model ${model} error: ${callErr.message}`
        console.warn(lastError)
      }
    }

    if (!aiParsed) {
      return res.status(500).json({
        error: lastError || 'AI 요청 분석에 실패했습니다. 내용을 구체적으로 작성해주세요.'
      })
    }

    // 3대 토큰 분리 메타데이터
    const tokenMetrics = {
      promptTokenCount: usageMeta?.promptTokenCount || 0,
      candidatesTokenCount: usageMeta?.candidatesTokenCount || 0,
      thoughtsTokenCount: usageMeta?.thoughtsTokenCount || 0,
      totalTokenCount: usageMeta?.totalTokenCount || ((usageMeta?.promptTokenCount || 0) + (usageMeta?.candidatesTokenCount || 0))
    }

    // =========================================================================
    // CASE A: 주문서 자동 초안 작성 (DRAFT_ORDER)
    // =========================================================================
    if (aiParsed.intent === 'DRAFT_ORDER') {
      const rawItems = Array.isArray(aiParsed.items) ? aiParsed.items : []
      const sourceWarehouse = aiParsed.sourceWarehouse || 'MAIN'
      let enrichedItems = []

      if (rawItems.length > 0) {
        // 품목 마스터 및 출발창고 실재고 즉시 조회
        const escapedModels = rawItems
          .map(i => `'${String(i.model || '').replace(/'/g, "''").trim().toUpperCase()}'`)
          .filter(Boolean)
          .join(',')

        if (escapedModels) {
          const checkSql = `
            SELECT 
              i.id,
              i.item_name,
              i.color,
              COALESCE(i.box_packaging_qty, 1) AS box_packaging_qty,
              COALESCE(s.box_qty, 0) AS current_box_qty,
              COALESCE(s.unit_qty, 0) AS current_unit_qty
            FROM public.items i
            LEFT JOIN public.inventory_stocks s 
              ON s.item_id = i.id AND s.warehouse_code = '${sourceWarehouse}'
            WHERE UPPER(i.item_name) IN (${escapedModels})
          `

          try {
            const rpcUrl = `${supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/rpc_exec_readonly_query`
            const rpcResp = await fetchWithTimeout(rpcUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                apikey: anonKey,
                Authorization: `Bearer ${anonKey}`
              },
              body: JSON.stringify({ p_sql: checkSql })
            }, DB_TIMEOUT_MS)

            if (rpcResp.ok) {
              const qRes = await rpcResp.json()
              const dbRows = qRes?.data || []

              enrichedItems = rawItems.map(it => {
                const match = dbRows.find(d => d.item_name.toUpperCase() === String(it.model).trim().toUpperCase())
                const boxContent = match ? Number(match.box_packaging_qty) : 1
                const currentStock = match ? Number(match.current_box_qty) : 0
                const boxQty = Number(it.boxQty) || 0
                const unitQty = Number(it.unitQty) || 0
                const isSufficient = (currentStock >= boxQty)

                return {
                  model: match?.item_name || it.model,
                  color: it.color || match?.color || 'SURTIDO',
                  boxQty,
                  unitQty,
                  boxContent,
                  currentStock,
                  isSufficient,
                  isCatalogMatch: Boolean(match)
                }
              })
            }
          } catch (enrichErr) {
            console.warn('Draft stock check warning:', enrichErr)
          }
        }
      }

      // 폴백: DB 조회가 안 되었더라도 기본 아이템 목록 유지
      if (enrichedItems.length === 0) {
        enrichedItems = rawItems.map(it => ({
          model: it.model,
          color: it.color || 'SURTIDO',
          boxQty: Number(it.boxQty) || 0,
          unitQty: Number(it.unitQty) || 0,
          boxContent: 1,
          currentStock: 0,
          isSufficient: true,
          isCatalogMatch: true
        }))
      }

      const totalTimeMs = Date.now() - startTime
      return res.status(200).json({
        success: true,
        isDraft: true,
        intent: 'DRAFT_ORDER',
        question: cleanQuestion,
        explanation: aiParsed.explanation || '주문서 초안을 작성했습니다.',
        title: aiParsed.title || `${aiParsed.location || ''} 주문서 초안`,
        draft: {
          orderType: aiParsed.orderType || 'out',
          targetPage: aiParsed.targetPage || '출고입력',
          location: aiParsed.location || '미지정',
          sourceWarehouse: sourceWarehouse,
          targetWarehouse: aiParsed.targetWarehouse || null,
          items: enrichedItems
        },
        tokenMetrics,
        usedModel,
        executionTimeMs: totalTimeMs
      })
    }

    // =========================================================================
    // CASE B: 일반 SELECT 조회 및 피벗 테이블 (QUERY)
    // =========================================================================
    if (!aiParsed.sql) {
      return res.status(500).json({
        error: lastError || 'AI 쿼리 생성에 실패했습니다. 질문을 구체적으로 작성해주세요.'
      })
    }

    const generatedSql = aiParsed.sql.trim()

    // Supabase RPC로 안전한 읽기 전용 쿼리 실행
    const rpcUrl = `${supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/rpc_exec_readonly_query`
    const rpcResp = await fetchWithTimeout(rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`
      },
      body: JSON.stringify({ p_sql: generatedSql })
    }, DB_TIMEOUT_MS)

    if (!rpcResp.ok) {
      const rpcErr = await rpcResp.text()
      return res.status(500).json({
        error: `데이터베이스 실행 실패: ${rpcErr}`,
        sql: generatedSql
      })
    }

    const queryResult = await rpcResp.json()
    if (!queryResult.success) {
      return res.status(400).json({
        error: `SQL 구문 오류 또는 권한 제한: ${queryResult.error}`,
        sql: generatedSql,
        explanation: aiParsed.explanation
      })
    }

    const rows = queryResult.data || []
    const columns = rows.length > 0 ? Object.keys(rows[0]) : []
    const totalTimeMs = Date.now() - startTime

    return res.status(200).json({
      success: true,
      isDraft: false,
      intent: 'QUERY',
      question: cleanQuestion,
      sql: generatedSql,
      explanation: aiParsed.explanation || '조회 결과를 불러왔습니다.',
      title: aiParsed.title || '재고 데이터 분석 결과',
      chartType: aiParsed.suggested_chart_type || 'table',
      rows,
      columns,
      rowCount: rows.length,
      tokenMetrics,
      usedModel,
      executionTimeMs: totalTimeMs
    })

  } catch (err) {
    console.error('AI Query Handler error:', err)
    return res.status(500).json({
      error: err.message || '서버 내부 오류가 발생했습니다.'
    })
  }
}
