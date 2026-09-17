// src/wms-entry.js
import { installSupabaseBridge, preloadItemIdCache } from './lib/supabaseAdapter.js'
import { supabase } from './lib/supabase.js'

// 1. Supabase 브릿지 설치
installSupabaseBridge()

// 2. 품목 ID 캐시 백그라운드 사전 적재
preloadItemIdCache()

// 3. 브릿지 준비 완료 이벤트 전파
window.dispatchEvent(new CustomEvent('supabase-bridge-ready'))

// 4. 전역 헬퍼
window.getSupabaseClient = () => supabase

console.log('⚡ [WMS Entry] Supabase WMS 코어 준비 완료')
