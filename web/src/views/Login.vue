<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import { useUserStore } from '@/stores/user'

declare const __APP_VERSION__: string

const userStore = useUserStore()
const appVersion = __APP_VERSION__
const gameVersion = ref('')

const isLogin = ref(true)
const username = ref('')
const password = ref('')
const cardCode = ref('')
const error = ref('')
const success = ref('')
const loading = ref(false)
const showPasswordStrength = ref(false)
const lockoutRemaining = ref(0)
const rateLimitRemaining = ref(0)

const cardClaimEnabled = ref(false)
const cardClaimLoading = ref(false)
const showClaimModal = ref(false)
const claimModalContent = ref({
  success: true,
  title: '',
  message: '',
  cardCode: '',
  days: 0,
})

const passwordStrength = computed(() => {
  const pwd = password.value
  if (!pwd)
    return { score: 0, level: '', valid: false }

  let score = 0

  if (pwd.length >= 6)
    score++
  if (pwd.length >= 10)
    score++

  let typeCount = 0
  if (/[a-z]/.test(pwd))
    typeCount++
  if (/[A-Z]/.test(pwd))
    typeCount++
  if (/\d/.test(pwd))
    typeCount++
  if (/[!@#$%^&*(),.?":{}|<>_\-+=[\]\\;'/`~]/.test(pwd))
    typeCount++

  if (typeCount >= 2)
    score += 2

  if (typeCount >= 3)
    score++
  if (typeCount >= 4)
    score++

  const commonPasswords = ['password', '123456', 'qwerty', 'abc123', '111111']
  if (commonPasswords.some(p => pwd.toLowerCase().includes(p))) {
    score = Math.max(0, score - 2)
  }

  const level = score <= 2 ? '弱' : score <= 4 ? '中' : score <= 6 ? '强' : '非常强'
  const color = score <= 2 ? '#ef5350' : score <= 4 ? '#ffa726' : score <= 6 ? '#66bb6a' : '#43a047'
  const valid = pwd.length >= 6 && typeCount >= 2

  return { score, level, color, valid }
})

const usernameValid = computed(() => {
  const name = username.value
  if (!name)
    return { valid: false, message: '' }
  if (name.length < 3)
    return { valid: false, message: '用户名至少3位' }
  if (name.length > 32)
    return { valid: false, message: '用户名最多32位' }
  if (!/^\w+$/.test(name))
    return { valid: false, message: '只能包含字母、数字、下划线' }
  return { valid: true, message: '' }
})

watch(password, () => {
  if (!isLogin.value && password.value) {
    showPasswordStrength.value = true
  }
})

function validateForm(): boolean {
  if (!username.value) {
    error.value = '请输入用户名'
    return false
  }

  if (!usernameValid.value.valid) {
    error.value = usernameValid.value.message
    return false
  }

  if (!password.value) {
    error.value = '请输入密码'
    return false
  }

  if (!isLogin.value) {
    if (password.value.length < 6) {
      error.value = '密码长度至少6位'
      return false
    }

    if (!passwordStrength.value.valid) {
      error.value = '密码强度不足：需包含大写字母、小写字母、数字、特殊符号中的至少两种'
      return false
    }

    if (!cardCode.value) {
      error.value = '请输入卡密'
      return false
    }
  }

  return true
}

async function handleSubmit() {
  if (!validateForm())
    return

  loading.value = true
  error.value = ''
  success.value = ''

  try {
    if (isLogin.value) {
      const result = await userStore.login(username.value, password.value)
      if (result.ok) {
        if (result.data?.mustChangePassword) {
          success.value = '登录成功！请修改默认密码以确保账户安全'
        }
        setTimeout(() => {
          window.location.href = '/'
        }, 500)
      }
      else {
        if (result.errorType === 'rate_limit') {
          error.value = result.error || '请求过于频繁，请稍后重试'
          if (result.remainingMs) {
            rateLimitRemaining.value = Math.ceil(result.remainingMs / 1000)
          }
        }
        else if (result.errorType === 'locked') {
          error.value = result.error || '账户已被锁定'
          if (result.remainingMs) {
            lockoutRemaining.value = Math.ceil(result.remainingMs / 1000 / 60)
          }
        }
        else {
          error.value = result.error || '登录失败'
        }
      }
    }
    else {
      const result = await userStore.register(username.value, password.value, cardCode.value)
      if (result.ok) {
        success.value = '注册成功，请登录'
        isLogin.value = true
        cardCode.value = ''
        password.value = ''
      }
      else {
        error.value = result.error || '注册失败'
      }
    }
  }
  catch (e: any) {
    const data = e.response?.data
    if (data?.errorType === 'rate_limit') {
      error.value = data.error || '请求过于频繁'
      if (data.remainingMs) {
        rateLimitRemaining.value = Math.ceil(data.remainingMs / 1000)
      }
    }
    else if (data?.errorType === 'locked') {
      error.value = data.error || '账户已被锁定'
      if (data.remainingMs) {
        lockoutRemaining.value = Math.ceil(data.remainingMs / 1000 / 60)
      }
    }
    else {
      error.value = data?.error || e.message || '操作异常'
    }
  }
  finally {
    loading.value = false
  }
}

function toggleMode() {
  isLogin.value = !isLogin.value
  error.value = ''
  success.value = ''
  showPasswordStrength.value = false
  lockoutRemaining.value = 0
  rateLimitRemaining.value = 0
}

async function checkCardClaimStatus() {
  try {
    const res = await api.get('/api/card-claim/status')
    if (res.data.ok) {
      cardClaimEnabled.value = res.data.enabled === true
    }
  }
  catch (e) {
    console.error('检查卡密领取状态失败:', e)
  }
}

async function claimFreeCard() {
  if (cardClaimLoading.value)
    return

  cardClaimLoading.value = true
  error.value = ''

  try {
    const res = await api.post('/api/card-claim/claim')

    if (res.data.ok) {
      cardCode.value = res.data.cardCode
      claimModalContent.value = {
        success: true,
        title: '领取成功',
        message: `成功领取 ${res.data.days} 天卡密！`,
        cardCode: res.data.cardCode,
        days: res.data.days,
      }
      showClaimModal.value = true
    }
    else {
      claimModalContent.value = {
        success: false,
        title: '领取失败',
        message: res.data.error || '领取失败，请稍后重试',
        cardCode: '',
        days: 0,
      }
      showClaimModal.value = true
    }
  }
  catch (e: any) {
    const data = e.response?.data
    claimModalContent.value = {
      success: false,
      title: '领取失败',
      message: data?.error || e.message || '领取失败',
      cardCode: '',
      days: 0,
    }
    showClaimModal.value = true
  }
  finally {
    cardClaimLoading.value = false
  }
}

function closeClaimModal() {
  showClaimModal.value = false
}

onMounted(() => {
  checkCardClaimStatus()
  fetchGameVersion()
})

async function fetchGameVersion() {
  try {
    const res = await api.get('/api/game-version')
    if (res.data.ok) {
      gameVersion.value = res.data.clientVersion
    }
  }
  catch (e) {
    console.error('获取游戏版本失败:', e)
  }
}
</script>

<template>
  <div class="login-container">
    <!-- 背景装饰 -->
    <div class="bg-decoration">
      <!-- 太阳 -->
      <div class="sun" />
      <!-- 云朵 -->
      <div class="cloud cloud-1" />
      <div class="cloud cloud-2" />
      <div class="cloud cloud-3" />
      <!-- 草地 -->
      <div class="grass" />
      <!-- 植物装饰 -->
      <div class="plant plant-1">
        🌱
      </div>
      <div class="plant plant-2">
        🌻
      </div>
      <div class="plant plant-3">
        🌾
      </div>
      <div class="plant plant-4">
        🌿
      </div>
      <div class="plant plant-5">
        🥕
      </div>
      <div class="plant plant-6">
        🍅
      </div>
    </div>

    <!-- 登录卡片 -->
    <div class="login-card">
      <!-- Logo 区域 -->
      <div class="logo-area">
        <div class="logo-icon">
          <span class="text-5xl">🌾</span>
        </div>
        <h1 class="logo-title">
          QQ农场智能助手
        </h1>
        <p class="logo-subtitle">
          {{ isLogin ? '欢迎回来，开始你的农场之旅' : '加入我们，开启农场新生活' }}
        </p>
      </div>

      <!-- 表单区域 -->
      <form class="form-area" @submit.prevent="handleSubmit">
        <div class="form-group">
          <label class="form-label">
            <span class="label-icon">👤</span>
            用户名
          </label>
          <BaseInput
            id="username"
            v-model="username"
            type="text"
            placeholder="请输入用户名（3-32位字母数字下划线）"
            required
          />
          <p v-if="username && !usernameValid.valid" class="form-hint error">
            {{ usernameValid.message }}
          </p>
        </div>

        <div class="form-group">
          <label class="form-label">
            <span class="label-icon">🔒</span>
            密码
          </label>
          <BaseInput
            id="password"
            v-model="password"
            type="password"
            placeholder="请输入密码"
            required
          />
          <div v-if="showPasswordStrength && password" class="password-strength">
            <div class="strength-bar">
              <div
                class="strength-fill"
                :style="{ width: `${Math.min(passwordStrength.score * 12.5, 100)}%`, backgroundColor: passwordStrength.color }"
              />
            </div>
            <span class="strength-text" :style="{ color: passwordStrength.color }">
              {{ passwordStrength.level }}
            </span>
          </div>
          <div v-if="error" class="message error-message">
            <span class="message-icon">⚠️</span>
            <div class="message-content">
              {{ error }}
              <span v-if="lockoutRemaining > 0" class="lockout-timer">
                ({{ lockoutRemaining }} 分钟后解锁)
              </span>
              <span v-if="rateLimitRemaining > 0" class="lockout-timer">
                ({{ rateLimitRemaining }} 秒后可重试)
              </span>
            </div>
          </div>
          <div v-if="success" class="message success-message">
            <span class="message-icon">✅</span>
            {{ success }}
          </div>
        </div>

        <div v-if="!isLogin" class="form-group">
          <label class="form-label">
            <span class="label-icon">🎫</span>
            卡密
          </label>

          <div v-if="cardClaimEnabled" class="mb-2">
            <button
              type="button"
              class="claim-card-btn"
              :disabled="cardClaimLoading"
              @click="claimFreeCard"
            >
              <span v-if="cardClaimLoading" class="i-svg-spinners-90-ring-with-bg" />
              <span v-else>🎁 免费领取卡密</span>
            </button>
          </div>

          <BaseInput
            id="cardCode"
            v-model="cardCode"
            type="text"
            placeholder="请输入卡密"
            :required="!isLogin"
          />
        </div>

        <BaseButton
          type="submit"
          variant="primary"
          block
          :loading="loading"
          class="submit-btn"
        >
          <span v-if="!loading">{{ isLogin ? '🚀 立即登录' : '🎉 立即注册' }}</span>
        </BaseButton>
      </form>

      <!-- 切换区域 -->
      <div class="switch-area">
        <button
          type="button"
          class="switch-btn"
          @click="toggleMode"
        >
          {{ isLogin ? '🌱 没有账号？立即注册' : '🌿 已有账号？立即登录' }}
        </button>
      </div>

      <!-- 底部装饰 -->
      <div class="card-footer">
        <span>🌻 愿你的农场丰收满满 🌻</span>
        <div class="footer-info">
          <span class="version">v{{ appVersion }}</span>
          <span class="separator">|</span>
          <a
            href="https://github.com/XyhTender/qq-farm-automation-bot"
            target="_blank"
            rel="noopener noreferrer"
            class="github-link"
          >
            GitHub
          </a>
        </div>
        <div v-if="gameVersion" class="game-version">
          当前游戏版本：{{ gameVersion }}
        </div>
      </div>
    </div>

    <!-- 卡密领取结果弹窗 -->
    <Teleport to="body">
      <Transition name="modal">
        <div
          v-if="showClaimModal"
          class="claim-modal-overlay"
          @click.self="closeClaimModal"
        >
          <div class="claim-modal">
            <div class="claim-modal-header">
              <span class="claim-modal-icon">{{ claimModalContent.success ? '🎉' : '⚠️' }}</span>
              <h3 class="claim-modal-title">
                {{ claimModalContent.title }}
              </h3>
            </div>
            <div class="claim-modal-body">
              <p class="claim-modal-message">
                {{ claimModalContent.message }}
              </p>
              <div v-if="claimModalContent.success && claimModalContent.cardCode" class="claim-modal-card-info">
                <div class="card-code-label">
                  卡密已自动填入
                </div>
                <div class="card-code-value">
                  {{ claimModalContent.cardCode }}
                </div>
              </div>
            </div>
            <div class="claim-modal-footer">
              <button class="claim-modal-btn" @click="closeClaimModal">
                {{ claimModalContent.success ? '开始注册' : '我知道了' }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.login-container {
  min-height: 100vh;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(180deg, #87ceeb 0%, #98d8c8 50%, #7cb342 100%);
  position: relative;
  overflow: hidden;
}

/* 背景装饰 */
.bg-decoration {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
}

/* 太阳 */
.sun {
  position: absolute;
  top: 40px;
  right: 80px;
  width: 80px;
  height: 80px;
  background: radial-gradient(circle, #ffd700 0%, #ffa500 100%);
  border-radius: 50%;
  box-shadow: 0 0 60px 20px rgba(255, 215, 0, 0.4);
  animation: sunPulse 4s ease-in-out infinite;
}

@keyframes sunPulse {
  0%,
  100% {
    transform: scale(1);
    box-shadow: 0 0 60px 20px rgba(255, 215, 0, 0.4);
  }
  50% {
    transform: scale(1.05);
    box-shadow: 0 0 80px 30px rgba(255, 215, 0, 0.5);
  }
}

/* 云朵 */
.cloud {
  position: absolute;
  background: white;
  border-radius: 50px;
  opacity: 0.9;
}

.cloud::before,
.cloud::after {
  content: '';
  position: absolute;
  background: white;
  border-radius: 50%;
}

.cloud-1 {
  top: 60px;
  left: 10%;
  width: 100px;
  height: 40px;
  animation: cloudFloat 20s linear infinite;
}

.cloud-1::before {
  width: 50px;
  height: 50px;
  top: -25px;
  left: 15px;
}

.cloud-1::after {
  width: 35px;
  height: 35px;
  top: -15px;
  right: 15px;
}

.cloud-2 {
  top: 120px;
  left: 60%;
  width: 80px;
  height: 32px;
  animation: cloudFloat 25s linear infinite;
  animation-delay: -5s;
}

.cloud-2::before {
  width: 40px;
  height: 40px;
  top: -20px;
  left: 10px;
}

.cloud-2::after {
  width: 28px;
  height: 28px;
  top: -12px;
  right: 10px;
}

.cloud-3 {
  top: 200px;
  left: 30%;
  width: 60px;
  height: 24px;
  animation: cloudFloat 30s linear infinite;
  animation-delay: -10s;
}

.cloud-3::before {
  width: 30px;
  height: 30px;
  top: -15px;
  left: 8px;
}

.cloud-3::after {
  width: 22px;
  height: 22px;
  top: -10px;
  right: 8px;
}

@keyframes cloudFloat {
  0% {
    transform: translateX(-100px);
  }
  100% {
    transform: translateX(calc(100vw + 100px));
  }
}

/* 草地 */
.grass {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 120px;
  background: linear-gradient(180deg, #7cb342 0%, #558b2f 100%);
  border-radius: 100% 100% 0 0;
}

.grass::before {
  content: '';
  position: absolute;
  top: -20px;
  left: 0;
  right: 0;
  height: 40px;
  background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 20'%3E%3Cpath fill='%237CB342' d='M0 20 Q25 0 50 20 Q75 0 100 20 V0 H0Z'/%3E%3C/svg%3E")
    repeat-x;
  background-size: 100px 20px;
}

/* 植物装饰 */
.plant {
  position: absolute;
  font-size: 2rem;
  animation: plantSway 3s ease-in-out infinite;
}

.plant-1 {
  bottom: 100px;
  left: 5%;
  animation-delay: 0s;
}
.plant-2 {
  bottom: 80px;
  left: 15%;
  animation-delay: 0.5s;
  font-size: 2.5rem;
}
.plant-3 {
  bottom: 110px;
  left: 25%;
  animation-delay: 1s;
}
.plant-4 {
  bottom: 90px;
  right: 25%;
  animation-delay: 1.5s;
}
.plant-5 {
  bottom: 100px;
  right: 15%;
  animation-delay: 2s;
}
.plant-6 {
  bottom: 85px;
  right: 5%;
  animation-delay: 2.5s;
  font-size: 2.5rem;
}

@keyframes plantSway {
  0%,
  100% {
    transform: rotate(-5deg);
  }
  50% {
    transform: rotate(5deg);
  }
}

/* 登录卡片 */
.login-card {
  width: 100%;
  max-width: 420px;
  margin: 20px;
  padding: 40px;
  background: rgba(255, 255, 255, 0.95);
  border-radius: 24px;
  box-shadow:
    0 20px 60px rgba(0, 0, 0, 0.15),
    0 0 0 1px rgba(255, 255, 255, 0.5);
  position: relative;
  z-index: 10;
  backdrop-filter: blur(10px);
}

/* Logo 区域 */
.logo-area {
  text-align: center;
  margin-bottom: 32px;
}

.logo-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 80px;
  height: 80px;
  background: linear-gradient(135deg, #7cb342 0%, #558b2f 100%);
  border-radius: 20px;
  margin-bottom: 16px;
  box-shadow: 0 8px 20px rgba(124, 179, 66, 0.3);
  animation: logoBounce 2s ease-in-out infinite;
}

@keyframes logoBounce {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-5px);
  }
}

.logo-title {
  font-size: 1.75rem;
  font-weight: 700;
  color: #2e7d32;
  margin-bottom: 8px;
  text-shadow: 0 2px 4px rgba(46, 125, 50, 0.1);
}

.logo-subtitle {
  font-size: 0.9rem;
  color: #66bb6a;
  font-weight: 500;
}

/* 表单区域 */
.form-area {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.form-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.875rem;
  font-weight: 600;
  color: #37474f;
}

.label-icon {
  font-size: 1rem;
}

.form-hint {
  font-size: 0.75rem;
  color: #66bb6a;
  margin-top: 4px;
}

.form-hint.error {
  color: #ef5350;
}

.password-strength {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.strength-bar {
  flex: 1;
  height: 4px;
  background: #e0e0e0;
  border-radius: 2px;
  overflow: hidden;
}

.strength-fill {
  height: 100%;
  transition:
    width 0.3s ease,
    background-color 0.3s ease;
}

.strength-text {
  font-size: 0.75rem;
  font-weight: 500;
  min-width: 50px;
}

.lockout-timer {
  display: block;
  font-size: 0.75rem;
  opacity: 0.8;
  margin-top: 2px;
}

.security-tips {
  background: linear-gradient(135deg, #fff8e1 0%, #ffecb3 100%);
  border: 1px solid #ffe082;
  border-radius: 12px;
  padding: 12px 16px;
  margin-top: 8px;
}

.tip-title {
  font-size: 0.8rem;
  font-weight: 600;
  color: #f57c00;
  margin-bottom: 6px;
}

.tip-list {
  margin: 0;
  padding-left: 16px;
  font-size: 0.75rem;
  color: #ef6c00;
}

.tip-list li {
  margin: 2px 0;
}

/* 消息提示 */
.message {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-radius: 12px;
  font-size: 0.875rem;
}

.message-icon {
  font-size: 1rem;
}

.error-message {
  background: linear-gradient(135deg, #ffebee 0%, #ffcdd2 100%);
  color: #c62828;
  border: 1px solid #ef9a9a;
}

.success-message {
  background: linear-gradient(135deg, #e8f5e9 0%, #c8e6c9 100%);
  color: #2e7d32;
  border: 1px solid #a5d6a7;
}

/* 提交按钮 */
.submit-btn {
  margin-top: 8px;
  height: 48px;
  font-size: 1rem;
  font-weight: 600;
  border-radius: 12px;
  background: linear-gradient(135deg, #7cb342 0%, #558b2f 100%);
  box-shadow: 0 4px 15px rgba(124, 179, 66, 0.4);
  transition: all 0.3s ease;
}

.submit-btn:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 20px rgba(124, 179, 66, 0.5);
}

.submit-btn:active {
  transform: translateY(0);
}

/* 切换区域 */
.switch-area {
  text-align: center;
  margin-top: 24px;
}

.switch-btn {
  background: none;
  border: none;
  color: #66bb6a;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  padding: 8px 16px;
  border-radius: 20px;
  transition: all 0.3s ease;
}

.switch-btn:hover {
  background: rgba(102, 187, 106, 0.1);
  color: #43a047;
}

/* 卡片底部 */
.card-footer {
  text-align: center;
  margin-top: 24px;
  padding-top: 20px;
  border-top: 1px solid rgba(102, 187, 106, 0.2);
  color: #81c784;
  font-size: 0.8rem;
}

.footer-info {
  margin-top: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 0.75rem;
  color: #a5d6a7;
}

.separator {
  color: #81c784;
}

.github-link {
  color: #66bb6a;
  text-decoration: none;
  transition: color 0.2s ease;
}

.github-link:hover {
  color: #43a047;
  text-decoration: underline;
}

.game-version {
  margin-top: 8px;
  font-size: 0.7rem;
  color: #81c784;
  text-align: center;
}

.claim-card-btn {
  width: 100%;
  padding: 8px 16px;
  background: linear-gradient(135deg, #7cb342 0%, #558b2f 100%);
  border: none;
  border-radius: 8px;
  color: white;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.3s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}

.claim-card-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(124, 179, 66, 0.3);
}

.claim-card-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* 暗色模式适配 */
@media (prefers-color-scheme: dark) {
  .login-container {
    background: linear-gradient(180deg, #1a3a2a 0%, #1e4d2b 50%, #0d2818 100%);
  }

  .login-card {
    background: rgba(30, 60, 40, 0.95);
    box-shadow:
      0 20px 60px rgba(0, 0, 0, 0.4),
      0 0 0 1px rgba(102, 187, 106, 0.2);
  }

  .logo-title {
    color: #81c784;
  }

  .logo-subtitle {
    color: #66bb6a;
  }

  .form-label {
    color: #a5d6a7;
  }

  .card-footer {
    border-top-color: rgba(102, 187, 106, 0.3);
    color: #66bb6a;
  }
}

/* 响应式适配 */
@media (max-width: 480px) {
  .login-card {
    margin: 10px;
    padding: 30px 24px;
    border-radius: 20px;
  }

  .logo-icon {
    width: 70px;
    height: 70px;
  }

  .logo-title {
    font-size: 1.5rem;
  }

  .sun {
    width: 60px;
    height: 60px;
    top: 20px;
    right: 40px;
  }

  .plant {
    font-size: 1.5rem;
  }

  .plant-2,
  .plant-6 {
    font-size: 2rem;
  }
}

/* 卡密领取结果弹窗样式 */
.claim-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 20px;
  backdrop-filter: blur(4px);
}

.claim-modal {
  background: white;
  border-radius: 20px;
  max-width: 360px;
  width: 100%;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
  overflow: hidden;
  animation: modalSlideIn 0.3s ease;
}

@keyframes modalSlideIn {
  from {
    opacity: 0;
    transform: translateY(-20px) scale(0.95);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.claim-modal-header {
  text-align: center;
  padding: 24px 20px 16px;
  background: linear-gradient(135deg, #e8f5e9 0%, #c8e6c9 100%);
}

.claim-modal-icon {
  font-size: 3rem;
  display: block;
  margin-bottom: 8px;
}

.claim-modal-title {
  font-size: 1.25rem;
  font-weight: 700;
  color: #2e7d32;
  margin: 0;
}

.claim-modal-body {
  padding: 20px;
  text-align: center;
}

.claim-modal-message {
  font-size: 1rem;
  color: #37474f;
  margin: 0 0 16px;
  line-height: 1.5;
}

.claim-modal-card-info {
  background: linear-gradient(135deg, #f5f5f5 0%, #e8e8e8 100%);
  border-radius: 12px;
  padding: 16px;
  margin-top: 8px;
}

.card-code-label {
  font-size: 0.75rem;
  color: #66bb6a;
  margin-bottom: 8px;
}

.card-code-value {
  font-family: 'Courier New', monospace;
  font-size: 0.9rem;
  font-weight: 600;
  color: #2e7d32;
  background: white;
  padding: 8px 12px;
  border-radius: 8px;
  word-break: break-all;
}

.claim-modal-footer {
  padding: 0 20px 20px;
}

.claim-modal-btn {
  width: 100%;
  padding: 14px;
  background: linear-gradient(135deg, #7cb342 0%, #558b2f 100%);
  border: none;
  border-radius: 12px;
  color: white;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
}

.claim-modal-btn:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 15px rgba(124, 179, 66, 0.4);
}

.claim-modal-btn:active {
  transform: translateY(0);
}

/* 弹窗过渡动画 */
.modal-enter-active,
.modal-leave-active {
  transition: all 0.3s ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .claim-modal,
.modal-leave-to .claim-modal {
  transform: translateY(-20px) scale(0.95);
}

/* 暗色模式适配弹窗 */
@media (prefers-color-scheme: dark) {
  .claim-modal {
    background: #1e3c28;
  }

  .claim-modal-header {
    background: linear-gradient(135deg, #1e4d2b 0%, #2e5a3a 100%);
  }

  .claim-modal-title {
    color: #81c784;
  }

  .claim-modal-message {
    color: #a5d6a7;
  }

  .claim-modal-card-info {
    background: linear-gradient(135deg, #1a3a2a 0%, #2a4a3a 100%);
  }

  .card-code-label {
    color: #66bb6a;
  }

  .card-code-value {
    background: #0d2818;
    color: #81c784;
  }
}

/* 移动端弹窗优化 */
@media (max-width: 480px) {
  .claim-modal-overlay {
    padding: 16px;
    align-items: flex-end;
  }

  .claim-modal {
    border-radius: 20px 20px 0 0;
    max-width: 100%;
    animation: modalSlideUp 0.3s ease;
  }

  @keyframes modalSlideUp {
    from {
      opacity: 0;
      transform: translateY(100%);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .claim-modal-header {
    padding: 20px 16px 12px;
  }

  .claim-modal-icon {
    font-size: 2.5rem;
  }

  .claim-modal-body {
    padding: 16px;
  }

  .claim-modal-footer {
    padding: 0 16px 16px;
  }

  .claim-modal-btn {
    padding: 12px;
  }
}
</style>
