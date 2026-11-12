<script setup lang="ts">
/**
 * 设计稿封面：进入视野后才渲染第一个画板的缩略图；加载中显示骨架，画不出来显示占位图标。
 * 外层尺寸由调用方定（宽高比、圆角），图片按 cover 铺满、对齐顶部。
 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ImageOff, LayoutTemplate } from "lucide-vue-next";
import { coverOf } from "../viewer/covers";

const props = defineProps<{ designId: string; version: number | null | undefined }>();
const host = ref<HTMLElement>();
const src = ref<string | null>(null);
const state = ref<"idle" | "loading" | "ready" | "empty">("idle");
/** 竖长的画板（手机稿）：缩小居中显示整块画板顶部，四周留出画布底色，而不是放大裁掉 */
const portrait = ref(false);
let seen = false;
let seq = 0;
let observer: IntersectionObserver | null = null;

async function load() {
  if (!seen) return;
  const mine = ++seq;
  if (!props.version) {
    src.value = null;
    state.value = "empty";
    return;
  }
  state.value = "loading";
  const url = await coverOf(props.designId, props.version);
  if (mine !== seq) return;
  src.value = url;
  state.value = url ? "ready" : "empty";
}
watch(() => [props.designId, props.version], load);
onMounted(() => {
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        seen = true;
        observer?.disconnect();
        void load();
      }
    },
    { rootMargin: "200px" },
  );
  if (host.value) observer.observe(host.value);
});
onBeforeUnmount(() => {
  observer?.disconnect();
  seq++;
});
</script>

<template>
  <div ref="host" class="cover" :class="state">
    <img
      v-if="src"
      :src="src"
      alt=""
      draggable="false"
      :class="{ portrait }"
      @load="portrait = ($event.target as HTMLImageElement).naturalHeight > ($event.target as HTMLImageElement).naturalWidth * 1.1"
      @error="((src = null), (state = 'empty'))"
    />
    <div v-else-if="state === 'empty'" class="ph">
      <component :is="version ? ImageOff : LayoutTemplate" :size="22" />
      <span v-if="!version">还没有上传</span>
    </div>
    <div v-else class="skeleton fill" />
  </div>
</template>

<style scoped>
.cover {
  position: relative;
  overflow: hidden;
  background: var(--canvas-bg);
}
img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: top center;
  animation: fade 0.25s var(--ease);
}
img.portrait {
  width: 52%;
  height: auto;
  margin: 10% auto 0;
  border-radius: 6px;
  box-shadow: var(--shadow-md);
}
.fill {
  position: absolute;
  inset: 0;
  border-radius: 0;
}
.ph {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--faint);
  font-size: 12px;
}
@keyframes fade {
  from {
    opacity: 0;
  }
}
</style>
