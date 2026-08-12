<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

const props = defineProps<{
  land: any
}>()

const land = computed(() => props.land)
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  if (timer) {
    clearInterval(timer)
  }
})

const growProgress = computed(() => {
  const matureInSec = land.value.matureInSec || 0
  const totalGrowTime = land.value.totalGrowTime || 0

  if (totalGrowTime <= 0 || matureInSec <= 0) {
    return 0
  }

  const progress = Math.min(100, Math.max(0, (matureInSec / totalGrowTime) * 100))
  return progress
})

function getLandStatusClass(land: any) {
  const status = land.status
  const level = Number(land.level) || 0

  if (status === 'locked')
    return 'bg-gray-100 dark:bg-gray-800 opacity-60 border-dashed'

  // 2x2 从属格：显示占用态（半透明 + 蓝色虚线），不显示为空
  if (land.occupiedByMaster)
    return 'bg-blue-50/60 dark:bg-blue-900/10 opacity-75 border-dashed border-blue-300 dark:border-blue-800'

  let baseClass = 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700'

  // 土地等级样式
  switch (level) {
    case 1: // 黄土地
      baseClass = 'bg-yellow-50/80 dark:bg-yellow-900/10 border-yellow-200 dark:border-yellow-800'
      break
    case 2: // 红土地
      baseClass = 'bg-red-50/80 dark:bg-red-900/10 border-red-200 dark:border-red-800'
      break
    case 3: // 黑土地
      baseClass = 'bg-slate-100 dark:bg-slate-800 border-slate-300 dark:border-slate-600'
      break
    case 4: // 金土地
      baseClass = 'bg-amber-100/80 dark:bg-amber-900/20 border-amber-300 dark:border-amber-600'
      break
  }

  // 状态叠加
  if (status === 'dead')
    return 'bg-gray-200 dark:bg-gray-700 border-gray-300 dark:border-gray-600 grayscale'

  if (status === 'harvestable')
    return `${baseClass} ring-2 ring-yellow-500 ring-offset-1 dark:ring-offset-gray-900`

  if (status === 'stealable')
    return `${baseClass} ring-2 ring-purple-500 ring-offset-1 dark:ring-offset-gray-900`

  if (status === 'growing')
    return baseClass

  return baseClass
}

function formatTime(sec: number) {
  if (sec <= 0)
    return ''
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return `${h > 0 ? `${h}:` : ''}${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

function getSafeImageUrl(url: string) {
  if (!url)
    return ''
  if (url.startsWith('http://'))
    return url.replace('http://', 'https://')
  return url
}

function getLandTypeName(level: number) {
  const typeMap: Record<number, string> = {
    0: '普通',
    1: '黄土地',
    2: '红土地',
    3: '黑土地',
    4: '金土地',
  }
  return typeMap[Number(level) || 0] || ''
}
function getPlantSizeText(land: any) {
  const size = Number(land?.plantSize) || 1
  if (size <= 1)
    return ''
  return `${size}x${size}`
}
</script>

<template>
  <div
    class="relative min-h-[140px] flex flex-col items-center border rounded-lg p-2 transition dark:border-gray-700 hover:shadow-md"
    :class="getLandStatusClass(land)"
  >
    <div class="absolute left-1 top-1 text-[10px] text-gray-400 font-mono">
      #{{ land.id }}
    </div>
    <div
      v-if="land.occupiedByMaster"
      class="absolute right-1 top-1 rounded bg-blue-100 px-1 py-0.5 text-[10px] text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
    >
      从属
    </div>
    <div
      v-else-if="land.plantSize > 1"
      class="absolute right-1 top-1 rounded bg-pink-100 px-1 py-0.5 text-[10px] text-pink-700 dark:bg-pink-900/30 dark:text-pink-300"
    >
      合种 {{ getPlantSizeText(land) }}
    </div>
    <div class="mb-1 mt-4 h-10 w-10 flex items-center justify-center">
      <img
        v-if="land.seedImage"
        :src="getSafeImageUrl(land.seedImage)"
        class="max-h-full max-w-full object-contain"
        loading="lazy"
        referrerpolicy="no-referrer"
      >
      <div v-else class="i-carbon-sprout text-xl text-gray-300" />
    </div>

    <div class="w-full truncate px-1 text-center text-xs font-bold" :title="land.plantName">
      {{ land.plantName || '-' }}
    </div>

    <div class="mb-0.5 mt-0.5 w-full text-center text-[10px] text-gray-500">
      <span v-if="land.matureInSec > 0" class="text-orange-500">
        预计 {{ formatTime(land.matureInSec) }} 后成熟
      </span>
      <span v-else>
        {{ land.phaseName || (land.status === 'locked' ? '未解锁' : '未开垦') }}
      </span>
    </div>

    <div v-if="land.matureInSec > 0 && land.totalGrowTime > 0" class="w-full px-1">
      <div class="rainbow-progress-bar">
        <div
          class="rainbow-progress-fill"
          :style="{ width: `${growProgress}%` }"
        />
      </div>
    </div>

    <!--    <div class="mb-1 text-[10px] text-gray-400"> -->
    <div class="text-[10px] text-gray-400">
      {{ getLandTypeName(land.level) }}
    </div>

    <div class="mb-1 text-[10px] text-gray-400">
      季数 {{ land.totalSeason > 0 ? (`${land.currentSeason}/${land.totalSeason}`) : '-/-' }}
    </div>

    <!-- Status Badges -->
    <div class="mt-auto flex origin-bottom scale-90 gap-0.5 text-[10px]">
      <span v-if="land.needWater" class="rounded bg-blue-100 px-0.5 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">水</span>
      <span v-if="land.needWeed" class="rounded bg-green-100 px-0.5 text-green-700 dark:bg-green-900/30 dark:text-green-400">草</span>
      <span v-if="land.needBug" class="rounded bg-red-100 px-0.5 text-red-700 dark:bg-red-900/30 dark:text-red-400">虫</span>
      <!-- For friends view -->
      <span v-if="land.status === 'harvestable'" class="rounded bg-orange-100 px-0.5 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400">可偷</span>
    </div>
  </div>
</template>

<style scoped>
.rainbow-progress-bar {
  width: 80%;
  margin: 0 auto;
  height: 8px;
  background: linear-gradient(145deg, #f0f0f0, #e6e6e6);
  border-radius: 10px;
  overflow: hidden;
  box-shadow:
    inset 3px 3px 6px rgba(0, 0, 0, 0.1),
    inset -3px -3px 6px rgba(255, 255, 255, 0.9),
    2px 2px 4px rgba(0, 0, 0, 0.05);
  position: relative;
}

.rainbow-progress-bar::before {
  content: '';
  position: absolute;
  top: 1px;
  left: 2px;
  right: 2px;
  height: 3px;
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.8), rgba(255, 255, 255, 0.2));
  border-radius: 10px 10px 0 0;
  pointer-events: none;
}

.rainbow-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #ff6b9d 0%, #ff9f43 20%, #ffd32a 40%, #26de81 60%, #45aaf2 80%, #a55eea 100%);
  border-radius: 10px;
  transition: width 1s linear;
  position: relative;
  box-shadow:
    inset 0 2px 4px rgba(255, 255, 255, 0.6),
    inset 0 -1px 2px rgba(0, 0, 0, 0.1);
  animation: cute-pulse 2s ease-in-out infinite;
}

.rainbow-progress-fill::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.4) 50%, transparent 100%);
  animation: shimmer 2s infinite;
  border-radius: 10px;
}

@keyframes cute-pulse {
  0%,
  100% {
    filter: brightness(1) saturate(1);
  }
  50% {
    filter: brightness(1.1) saturate(1.1);
  }
}

@keyframes shimmer {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(100%);
  }
}

@media (prefers-color-scheme: dark) {
  .rainbow-progress-bar {
    background: linear-gradient(145deg, #2a2a2a, #1e1e1e);
    box-shadow:
      inset 3px 3px 6px rgba(0, 0, 0, 0.3),
      inset -3px -3px 6px rgba(60, 60, 60, 0.3),
      2px 2px 4px rgba(0, 0, 0, 0.2);
  }

  .rainbow-progress-bar::before {
    background: linear-gradient(90deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.02));
  }

  .rainbow-progress-fill {
    box-shadow:
      inset 0 2px 4px rgba(255, 255, 255, 0.2),
      inset 0 -1px 2px rgba(0, 0, 0, 0.2);
  }
}
</style>
