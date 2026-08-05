<script setup lang="ts">
import type { SolarTermsDto } from '@/stores/activity-center'
import { computed, ref, watch } from 'vue'
import RewardItem from './RewardItem.vue'

const props = defineProps<{ solar: SolarTermsDto | null, now: number, pending?: boolean }>()
const emit = defineEmits<{ claim: [termId: string] }>()
const selectedId = ref('')
function activeTermId(solar: SolarTermsDto | null) {
  if (!solar || !Number.isFinite(props.now))
    return ''

  return solar.terms.find(term => (
    Number.isFinite(term.startTime)
    && Number.isFinite(term.endTime)
    && term.startTime! <= props.now
    && props.now <= term.endTime!
  ))?.id || ''
}
watch(() => props.solar, (solar) => {
  if (!solar?.terms.some(term => term.id === selectedId.value))
    selectedId.value = activeTermId(solar) || solar?.currentTermId || solar?.terms.find(term => term.current)?.id || solar?.terms[0]?.id || ''
}, { immediate: true })
const current = computed(() => props.solar?.terms.find(term => term.id === selectedId.value) ?? null)
const description = computed(() => current.value?.description || props.solar?.description || '')
const rewardTitle = computed(() => current.value?.rewardTitle || props.solar?.rewardTitle || '')
const rewardDescription = computed(() => current.value?.rewardDescription || props.solar?.rewardDescription || '')
const timeStatus = computed(() => {
  const startTime = current.value?.startTime
  const endTime = current.value?.endTime
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || !Number.isFinite(props.now))
    return 'unavailable'

  const now = Math.floor(props.now / 1000)
  const start = Math.floor(startTime! / 1000)
  const end = Math.floor(endTime! / 1000)
  if (start > end)
    return 'unavailable'
  if (now < start)
    return 'not-started'
  if (now > end)
    return 'expired'
  return 'active'
})
const canClaim = computed(() => Boolean(current.value && !current.value.claimed && timeStatus.value === 'active' && !props.pending))
const rewardsLocked = computed(() => timeStatus.value === 'not-started')
const buttonLabel = computed(() => {
  if (props.pending)
    return '领取中…'
  if (current.value?.claimed)
    return '已领取'
  if (timeStatus.value === 'not-started')
    return '未开始'
  if (timeStatus.value === 'expired')
    return '已过期'
  if (timeStatus.value === 'active')
    return '领取'
  return '暂不可领取'
})
function claim() {
  if (canClaim.value && current.value)
    emit('claim', current.value.id)
}
</script>

<template>
  <div class="solar-tab">
    <img class="solar-background" src="/activity-center/stellar/solar/dashu-background.png" alt="">
    <div v-if="solar?.terms.length" class="term-rail" aria-label="节令列表">
      <button v-for="term in solar.terms" :key="term.id" type="button" :class="{ active: term.id === selectedId, locked: term.locked }" @click="selectedId = term.id">
        <span>{{ term.name || '—' }}</span><i v-if="term.claimable" aria-label="可领取" />
      </button>
    </div>
    <section class="solar-hero">
      <span v-if="current?.englishName" class="solar-english">{{ current.englishName }}</span>
      <h2>{{ current?.title || current?.name || solar?.title || '—' }}</h2>
      <p v-if="description">
        {{ description }}
      </p>
    </section>
    <section class="solar-reward">
      <h3 v-if="rewardTitle">
        {{ rewardTitle }}
      </h3>
      <p v-if="rewardDescription">
        {{ rewardDescription }}
      </p>
      <div v-if="current?.rewards.length" class="solar-reward__items">
        <RewardItem v-for="(reward, index) in current.rewards" :key="reward.id || index" :name="reward.name" :count="reward.count" :image="reward.image" :rarity="reward.rarity" :locked="rewardsLocked" :claimed="current.claimed" />
      </div>
      <div v-else class="solar-reward__empty">
        暂无数据
      </div>
      <button type="button" :disabled="!canClaim" @click="claim">
        {{ buttonLabel }}
      </button>
    </section>
  </div>
</template>

<style scoped>
.solar-tab {
  position: relative;
  min-height: 100%;
  padding: calc(118px + env(safe-area-inset-top)) 18px 122px;
  color: #275b63;
  background: linear-gradient(180deg, rgba(69, 183, 231, 0.08), rgba(232, 247, 210, 0.1));
  isolation: isolate;
}
.solar-background {
  position: absolute;
  z-index: -2;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center top;
}
.solar-tab::after {
  content: '';
  position: absolute;
  z-index: -1;
  inset: 58% 0 0;
  background: linear-gradient(transparent, rgba(214, 238, 185, 0.5) 30%, rgba(116, 190, 104, 0.42));
}
.term-rail {
  position: absolute;
  z-index: 3;
  top: calc(126px + env(safe-area-inset-top));
  left: 13px;
  bottom: 112px;
  width: 66px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 9px;
  overflow-y: auto;
  padding: 5px 8px 25px;
  scrollbar-width: none;
}
.term-rail::before {
  content: '';
  position: absolute;
  z-index: -1;
  top: 15px;
  bottom: 15px;
  left: 50%;
  border-left: 2px dotted rgba(53, 113, 136, 0.5);
}
.term-rail button {
  position: relative;
  flex: none;
  width: 50px;
  min-height: 45px;
  padding: 5px;
  border: 2px solid rgba(80, 139, 161, 0.65);
  border-radius: 50%;
  color: #326e83;
  background: rgba(222, 246, 239, 0.88);
  box-shadow: 0 2px 7px rgba(43, 105, 120, 0.24);
  font-weight: 700;
  cursor: pointer;
}
.term-rail button.active {
  width: 58px;
  min-height: 53px;
  border-color: #d9f9f0;
  color: #fff;
  background: linear-gradient(#45bad3, #2b7699);
  box-shadow: 0 0 0 3px rgba(74, 157, 181, 0.38);
}
.term-rail button.locked {
  filter: grayscale(0.65);
  opacity: 0.6;
}
.term-rail i {
  position: absolute;
  top: -1px;
  right: 0;
  width: 9px;
  height: 9px;
  border: 1px solid white;
  border-radius: 50%;
  background: #ff4058;
}
.solar-hero {
  padding: 58px 15px 12px 74px;
  text-align: center;
  text-shadow: 0 1px rgba(255, 255, 255, 0.8);
}
.solar-english {
  display: block;
  color: #417288;
  font:
    11px Georgia,
    serif;
  letter-spacing: 0.17em;
}
.solar-hero h2 {
  margin: 4px 0 12px;
  color: #27586b;
  font:
    800 clamp(38px, 12vw, 56px) 'STKaiti',
    'KaiTi',
    serif;
  line-height: 1.06;
  overflow-wrap: anywhere;
}
.solar-hero p {
  margin: 0;
  color: #397483;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-line;
}
.solar-reward {
  position: relative;
  margin: 15px 0 0 70px;
  padding: 17px 12px 13px;
  border: 2px solid rgba(79, 144, 137, 0.56);
  border-radius: 18px;
  background: rgba(239, 253, 231, 0.84);
  box-shadow:
    inset 0 0 14px rgba(255, 255, 255, 0.72),
    0 4px 10px rgba(49, 114, 99, 0.2);
  text-align: center;
}
.solar-reward h3 {
  margin: 0;
  color: #326d68;
  font-size: 17px;
}
.solar-reward p {
  min-height: 1em;
  margin: 4px 0 10px;
  color: #61908a;
  font-size: 10px;
  white-space: pre-line;
}
.solar-reward__items {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
}
.solar-reward__empty {
  padding: 16px;
  color: #719b95;
  font-size: 12px;
}
.solar-reward button {
  display: block;
  width: 118px;
  margin: 12px auto 0;
  padding: 9px;
  border: 2px solid #d8f5dd;
  border-radius: 20px;
  color: white;
  background: linear-gradient(#6ec8e2, #3796be);
  box-shadow: 0 2px 6px rgba(35, 100, 87, 0.28);
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
}
.solar-reward button:disabled {
  filter: grayscale(0.5);
  opacity: 0.58;
  cursor: not-allowed;
}
</style>
