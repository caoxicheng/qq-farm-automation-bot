<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { computed, reactive, ref, watch } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseTextarea from '@/components/ui/BaseTextarea.vue'
import { useWxLoginStore } from '@/stores/wx-login'

const props = defineProps<{
  show: boolean
  editData?: any
}>()

const emit = defineEmits(['close', 'saved'])

const wxLoginStore = useWxLoginStore()

// 标签页：wx-微信扫码, manual-手动填码
const activeTab = ref<'wx' | 'manual'>('manual')
const loading = ref(false)
const errorMessage = ref('')

// 微信扫码相关
const wxAccountName = ref('')

// 表单数据
const form = reactive({
  name: '',
  code: '',
  platform: 'qq' as 'qq' | 'wx',
})

// 微信扫码轮询（串行：上一次完成才发下一次；2s 间隔 + 60s 超时下并发堆积会拖慢页面/过期响应覆盖状态，加锁防重叠）
let pollingLock = false
const { pause: stopWxCheck, resume: startWxCheck } = useIntervalFn(async () => {
  if (pollingLock) {
    return
  }
  if (wxLoginStore.status !== 'qr_ready' && wxLoginStore.status !== 'confirming') {
    return
  }
  pollingLock = true
  try {
    const result = await wxLoginStore.checkLogin()
    if (result.success && result.wxid) {
      stopWxCheck()
      // 获取Code并添加账号
      const codeResult = await wxLoginStore.getFarmCode(undefined, props.editData?.id)
      if (codeResult.success && codeResult.code) {
        const name = wxAccountName.value.trim() || result.nickname || `微信账号${Date.now()}`
        // 检查是否启用自动添加账号
        if (wxLoginStore.config.autoAddAccount) {
          await addAccount({
            id: props.editData?.id,
            name: props.editData ? (props.editData.name || name) : name,
            code: codeResult.code,
            platform: 'wx',
            loginType: 'wx_qr',
            wxid: result.wxid,
            wxSessionId: wxLoginStore.uuid,
          })
        }
        else {
          // 不自动添加，只显示 code 让用户手动复制
          form.code = codeResult.code
          form.platform = 'wx'
          activeTab.value = 'manual'
        }
      }
    }
  }
  finally {
    pollingLock = false
  }
}, 2000, { immediate: false })

// 获取微信二维码
async function loadWxQRCode() {
  if (activeTab.value !== 'wx')
    return
  wxLoginStore.resetState()
  const success = await wxLoginStore.getQRCode()
  if (success) {
    startWxCheck()
  }
}

// 添加账号
async function addAccount(data: any) {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = await api.post('/api/accounts', data)
    if (res.data.ok) {
      emit('saved')
      close()
    }
    else {
      errorMessage.value = `保存失败: ${res.data.error}`
    }
  }
  catch (e: any) {
    errorMessage.value = `保存失败: ${e.response?.data?.error || e.message}`
  }
  finally {
    loading.value = false
  }
}

// 手动提交
async function submitManual() {
  errorMessage.value = ''
  if (!form.code) {
    errorMessage.value = '请输入Code'
    return
  }

  let code = form.code.trim()
  const match = code.match(/[?&]code=([^&]+)/i)
  if (match && match[1]) {
    code = decodeURIComponent(match[1])
    form.code = code
  }

  let payload: any = {}
  if (props.editData) {
    const onlyNameChanged = form.name !== props.editData.name
      && form.code === (props.editData.code || '')
      && form.platform === (props.editData.platform || 'qq')

    if (onlyNameChanged) {
      payload = { id: props.editData.id, name: form.name }
    }
    else {
      payload = {
        id: props.editData.id,
        name: form.name,
        code,
        platform: form.platform,
        loginType: 'manual',
      }
    }
  }
  else {
    payload = {
      name: form.name,
      code,
      platform: form.platform,
      loginType: 'manual',
    }
  }

  if (form.platform === 'wx' && wxLoginStore.wxid && wxLoginStore.uuid) {
    payload.loginType = 'wx_qr'
    payload.wxid = wxLoginStore.wxid
    payload.wxSessionId = wxLoginStore.uuid
  }

  await addAccount(payload)
}

// 微信二维码图片
const wxQrImageSrc = computed(() => {
  if (!wxLoginStore.qrCode)
    return ''
  if (wxLoginStore.qrCode.startsWith('data:'))
    return wxLoginStore.qrCode
  if (wxLoginStore.qrCode.startsWith('http'))
    return wxLoginStore.qrCode
  return `data:image/png;base64,${wxLoginStore.qrCode}`
})

function close() {
  stopWxCheck()
  wxLoginStore.resetState()
  emit('close')
}

watch(() => props.show, (newVal) => {
  if (newVal) {
    errorMessage.value = ''
    if (props.editData) {
      activeTab.value = 'manual'
      form.name = props.editData.name || ''
      form.code = props.editData.code || ''
      form.platform = props.editData.platform || 'qq'
      wxAccountName.value = props.editData.name || ''
    }
    else {
      activeTab.value = 'manual'
      form.name = ''
      form.code = ''
      form.platform = 'qq'
      wxAccountName.value = ''
    }
  }
  else {
    stopWxCheck()
    wxLoginStore.resetState()
  }
})

watch(activeTab, (tab) => {
  if (tab === 'wx') {
    loadWxQRCode()
  }
})
</script>

<template>
  <div v-if="show" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
    <div class="max-h-[90vh] max-w-md w-full overflow-hidden rounded-lg shadow-xl" :style="{ background: 'var(--theme-bg)' }">
      <!-- Header -->
      <div class="flex items-center justify-between border-b p-4" :style="{ borderColor: 'color-mix(in srgb, var(--theme-text) 10%, transparent)' }">
        <h3 class="text-lg font-semibold" :style="{ color: 'var(--theme-text)' }">
          {{ editData ? '编辑账号' : '添加账号' }}
        </h3>
        <BaseButton variant="ghost" class="!p-1" @click="close">
          <div class="i-carbon-close text-xl" :style="{ color: 'var(--theme-text)' }" />
        </BaseButton>
      </div>

      <div class="max-h-[calc(90vh-80px)] overflow-y-auto p-4">
        <!-- 错误信息 -->
        <div v-if="errorMessage" class="mb-4 rounded p-3 text-sm" :style="{ background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444' }">
          {{ errorMessage }}
        </div>

        <!-- Tabs -->
        <div class="mb-4 flex border-b" :style="{ borderColor: 'color-mix(in srgb, var(--theme-text) 10%, transparent)' }">
          <button
            class="flex-1 py-2 text-center text-sm font-medium transition-colors"
            :class="activeTab === 'manual' ? 'border-b-2' : 'opacity-60'"
            :style="{
              color: activeTab === 'manual' ? 'var(--theme-primary)' : 'var(--theme-text)',
              borderColor: 'var(--theme-primary)',
            }"
            @click="activeTab = 'manual'"
          >
            手动填码
          </button>
          <button
            v-if="wxLoginStore.config.enabled"
            class="flex-1 py-2 text-center text-sm font-medium transition-colors"
            :class="activeTab === 'wx' ? 'border-b-2' : 'opacity-60'"
            :style="{
              color: activeTab === 'wx' ? 'var(--theme-primary)' : 'var(--theme-text)',
              borderColor: 'var(--theme-primary)',
            }"
            @click="activeTab = 'wx'"
          >
            微信扫码
          </button>
        </div>

        <!-- 微信扫码 Tab -->
        <div v-if="activeTab === 'wx'" class="space-y-4">
          <BaseInput
            v-model="wxAccountName"
            label="账号备注（可选）"
            placeholder="留空使用微信昵称"
          />

          <div class="flex flex-col items-center justify-center py-4 space-y-4">
            <div
              v-if="wxQrImageSrc"
              class="border rounded-lg p-2"
              :style="{ borderColor: 'color-mix(in srgb, var(--theme-text) 20%, transparent)', background: '#fff' }"
            >
              <img :src="wxQrImageSrc" class="h-48 w-48">
            </div>
            <div
              v-else
              class="h-48 w-48 flex items-center justify-center rounded-lg"
              :style="{ background: 'color-mix(in srgb, var(--theme-bg) 90%, var(--theme-text))' }"
            >
              <div v-if="wxLoginStore.isLoading" i-svg-spinners-90-ring-with-bg class="text-3xl" :style="{ color: 'var(--theme-primary)' }" />
              <span v-else class="text-sm" :style="{ color: 'var(--theme-text)' }">点击获取二维码</span>
            </div>

            <p class="text-center text-sm" :style="{ color: 'var(--theme-text)' }">
              {{ wxLoginStore.statusMessage }}
            </p>

            <p v-if="wxLoginStore.errorMessage" class="text-center text-sm text-red-600">
              {{ wxLoginStore.errorMessage }}
            </p>

            <BaseButton variant="secondary" size="sm" :loading="wxLoginStore.isLoading" @click="loadWxQRCode">
              刷新二维码
            </BaseButton>
          </div>

          <div class="text-center text-xs opacity-60" :style="{ color: 'var(--theme-text)' }">
            使用微信扫描二维码登录，登录成功后将自动添加账号
          </div>
        </div>

        <!-- 手动填码 Tab -->
        <div v-if="activeTab === 'manual'" class="space-y-4">
          <BaseInput
            v-model="form.name"
            label="账号备注（可选）"
            placeholder="留空默认账号"
          />

          <BaseTextarea
            v-model="form.code"
            label="Code"
            placeholder="请输入登录 Code"
            :rows="3"
          />

          <div v-if="!editData" class="flex gap-4">
            <label class="flex cursor-pointer items-center gap-2">
              <input
                v-model="form.platform"
                type="radio"
                value="qq"
                class="h-4 w-4"
                :style="{ accentColor: 'var(--theme-primary)' }"
              >
              <span class="text-sm" :style="{ color: 'var(--theme-text)' }">QQ小程序</span>
            </label>
            <label class="flex cursor-pointer items-center gap-2">
              <input
                v-model="form.platform"
                type="radio"
                value="wx"
                class="h-4 w-4"
                :style="{ accentColor: 'var(--theme-primary)' }"
              >
              <span class="text-sm" :style="{ color: 'var(--theme-text)' }">微信小程序</span>
            </label>
          </div>

          <div class="flex justify-end gap-2 pt-4">
            <BaseButton variant="outline" @click="close">
              取消
            </BaseButton>
            <BaseButton variant="primary" :loading="loading" @click="submitManual">
              {{ editData ? '保存' : '添加' }}
            </BaseButton>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
