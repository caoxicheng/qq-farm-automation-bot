<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'

const props = defineProps<{
  open: boolean
  name: string
  explain: string
}>()
const emit = defineEmits<{ close: [] }>()
const closeButton = ref<HTMLButtonElement | null>(null)
const titleId = `constellation-book-${useId()}`
let returnFocus: HTMLElement | null = null

function close() {
  emit('close')
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
  }
}

watch(() => props.open, async (open) => {
  if (open) {
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    window.addEventListener('keydown', onKeydown)
    await nextTick()
    closeButton.value?.focus()
  }
  else {
    window.removeEventListener('keydown', onKeydown)
    returnFocus?.focus()
    returnFocus = null
  }
})

onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Transition name="book-panel">
    <section v-if="open" class="book-panel" role="dialog" aria-modal="true" :aria-labelledby="titleId">
      <div class="book-panel__ornament book-panel__ornament--top" aria-hidden="true">
        ◇
      </div>
      <h2 :id="titleId" class="sr-only">
        {{ name }}星宿书册
      </h2>
      <button ref="closeButton" type="button" class="book-panel__close" aria-label="关闭星宿书册" @click="close">
        ×
      </button>
      <p>{{ explain || '星宿释义待补充' }}</p>
      <div class="book-panel__ornament book-panel__ornament--left" aria-hidden="true">
        ◇
      </div>
      <div class="book-panel__ornament book-panel__ornament--right" aria-hidden="true">
        ◇
      </div>
    </section>
  </Transition>
</template>

<style scoped>
.book-panel {
  position: absolute;
  z-index: 14;
  top: 76px;
  right: 3px;
  left: 3px;
  min-height: 127px;
  display: flex;
  align-items: center;
  padding: 27px 29px 24px;
  border: 2px solid #ffe88d;
  border-radius: 16px;
  color: #f2f7ff;
  background: linear-gradient(135deg, rgba(10, 83, 155, 0.96), rgba(67, 129, 220, 0.93));
  box-shadow:
    inset 0 0 0 4px rgba(174, 221, 255, 0.24),
    inset 0 -28px 42px rgba(111, 159, 239, 0.25),
    0 7px 20px rgba(0, 26, 73, 0.55);
}
.book-panel::before {
  position: absolute;
  inset: 6px;
  border: 1px solid rgba(178, 226, 255, 0.52);
  border-radius: 11px;
  background:
    radial-gradient(circle at 12% 22%, rgba(255, 255, 255, 0.22) 0 1px, transparent 2px),
    radial-gradient(circle at 86% 70%, rgba(255, 236, 137, 0.22) 0 1px, transparent 2px);
  background-size:
    39px 37px,
    51px 47px;
  content: '';
  pointer-events: none;
}
.book-panel p {
  position: relative;
  z-index: 1;
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  line-height: 1.72;
  text-shadow: 0 2px 2px #175492;
  white-space: pre-line;
}
.book-panel__close {
  position: absolute;
  z-index: 3;
  top: 3px;
  right: 8px;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 0;
  color: #fff3a1;
  background: transparent;
  font:
    700 27px/28px Arial,
    sans-serif;
  cursor: pointer;
}
.book-panel__close:focus-visible {
  outline: 2px solid #fff2a1;
  outline-offset: 1px;
}
.book-panel__ornament {
  position: absolute;
  z-index: 2;
  color: #fff1a2;
  text-shadow: 0 1px #285fa0;
}
.book-panel__ornament--top {
  top: -11px;
  left: calc(50% - 7px);
  font-size: 20px;
}
.book-panel__ornament--left {
  top: calc(50% - 8px);
  left: -8px;
}
.book-panel__ornament--right {
  top: calc(50% - 8px);
  right: -8px;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  clip-path: inset(50%);
}
.book-panel-enter-active,
.book-panel-leave-active {
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
}
.book-panel-enter-from,
.book-panel-leave-to {
  opacity: 0;
  transform: translateY(-5px) scale(0.98);
}
</style>
