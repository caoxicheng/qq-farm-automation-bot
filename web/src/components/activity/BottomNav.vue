<script setup lang="ts">
import type { ActivityTabDefinition } from '@/features/activity-center/registry'
import type { ActivityTabKey } from '@/features/activity-center/types'

export type ActivityTab = ActivityTabKey

const props = withDefaults(defineProps<{
  modelValue: ActivityTab
  badges?: Partial<Record<ActivityTab, boolean>>
  items: readonly ActivityTabDefinition[]
}>(), { badges: () => ({}) })

defineEmits<{
  'update:modelValue': [value: ActivityTab]
}>()
</script>

<template>
  <nav class="activity-nav" aria-label="活动页面" :style="{ gridTemplateColumns: `repeat(${Math.max(1, props.items.length)}, minmax(0, 1fr))` }">
    <button
      v-for="item in props.items"
      :key="item.key"
      type="button"
      :class="`activity-nav__item--${item.key}`"
      :aria-label="item.label"
      :aria-current="modelValue === item.key ? 'page' : undefined"
      :data-active="modelValue === item.key || undefined"
      @click="$emit('update:modelValue', item.key)"
    >
      <span class="activity-nav__visual">
        <span v-if="item.key === 'qingmei'" class="activity-nav__qingmei" aria-hidden="true">🍶</span>
        <img v-else :src="`/activity-center/stellar/nav-${item.key}.png`" alt="">
        <i v-if="badges[item.key]" class="activity-nav__badge" aria-label="有可操作内容" />
      </span>
    </button>
  </nav>
</template>

<style scoped>
.activity-nav {
  position: absolute;
  z-index: 30;
  inset: auto 0 0;
  height: calc(72px + env(safe-area-inset-bottom));
  padding: 1px 7px env(safe-area-inset-bottom);
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  border-top: 2px solid rgba(132, 220, 252, 0.68);
  background: #326ba3 url('/activity-center/stellar/nav-background.png') center top / 100% 100% no-repeat;
  box-shadow:
    0 -7px 18px rgba(2, 35, 80, 0.3),
    inset 0 2px rgba(255, 255, 255, 0.12);
}

button {
  --nav-image-offset-x: 0px;
  --nav-image-offset-y: 0px;
  --nav-image-width: 58px;
  position: relative;
  min-width: 0;
  display: grid;
  place-items: start center;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}

.activity-nav__item--travel {
  --nav-image-width: 54px;
  --nav-image-offset-y: 7px;
}
.activity-nav__item--constellation {
  --nav-image-width: 68px;
  --nav-image-offset-y: -10px;
}
.activity-nav__item--shop {
  --nav-image-width: 53px;
  --nav-image-offset-y: 8px;
}
.activity-nav__item--solar {
  --nav-image-width: 48px;
  --nav-image-offset-y: 7px;
}
.activity-nav__item--qingmei {
  --nav-image-offset-y: 7px;
}
.activity-nav__qingmei {
  margin-top: 8px;
  font-size: 38px;
  line-height: 1;
  filter: drop-shadow(0 2px 3px rgba(25, 71, 45, 0.45));
}

.activity-nav__visual {
  position: relative;
  width: min(100%, 72px);
  height: 68px;
  display: grid;
  place-items: start center;
}

.activity-nav__visual::before {
  content: '';
  position: absolute;
  z-index: -1;
  top: 5px;
  left: 50%;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(255, 246, 153, 0.64), rgba(72, 159, 207, 0.08) 70%);
  opacity: 0;
  transform: translateX(-50%) scale(0.88);
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
}

.activity-nav__visual img {
  width: var(--nav-image-width);
  max-width: 100%;
  height: auto;
  object-fit: contain;
  transform: translate(var(--nav-image-offset-x), var(--nav-image-offset-y));
  transform-origin: center center;
  transition:
    filter 0.16s ease,
    transform 0.16s ease;
}

button[data-active] .activity-nav__visual::before {
  opacity: 1;
  transform: translateX(-50%) scale(1);
}

button[data-active] .activity-nav__visual img {
  filter: drop-shadow(0 0 6px rgba(255, 239, 129, 0.8));
  transform: translate(var(--nav-image-offset-x), var(--nav-image-offset-y)) scale(1.05);
}

.activity-nav__badge {
  position: absolute;
  top: 1px;
  left: calc(50% + 20px);
  width: 10px;
  height: 10px;
  border: 1px solid white;
  border-radius: 50%;
  background: #ff4058;
  box-shadow: 0 1px 4px rgba(120, 0, 15, 0.55);
}
</style>
