import { createClient } from '@supabase/supabase-js'

const getEnv = (key) => {
  if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env[key]) {
    return import.meta.env[key]
  }
  if (typeof process !== 'undefined' && process.env && process.env[key]) {
    return process.env[key]
  }
  return ''
}

const supabaseUrl = getEnv('VITE_SUPABASE_URL')
const supabaseAnonKey = getEnv('VITE_SUPABASE_ANON_KEY')

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)
export const WMS_AUTH_STORAGE_KEY = 'wms_auth_user'
const SUPABASE_FETCH_TIMEOUT_MS = 60000

export function readWmsSessionToken() {
  try {
    if (typeof localStorage === 'undefined') return ''
    const raw = localStorage.getItem(WMS_AUTH_STORAGE_KEY)
    if (!raw) return ''
    return JSON.parse(raw)?.session_token || ''
  } catch {
    return ''
  }
}

export const supabase = createClient(
  supabaseUrl || '',
  supabaseAnonKey || '',
  {
    global: {
      fetch: (url, options = {}) => {
        const headers = new Headers(options.headers || {})
        const token = readWmsSessionToken()
        if (token) headers.set('x-wms-session', token)

        // 응답이 영영 오지 않으면 호출 측(callServer)의 중복 방지 잠금이 풀리지 않으므로
        // 요청 자체에 상한을 둔다. 쓰기 RPC는 멱등 키로 재시도해도 안전하다.
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(new Error('network timeout')), SUPABASE_FETCH_TIMEOUT_MS)
        if (options.signal) {
          if (options.signal.aborted) controller.abort(options.signal.reason)
          else options.signal.addEventListener('abort', () => controller.abort(options.signal.reason), { once: true })
        }
        return fetch(url, { ...options, headers, signal: controller.signal })
          .finally(() => clearTimeout(timer))
      }
    }
  }
)
