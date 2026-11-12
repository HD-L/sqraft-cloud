<script setup lang="ts">
/** 居中弹窗：点遮罩或 Esc 关闭。底部按钮放在 #footer 插槽里（右对齐）。 */
import { onBeforeUnmount, onMounted } from "vue";
import { X } from "lucide-vue-next";

const props = withDefaults(defineProps<{ title: string; width?: number }>(), { width: 460 });
const emit = defineEmits<{ close: [] }>();
const onKey = (e: KeyboardEvent) => e.key === "Escape" && emit("close");
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <Teleport to="body">
    <div class="mask" @mousedown.self="emit('close')">
      <div class="modal" :style="{ width: `${props.width}px` }" role="dialog" aria-modal="true" :aria-label="title">
        <div class="head">
          <h2>{{ title }}</h2>
          <button class="ghost sm icon-btn" aria-label="关闭" @click="emit('close')"><X :size="16" /></button>
        </div>
        <div class="body"><slot /></div>
        <div v-if="$slots.footer" class="footer"><slot name="footer" /></div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: rgba(16, 20, 34, 0.42);
  backdrop-filter: blur(2px);
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  animation: fade 0.15s var(--ease);
}
.modal {
  max-width: 100%;
  max-height: 90vh;
  overflow-y: auto;
  background: var(--panel);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  animation: pop 0.18s var(--ease);
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 16px 8px 20px;
}
.head h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}
.body {
  padding: 4px 20px 20px;
}
.footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid var(--border);
  background: var(--panel-2);
  border-radius: 0 0 var(--radius-lg) var(--radius-lg);
}
.body :deep(input),
.body :deep(select),
.body :deep(textarea) {
  width: 100%;
}
.body :deep(input[type="checkbox"]),
.body :deep(input[type="radio"]) {
  width: auto;
  flex-shrink: 0;
}
@keyframes fade {
  from {
    opacity: 0;
  }
}
@keyframes pop {
  from {
    opacity: 0;
    transform: scale(0.97) translateY(6px);
  }
}
</style>
