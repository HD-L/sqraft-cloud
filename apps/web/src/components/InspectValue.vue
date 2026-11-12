<script setup lang="ts">
/**
 * 标注面板里的一个值：灰底小框，悬停出现复制图标，点击复制（值 + 单位），原位显示 ✓。
 * 绑定了 Token 时在框下方挂一个 Token 标签（点标签复制 Token 名）；也可以在下方放一行说明（sub）。
 */
import { ref } from "vue";
import { Check, Copy } from "lucide-vue-next";
import { copyText } from "../viewer/copy";

const props = withDefaults(
  defineProps<{ value: string; unit?: string; hint?: string; swatch?: string; copy?: string; wide?: boolean; token?: string; sub?: string; mono?: boolean }>(),
  { unit: "", hint: "", swatch: "", copy: "", wide: false, token: "", sub: "", mono: false },
);
const emit = defineEmits<{ swatch: [] }>();
const done = ref(false);
const tokenDone = ref(false);
let timer = 0;

function copy() {
  void copyText(props.copy || props.value + props.unit);
  done.value = true;
  clearTimeout(timer);
  timer = window.setTimeout(() => (done.value = false), 1000);
}
function copyToken() {
  void copyText(props.token);
  tokenDone.value = true;
  window.setTimeout(() => (tokenDone.value = false), 1000);
}
</script>

<template>
  <div class="cell" :class="{ wide }">
    <button class="val" :class="{ done, mono }" :title="props.copy && props.copy !== props.value ? `${props.value}\n点击复制 ${props.copy}` : `点击复制 ${props.value + props.unit}`" @click="copy">
      <span v-if="swatch" class="sw" title="点色块切换颜色格式" @click.stop="emit('swatch')"><span :style="{ background: swatch }" /></span>
      <span class="v">{{ value }}</span><span v-if="unit" class="u">{{ unit }}</span>
      <span class="spacer" />
      <span v-if="hint" class="h">{{ hint }}</span>
      <span class="ic"><Check v-if="done" :size="12" /><Copy v-else :size="12" /></span>
    </button>
    <button v-if="token" class="tk" :title="`Token：${token}（点击复制）`" @click="copyToken">{{ tokenDone ? "✓ 已复制" : `⟨${token}⟩` }}</button>
    <span v-else-if="sub" class="sub" :title="sub">{{ sub }}</span>
  </div>
</template>

<style scoped>
.cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}
.cell.wide {
  flex: 2;
}
.val {
  position: relative;
  display: flex;
  align-items: center;
  gap: 2px;
  width: 100%;
  min-width: 0;
  height: 30px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: #f4f5f8;
  color: var(--text);
  font-weight: 500;
  font-size: 13px;
  justify-content: flex-start;
  font-variant-numeric: tabular-nums;
  transition: border-color 0.15s, background 0.15s;
}
.val:hover:not(:disabled) {
  background: #eef2ff;
  color: var(--text);
  border-color: transparent;
}
.val.done {
  border-color: var(--brand);
  background: var(--brand-soft);
}
.val.mono .v {
  font-family: "SF Mono", Menlo, Consolas, monospace;
  font-size: 12px;
}
.v {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.u {
  color: var(--muted);
  margin-left: 2px;
  font-weight: 400;
}
.h {
  color: var(--muted);
  font-weight: 400;
  font-size: 11px;
  white-space: nowrap;
}
/* 复制图标浮在右侧、不占位置：窄格子里的数值不会被它挤成省略号 */
.ic {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 20px;
  display: grid;
  place-items: center;
  font-size: 11px;
  color: var(--brand);
  background: inherit;
  border-radius: 0 6px 6px 0;
  opacity: 0;
}
.val:hover .ic,
.val.done .ic {
  opacity: 1;
}
.sw {
  width: 16px;
  height: 16px;
  border-radius: 3px;
  margin-right: 6px;
  flex-shrink: 0;
  background: repeating-conic-gradient(#ddd 0 25%, #fff 0 50%) 0 0 / 8px 8px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  overflow: hidden;
  cursor: pointer;
}
.sw span {
  display: block;
  width: 100%;
  height: 100%;
}
.tk {
  align-self: flex-start;
  max-width: 100%;
  border: none;
  padding: 0 4px;
  border-radius: 4px;
  background: #f3edff;
  color: #7a3df0;
  font-size: 11px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  justify-content: flex-start;
}
.sub {
  font-size: 11px;
  color: var(--muted);
  padding-left: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tk {
  height: auto;
  line-height: 18px;
  box-shadow: none;
}
.val {
  box-shadow: none;
}
</style>
