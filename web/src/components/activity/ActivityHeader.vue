<script setup lang="ts">
defineProps<{
  title: string
  remaining?: string
  balance?: string
  currencyImage?: string
  currencyName?: string
  loading?: boolean
  brandImage?: string
  showRefresh?: boolean
}>()

defineEmits<{
  back: []
  refresh: []
}>()
</script>

<template>
  <header class="activity-header">
    <div class="activity-header__brand">
      <button type="button" class="activity-header__back" aria-label="返回" @click="$emit('back')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 4-8 8 8 8" /></svg>
      </button>
      <img v-if="brandImage" class="activity-header__logo" :src="brandImage" :alt="title || '活动标题'">
      <h1 v-else>
        {{ title || '—' }}
      </h1>
    </div>
    <div v-if="balance !== undefined" class="activity-header__balance" :title="currencyName">
      <img v-if="currencyImage" :src="currencyImage" alt="">
      <b>{{ balance || '--' }}</b>
    </div>
    <button v-if="showRefresh" class="activity-header__refresh" type="button" :disabled="loading" aria-label="刷新活动数据" @click="$emit('refresh')">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 7v5h-5M5 17v-5h5" /><path d="M18 12a6 6 0 0 0-10.2-4.3L5 10m1 2a6 6 0 0 0 10.2 4.3L19 14" /></svg>
    </button>
    <div v-if="remaining" class="activity-header__time">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13" r="8" /><path d="M12 9v4l3 2M9 3h6" /></svg>
      {{ remaining }}
    </div>
  </header>
</template>

<style scoped>
.activity-header {
  position: absolute;
  z-index: 20;
  inset: 0 0 auto;
  min-height: calc(122px + env(safe-area-inset-top));
  padding: calc(12px + env(safe-area-inset-top)) 14px 8px;
  pointer-events: none;
  background: linear-gradient(180deg, rgba(7, 25, 66, 0.55), rgba(7, 35, 78, 0.08) 86%, transparent);
  text-shadow: 0 2px 3px rgba(0, 23, 65, 0.8);
}
.activity-header__brand {
  display: flex;
  align-items: center;
  gap: 4px;
  max-width: calc(100% - 90px);
}
button {
  pointer-events: auto;
}
.activity-header__back {
  width: 35px;
  height: 40px;
  display: grid;
  flex: none;
  place-items: center;
  padding: 0;
  border: 0;
  color: #f5fdff;
  background: transparent;
  filter: drop-shadow(0 2px 2px #155a91);
  cursor: pointer;
}
.activity-header__back svg {
  width: 34px;
  fill: none;
  stroke: currentColor;
  stroke-width: 3.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.activity-header__logo {
  width: min(250px, calc(100vw - 66px));
  height: 62px;
  object-fit: contain;
  object-position: left center;
  filter: drop-shadow(0 2px 3px rgba(21, 90, 145, 0.48));
}
h1 {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: white;
  font-size: clamp(20px, 5.7vw, 27px);
  font-weight: 800;
  letter-spacing: 0.035em;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.activity-header__balance {
  position: absolute;
  top: calc(18px + env(safe-area-inset-top));
  right: 54px;
  min-width: 53px;
  height: 29px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 2px 8px 2px 4px;
  border: 1px solid rgba(255, 255, 255, 0.65);
  border-radius: 999px;
  color: #79531d;
  background: rgba(255, 249, 220, 0.94);
  text-shadow: none;
  font-size: 12px;
}
.activity-header__balance img {
  width: 23px;
  height: 23px;
  object-fit: contain;
}
.activity-header__refresh {
  position: absolute;
  top: calc(16px + env(safe-area-inset-top));
  right: 13px;
  width: 31px;
  height: 31px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(255, 255, 255, 0.36);
  border-radius: 50%;
  color: white;
  background: rgba(4, 53, 105, 0.48);
  cursor: pointer;
}
.activity-header__refresh:disabled {
  opacity: 0.55;
  cursor: wait;
}
.activity-header__refresh svg {
  width: 17px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.activity-header__time {
  width: max-content;
  max-width: calc(100% - 55px);
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 1px 0 0 37px;
  padding: 4px 10px;
  border-radius: 999px;
  overflow: hidden;
  color: #eff9ff;
  background: rgba(0, 20, 51, 0.78);
  box-shadow: 0 2px 8px rgba(0, 12, 43, 0.2);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.activity-header__time svg {
  width: 14px;
  height: 14px;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
}
</style>
