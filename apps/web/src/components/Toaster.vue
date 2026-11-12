<script setup lang="ts">
/** 轻提示的宿主：挂在应用根部，显示 ui.ts 里 toast.* 推入的消息。 */
import { CircleAlert, CircleCheck, Info, X } from "lucide-vue-next";
import { dismissToast, toasts } from "../ui";
</script>

<template>
  <Teleport to="body">
    <TransitionGroup name="toast" tag="div" class="toaster" aria-live="polite">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="t.kind" role="status">
        <CircleCheck v-if="t.kind === 'success'" :size="16" />
        <CircleAlert v-else-if="t.kind === 'error'" :size="16" />
        <Info v-else :size="16" />
        <span class="text">{{ t.text }}</span>
        <button class="ghost sm icon-btn" aria-label="关闭" @click="dismissToast(t.id)"><X :size="14" /></button>
      </div>
    </TransitionGroup>
  </Teleport>
</template>

<style scoped>
.toaster {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 200;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 420px;
  padding: 8px 8px 8px 12px;
  background: #1c1f2b;
  color: #fff;
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  font-size: 13px;
}
.toast.success svg:first-child {
  color: #4ade80;
}
.toast.error svg:first-child {
  color: #ff8589;
}
.toast.info svg:first-child {
  color: #8fb0ff;
}
.text {
  flex: 1;
  line-height: 1.45;
}
.toast button {
  color: rgba(255, 255, 255, 0.6);
}
.toast button:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
}
.toast-enter-active,
.toast-leave-active {
  transition: all 0.2s var(--ease);
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
