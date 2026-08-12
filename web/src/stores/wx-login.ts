import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useUserStore } from './user'

export interface WxLoginConfig {
  enabled: boolean
  autoAddAccount: boolean
  userIsolation: boolean
}

export const useWxLoginStore = defineStore('wx-login', () => {
  // 默认配置
  const defaultConfig: WxLoginConfig = {
    enabled: true,
    autoAddAccount: true,
    userIsolation: true,
  }

  // 获取当前用户ID
  const userStore = useUserStore()
  const currentUserId = computed(() => userStore.username || 'default')

  // 使用 ref 存储配置
  const rawConfig = ref<WxLoginConfig>({ ...defaultConfig })

  // 初始化时从服务器加载
  async function loadConfig() {
    await loadConfigFromServer()
  }

  // 从服务器加载配置
  async function loadConfigFromServer() {
    try {
      const response = await fetch('/api/user/wxlogin-config', {
        headers: {
          'x-admin-token': localStorage.getItem('admin_token') || '',
        },
      })
      const result = await response.json()
      if (result.ok && result.config) {
        // 合并服务器配置（服务器配置优先）
        rawConfig.value = { ...defaultConfig, ...result.config }
      }
      else {
        rawConfig.value = { ...defaultConfig }
      }
    }
    catch (e) {
      console.error('从服务器加载配置失败:', e)
      rawConfig.value = { ...defaultConfig }
    }
  }

  // 初始化加载
  loadConfig()

  // 合并配置：确保新字段有默认值
  const config = computed<WxLoginConfig>(() => ({
    ...defaultConfig,
    ...rawConfig.value,
  }))

  // 扫码登录状态
  const isLoading = ref(false)
  const qrCode = ref<string | null>(null)
  const uuid = ref('')
  const wxid = ref('')
  const status = ref<'idle' | 'qr_loading' | 'qr_ready' | 'scanning' | 'confirming' | 'success' | 'error'>('idle')
  const statusMessage = ref('')
  const errorMessage = ref('')

  // 获取二维码接口地址
  const qrEndpoint = 'LoginGetQRCar'

  // 重置登录状态
  function resetState() {
    qrCode.value = null
    uuid.value = ''
    wxid.value = ''
    status.value = 'idle'
    statusMessage.value = ''
    errorMessage.value = ''
  }

  function authHeaders() {
    return {
      'Content-Type': 'application/json',
      'x-admin-token': localStorage.getItem('admin_token') || '',
    }
  }

  // 获取二维码
  async function getQRCode(): Promise<boolean> {
    isLoading.value = true
    status.value = 'qr_loading'
    statusMessage.value = '正在获取二维码...'
    errorMessage.value = ''

    try {
      const response = await fetch(`/api/Login/${qrEndpoint}`, {
        method: 'POST',
        headers: authHeaders(),
        body: '{}',
      })
      const data = await response.json()

      if (data.Success && data.Data) {
        uuid.value = data.Data.Uuid
        qrCode.value = data.Data.QrBase64 || data.Data.qrBase64 || ''
        status.value = 'qr_ready'
        statusMessage.value = '请使用微信扫码登录'
        return true
      }
      else {
        status.value = 'error'
        errorMessage.value = data.Message || '获取二维码失败'
        return false
      }
    }
    catch (e: any) {
      status.value = 'error'
      errorMessage.value = `请求失败: ${e.message}`
      return false
    }
    finally {
      isLoading.value = false
    }
  }

  // 检查登录状态
  async function checkLogin(): Promise<{ success: boolean, wxid?: string, nickname?: string }> {
    if (!uuid.value) {
      return { success: false }
    }

    status.value = 'scanning'
    statusMessage.value = '正在检查登录状态...'

    try {
      // 微信扫码接口是长轮询（~15s），超时给 60s 兜底。
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 60000)
      let data: any
      try {
        const response = await fetch(`/api/Login/LoginCheckQR?uuid=${uuid.value}`, {
          method: 'POST',
          headers: authHeaders(),
          signal: controller.signal,
        })
        data = await response.json()
      }
      finally {
        clearTimeout(timer)
      }

      const acctResp = data?.Data?.acctSectResp || data?.Data?.AcctSectResp
      const userName = acctResp?.userName || acctResp?.UserName
      const nickName = acctResp?.nickName || acctResp?.NickName || '微信用户'
      const qrStatus = data?.Data?.status

      if (data.Success && userName) {
        wxid.value = userName
        status.value = 'success'
        statusMessage.value = `登录成功！欢迎 ${nickName}`
        return { success: true, wxid: userName, nickname: nickName }
      }
      else if (data.Success && (qrStatus === 1 || qrStatus === 0)) {
        status.value = qrStatus === 1 ? 'confirming' : 'qr_ready'
        statusMessage.value = qrStatus === 1 ? '已扫码，请在手机确认登录' : '等待扫码中'
        return { success: false }
      }
      else {
        status.value = 'error'
        errorMessage.value = data.Message || '登录检查失败'
        return { success: false }
      }
    }
    catch (e: any) {
      // 请求超时/中断（abort）：MMTLS 冷启动握手慢，后端仍在处理——不算失败，
      // 恢复 qr_ready 保持等待（checkLogin 开头置了 scanning，不恢复会导致轮询守卫停止轮询），
      // 避免误弹"重新扫码"
      if (e?.name === 'AbortError' || /aborted|timeout/i.test(String(e?.message || ''))) {
        status.value = 'qr_ready'
        statusMessage.value = '网络较慢，持续等待中...'
        return { success: false }
      }
      status.value = 'error'
      errorMessage.value = `请求失败: ${e.message}`
      statusMessage.value = '' // 清掉等待提示残留，避免状态不一致
      return { success: false }
    }
  }

  // 获取QQ农场Code
  async function getFarmCode(wxidParam?: string, accountId?: string): Promise<{ success: boolean, code?: string }> {
    const targetWxid = wxidParam || wxid.value
    if (!targetWxid) {
      return { success: false }
    }

    isLoading.value = true
    statusMessage.value = '正在获取QQ农场Code...'

    try {
      const response = await fetch('/api/Wxapp/JSLogin', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          Wxid: targetWxid,
          Uuid: uuid.value,
          AccountId: accountId,
        }),
      })
      const data = await response.json()

      if (data.Success && data.Data && data.Data.code) {
        return { success: true, code: data.Data.code }
      }
      else {
        const errMsg = data.Data?.jsapiBaseresponse?.errmsg || data.Message || '获取Code失败'
        errorMessage.value = errMsg
        return { success: false }
      }
    }
    catch (e: any) {
      errorMessage.value = `请求失败: ${e.message}`
      return { success: false }
    }
    finally {
      isLoading.value = false
    }
  }

  return {
    config,
    isLoading,
    qrCode,
    uuid,
    wxid,
    status,
    statusMessage,
    errorMessage,
    qrEndpoint,
    currentUserId,
    resetState,
    getQRCode,
    checkLogin,
    getFarmCode,
    loadConfigFromServer,
  }
})
