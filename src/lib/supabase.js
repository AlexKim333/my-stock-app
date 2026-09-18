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
        return fetch(url, { ...options, headers })
      }
    }
  }
)
