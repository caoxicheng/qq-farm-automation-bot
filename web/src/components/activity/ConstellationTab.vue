<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue'
import type { ConstellationDto, ConstellationGroupDto } from '@/stores/activity-center'
import { computed, nextTick, ref, watch } from 'vue'
import ActivityRulesDialog from './ActivityRulesDialog.vue'
import ConstellationBookPanel from './ConstellationBookPanel.vue'
import RewardItem from './RewardItem.vue'

interface Point { x: number, y: number }
interface StarShape { points: Point[], links: Array<[number, number]> }

const props = defineProps<{
  constellation: ConstellationDto | null
  pending?: boolean
  enabled?: boolean
}>()
const emit = defineEmits<{ light: [] }>()
const selectedGroupId = ref('')
const bookOpen = ref(false)
const rulesOpen = ref(false)
const tabButtons = new Map<string, HTMLButtonElement>()

const shapes: StarShape[] = [
  { points: [{ x: 0, y: 4 }, { x: 7, y: 0 }, { x: 13, y: 7 }], links: [[0, 1], [1, 2]] },
  { points: [{ x: 0, y: 1 }, { x: 6, y: 7 }, { x: 13, y: 3 }, { x: 17, y: 10 }], links: [[0, 1], [1, 2], [2, 3]] },
  { points: [{ x: 1, y: 0 }, { x: 0, y: 9 }, { x: 8, y: 5 }, { x: 15, y: 10 }], links: [[0, 2], [1, 2], [2, 3]] },
  { points: [{ x: 0, y: 3 }, { x: 7, y: 0 }, { x: 7, y: 10 }, { x: 15, y: 7 }], links: [[0, 1], [0, 2], [1, 3], [2, 3]] },
  { points: [{ x: 0, y: 5 }, { x: 6, y: 0 }, { x: 12, y: 5 }, { x: 6, y: 10 }], links: [[0, 1], [1, 2], [2, 3], [3, 0]] },
  { points: [{ x: 0, y: 0 }, { x: 5, y: 8 }, { x: 11, y: 2 }, { x: 16, y: 10 }], links: [[0, 1], [1, 2], [2, 3]] },
  { points: [{ x: 0, y: 7 }, { x: 5, y: 0 }, { x: 11, y: 4 }, { x: 16, y: 1 }, { x: 20, y: 9 }], links: [[0, 1], [1, 2], [2, 3], [2, 4]] },
]

// Catalog仅提供四象索引与连线成员，不含坐标；这里是稳定的前端展示布局。
const chartOrigins: ReadonlyArray<ReadonlyArray<Point>> = [
  [{ x: 18, y: 24 }, { x: 39, y: 17 }, { x: 62, y: 22 }, { x: 27, y: 43 }, { x: 52, y: 42 }, { x: 70, y: 52 }, { x: 43, y: 65 }],
  [{ x: 19, y: 18 }, { x: 43, y: 21 }, { x: 67, y: 17 }, { x: 27, y: 39 }, { x: 57, y: 40 }, { x: 18, y: 59 }, { x: 53, y: 62 }],
  [{ x: 20, y: 21 }, { x: 48, y: 16 }, { x: 67, y: 29 }, { x: 18, y: 43 }, { x: 44, y: 40 }, { x: 67, y: 52 }, { x: 35, y: 63 }],
  [{ x: 17, y: 19 }, { x: 42, y: 16 }, { x: 65, y: 21 }, { x: 29, y: 37 }, { x: 55, y: 39 }, { x: 17, y: 58 }, { x: 53, y: 61 }],
]

const orderedGroups = computed(() => [...(props.constellation?.groups ?? [])].sort((a, b) => (a.order ?? 999) - (b.order ?? 999)))
const selectedGroup = computed(() => orderedGroups.value.find(group => group.id === selectedGroupId.value) ?? null)
const chartIndex = computed(() => Math.min(3, Math.max(0, selectedGroup.value?.chartIndex ?? Math.floor(Math.max(0, (selectedGroup.value?.order ?? 1) - 1) / 7))))
const chartGroups = computed(() => orderedGroups.value.filter(group => (group.chartIndex ?? Math.floor(Math.max(0, (group.order ?? 1) - 1) / 7)) === chartIndex.value).slice(0, 7))
const chartMarks = computed(() => chartGroups.value.map((group, index) => {
  const origin = chartOrigins[chartIndex.value]?.[index] ?? chartOrigins[0]![index]!
  const shape = shapes[index] ?? shapes[0]!
  return {
    group,
    points: shape.points.map(point => ({ x: origin.x + point.x, y: origin.y + point.y })),
    links: shape.links,
  }
}))
const catalogUnsupported = computed(() => props.constellation?.catalogStatus.toLowerCase() === 'unsupported')
const stateLabel = computed(() => {
  if (selectedGroup.value?.visualState === 'lit')
    return selectedGroup.value.claimStatus === 'confirmed-no-claimable' ? '今日已领取' : '已点亮'
  if (selectedGroup.value?.visualState === 'locked')
    return '未开启'
  if (selectedGroup.value?.visualState === 'unknown')
    return '历史状态待同步'
  return ''
})
const canLight = computed(() => ['lightable', 'claimableUnknown'].includes(selectedGroup.value?.visualState || '') && Boolean(props.enabled) && !props.pending)

function setTabRef(groupId: string, value: Element | ComponentPublicInstance | null) {
  if (value instanceof HTMLButtonElement)
    tabButtons.set(groupId, value)
  else
    tabButtons.delete(groupId)
}

function selectGroup(group: ConstellationGroupDto, focus = false) {
  selectedGroupId.value = group.id
  bookOpen.value = false
  nextTick(() => {
    const button = tabButtons.get(group.id)
    button?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
    if (focus)
      button?.focus()
  })
}

function onTabKeydown(event: KeyboardEvent, index: number) {
  let target = index
  if (event.key === 'ArrowRight')
    target = Math.min(orderedGroups.value.length - 1, index + 1)
  else if (event.key === 'ArrowLeft')
    target = Math.max(0, index - 1)
  else if (event.key === 'Home')
    target = 0
  else if (event.key === 'End')
    target = orderedGroups.value.length - 1
  else return
  event.preventDefault()
  const group = orderedGroups.value[target]
  if (group)
    selectGroup(group, true)
}

watch(() => props.constellation, (value) => {
  const groups = value?.groups ?? []
  if (!groups.some(group => group.id === selectedGroupId.value))
    selectedGroupId.value = groups.find(group => group.current)?.id || groups.find(group => ['lightable', 'claimableUnknown'].includes(group.visualState))?.id || groups[0]?.id || ''
}, { immediate: true })
</script>

<template>
  <div class="constellation-tab">
    <div class="constellation-background" aria-hidden="true" />

    <div v-if="catalogUnsupported" class="catalog-unsupported" role="status">
      <span aria-hidden="true">✦</span>
      <strong>本期星宿配置暂未支持</strong>
    </div>

    <template v-else>
      <div v-if="orderedGroups.length" class="group-strip" role="tablist" aria-label="二十八星宿">
        <button
          v-for="(item, index) in orderedGroups"
          :id="`constellation-tab-${item.id}`"
          :key="item.id"
          :ref="value => setTabRef(item.id, value)"
          type="button"
          role="tab"
          :aria-selected="item.id === selectedGroupId"
          :aria-controls="`constellation-panel-${item.id}`"
          :tabindex="item.id === selectedGroupId ? 0 : -1"
          :class="[`state-${item.visualState}`, { active: item.id === selectedGroupId }]"
          @click="selectGroup(item)"
          @keydown="onTabKeydown($event, index)"
        >
          <span class="group-strip__name">{{ item.name || '未命名' }}</span>
          <span v-if="item.visualState === 'lightable'" class="group-strip__dot" aria-label="可点亮" />
          <span v-else-if="item.visualState === 'claimableUnknown'" class="group-strip__sync" aria-label="领取状态待同步">?</span>
          <svg v-else-if="item.visualState === 'locked'" class="group-strip__lock" viewBox="0 0 24 24" aria-label="未开启"><rect x="5" y="10" width="14" height="10" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
          <svg v-else-if="item.visualState === 'lit'" class="group-strip__done" viewBox="0 0 24 24" aria-label="已点亮"><path d="m5 12 4 4 10-9" /></svg>
        </button>
      </div>

      <section
        v-if="selectedGroup"
        :id="`constellation-panel-${selectedGroup.id}`"
        class="constellation-scene"
        role="tabpanel"
        :aria-labelledby="`constellation-tab-${selectedGroup.id}`"
      >
        <div class="constellation-heading">
          <div>
            <strong>{{ selectedGroup.name }}</strong>
            <span>{{ selectedGroup.category }}</span>
          </div>
          <button type="button" class="book-button" aria-label="查看星宿书册" :aria-expanded="bookOpen" @click="bookOpen = true">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A3.5 3.5 0 0 1 7.5 2H11v17H7.5A3.5 3.5 0 0 0 4 22zM20 5.5A3.5 3.5 0 0 0 16.5 2H13v17h3.5A3.5 3.5 0 0 1 20 22z" /></svg>
          </button>
        </div>

        <img class="constellation-creature" src="/activity-center/stellar/constellation-creature.png" alt="" aria-hidden="true">
        <svg class="star-chart" viewBox="0 0 100 78" role="img" :aria-label="`${selectedGroup.category}七宿展示图，当前选中${selectedGroup.name}；坐标为页面展示布局`">
          <defs>
            <filter id="star-blue-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="1.1" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
            <filter id="star-gold-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="1.5" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
          </defs>
          <g v-for="mark in chartMarks" :key="mark.group.id" class="star-constellation" :class="{ selected: mark.group.id === selectedGroupId }">
            <line v-for="([from, to], lineIndex) in mark.links" :key="lineIndex" :x1="mark.points[from]?.x" :y1="mark.points[from]?.y" :x2="mark.points[to]?.x" :y2="mark.points[to]?.y" />
            <circle v-for="(point, pointIndex) in mark.points" :key="pointIndex" :cx="point.x" :cy="point.y" :r="mark.group.id === selectedGroupId ? 1.05 : .72">
              <title>{{ mark.group.name }}</title>
            </circle>
          </g>
        </svg>

        <ConstellationBookPanel :open="bookOpen" :name="selectedGroup.name" :explain="selectedGroup.explain" @close="bookOpen = false" />
      </section>

      <section v-if="selectedGroup" class="star-reward" aria-labelledby="constellation-reward-title">
        <h2 id="constellation-reward-title" class="star-reward__title">
          <span>星宿福利</span>
          <button type="button" aria-label="查看观星礼录活动说明" title="查看活动说明" @click.stop="rulesOpen = true">
            ?
          </button>
        </h2>
        <div class="star-reward__items">
          <RewardItem
            v-for="(reward, index) in selectedGroup.rewards"
            :key="reward.id || index"
            :name="reward.name"
            :count="reward.count"
            :image="reward.image"
            :rarity="reward.rarity"
            :locked="selectedGroup.visualState === 'locked'"
            :claimed="selectedGroup.visualState === 'lit'"
            compact
          />
        </div>
      </section>

      <div v-if="selectedGroup" class="light-action" :class="`light-action--${selectedGroup.visualState}`" role="status">
        <button v-if="selectedGroup.visualState === 'lightable' || selectedGroup.visualState === 'claimableUnknown'" type="button" :disabled="!canLight" @click="emit('light')">
          {{ pending ? '同步中…' : selectedGroup.visualState === 'claimableUnknown' ? '尝试领取今日奖励' : '点亮' }}
        </button>
        <strong v-else>{{ stateLabel }}</strong>
      </div>

      <ActivityRulesDialog :open="rulesOpen" :rules="constellation?.rules" @close="rulesOpen = false" />
    </template>
  </div>
</template>

<style scoped>
.constellation-tab {
  position: relative;
  min-height: 100%;
  padding: calc(128px + env(safe-area-inset-top)) 10px calc(105px + env(safe-area-inset-bottom));
  isolation: isolate;
}
.constellation-background {
  position: absolute;
  z-index: -2;
  inset: 0;
  background: url('/activity-center/stellar/constellation-background.png') center top/cover no-repeat;
  opacity: 0.82;
}
.constellation-tab::before {
  position: absolute;
  z-index: -1;
  inset: 0;
  background: radial-gradient(ellipse at 50% 42%, rgba(35, 100, 188, 0.22), transparent 54%);
  content: '';
}
.group-strip {
  display: flex;
  gap: 10px;
  margin: 0 -10px;
  padding: 13px 17px 11px;
  overflow-x: auto;
  overflow-y: visible;
  overscroll-behavior-x: contain;
  scroll-behavior: smooth;
  scroll-snap-type: x mandatory;
  scrollbar-width: none;
}
.group-strip::-webkit-scrollbar {
  display: none;
}
.group-strip button {
  position: relative;
  min-width: 72px;
  height: 29px;
  flex: none;
  padding: 2px 20px 3px;
  border: 1px solid rgba(104, 133, 202, 0.68);
  border-radius: 999px;
  color: #8299ce;
  background: linear-gradient(180deg, rgba(49, 68, 134, 0.78), rgba(33, 50, 112, 0.75));
  box-shadow: inset 0 1px rgba(197, 221, 255, 0.15);
  scroll-snap-align: center;
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
  cursor: pointer;
}
.group-strip button::before,
.group-strip button::after {
  position: absolute;
  top: 50%;
  width: 11px;
  height: 1px;
  background: rgba(115, 150, 216, 0.48);
  content: '';
}
.group-strip button::before {
  right: calc(100% + 1px);
}
.group-strip button::after {
  left: calc(100% + 1px);
}
.group-strip button.active {
  border-color: #d7e5ff;
  color: #6985cc;
  background: linear-gradient(#fff, #e8efff);
  box-shadow:
    0 0 10px rgba(213, 229, 255, 0.72),
    inset 0 -2px 4px rgba(120, 150, 215, 0.25);
}
.group-strip button.state-lit:not(.active) {
  color: #b9cdf0;
}
.group-strip button:focus-visible {
  outline: 2px solid #fff0a2;
  outline-offset: 2px;
}
.group-strip__dot {
  position: absolute;
  top: -7px;
  right: 2px;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: #ff4f68;
  box-shadow: 0 0 5px rgba(255, 69, 93, 0.8);
}
.group-strip__sync {
  position: absolute;
  top: -9px;
  right: 1px;
  width: 16px;
  height: 16px;
  display: grid;
  place-items: center;
  border: 1px solid #c5e8ff;
  border-radius: 50%;
  color: #e8f7ff;
  background: #496da8;
  box-shadow: 0 1px 4px rgba(5, 26, 70, 0.65);
  font-size: 10px;
  line-height: 1;
}
.group-strip__lock,
.group-strip__done {
  position: absolute;
  top: -11px;
  left: calc(50% - 8px);
  width: 16px;
  height: 16px;
  overflow: visible;
}
.group-strip__lock {
  fill: #314773;
  stroke: #d5e1ff;
  stroke-width: 2;
  filter: drop-shadow(0 1px 2px rgba(7, 24, 67, 0.75));
}
.group-strip__done {
  padding: 2px;
  border: 1px solid rgba(255, 239, 124, 0.7);
  border-radius: 50%;
  fill: none;
  stroke: #fff285;
  stroke-width: 3;
  stroke-linecap: round;
  stroke-linejoin: round;
  background: #766719;
  filter: drop-shadow(0 1px 3px rgba(71, 53, 0, 0.75));
}
.constellation-scene {
  position: relative;
  height: 355px;
}
.constellation-heading {
  position: absolute;
  z-index: 7;
  top: 8px;
  left: 24px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.constellation-heading div {
  display: flex;
  flex-direction: column;
}
.constellation-heading strong {
  color: #a9eaff;
  font-size: 22px;
  line-height: 1.1;
  text-shadow:
    0 2px 3px #16497f,
    0 0 7px rgba(84, 210, 255, 0.4);
}
.constellation-heading span {
  margin-top: 3px;
  color: #d4efff;
  font-size: 14px;
  letter-spacing: 0.16em;
}
.book-button {
  width: 29px;
  height: 29px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 2px solid #bfdcff;
  border-radius: 50%;
  color: #ecf8ff;
  background: linear-gradient(#679ee4, #456abd);
  box-shadow: 0 2px 4px rgba(0, 33, 87, 0.5);
  cursor: pointer;
}
.book-button svg {
  width: 17px;
  fill: currentColor;
}
.book-button:focus-visible {
  outline: 2px solid #fff0a2;
  outline-offset: 2px;
}
.constellation-creature {
  position: absolute;
  top: 24px;
  left: 50%;
  width: min(340px, 86vw);
  height: 304px;
  transform: translateX(-50%);
  object-fit: contain;
  opacity: 0.29;
  filter: hue-rotate(-7deg) saturate(0.8);
}
.star-chart {
  position: absolute;
  z-index: 3;
  top: 26px;
  right: 0;
  left: 0;
  width: 100%;
  height: 318px;
  overflow: visible;
}
.star-constellation line {
  stroke: rgba(146, 225, 255, 0.67);
  stroke-width: 0.28;
  stroke-linecap: round;
  filter: url('#star-blue-glow');
}
.star-constellation circle {
  fill: #2f9bc3;
  stroke: #86ddff;
  stroke-width: 0.22;
  filter: url('#star-blue-glow');
}
.star-constellation.selected line {
  stroke: #b46b27;
  stroke-width: 0.48;
  filter: url('#star-gold-glow');
}
.star-constellation.selected circle {
  fill: #fff3a2;
  stroke: #ff982f;
  stroke-width: 0.42;
  filter: url('#star-gold-glow');
}
.star-reward {
  position: relative;
  width: min(258px, 75vw);
  min-height: 73px;
  margin: -4px auto 0;
  padding: 14px 11px 9px;
  border: 2px solid #e9cf73;
  border-radius: 17px;
  background: linear-gradient(145deg, rgba(25, 100, 182, 0.95), rgba(31, 80, 158, 0.94));
  box-shadow:
    inset 0 0 0 3px rgba(113, 195, 250, 0.22),
    0 5px 12px rgba(0, 31, 80, 0.45);
}
.star-reward::after {
  position: absolute;
  bottom: -12px;
  left: calc(50% - 7px);
  width: 12px;
  height: 12px;
  transform: rotate(45deg);
  border-right: 2px solid #e9cf73;
  border-bottom: 2px solid #e9cf73;
  background: #1d559d;
  content: '';
}
.star-reward__title {
  position: absolute;
  z-index: 6;
  top: -35px;
  right: 0;
  left: 0;
  min-height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  margin: 0;
  color: #edf9ff;
  font-size: 16px;
  text-align: center;
  text-shadow: 0 2px #22528c;
  pointer-events: none;
}
.star-reward__title button {
  position: relative;
  z-index: 7;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  flex: none;
  margin: 0 -5px 0 -2px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  color: #8d633f;
  background: transparent;
  font-size: 0;
  cursor: pointer;
  pointer-events: auto;
  touch-action: manipulation;
}
.star-reward__title button::before {
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border: 1px solid #d4bd91;
  border-radius: 50%;
  background: #fff8df;
  box-shadow: 0 1px 4px rgba(8, 37, 84, 0.35);
  content: '?';
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
}
.star-reward__title button:hover::before {
  background: #fff3c4;
  transform: scale(1.05);
}
.star-reward__title button:focus-visible {
  outline: 2px solid #fff0a2;
  outline-offset: 1px;
}
.star-reward__items {
  min-height: 54px;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
}
.light-action {
  min-height: 67px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding-top: 10px;
}
.light-action strong {
  color: #d9f5ff;
  font-size: 21px;
  text-shadow:
    0 2px #13518b,
    0 0 12px rgba(74, 207, 255, 0.65);
}
.light-action--unknown strong {
  color: #b6cbe0;
  font-size: 17px;
}
.light-action--claimableUnknown button {
  min-width: 190px;
  border-radius: 28px;
  font-size: 15px;
}
.light-action button {
  min-width: 118px;
  min-height: 51px;
  padding: 8px 25px;
  border: 2px solid #fff0a1;
  border-radius: 50%;
  color: #fff3b5;
  background: radial-gradient(circle, #f7c660 10%, #ce852d 68%, #9d5b24);
  box-shadow:
    0 0 26px rgba(255, 203, 80, 0.68),
    inset 0 1px rgba(255, 255, 255, 0.62);
  font-size: 20px;
  font-weight: 800;
  text-shadow: 0 2px #a35b1f;
  cursor: pointer;
}
.light-action button:disabled {
  cursor: wait;
  opacity: 0.7;
}
.catalog-unsupported {
  min-height: calc(100vh - 217px);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: #cdeaff;
  text-align: center;
}
.catalog-unsupported span {
  color: #8fdfff;
  font-size: 50px;
  text-shadow: 0 0 15px #58bde9;
}
.catalog-unsupported strong {
  font-size: 16px;
}
@media (max-height: 720px) {
  .constellation-scene {
    height: 320px;
  }
  .constellation-creature {
    height: 277px;
  }
  .star-chart {
    height: 285px;
  }
}
</style>
