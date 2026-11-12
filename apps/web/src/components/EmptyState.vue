<script setup lang="ts">
/** 空状态：图标 + 标题 + 一句说明 + 可选操作（默认插槽放按钮）。图标传 lucide 组件。 */
import type { Component } from "vue";

defineProps<{ icon?: Component; title: string; hint?: string }>();
</script>

<template>
  <div class="empty">
    <div v-if="icon" class="empty-icon"><component :is="icon" :size="22" /></div>
    <div class="empty-title">{{ title }}</div>
    <div v-if="hint" class="hint">{{ hint }}</div>
    <div v-if="$slots.default" class="acts"><slot /></div>
  </div>
</template>

<style scoped>
.hint {
  max-width: 380px;
  line-height: 1.6;
}
.acts {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
</style>
