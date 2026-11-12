<script setup lang="ts">
/** 居中弹窗：点遮罩或 Esc 关闭。 */
import { onBeforeUnmount, onMounted } from "vue";

const props = withDefaults(defineProps<{ title: string; width?: number }>(), { width: 460 });
const emit = defineEmits<{ close: [] }>();
const onKey = (e: KeyboardEvent) => e.key === "Escape" && emit("close");
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <Teleport to="body">
    <div class="mask" @mousedown.self="emit('close')">
      <div class="modal" :style="{ width: `${props.width}px` }" role="dialog" :aria-label="title">
        <div class="head">
          <h2>{{ title }}</h2>
          <button class="x" aria-label="关闭" @click="emit('close')">✕</button>
        </div>
        <div class="body"><slot /></div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 18, 32, 0.5);
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  animation: fade 0.15s;
}
.modal {
  max-width: 100%;
  max-height: 90vh;
  overflow-y: auto;
  background: #fff;
  border-radius: 16px;
  box-shadow: var(--shadow-lg);
  animation: pop 0.18s;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 22px 10px;
}
.head h2 {
  margin: 0;
  font-size: 17px;
}
.x {
  border: none;
  width: 28px;
  height: 28px;
  padding: 0;
  color: var(--muted);
}
.x:hover {
  background: var(--bg);
}
.body {
  padding: 6px 22px 22px;
}
.body :deep(input),
.body :deep(select),
.body :deep(textarea) {
  width: 100%;
}
.body :deep(input[type="checkbox"]) {
  width: auto;
}
@keyframes fade {
  from {
    opacity: 0;
  }
}
@keyframes pop {
  from {
    opacity: 0;
    transform: scale(0.96) translateY(8px);
  }
}
</style>
