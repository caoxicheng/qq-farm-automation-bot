<script setup lang="ts">
import type { ActivityRulesDto } from '@/stores/activity-center'
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'

const props = withDefaults(defineProps<{
  open: boolean
  rules?: ActivityRulesDto | null
  title?: string
  closeLabel?: string
}>(), {
  rules: null,
  title: '',
  closeLabel: '关闭活动说明',
})
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLElement | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)
const titleId = `activity-rules-${useId()}`
let returnFocus: HTMLElement | null = null
let previousOverflow = ''
let pageLocked = false

function close() {
  emit('close')
}

function focusableElements() {
  return Array.from(dialog.value?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    return
  }
  if (event.key !== 'Tab')
    return
  const focusable = focusableElements()
  if (!focusable.length) {
    event.preventDefault()
    dialog.value?.focus()
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  }
  else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}

function unlockPage(restoreFocus = true) {
  if (!pageLocked)
    return
  document.body.style.overflow = previousOverflow
  window.removeEventListener('keydown', onKeydown)
  if (restoreFocus)
    returnFocus?.focus()
  returnFocus = null
  pageLocked = false
}

watch(() => props.open, async (open) => {
  if (open) {
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    pageLocked = true
    window.addEventListener('keydown', onKeydown)
    await nextTick()
    closeButton.value?.focus()
  }
  else {
    unlockPage()
  }
})

onBeforeUnmount(() => unlockPage(false))
</script>

<template>
  <Teleport to="body">
    <Transition name="activity-rules-fade">
      <div v-if="open" class="activity-rules-overlay" role="presentation" @mousedown.self="close">
        <section ref="dialog" class="activity-rules-dialog" role="dialog" aria-modal="true" :aria-labelledby="titleId" tabindex="-1">
          <header class="activity-rules-dialog__header">
            <h2 :id="titleId">
              {{ title || rules?.title || '活动说明' }}
            </h2>
            <button ref="closeButton" type="button" class="activity-rules-dialog__close" :aria-label="closeLabel" @click="close">
              ×
            </button>
          </header>

          <div class="activity-rules-paper">
            <slot name="guide" />
            <slot>
              <div v-if="rules?.paragraphs.length" class="activity-rules-copy">
                <p v-for="(paragraph, index) in rules.paragraphs" :key="index">
                  {{ paragraph }}
                </p>
              </div>
              <p v-else class="activity-rules-empty">
                暂无活动说明
              </p>
            </slot>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.activity-rules-overlay {
  position: fixed;
  z-index: 1000;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 72px 20px 54px;
  background: rgba(0, 13, 35, 0.76);
  backdrop-filter: blur(1px);
}
.activity-rules-dialog {
  position: relative;
  width: min(394px, 100%);
  height: min(648px, 100%);
  padding: 58px 13px 13px;
  border: 5px solid #8c471e;
  border-radius: 23px;
  background: linear-gradient(90deg, #a95b27 0 4%, #cf8243 4% 8%, #ad6029 8% 92%, #d58a49 92% 96%, #955022 96%);
  box-shadow:
    0 12px 35px rgba(0, 0, 0, 0.55),
    inset 0 0 0 3px #e4a35c,
    inset 0 0 20px #703516;
}
.activity-rules-dialog::before,
.activity-rules-dialog::after {
  position: absolute;
  top: 14px;
  width: 22px;
  height: 29px;
  border-radius: 48%;
  background: radial-gradient(circle at 38% 32%, #efb36d, #955023 62%, #632b14);
  content: '';
  box-shadow: 0 2px 3px rgba(67, 25, 8, 0.7);
}
.activity-rules-dialog::before {
  left: 18px;
}
.activity-rules-dialog::after {
  right: 18px;
}
.activity-rules-dialog__header {
  position: absolute;
  z-index: 2;
  top: 0;
  right: 0;
  left: 0;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.activity-rules-dialog__header h2 {
  margin: 0;
  color: #fff7dc;
  font-size: 22px;
  letter-spacing: 2px;
  text-shadow: 0 2px 2px #6c2b10;
}
.activity-rules-dialog__close {
  position: absolute;
  top: -16px;
  right: -16px;
  width: 48px;
  height: 48px;
  padding: 0;
  border: 4px solid #f1bb76;
  border-radius: 14px;
  color: #fff;
  background: linear-gradient(#c77939, #8d411d);
  box-shadow:
    0 4px 7px rgba(0, 0, 0, 0.4),
    inset 0 0 0 2px #6f3016;
  font:
    700 34px/36px Arial,
    sans-serif;
  cursor: pointer;
}
.activity-rules-dialog__close:focus-visible {
  outline: 3px solid #fff5a8;
  outline-offset: 2px;
}
.activity-rules-paper {
  height: 100%;
  overflow-y: auto;
  padding: 17px 14px 24px;
  border: 3px solid #75421f;
  border-radius: 13px;
  color: #684119;
  background:
    linear-gradient(rgba(255, 250, 212, 0.93), rgba(248, 226, 165, 0.96)),
    repeating-linear-gradient(0deg, transparent 0 25px, rgba(131, 82, 31, 0.08) 26px);
  box-shadow: inset 0 0 20px rgba(133, 76, 25, 0.25);
  overscroll-behavior: contain;
  scrollbar-color: #aa713a #f5dfa9;
  scrollbar-width: thin;
}
.activity-rules-copy {
  font-size: 14px;
  line-height: 1.72;
}
.activity-rules-copy p {
  margin: 0 0 13px;
  white-space: pre-line;
}
.activity-rules-copy p:first-child {
  font-weight: 700;
}
.activity-rules-empty {
  padding: 50px 0;
  color: #a2794c;
  text-align: center;
}
.activity-rules-fade-enter-active,
.activity-rules-fade-leave-active {
  transition: opacity 0.18s ease;
}
.activity-rules-fade-enter-active .activity-rules-dialog,
.activity-rules-fade-leave-active .activity-rules-dialog {
  transition: transform 0.18s ease;
}
.activity-rules-fade-enter-from,
.activity-rules-fade-leave-to {
  opacity: 0;
}
.activity-rules-fade-enter-from .activity-rules-dialog,
.activity-rules-fade-leave-to .activity-rules-dialog {
  transform: scale(0.96);
}
@media (max-height: 680px) {
  .activity-rules-overlay {
    padding-top: 44px;
    padding-bottom: 30px;
  }
  .activity-rules-dialog {
    height: 100%;
  }
}
</style>
