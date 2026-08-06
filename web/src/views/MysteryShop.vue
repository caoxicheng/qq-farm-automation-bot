<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import api from '@/api'
import CommerceItemImage from '@/components/commerce/CommerceItemImage.vue'
import { useAccountStore } from '@/stores/account'

interface MysteryNpcDto {
  id: string
  reward: { id: string, count: string, name: string, image: string }
  stock: number
  price: { id: string, count: string, balance: number | null }
  originalPrice: string
  discountPercent: number
}

interface MysteryShopDto {
  active: boolean
  serverTime: number
  activeTime?: number
  expireTime?: number
  npc: MysteryNpcDto | null
}

const accountStore = useAccountStore()
const { currentAccountId } = storeToRefs(accountStore)
const mystery = ref<MysteryShopDto | null>(null)
const loading = ref(false)
const error = ref('')
const notice = ref('')
const buying = ref(false)
const buyCount = ref(1)
const clock = ref(Date.now())
let timer: number | undefined

const remaining = computed(() => {
  const end = mystery.value?.expireTime || 0
  const diff = Math.max(0, end - clock.value)
  if (!end || diff === 0)
    return '已离开'
  const hours = Math.floor(diff / 3600000)
  const minutes = Math.floor((diff % 3600000) / 60000)
  const seconds = Math.floor((diff % 60000) / 1000)
  return `${hours}小时${minutes}分${seconds}秒`
})

const discountLabel = computed(() => {
  const percent = mystery.value?.npc?.discountPercent || 0
  return percent > 0 ? `${(percent / 10).toFixed(percent % 10 ? 1 : 0)}折` : ''
})

const priceNumber = computed(() => Number(mystery.value?.npc?.price?.count || 0))
const balanceNumber = computed(() => {
  const b = mystery.value?.npc?.price?.balance
  return b === null || b === undefined ? null : Number(b)
})
const canBuy = computed(() => {
  const npc = mystery.value?.npc
  if (!npc)
    return false
  if (balanceNumber.value === null)
    return true
  return balanceNumber.value >= priceNumber.value * buyCount.value
})

async function load() {
  const id = String(currentAccountId.value || '')
  if (!id)
    return
  loading.value = true
  error.value = ''
  try {
    const response = await api.get('/api/mystery-shop', {
      headers: { 'x-account-id': id },
      skipErrorToast: true,
    } as any)
    if (!response.data?.ok)
      throw new Error(response.data?.error || '神秘商人加载失败')
    mystery.value = response.data.data as MysteryShopDto
  }
  catch (cause: any) {
    error.value = cause?.message || '神秘商人加载失败'
  }
  finally {
    loading.value = false
  }
}

async function buy() {
  const id = String(currentAccountId.value || '')
  const npc = mystery.value?.npc
  if (!id || !npc || buying.value)
    return
  buying.value = true
  notice.value = ''
  error.value = ''
  try {
    const response = await (api.post as any)('/api/mystery-shop/buy', {
      npcId: npc.id,
      count: buyCount.value,
    }, {
      headers: { 'x-account-id': id },
      skipErrorToast: true,
    })
    if (!response.data?.ok)
      throw new Error(response.data?.error || '购买失败')
    const rewards = (response.data.data?.rewards || [])
      .map((item: any) => `${item.name || `#${item.id}`} x${item.count}`)
      .join('、')
    notice.value = rewards ? `购买成功：${rewards}` : '购买成功'
    mystery.value = response.data.data?.snapshot || mystery.value
  }
  catch (cause: any) {
    error.value = cause?.message || '购买失败'
  }
  finally {
    buying.value = false
  }
}

watch(currentAccountId, load)
onMounted(() => {
  load()
  timer = window.setInterval(() => clock.value = Date.now(), 1000)
})
onUnmounted(() => {
  if (timer)
    window.clearInterval(timer)
})
</script>

<template>
  <div class="mystery-page">
    <header class="mystery-header">
      <div>
        <p>限时来访</p>
        <h1>神秘商人</h1>
        <span v-if="mystery?.active">距离离开 {{ remaining }}</span>
      </div>
      <button type="button" title="刷新神秘商人" :disabled="loading" @click="load">
        <span :class="{ spinning: loading }">🔄</span>
      </button>
    </header>

    <div v-if="!currentAccountId" class="mystery-state">
      <div class="mystery-state__icon">
        👤
      </div>
      <strong>请先选择账号</strong>
    </div>
    <div v-else-if="loading && !mystery" class="mystery-state">
      <div class="mystery-state__icon spinning">
        🔄
      </div>
      <strong>正在寻找神秘商人</strong>
    </div>
    <div v-else-if="error && !mystery" class="mystery-state">
      <div class="mystery-state__icon">
        ⚠️
      </div>
      <strong>{{ error }}</strong>
      <button type="button" @click="load">
        重试
      </button>
    </div>
    <div v-else-if="!mystery?.active || !mystery.npc" class="mystery-state">
      <div class="mystery-state__icon">
        🎩
      </div>
      <strong>神秘商人暂未出现</strong>
      <p class="mystery-state__hint">
        限时商人随机出现，出现后自动显示
      </p>
      <button type="button" @click="load">
        立即刷新
      </button>
    </div>

    <main v-else class="merchant-scene">
      <section class="merchant-identity">
        <div class="merchant-mark">
          🎩
        </div>
        <div>
          <span>商人编号 #{{ mystery.npc.id }}</span>
          <h2>今日神秘货品</h2>
          <p>{{ new Date(mystery.activeTime || 0).toLocaleString() }} 开始营业</p>
        </div>
      </section>

      <article class="mystery-offer">
        <div class="offer-visual">
          <CommerceItemImage :src="mystery.npc.reward.image" :alt="mystery.npc.reward.name" size="lg" />
          <span v-if="discountLabel">{{ discountLabel }}</span>
        </div>
        <div class="offer-content">
          <small>神秘商品 #{{ mystery.npc.reward.id }}</small>
          <h2>{{ mystery.npc.reward.name || '未知商品' }}</h2>
          <p>每份 x{{ mystery.npc.reward.count }}</p>
          <dl>
            <div><dt>剩余库存</dt><dd>{{ mystery.npc.stock }}</dd></div>
            <div>
              <dt>原价</dt><dd class="original">
                {{ Number(mystery.npc.originalPrice || 0).toLocaleString() }}
              </dd>
            </div>
          </dl>
          <div class="offer-price">
            <span class="offer-price__coin">🪙</span>
            <strong>{{ priceNumber.toLocaleString() }}</strong>
            <span>余额 {{ balanceNumber === null ? '--' : balanceNumber.toLocaleString() }}</span>
          </div>
          <div class="offer-buy">
            <div class="offer-buy__count">
              <button type="button" :disabled="buyCount <= 1" @click="buyCount--">
                −
              </button>
              <span>{{ buyCount }}</span>
              <button type="button" :disabled="buyCount >= Math.max(1, mystery.npc.stock)" @click="buyCount++">
                +
              </button>
            </div>
            <button type="button" class="offer-buy__btn" :disabled="buying || !canBuy" @click="buy">
              {{ buying ? '购买中...' : (canBuy ? '购买' : '余额不足') }}
            </button>
          </div>
          <p v-if="notice" class="offer-buy__notice">
            {{ notice }}
          </p>
          <p v-if="error" class="offer-buy__error">
            {{ error }}
          </p>
        </div>
      </article>
    </main>
  </div>
</template>

<style scoped>
.mystery-page {
  min-height: 100%;
  color: #302b26;
}
.mystery-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 2px 20px;
  border-bottom: 1px solid rgba(116, 91, 59, 0.18);
}
.mystery-header p {
  margin: 0 0 3px;
  color: #8c623c;
  font-size: 12px;
}
.mystery-header h1 {
  margin: 0;
  font-size: 28px;
  letter-spacing: 0;
}
.mystery-header span {
  display: block;
  margin-top: 5px;
  color: #74685d;
  font-size: 12px;
}
.mystery-header button {
  display: grid;
  width: 40px;
  height: 40px;
  place-items: center;
  border: 1px solid #d9d0c4;
  border-radius: 6px;
  background: white;
  color: #51483f;
  font-size: 18px;
  cursor: pointer;
}
.merchant-scene {
  padding: 26px 0;
}
.merchant-identity {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 22px;
}
.merchant-mark {
  display: grid;
  width: 58px;
  height: 58px;
  place-items: center;
  border-radius: 50%;
  background: #392e25;
  color: #f0c56a;
  font-size: 28px;
}
.merchant-identity span {
  color: #8c7c6d;
  font-size: 11px;
}
.merchant-identity h2 {
  margin: 2px 0;
  font-size: 18px;
  letter-spacing: 0;
}
.merchant-identity p {
  margin: 0;
  color: #8c7c6d;
  font-size: 12px;
}
.mystery-offer {
  display: grid;
  grid-template-columns: minmax(240px, 42%) 1fr;
  min-height: 430px;
  overflow: hidden;
  border: 1px solid rgba(101, 75, 49, 0.24);
  border-radius: 8px;
  background: #fffdf8;
  box-shadow: 0 8px 28px rgba(64, 43, 24, 0.1);
}
.offer-visual {
  position: relative;
  display: grid;
  place-items: center;
  background: linear-gradient(145deg, #2f2823, #534332);
}
.offer-visual:before {
  position: absolute;
  inset: 12%;
  border: 1px solid rgba(245, 203, 111, 0.2);
  border-radius: 50%;
  content: '';
}
.offer-visual > span {
  position: absolute;
  top: 16px;
  right: 16px;
  padding: 5px 10px;
  border-radius: 4px;
  background: #c75036;
  color: white;
  font-size: 13px;
  font-weight: 800;
}
.offer-content {
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: clamp(26px, 6vw, 64px);
}
.offer-content small {
  color: #9a8979;
}
.offer-content h2 {
  margin: 8px 0 4px;
  font-size: clamp(24px, 4vw, 38px);
  letter-spacing: 0;
}
.offer-content > p {
  margin: 0;
  color: #6e6257;
}
.offer-content dl {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin: 28px 0;
}
.offer-content dl > div {
  padding: 12px 0;
  border-block: 1px solid #ece3d7;
}
.offer-content dt {
  color: #8b7e71;
  font-size: 11px;
}
.offer-content dd {
  margin: 5px 0 0;
  font-size: 16px;
  font-weight: 800;
}
.offer-content dd.original {
  text-decoration: line-through;
  color: #9e9185;
}
.offer-price {
  display: flex;
  align-items: center;
  gap: 10px;
}
.offer-price strong {
  color: #9a6217;
  font-size: 28px;
}
.offer-price span {
  margin-left: auto;
  color: #807366;
  font-size: 12px;
}
.offer-buy {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 22px;
}
.offer-buy__count {
  display: flex;
  align-items: center;
  gap: 8px;
}
.offer-buy__count button {
  width: 32px;
  height: 32px;
  border: 1px solid #d9d0c4;
  border-radius: 6px;
  background: white;
  color: #51483f;
  font-size: 16px;
  cursor: pointer;
}
.offer-buy__count span {
  min-width: 32px;
  text-align: center;
  font-size: 16px;
  font-weight: 800;
}
.offer-buy__btn {
  height: 38px;
  padding: 0 26px;
  border: 0;
  border-radius: 6px;
  background: #9a6217;
  color: white;
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
}
.offer-buy__btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.offer-buy__notice {
  color: #2e7d32;
  font-size: 13px;
  font-weight: 600;
}
.offer-buy__error {
  color: #c62828;
  font-size: 13px;
}
.mystery-state {
  display: flex;
  min-height: 430px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: #80756a;
  text-align: center;
}
.mystery-state__icon {
  font-size: 38px;
}
.mystery-state__hint {
  margin: 0;
  color: #a89b8e;
  font-size: 12px;
}
.mystery-state button {
  height: 36px;
  padding: 0 16px;
  border: 0;
  border-radius: 6px;
  background: #3f342b;
  color: white;
  cursor: pointer;
}
.spinning {
  display: inline-block;
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 720px) {
  .mystery-offer {
    grid-template-columns: 1fr;
  }
  .offer-visual {
    min-height: 260px;
  }
  .offer-content {
    padding: 26px;
  }
  .mystery-header h1 {
    font-size: 24px;
  }
}
</style>
