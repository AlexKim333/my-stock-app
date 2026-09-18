

import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import ocrHandler from './api/ocr.js'

function vueSpaFallback() {
  const rewriteToIndex = (req) => {
    const url = String(req.url || '').split('?')[0]
    if (url === '/login' || url.startsWith('/login/')) {
      req.url = '/index.html'
    }
  }
  return {
    name: 'vue-spa-fallback',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        rewriteToIndex(req)
        next()
      })
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        rewriteToIndex(req)
        next()
      })
    }
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  process.env.GEMINI_API_KEY = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY

  return {
    plugins: [
      vue(),
      vueSpaFallback(),
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
          wms: resolve(__dirname, 'wms.html'),
          searchmodify: resolve(__dirname, 'searchmodify.html'),
          pos: resolve(__dirname, 'pos.html'),
          productLedger: resolve(__dirname, 'product-ledger.html')
        }
      }
    }
  }
})