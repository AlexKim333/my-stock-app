import { installSupabaseBridge, preloadItemIdCache } from './lib/supabaseAdapter.js'
import { supabase, WMS_AUTH_STORAGE_KEY } from './lib/supabase.js'
import FlexSearch from 'flexsearch'

// 0. ktk-wms-v2 동급 최강 FlexSearch 초고속 검색엔진 전역 등록
window.FlexSearch = FlexSearch


// 1. Supabase 브릿지 설치
installSupabaseBridge()

// 2. 품목 ID 캐시 백그라운드 사전 적재
preloadItemIdCache()

// 3. 브릿지 준비 완료 이벤트 전파
window.dispatchEvent(new CustomEvent('supabase-bridge-ready'))

// 4. 전역 헬퍼
window.getSupabaseClient = () => supabase

// 5. 작업 중 세션 만료 시 로그인 화면으로 복귀 (한 번만 안내)
let sessionExpiredHandled = false
window.addEventListener('wms-session-expired', () => {
  if (sessionExpiredHandled) return
  sessionExpiredHandled = true
  try { localStorage.removeItem(WMS_AUTH_STORAGE_KEY) } catch {}
  const modal = document.getElementById('wmsAuthModal')
  if (modal) {
    modal.style.display = 'flex'
    const errEl = document.getElementById('wmsAuthError')
    if (errEl) {
      errEl.textContent = '세션이 만료되었습니다. 다시 로그인하세요.'
      errEl.style.display = 'block'
    }
    // 재로그인 후 다시 만료되면 다시 안내할 수 있도록 해제
    setTimeout(() => { sessionExpiredHandled = false }, 3000)
  } else {
    alert('세션이 만료되었습니다. 메인 화면에서 다시 로그인하세요.')
    window.location.href = '/'
  }
})

console.log('⚡ [WMS Entry] Supabase WMS 코어 준비 완료')
