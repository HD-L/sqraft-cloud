<script setup lang="ts">
import { computed } from "vue";
import { colorOf } from "../api";

const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 32 });
const letter = computed(() => (props.name || "?").trim().slice(0, 1).toUpperCase());
</script>

<template>
  <span class="avatar" :style="{ width: `${size}px`, height: `${size}px`, background: colorOf(name), fontSize: `${Math.round(size * 0.42)}px` }">{{ letter }}</span>
</template>
