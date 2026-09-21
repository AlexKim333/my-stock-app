// api/ai-query.js
// Vercel Serverless Function: AI Natural Language Inventory & Pivot Query (Chat BI)
// Token Circuit Breaker (thinking_budget: 0) & 3-Tier Token Breakdown

const MODEL_TIMEOUT_MS = 15000
const SESSION_CHECK_TIMEOUT_MS = 5000
const DB_TIMEOUT_MS = 15000

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
    return { ok: true, user: data.user }
  } catch (e) {
    return { ok: false, status: 503, error: `세션 확인 실패: ${e.message}` }
  }
}

const SYSTEM_SCHEMA_PROMPT = `You are an expert PostgreSQL DBA and Logistics Analytics AI for a high-volume WMS (Warehouse Management System).
Generate a single, precise, performant, READ-ONLY PostgreSQL SELECT query based on the user's natural language question.

### DATABASE SCHEMA & SEMANTICS:
1. public.items (id UUID, item_name TEXT, color TEXT, box_packaging_qty INT, is_active BOOLEAN, memo TEXT, created_at TIMESTAMPTZ)
   - Product master. item_name is model code (e.g. 'PT88', 'LIGA1204'). box_packaging_qty is units per box.
2. public.inventory_stocks (id UUID, item_id UUID, warehouse_code TEXT, box_qty INT, unit_qty INT, safe_stock_boxes INT, updated_at TIMESTAMPTZ)
   - Real-time physical inventory by warehouse.
   - warehouse_code: 'MAIN' (Main Hub), 'PANTACO', 'IKEA', 'TLANE', 'PINO', 'LERMA', 'ALMINTER', 'YARE' (Sub/External warehouses).
   - Foreign key: item_id references items(id).
3. public.stock_transactions (id UUID, transaction_type TEXT, item_id UUID, warehouse_code TEXT, source_warehouse TEXT, target_warehouse TEXT, partner_name TEXT, invoice_no TEXT, box_qty INT, unit_qty INT, memo TEXT, created_at TIMESTAMPTZ)
   - Transaction log for all inventory movements.
   - transaction_type:
     * 'INBOUND': Receiving products from suppliers or imports into warehouse_code.
     * 'OUTBOUND': Shipping orders to branches/customers (partner_name has the branch/customer name).
     * 'MOVE': Transfer between warehouses (source_warehouse -> target_warehouse).
     * 'ADJUST': Inventory physical audit correction.
4. public.partners (id UUID, name TEXT, is_supplier BOOLEAN, is_customer BOOLEAN, is_branch BOOLEAN, warehouse_code TEXT, memo TEXT)
   - Business partners (branches, retail customers, suppliers).
5. public.view_effective_stocks (item_id UUID, item_name TEXT, color TEXT, box_packaging_qty INT, main_box_qty INT, safe_stock_boxes INT, pending_in_boxes INT, effective_box_qty INT)
   - Real-time effective available stock view.
   - effective_box_qty = main_box_qty - safe_stock_boxes + pending_in_boxes.
   - Ideal for stock shortage analysis (where effective_box_qty < 0 or main_box_qty <= safe_stock_boxes).
6. public.view_branch_stocks (partner_name TEXT, item_id UUID, item_name TEXT, color TEXT, total_outbound_boxes INT, total_outbound_units INT, total_return_boxes INT, current_branch_boxes INT)
   - Branch store inventory view based on outbound & return transactions.

### RULES:
1. ONLY produce valid PostgreSQL SELECT statements (or WITH ... SELECT). NEVER produce INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, or CREATE statements.
2. Provide clear column aliases in Korean or readable English (e.g. SELECT i.item_name AS "품목명", s.box_qty AS "현재고_상자" ...).
3. Add 'LIMIT 100' for list queries if no GROUP BY aggregation is used, to avoid overflowing the UI. For GROUP BY / pivot queries, limit to top 50 if rows are large.
4. If the user asks about shortage/safety stock, prefer using view_effective_stocks or joining items with inventory_stocks (warehouse_code = 'MAIN').
5. Output format must be strictly JSON with NO markdown fences:
{
  "sql": "SELECT ...",
  "explanation": "한 줄 요약 설명 (한국어)",
  "title": "결과 테이블 제목 (예: 창고별 재고 현황 피벗)",
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

    // 2. Gemini 호출 (Fast Text-to-SQL with thinking_budget: 0)
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
              { text: `User Question: "${cleanQuestion}"\nGenerate the JSON output now:` }
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

    if (!aiParsed || !aiParsed.sql) {
      return res.status(500).json({
        error: lastError || 'AI 쿼리 생성에 실패했습니다. 질문을 구체적으로 작성해주세요.'
      })
    }

    const generatedSql = aiParsed.sql.trim()

    // 3. Supabase RPC로 안전한 읽기 전용 쿼리 실행
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

    // 3대 토큰 분리 메타데이터
    const tokenMetrics = {
      promptTokenCount: usageMeta?.promptTokenCount || 0,
      candidatesTokenCount: usageMeta?.candidatesTokenCount || 0,
      thoughtsTokenCount: usageMeta?.thoughtsTokenCount || 0,
      totalTokenCount: usageMeta?.totalTokenCount || ((usageMeta?.promptTokenCount || 0) + (usageMeta?.candidatesTokenCount || 0))
    }

    return res.status(200).json({
      success: true,
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
