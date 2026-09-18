import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { isSupabaseConfigured, supabase, WMS_AUTH_STORAGE_KEY } from '../lib/supabase.js'

export const useAuthStore = defineStore('auth', () => {
  const user = ref(null)
  const isLoading = ref(false)
  const errorMessage = ref('')
  const isRestored = ref(false)

  const isAuthenticated = computed(() => Boolean(user.value?.id && user.value?.session_token))
  const isAdmin = computed(() => String(user.value?.access_level || '').toLowerCase() === 'admin')
  const accessLevel = computed(() => user.value?.access_level ?? null)

  function persistSession() {
    if (user.value?.session_token) {
      localStorage.setItem(WMS_AUTH_STORAGE_KEY, JSON.stringify(user.value))
    } else {
      localStorage.removeItem(WMS_AUTH_STORAGE_KEY)
    }
  }

  function restoreSession() {
    try {
      const raw = localStorage.getItem(WMS_AUTH_STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed?.id && parsed?.session_token) {
          user.value = parsed
        } else {
          localStorage.removeItem(WMS_AUTH_STORAGE_KEY)
          user.value = null
        }
      }
    } catch {
      localStorage.removeItem(WMS_AUTH_STORAGE_KEY)
      user.value = null
    } finally {
      isRestored.value = true
    }
    if (user.value?.session_token) {
      supabase.rpc('rpc_session_info').then(({ data, error }) => {
        if (error || !data?.success || !data.user) {
          user.value = null
          persistSession()
          return
        }
        user.value = {
          ...user.value,
          id: data.user.id,
          member_name: data.user.member_name,
          branch_name: data.user.branch_name,
          access_level: data.user.access_level,
          preferred_language: data.user.preferred_language,
        }
        persistSession()
      }).catch(() => {
        user.value = null
        persistSession()
      })
    }
  }

  async function login(memberName, password) {
    errorMessage.value = ''
    const trimmedName = (memberName || '').trim()

    if (!trimmedName || !password) {
      errorMessage.value = '아이디와 비밀번호를 입력하세요.'
      return { success: false, message: errorMessage.value }
    }

    if (!isSupabaseConfigured) {
      errorMessage.value = 'Supabase 환경 설정(.env.local)이 필요합니다.'
      return { success: false, message: errorMessage.value }
    }

    isLoading.value = true
    try {
      const { data, error } = await supabase.rpc('rpc_login', {
        p_member_name: trimmedName,
        p_password: password
      })
      if (error) throw error
      if (!data?.success || !data.user || !data.session_token) {
        errorMessage.value = '아이디 또는 비밀번호가 올바르지 않습니다.'
        return { success: false, message: errorMessage.value }
      }

      user.value = {
        id: data.user.id,
        member_name: data.user.member_name,
        branch_name: data.user.branch_name,
        access_level: data.user.access_level,
        preferred_language: data.user.preferred_language,
        session_token: data.session_token,
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

  async function logout() {
    try {
      await supabase.rpc('rpc_logout')
    } catch {
      // 서버 세션 삭제가 실패해도 로컬은 비운다
    }
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
