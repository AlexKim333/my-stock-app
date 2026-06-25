import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { isSupabaseConfigured, supabase } from '../lib/supabase.js'

const SESSION_KEY = 'wms_auth_user'

/** MVP: password_hash 컬럼과 입력값 직접 비교 (추후 bcrypt 등으로 교체) */
function verifyPassword(input, storedHash) {
  return input === storedHash
}

export const useAuthStore = defineStore('auth', () => {
  const user = ref(null)
  const isLoading = ref(false)
  const errorMessage = ref('')
  const isRestored = ref(false)

  const isAuthenticated = computed(() => Boolean(user.value?.id))
  const isAdmin = computed(() => user.value?.access_level === 'admin')
  const accessLevel = computed(() => user.value?.access_level ?? null)

  function persistSession() {
    if (user.value) {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(user.value))
    } else {
      sessionStorage.removeItem(SESSION_KEY)
    }
  }

  function restoreSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY)
      if (raw) {
        user.value = JSON.parse(raw)
      }
    } catch {
      sessionStorage.removeItem(SESSION_KEY)
      user.value = null
    } finally {
      isRestored.value = true
    }
  }

  async function login(memberName, password) {
    errorMessage.value = ''
    const trimmedName = memberName.trim()

    if (!trimmedName || !password) {
      errorMessage.value = '아이디와 비밀번호를 입력하세요.'
      return { success: false, message: errorMessage.value }
    }

    if (!isSupabaseConfigured) {
      errorMessage.value = 'Supabase 설정(.env)이 필요합니다.'
      return { success: false, message: errorMessage.value }
    }

    isLoading.value = true
    try {
      const { data, error } = await supabase
        .from('app_members')
        .select('id, member_name, branch_name, access_level, preferred_language, password_hash, is_active')
        .eq('member_name', trimmedName)
        .eq('is_active', true)
        .maybeSingle()

      if (error) throw error

      if (!data) {
        errorMessage.value = '아이디 또는 비밀번호가 올바르지 않습니다.'
        return { success: false, message: errorMessage.value }
      }

      if (!verifyPassword(password, data.password_hash)) {
        errorMessage.value = '아이디 또는 비밀번호가 올바르지 않습니다.'
        return { success: false, message: errorMessage.value }
      }

      user.value = {
        id: data.id,
        member_name: data.member_name,
        branch_name: data.branch_name,
        access_level: data.access_level,
        preferred_language: data.preferred_language,
      }
      persistSession()
      return { success: true }
    } catch (err) {
      errorMessage.value = `로그인 실패: ${err.message}`
      return { success: false, message: errorMessage.value }
    } finally {
      isLoading.value = false
    }
  }

  function logout() {
    user.value = null
    errorMessage.value = ''
    persistSession()
  }

  return {
    user,
    isLoading,
    errorMessage,
    isRestored,
    isAuthenticated,
    isAdmin,
    accessLevel,
    login,
    logout,
    restoreSession,
  }
})
