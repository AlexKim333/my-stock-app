// api/ocr.js
// Vercel Serverless Function: Gemini OCR with Token Circuit Breaker (thinking_budget: 1024)

export default async function handler(req, res) {
  // CORS & Preflight
  res.setHeader('Access-Control-Allow-Credentials', true)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  )

  if (req.method === 'OPTIONS') {
    res.status(200).end()
    return
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' })
  }

  try {
    const { type, imageBase64 } = req.body || {}
    if (!imageBase64) {
      return res.status(400).json({ error: '전달된 이미지 데이터가 없습니다.' })
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
8. "items": Array of { "modelo": string, "color": string, "boxes": number, "piezas": number }.
   - Disambiguation: Letter 'O' often looks like 'A' in Mexican handwriting. If loop without right leg, transcribe as 'O', not 'A'.
   - Multi-Variant Splitting: If a row lists multiple variants or colors (e.g., 'CK928 K, J' with 2 boxes), split into separate items with divided box quantities (e.g., 'CK928K' 1 box, 'CK928J' 1 box).
9. "total_boxes": Total boxes number.

Directly extract visible text without excessive deliberation. Return ONLY valid JSON.`
    } else {
      promptText = `Extract all handwritten order rows from the image.
Rules:
1. Header:
   - "branch": Customer or store name at top header (e.g. "william", "Fernando", "CARMEN", "Abelardo", "Tienda"). Standalone top name is customer/branch!
   - "requester": Internal salesperson name only if underlined or explicitly marked.
2. Category vs Model: Do NOT prepend category titles (e.g. "Termico niños") to model name. If row has only "60", extract "60".
3. Row Parsing:
   - "modelo": Product code (clean uppercase code, e.g. "CK928K", "CCAK999C", "MIS0081", "SLT1205").
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
     * If 3 variants listed (e.g. "CCAK999 C, D, K" with "3 x 72" or 3 boxes):
       Split into 3 rows with 1 box each: CCAK999C (1 box), CCAK999D (1 box), CCAK999K (1 box).
     * If specific quantities are written per variant (e.g. "negro 2, blanco 1"), assign those exact counts.
   - Connectors can be comma (,), slash (/), space ( ), hyphen (-), or Spanish "y" / "&".
5. Fast Extraction: Read along baseline grid directly without excessive deliberation.

Return ONLY valid JSON:
{
  "branch": "...",
  "requester": "...",
  "results": [
    {"modelo": "...", "color": "...", "raw_qty": "...", "boxes": 1, "pack_qty": 0, "no_de_bultos": 1}
  ]
}`
    }

    const models = ['gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-2.5-flash']
    let lastError = null

    for (const model of models) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
      const payload = {
        contents: [{
          parts: [
            { text: promptText },
            { inline_data: { mime_type: 'image/jpeg', data: cleanB64 } }
          ]
        }],
        generationConfig: {
          response_mime_type: 'application/json',
          temperature: 0.1,
          thinking_config: {
            thinking_budget: 1024
          }
        }
      }

      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })

        if (resp.ok) {
          const json = await resp.json()
          const candidate = json.candidates?.[0]
          const textPart = candidate?.content?.parts?.[0]?.text
          if (textPart) {
            const parsed = JSON.parse(textPart)
            parsed.usedModel = model
            parsed.usageMetadata = json.usageMetadata || null
            return res.status(200).json(parsed)
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

    return res.status(500).json({ error: lastError || 'Gemini API 호출에 실패했습니다.' })
  } catch (err) {
    console.error('OCR API Handler error:', err)
    return res.status(500).json({ error: err.message || '서버 오류' })
  }
}
