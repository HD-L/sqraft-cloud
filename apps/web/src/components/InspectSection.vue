<script setup lang="ts">
/** 标注面板的一个分区：标题可点击折叠（状态记在设置里），右侧可放「复制本区 CSS」与其他操作。 */
import { computed, ref } from "vue";
import { Check, ChevronRight } from "lucide-vue-next";
import { prefs, toggleCollapsed } from "../viewer/prefs";
import { copyText } from "../viewer/copy";

const props = withDefaults(defineProps<{ id: string; title: string; icon?: string; css?: string }>(), { icon: "", css: "" });
const open = computed(() => !prefs.collapsed.includes(props.id));
const copied = ref(false);

function copyCss() {
  void copyText(props.css);
  copied.value = true;
  window.setTimeout(() => (copied.value = false), 1000);
}
</script>

<template>
  <section class="sec">
    <header>
      <button class="tg" :aria-expanded="open" @click="toggleCollapsed(id)">
        <ChevronRight :size="13" class="caret" :class="{ open }" />
        <span v-if="icon" class="ico">{{ icon }}</span>
        <span class="t">{{ title }}</span>
      </button>
      <span class="spacer" />
      <slot name="extra" />
      <button v-if="css" class="cp" :title="`复制本区 CSS\n${css}`" @click="copyCss"><Check v-if="copied" :size="12" /><template v-else>CSS</template></button>
    </header>
    <div v-if="open" class="content"><slot /></div>
  </section>
</template>

<style scoped>
.sec {
  border-bottom: 1px solid var(--border);
}
header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px 8px 6px;
}
.tg {
  display: flex;
  align-items: center;
  gap: 6px;
  border: none;
  padding: 2px 4px;
  font-size: 13px;
  font-weight: 650;
  color: var(--text);
  min-width: 0;
}
.caret {
  display: inline-block;
  width: 10px;
  font-size: 9px;
  color: var(--muted);
  transition: transform 0.12s;
}
.caret.open {
  transform: rotate(90deg);
}
.ico {
  width: 16px;
  text-align: center;
  color: var(--text-2);
}
.t {
  white-space: nowrap;
}
.cp {
  padding: 1px 7px;
  font-size: 11px;
  border-radius: 5px;
  color: var(--text-2);
}
.content {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 12px 12px;
}

.tg {
  height: auto;
  background: none;
  box-shadow: none;
}
.cp {
  height: 22px;
  box-shadow: none;
}
</style>
