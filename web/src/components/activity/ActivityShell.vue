<script setup lang="ts">
defineProps<{ theme?: 'night' | 'day' }>()
</script>

<template>
  <section class="activity-shell" :class="`activity-shell--${theme || 'night'}`" data-theme-exempt>
    <div class="activity-shell__stars" aria-hidden="true" />
    <div class="activity-shell__frame">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.activity-shell {
  position: fixed;
  z-index: 50;
  inset: 0;
  overflow: hidden;
  color: #f8fbff;
  background: #102758;
  font-family: 'Microsoft YaHei', 'PingFang SC', sans-serif;
  isolation: isolate;
}
.activity-shell--night {
  background:
    radial-gradient(circle at 75% 20%, rgba(83, 142, 225, 0.38), transparent 25%),
    linear-gradient(180deg, #152958 0%, #075a91 52%, #087bb0 100%);
}
.activity-shell--day {
  background: linear-gradient(180deg, #50bde9, #9dddf2 50%, #83c866);
}
.activity-shell__stars {
  position: absolute;
  inset: 0;
  opacity: 0.55;
  pointer-events: none;
  background-image:
    radial-gradient(circle, #fff 0 1px, transparent 1.6px), radial-gradient(circle, #ffe976 0 1.4px, transparent 2px);
  background-position:
    17px 23px,
    53px 71px;
  background-size:
    71px 83px,
    109px 127px;
}
.activity-shell--day .activity-shell__stars {
  opacity: 0.12;
}
.activity-shell__frame {
  position: relative;
  z-index: 1;
  width: min(100%, 455px);
  height: 100%;
  margin: 0 auto;
  overflow: hidden;
  background: rgba(0, 34, 86, 0.08) url('/activity-center/stellar/night-background.png') center/cover no-repeat;
  box-shadow: 0 0 44px rgba(0, 18, 55, 0.4);
}
.activity-shell--day .activity-shell__frame {
  background: rgba(120, 200, 110, 0.08);
}
@media (min-width: 700px) {
  .activity-shell {
    padding: 12px 0;
  }
  .activity-shell__frame {
    height: calc(100% - 24px);
    border: 1px solid rgba(255, 255, 255, 0.25);
    border-radius: 22px;
  }
}
</style>
