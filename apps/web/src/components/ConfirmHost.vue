<script setup lang="ts">
/** 确认弹窗的宿主：挂在应用根部，响应 ui.ts 的 confirmDialog()。Enter 确认，Esc / 点遮罩取消。 */
import { nextTick, ref, watch } from "vue";
import { answerConfirm, confirmState } from "../ui";
import Modal from "./Modal.vue";

const ok = ref<HTMLButtonElement>();
watch(
  () => confirmState.open,
  (open) => open && void nextTick(() => ok.value?.focus()),
);
</script>

<template>
  <Modal v-if="confirmState.open" :title="confirmState.options.title" :width="420" @close="answerConfirm(false)">
    <p v-if="confirmState.options.message" class="msg">{{ confirmState.options.message }}</p>
    <div class="foot">
      <button @click="answerConfirm(false)">取消</button>
      <button ref="ok" class="primary" :class="{ danger: confirmState.options.danger }" @click="answerConfirm(true)">
        {{ confirmState.options.confirmText ?? "确定" }}
      </button>
    </div>
  </Modal>
</template>

<style scoped>
.msg {
  margin: 0 0 4px;
  color: var(--text-2);
  line-height: 1.6;
}
.foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
}
</style>
