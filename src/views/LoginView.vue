<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-brand">
       
        <img src="../assets/lady_polo_logo.png" alt="LADY POLO" class="custom-logo" />
        <p class="login-subtitle">작업자 로그인</p>
      </div>

      <form class="login-form" @submit.prevent="handleLogin">
        <label class="login-field">
          <span>아이디 (member_name)</span>
          <input
            ref="memberNameInputRef"
            v-model="memberName"
            type="text"
            autocomplete="username"
            placeholder="작업자 ID"
            :disabled="auth.isLoading"
          />
        </label>

        <label class="login-field">
          <span>비밀번호</span>
          <input
            v-model="password"
            type="password"
            autocomplete="current-password"
            placeholder="비밀번호"
            :disabled="auth.isLoading"
            @keydown.enter.prevent="handleLogin"
          />
        </label>

        <p v-if="localError || auth.errorMessage" class="login-error">
          {{ localError || auth.errorMessage }}
        </p>

        <button type="submit" class="login-btn" :disabled="auth.isLoading">
          {{ auth.isLoading ? '로그인 중…' : 'Iniciar sesión / 로그인' }}
        </button>
      </form>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '../stores/auth.js'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

const memberName = ref('')
const password = ref('')
const localError = ref('')
const memberNameInputRef = ref(null)

const handleLogin = async () => {
  localError.value = ''
  const result = await auth.login(memberName.value, password.value)
  if (result.success) {
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/'
    router.replace(redirect)
  }
}

onMounted(() => {
  memberNameInputRef.value?.focus()
})
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #1e293b 0%, #0f172a 50%, #134e4a 100%);
  padding: 24px;
}

.login-card {
  width: 100%;
  max-width: 400px;
  background: white;
  border-radius: 12px;
  padding: 36px 32px 32px;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
}

.login-brand {
  text-align: center;
  margin-bottom: 28px;
}

.login-logo {
  font-size: 26px;
  font-weight: bold;
  color: #00a896;
}

.custom-logo {
  display: block;
  margin: 0 auto 15px;
  max-width: 180px; /* 🌟 바로 이 숫자를 조절하시면 됩니다! */
  height: auto;
}

.login-subtitle {
  margin: 8px 0 0;
  font-size: 14px;
  color: #64748b;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.login-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  font-weight: bold;
  color: #64748b;
}

.login-field input {
  padding: 12px 14px;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  font-size: 15px;
  outline: none;
  transition: border-color 0.2s;
}

.login-field input:focus {
  border-color: #00a896;
  box-shadow: 0 0 0 3px rgba(0, 168, 150, 0.15);
}

.login-field input:disabled {
  background: #f1f5f9;
  cursor: not-allowed;
}

.login-error {
  margin: 0;
  padding: 10px 12px;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 6px;
  color: #dc2626;
  font-size: 13px;
}

.login-btn {
  margin-top: 4px;
  padding: 14px;
  background: #00a896;
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 15px;
  font-weight: bold;
  cursor: pointer;
  transition: background 0.2s;
}

.login-btn:hover:not(:disabled) {
  background: #008f7f;
}

.login-btn:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}
</style>
