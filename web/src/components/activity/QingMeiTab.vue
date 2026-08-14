<script setup lang="ts">
import type { QingMeiActivityDto } from '@/stores/activity-center'
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  activity: QingMeiActivityDto | null
  pendingSeed: boolean
  pendingStart: boolean
  pendingContinue: boolean
  pendingSettle: boolean
}>()
const emit = defineEmits<{
  claimSeed: []
  start: [ingredients: Array<{ uid: string, count: number }>]
  continue: []
  settle: []
}>()

const selected = ref(new Set<string>())
const counts = ref<Record<string, number>>({})
const ingredients = computed(() => props.activity?.ingredients || [])
const busy = computed(() => props.pendingSeed || props.pendingStart || props.pendingContinue || props.pendingSettle)
const allSelected = computed(() => ingredients.value.length > 0 && selected.value.size === ingredients.value.length)
const quotes = computed(() => props.activity?.quotes || [])

watch(ingredients, (items) => {
  const available = new Set(items.map(item => item.uid))
  selected.value = new Set([...selected.value].filter(uid => available.has(uid)))
  counts.value = Object.fromEntries(items.map(item => [item.uid, Math.max(1, Math.min(counts.value[item.uid] || Number(item.count), Number(item.count)))]))
}, { immediate: true })

function toggle(uid: string) {
  const next = new Set(selected.value)
  next.has(uid) ? next.delete(uid) : next.add(uid)
  selected.value = next
}
function toggleAll() {
  selected.value = allSelected.value ? new Set() : new Set(ingredients.value.map(item => item.uid))
}
function setCount(uid: string, value: unknown) {
  const maximum = Number(ingredients.value.find(item => item.uid === uid)?.count || 1)
  counts.value = { ...counts.value, [uid]: Math.max(1, Math.min(Math.trunc(Number(value) || 1), maximum)) }
}
function start() {
  emit('start', ingredients.value.filter(item => selected.value.has(item.uid)).map(item => ({ uid: item.uid, count: counts.value[item.uid] || 1 })))
}
function formatGold(value: string) {
  try {
    return BigInt(value).toLocaleString('zh-CN')
  }
  catch {
    return value
  }
}
</script>

<template>
  <section class="qingmei">
    <div v-if="!activity" class="empty">
      当前账号暂未发现青酿换万金活动
    </div>
    <template v-else>
      <header>
        <div><span>限时酿造</span><h2>{{ activity.name }}</h2><p>投入青梅逐轮查看报价，在合适的时机分享出售。</p></div>
        <div class="balance">
          <img v-if="activity.ingredient.image" :src="activity.ingredient.image" alt=""><strong>{{ activity.balanceKnown ? activity.balance : '—' }}</strong><small>{{ activity.balanceKnown ? '可用青梅' : '背包暂不可用' }}</small>
        </div>
      </header>
      <div class="card daily">
        <div><strong>每日青梅种子</strong><small>领取后种植并收获青梅</small></div>
        <button :disabled="busy || activity.dailySeed.claimed || !activity.actions.claimSeed.enabled" @click="emit('claimSeed')">
          {{ activity.dailySeed.claimed ? '今日已领取' : '领取种子' }}
        </button>
      </div>
      <div class="card brew">
        <div class="heading">
          <div><small>酿造进度</small><strong>{{ activity.started ? `第 ${activity.currentRound}/${activity.maxRounds} 轮` : '尚未开始' }}</strong></div><span>保底单价 {{ activity.guaranteedPrice || activity.basePrice }}</span>
        </div>
        <template v-if="!activity.started">
          <div class="select-head">
            <strong>选择青梅原料</strong><button :disabled="busy || !ingredients.length" @click="toggleAll">
              {{ allSelected ? '取消全选' : '全选' }}
            </button>
          </div>
          <div class="ingredients">
            <article v-for="item in ingredients" :key="item.uid" :class="{ selected: selected.has(item.uid) }">
              <button class="item" :disabled="busy" @click="toggle(item.uid)">
                <img v-if="item.image" :src="item.image" alt=""><span><strong>{{ item.name }}</strong><small>UID {{ item.uid }} · x{{ item.count }}</small></span><i>{{ selected.has(item.uid) ? '✓' : '' }}</i>
              </button>
              <input type="number" min="1" :max="item.count" :disabled="busy || !selected.has(item.uid)" :value="counts[item.uid]" @input="setCount(item.uid, ($event.target as HTMLInputElement).value)">
            </article>
          </div>
          <button class="primary" :disabled="busy || selected.size === 0 || !activity.actions.start.enabled" @click="start">
            开始酿造
          </button>
        </template>
        <template v-else>
          <div class="quotes">
            <article v-for="quote in quotes" :key="quote.round">
              <small>第 {{ quote.round }} 轮</small><strong>{{ formatGold(quote.totalGold) }}</strong><span>{{ quote.unitPrice === '0' ? '单价待确认' : `单价 ${quote.unitPrice}` }}</span>
            </article><article v-for="round in Math.max(0, activity.maxRounds - quotes.length)" :key="`pending-${round}`" class="pending">
              <small>第 {{ quotes.length + round }} 轮</small><strong>待报价</strong>
            </article>
          </div>
          <div class="actions">
            <button :disabled="busy || !activity.actions.continue.enabled" @click="emit('continue')">
              继续酿造
            </button><button class="settle" :disabled="busy || !activity.actions.settle.enabled" @click="emit('settle')">
              分享出售（1.5 倍）
            </button>
          </div>
        </template>
      </div>
    </template>
  </section>
</template>

<style scoped>
.qingmei {
  min-height: 100%;
  padding: 112px 16px 96px;
  color: #234b3b;
  background: linear-gradient(180deg, #c9ead2, #eef5dd 42%, #f7edca);
}
.empty {
  padding: 100px 20px;
  text-align: center;
  color: #678073;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}
header span,
header p,
small {
  color: #688073;
  font-size: 12px;
}
h2 {
  margin: 3px 0;
  font-size: 28px;
}
.balance {
  display: grid;
  grid-template-columns: 44px auto;
  align-items: center;
  gap: 0 8px;
}
.balance img {
  width: 44px;
  height: 44px;
  grid-row: 1/3;
  object-fit: contain;
}
.balance strong {
  font-size: 22px;
}
.card {
  margin-bottom: 12px;
  padding: 14px;
  border: 1px solid #9ebca6;
  border-radius: 12px;
  background: #fffffff0;
  box-shadow: 0 5px 18px #355f4215;
}
.daily,
.heading,
.select-head,
.actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.daily > div,
.heading > div {
  display: flex;
  flex-direction: column;
}
.card button {
  min-height: 38px;
  padding: 0 14px;
  border: 0;
  border-radius: 8px;
  color: white;
  background: #397b51;
  font-weight: 700;
}
.card button:disabled {
  opacity: 0.45;
}
.heading > span {
  padding: 5px 8px;
  border-radius: 6px;
  color: #765b28;
  background: #f5e8b9;
}
.select-head {
  margin: 14px 0 8px;
}
.select-head button {
  color: #397b51;
  background: transparent;
}
.ingredients {
  display: grid;
  gap: 8px;
}
.ingredients article {
  display: grid;
  grid-template-columns: 1fr 74px;
  gap: 8px;
  padding: 9px;
  border: 1px solid #b5c8b9;
  border-radius: 9px;
  background: #f4f8ef;
}
.ingredients article.selected {
  border-color: #397b51;
  background: #eaf5e8;
}
.item {
  display: grid !important;
  grid-template-columns: 44px 1fr 24px;
  align-items: center;
  text-align: left !important;
  color: #234b3b !important;
  background: transparent !important;
}
.item img {
  width: 42px;
  height: 42px;
  object-fit: contain;
}
.item span {
  display: flex;
  min-width: 0;
  flex-direction: column;
}
.item i {
  display: grid;
  width: 22px;
  height: 22px;
  place-items: center;
  border: 1px solid #8aa797;
  border-radius: 5px;
  font-style: normal;
}
.ingredients input {
  width: 100%;
  border: 1px solid #9db2a4;
  border-radius: 7px;
  text-align: center;
}
.primary {
  width: 100%;
  margin-top: 12px;
}
.quotes {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-top: 14px;
}
.quotes article {
  min-height: 84px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border: 1px solid #b5c8b9;
  border-radius: 8px;
  background: #f5f8ef;
}
.quotes strong {
  color: #815125;
  font-size: 17px;
}
.quotes span {
  font-size: 11px;
}
.quotes .pending {
  opacity: 0.55;
}
.actions {
  margin-top: 12px;
}
.actions button {
  flex: 1;
}
.actions .settle {
  background: #a56727;
}
@media (max-width: 480px) {
  header {
    align-items: flex-start;
  }
  .balance {
    grid-template-columns: 34px auto;
  }
  .balance img {
    width: 34px;
    height: 34px;
  }
  .ingredients article {
    grid-template-columns: 1fr 60px;
  }
}
</style>
