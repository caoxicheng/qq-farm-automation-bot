<script setup lang="ts">
/* eslint-disable style/max-statements-per-line */
import type { ActivityTab } from '@/components/activity/BottomNav.vue'
import type { ShopGoodsDto } from '@/stores/activity-center'
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import ActivityHeader from '@/components/activity/ActivityHeader.vue'
import ActivityShell from '@/components/activity/ActivityShell.vue'
import BottomNav from '@/components/activity/BottomNav.vue'
import ConstellationTab from '@/components/activity/ConstellationTab.vue'
import QingMeiTab from '@/components/activity/QingMeiTab.vue'
import SolarTermsTab from '@/components/activity/SolarTermsTab.vue'
import StarSandExchangeDialog from '@/components/activity/StarSandExchangeDialog.vue'
import StarSandShopTab from '@/components/activity/StarSandShopTab.vue'
import TravelPassTab from '@/components/activity/TravelPassTab.vue'
import { useAccountStore } from '@/stores/account'
import { useActivityCenterStore } from '@/stores/activity-center'

const router = useRouter()
const accountStore = useAccountStore()
const activityStore = useActivityCenterStore()
const { currentAccountId } = storeToRefs(accountStore)
const { season, shop, solarTerms, constellation, qingMei, actions, tabBadges, loading, error, actionError, notice, serverClockOffset, pendingActions } = storeToRefs(activityStore)
const activeTab = ref<ActivityTab>('travel')
const selectedShopGoods = ref<ShopGoodsDto | null>(null)
const clockNow = ref(Date.now())
let clockTimer: number | undefined

const currentData = computed(() => activeTab.value === 'shop' ? shop.value : activeTab.value === 'solar' ? solarTerms.value : activeTab.value === 'constellation' ? constellation.value : activeTab.value === 'qingmei' ? qingMei.value : season.value)
const serverNow = computed(() => clockNow.value + serverClockOffset.value)
const pageTitle = computed(() => activeTab.value === 'qingmei' ? (qingMei.value?.name || '青酿换万金') : currentData.value && 'title' in currentData.value ? currentData.value.title : (season.value?.title || '—'))
const theme = computed(() => activeTab.value === 'solar' ? 'day' : 'night')
const endTime = computed(() => {
  if (activeTab.value === 'shop')
    return shop.value?.endTime
  if (activeTab.value === 'constellation')
    return constellation.value?.endTime || season.value?.endTime
  if (activeTab.value === 'solar')
    return season.value?.endTime
  if (activeTab.value === 'qingmei')
    return qingMei.value?.endTime
  return season.value?.endTime
})
const remaining = computed(() => {
  if (!endTime.value)
    return ''
  const diff = Math.max(0, endTime.value - serverNow.value)
  if (diff === 0)
    return '活动已结束'
  const days = Math.floor(diff / 86400000)
  const hours = Math.floor(diff % 86400000 / 3600000)
  const minutes = Math.floor(diff % 3600000 / 60000)
  return days > 0 ? `剩余：${days}天${hours}小时` : `剩余：${hours}小时${minutes}分钟`
})
const balanceVisible = computed(() => activeTab.value === 'travel' || activeTab.value === 'shop')
const constellationBrandImage = computed(() => activeTab.value === 'constellation' ? '/activity-center/stellar/activity-title.png' : undefined)

function accountId() { return String(currentAccountId.value || '') }
function load(force = false) { return force ? activityStore.refresh(accountId()) : activityStore.lazyLoad(accountId()) }
function goBack() { router.back() }
function claimPass() { activityStore.claimPass(accountId()) }
function lightConstellation() { activityStore.lightConstellation(accountId()) }
function claimSolar(termId: string) { activityStore.claimSolarTerm(accountId(), termId) }
function claimQingMeiSeed() { activityStore.claimQingMeiSeed(accountId()) }
function startQingMeiBrew(ingredients: Array<{ uid: string, count: number }>) { activityStore.startQingMeiBrew(accountId(), ingredients) }
function continueQingMeiBrew() { activityStore.continueQingMeiBrew(accountId()) }
function settleQingMeiBrew() { activityStore.settleQingMeiBrew(accountId()) }
function selectShopGoods(goods: ShopGoodsDto) { selectedShopGoods.value = goods }
function closeExchangeDialog() {
  if (!pendingActions.value.exchange)
    selectedShopGoods.value = null
}
async function exchangeShopGoods(goodsId: string, count: number) {
  const succeeded = await activityStore.exchangeStarSandGoods(accountId(), goodsId, count)
  if (succeeded)
    selectedShopGoods.value = null
}

watch(currentAccountId, () => { selectedShopGoods.value = null; load(true) }, { flush: 'post' })
watch(activeTab, (tab) => {
  if (tab !== 'shop' && !pendingActions.value.exchange)
    selectedShopGoods.value = null
})
onMounted(() => { load(true); clockTimer = window.setInterval(() => clockNow.value = Date.now(), 1000) })
onUnmounted(() => {
  if (clockTimer)
    window.clearInterval(clockTimer)
})
</script>

<template>
  <ActivityShell :theme="theme">
    <div class="activity-center">
      <ActivityHeader :title="pageTitle" :brand-image="constellationBrandImage" :remaining="remaining" :balance="balanceVisible ? (shop?.balanceKnown ? (shop.balance ?? '0') : '--') : undefined" :currency-image="shop?.currency.image" :currency-name="shop?.currency.name" :loading="loading" :show-refresh="activeTab !== 'constellation'" @back="goBack" @refresh="load(true)" />
      <div v-if="!currentAccountId" class="activity-state">
        <strong>请先选择账号</strong><span>活动数据按当前账号加载</span>
      </div>
      <div v-else-if="loading && !season && !shop && !solarTerms && !constellation && !qingMei" class="activity-state">
        <div class="activity-spinner" /><strong>正在加载活动</strong>
      </div>
      <template v-else>
        <div v-if="error || actionError || notice" class="activity-message" :class="{ success: notice && !error && !actionError }" role="status">
          <span>{{ actionError || error || notice }}</span><button v-if="error" type="button" :disabled="loading" @click="load(true)">
            重试
          </button>
        </div>
        <main class="activity-content">
          <TravelPassTab v-if="activeTab === 'travel'" :season="season" :enabled="actions.claimPass.enabled" :pending="pendingActions.claimPass" @claim="claimPass" />
          <ConstellationTab v-else-if="activeTab === 'constellation'" :constellation="constellation" :enabled="actions.lightConstellation.enabled" :pending="pendingActions.lightConstellation" @light="lightConstellation" />
          <StarSandShopTab v-else-if="activeTab === 'shop'" :shop="shop" :enabled="actions.exchange.enabled" :pending="pendingActions.exchange" @select="selectShopGoods" />
          <SolarTermsTab v-else-if="activeTab === 'solar'" :solar="solarTerms" :now="serverNow" :pending="pendingActions.claimSolar" @claim="claimSolar" />
          <QingMeiTab v-else :activity="qingMei" :pending-seed="pendingActions.qingMeiSeed" :pending-start="pendingActions.qingMeiStart" :pending-continue="pendingActions.qingMeiContinue" :pending-settle="pendingActions.qingMeiSettle" @claim-seed="claimQingMeiSeed" @start="startQingMeiBrew" @continue="continueQingMeiBrew" @settle="settleQingMeiBrew" />
        </main>
      </template>
      <BottomNav v-model="activeTab" :badges="tabBadges" />
      <StarSandExchangeDialog
        :open="!!selectedShopGoods"
        :goods="selectedShopGoods"
        :shop="shop"
        :pending="pendingActions.exchange"
        @close="closeExchangeDialog"
        @confirm="exchangeShopGoods"
      />
    </div>
  </ActivityShell>
</template>

<style scoped>
.activity-center {
  position: relative;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.activity-content {
  position: absolute;
  inset: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: rgba(172, 224, 246, 0.5) transparent;
}
.activity-message {
  position: absolute;
  z-index: 25;
  top: calc(91px + env(safe-area-inset-top));
  left: 12px;
  right: 12px;
  min-height: 30px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 10px;
  border: 1px solid rgba(255, 220, 142, 0.6);
  border-radius: 10px;
  color: #fff0c2;
  background: rgba(88, 51, 28, 0.86);
  font-size: 10px;
}
.activity-message.success {
  border-color: rgba(179, 242, 202, 0.65);
  color: #e5ffed;
  background: rgba(30, 91, 67, 0.83);
}
.activity-message button {
  flex: none;
  padding: 3px 8px;
  border: 1px solid rgba(255, 255, 255, 0.42);
  border-radius: 8px;
  color: white;
  background: rgba(255, 255, 255, 0.12);
  cursor: pointer;
}
.activity-state {
  position: absolute;
  z-index: 5;
  inset: 0 0 92px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #c9e7f7;
  text-align: center;
}
.activity-state strong {
  margin-top: 12px;
  font-size: 16px;
}
.activity-state span {
  margin-top: 4px;
  color: #9ec7dc;
  font-size: 11px;
}
.activity-spinner {
  width: 43px;
  height: 43px;
  border: 3px solid rgba(180, 232, 250, 0.25);
  border-top-color: #dff9ff;
  border-radius: 50%;
  animation: spin 0.85s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
