import { defineConfig, loadEnv } from 'vite'
import { resolve } from 'path'
import ocrHandler from './api/ocr.js'
import aiQueryHandler from './api/ai-query.js'

// 개발 서버에서 Vercel 서버리스 함수(api/*.js)와 같은 경로로 호출할 수 있게 하는 라우트 표.
// 새 API 파일을 추가하면 여기에도 등록해야 로컬에서 검증할 수 있다.
const API_ROUTES = {
  '/api/ocr': ocrHandler,
  '/api/ai-query': aiQueryHandler
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  process.env.GEMINI_API_KEY = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY
  // 개발 서버의 /api/* 미들웨어가 세션 검증·DB 조회에 사용
  process.env.VITE_SUPABASE_URL = env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL
  process.env.VITE_SUPABASE_ANON_KEY = env.VITE_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY

  return {
    plugins: [
      {
        name: 'api-dev-server',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            const pathname = String(req.url || '').split('?')[0]
            const handler = API_ROUTES[pathname]
            if (!handler) return next()

            // Vercel 함수 응답 형식(res.status().json())을 흉내 낸다.
            res.status = (code) => { res.statusCode = code; return res }
            res.json = (data) => {
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify(data))
            }

            let body = ''
            req.on('data', chunk => { body += chunk })
            req.on('end', async () => {
              try {
                try {
                  req.body = body ? JSON.parse(body) : {}
                } catch {
                  return res.status(400).json({ error: '요청 본문이 올바른 JSON이 아닙니다.' })
                }
                await handler(req, res)
              } catch (e) {
                res.statusCode = 500
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ error: e.message }))
              }
            })
          })
        }
      }
    ],
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'index.html'),
          searchmodify: resolve(__dirname, 'searchmodify.html'),
          productLedger: resolve(__dirname, 'product-ledger.html')
        }
      }
    }
  }
})