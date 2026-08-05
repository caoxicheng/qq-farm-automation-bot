<script setup lang="ts">
import type { ShopDto, ShopGoodsDto } from '@/stores/activity-center'
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  shop: ShopDto | null
  enabled: boolean
  pending: boolean
}>()
const emit = defineEmits<{
  select: [goods: ShopGoodsDto]
}>()
const activeCategory = ref('')
const allCategory = '__all__'
const categories = computed(() => props.shop?.categories ?? [])

watch(categories, (value) => {
  if (activeCategory.value !== allCategory && !value.some(category => category.id === activeCategory.value))
    activeCategory.value = allCategory
}, { immediate: true })

const visibleGoods = computed(() => activeCategory.value === allCategory
  ? (props.shop?.goods ?? [])
  : (props.shop?.goods ?? []).filter(item => item.categoryId === activeCategory.value || item.categoryName === categories.value.find(category => category.id === activeCategory.value)?.name))

function hasPositiveMaximum(item: ShopGoodsDto) {
  if (!item.maxExchangeCountKnown)
    return true
  try {
    return BigInt(item.maxExchangeCount || '0') > 0n
  }
  catch {
    return false
  }
}

function disabledReason(item: ShopGoodsDto) {
  if (props.pending)
    return '正在处理兑换'
  if (item.soldOut)
    return '已售罄'
  if (!item.exchangeable)
    return '不可兑换'
  if (!item.balanceKnown || !item.maxExchangeCountKnown)
    return '余额未知'
  if (!hasPositiveMaximum(item))
    return '余额不足'
  if (!props.enabled)
    return '暂不可兑换'
  return ''
}

function selectGoods(item: ShopGoodsDto) {
  if (!disabledReason(item))
    emit('select', item)
}
</script>

<template>
  <div class="shop-tab">
    <section class="shop-banner">
      <strong>{{ shop?.title || shop?.name || '星砂商店' }}</strong>
      <span>{{ shop?.description || '使用星砂兑换心仪奖励' }}</span>
    </section>
    <div class="shop-categories">
      <button type="button" :class="{ active: activeCategory === allCategory }" @click="activeCategory = allCategory">
        全部
      </button>
      <button v-for="category in categories" :key="category.id" type="button" :class="{ active: activeCategory === category.id }" @click="activeCategory = category.id">
        {{ category.name }}
      </button>
    </div>
    <div v-if="visibleGoods.length" class="goods-grid">
      <article v-for="item in visibleGoods" :key="item.id" :class="{ sold: item.soldOut, disabled: !!disabledReason(item) }">
        <button
          type="button"
          class="goods-card"
          :disabled="!!disabledReason(item)"
          :aria-label="`${item.name || item.item.name || '商品'}，${disabledReason(item) || '打开兑换确认'}`"
          @click="selectGoods(item)"
        >
          <div class="goods-image">
            <img v-if="item.item.image" :src="item.item.image" :alt="item.item.name || item.name">
            <span v-else aria-hidden="true" />
            <i v-if="item.owned" class="owned-badge">已拥有</i>
          </div>
          <h3>{{ item.name || item.item.name || '—' }}</h3>
          <div class="goods-price">
            <img v-if="item.cost.image" :src="item.cost.image" alt="">
            <b>{{ item.cost.count || '--' }}</b>
          </div>
          <span class="goods-action" :class="{ available: !disabledReason(item) }">
            {{ disabledReason(item) || '兑换' }}
          </span>
        </button>
      </article>
    </div>
    <div v-else class="shop-empty">
      <span aria-hidden="true">◇</span><p>暂无数据</p>
    </div>
  </div>
</template>

<style scoped>
.shop-tab {
  min-height: 100%;
  padding: calc(126px + env(safe-area-inset-top)) 14px 120px;
  background: radial-gradient(ellipse at 50% 25%, rgba(42, 136, 196, 0.38), transparent 54%);
}
.shop-banner {
  padding: 14px 16px;
  border: 1px solid rgba(158, 224, 255, 0.42);
  border-radius: 15px;
  background: linear-gradient(100deg, rgba(16, 100, 164, 0.93), rgba(28, 72, 143, 0.85));
  box-shadow: inset 0 0 14px rgba(127, 212, 255, 0.14);
}
.shop-banner strong {
  display: block;
  overflow: hidden;
  color: white;
  font-size: 19px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.shop-banner span {
  display: block;
  min-height: 1em;
  margin-top: 4px;
  color: #bde5f7;
  font-size: 11px;
  white-space: pre-line;
}
.shop-categories {
  display: flex;
  gap: 3px;
  margin: 7px -2px 11px;
  overflow-x: auto;
  border-bottom: 1px solid rgba(160, 219, 245, 0.42);
  scrollbar-width: none;
}
.shop-categories button {
  flex: 1;
  min-width: 76px;
  padding: 9px 7px;
  border: 0;
  color: #c8e4f5;
  background: transparent;
  white-space: nowrap;
  cursor: pointer;
}
.shop-categories button.active {
  color: #fff6c7;
  border-bottom: 2px solid #fff1a2;
  background: linear-gradient(180deg, transparent, rgba(255, 235, 145, 0.16));
  font-weight: 700;
}
.goods-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 9px;
}
article {
  min-width: 0;
  border: 2px solid #75bbe7;
  border-radius: 13px;
  background: linear-gradient(150deg, rgba(26, 124, 184, 0.95), rgba(40, 66, 138, 0.96));
  box-shadow:
    inset 0 0 11px rgba(255, 255, 255, 0.2),
    0 3px 8px rgba(0, 34, 78, 0.32);
  overflow: hidden;
}
article.sold,
article.disabled {
  filter: saturate(0.62);
}
.goods-card {
  width: 100%;
  display: block;
  padding: 6px;
  border: 0;
  color: inherit;
  background: transparent;
  cursor: pointer;
}
.goods-card:not(:disabled):hover,
.goods-card:not(:disabled):focus-visible {
  background: rgba(255, 245, 170, 0.12);
  outline: 2px solid #fff3a2;
  outline-offset: -3px;
}
.goods-card:disabled {
  cursor: not-allowed;
}
.goods-image {
  position: relative;
  height: 87px;
  display: grid;
  place-items: center;
  overflow: hidden;
  border-radius: 9px;
  background: linear-gradient(180deg, rgba(139, 213, 242, 0.55), rgba(39, 104, 163, 0.3));
}
.goods-image img {
  width: 88%;
  height: 88%;
  object-fit: contain;
}
.goods-image > span:not(.goods-action) {
  width: 30px;
  height: 30px;
  border: 2px solid rgba(195, 236, 249, 0.5);
  transform: rotate(45deg);
}
.owned-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  padding: 2px 5px;
  border-radius: 999px;
  color: #60400c;
  background: #fff1a4;
  font-size: 9px;
  font-style: normal;
}
h3 {
  min-height: 32px;
  margin: 6px 2px 2px;
  overflow: hidden;
  color: #fff;
  font-size: 12px;
  line-height: 1.35;
  text-align: center;
}
.goods-price {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  color: #fff4b5;
  font-size: 12px;
}
.goods-price img {
  width: 17px;
  height: 17px;
  object-fit: contain;
}
.goods-price b {
  overflow: hidden;
  text-overflow: ellipsis;
}
.goods-action {
  display: block;
  margin: 5px 2px 1px;
  padding: 3px;
  border: 1px solid rgba(194, 225, 244, 0.36);
  border-radius: 999px;
  color: #b7d1e2;
  background: rgba(10, 44, 90, 0.3);
  font-size: 10px;
}
.goods-action.available {
  border-color: #ffe997;
  color: #704a14;
  background: linear-gradient(#fff5b0, #e7b94f);
  font-weight: 700;
}
.shop-empty {
  min-height: 300px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #b9dcec;
}
.shop-empty span {
  font-size: 65px;
  color: rgba(157, 230, 247, 0.4);
}
.shop-empty p {
  margin: 0;
}
</style>
