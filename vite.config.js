import { defineConfig, loadEnv } from 'vite'
import { resolve } from 'path'
import ocrHandler from './api/ocr.js'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  process.env.GEMINI_API_KEY = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY
  // 개발 서버의 /api/ocr 미들웨어가 세션 검증에 사용
  process.env.VITE_SUPABASE_URL = env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL
  process.env.VITE_SUPABASE_ANON_KEY = env.VITE_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY

  return {
    plugins: [
      {
        name: 'api-ocr-dev-server',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (req.url === '/api/ocr' && req.method === 'POST') {
              let body = ''
              req.on('data', chunk => { body += chunk })
              req.on('end', async () => {
                try {
                  req.body = JSON.parse(body)
                  res.status = (code) => { res.statusCode = code; return res }
                  res.json = (data) => {
                    res.setHeader('Content-Type', 'application/json')
                    res.end(JSON.stringify(data))
                  }
                  await ocrHandler(req, res)
                } catch (e) {
                  res.statusCode = 500
                  res.end(JSON.stringify({ error: e.message }))
                }
              })
            } else {
              next()
            }
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