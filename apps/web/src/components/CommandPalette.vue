<script setup lang="ts">
/**
 * 命令面板（⌘K）：输入即搜项目、设计稿、成员；没输入时列出可以直接跳转的页面。
 * ↑ ↓ 选择，Enter 打开，Esc 关闭。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Component } from "vue";
import { useRouter } from "vue-router";
import { Clock, CornerDownLeft, FileImage, FolderKanban, KeyRound, ScrollText, Search, Settings, Users, Wrench } from "lucide-vue-next";
import { api, session } from "../api";
import Avatar from "./Avatar.vue";

const emit = defineEmits<{ close: [] }>();
const router = useRouter();

interface Hits {
  projects: Array<{ id: string; name: string; description: string }>;
  designs: Array<{ id: string; name: string; projectName: string }>;
  members: Array<{ id: string; username: string; displayName: string }>;
}
interface Item {
  key: string;
  group: string;
  title: string;
  sub?: string;
  icon?: Component;
  avatar?: string;
  to: string;
}

const q = ref("");
const hits = ref<Hits | null>(null);
const loading = ref(false);
const index = ref(0);
const input = ref<HTMLInputElement>();
const list = ref<HTMLElement>();

const PAGES = computed<Item[]>(() => [
  { key: "p:/", group: "前往", title: "项目", icon: FolderKanban, to: "/" },
  { key: "p:/recent", group: "前往", title: "最近浏览", icon: Clock, to: "/recent" },
  { key: "p:/members", group: "前往", title: "成员", icon: Users, to: "/members" },
  { key: "p:/tokens", group: "前往", title: "MCP 令牌", icon: KeyRound, to: "/tokens" },
  { key: "p:/settings", group: "前往", title: "个人设置", icon: Settings, to: "/settings" },
  ...(session.user?.isAdmin
    ? [
        { key: "p:/admin/audit", group: "前往", title: "审计日志", icon: ScrollText, to: "/admin/audit" },
        { key: "p:/admin/system", group: "前往", title: "系统维护", icon: Wrench, to: "/admin/system" },
      ]
    : []),
]);

const items = computed<Item[]>(() => {
  const text = q.value.trim().toLowerCase();
  if (!text) return PAGES.value;
  const h = hits.value;
  return [
    ...(h?.projects ?? []).map((p) => ({ key: `pr:${p.id}`, group: "项目", title: p.name, sub: p.description, icon: FolderKanban, to: `/projects/${p.id}` })),
    ...(h?.designs ?? []).map((d) => ({ key: `d:${d.id}`, group: "设计稿", title: d.name, sub: d.projectName, icon: FileImage, to: `/designs/${d.id}` })),
    ...(h?.members ?? []).map((m) => ({ key: `m:${m.id}`, group: "成员", title: m.displayName, sub: `@${m.username}`, avatar: m.displayName, to: `/members?q=${encodeURIComponent(m.username)}` })),
    ...PAGES.value.filter((p) => p.title.toLowerCase().includes(text)),
  ];
});
/** 按分组切段，同时保留每一项在扁平列表里的序号（键盘选择用） */
const groups = computed(() => {
  const out: Array<{ name: string; rows: Array<{ item: Item; i: number }> }> = [];
  items.value.forEach((item, i) => {
    let g = out.find((x) => x.name === item.group);
    if (!g) out.push((g = { name: item.group, rows: [] }));
    g.rows.push({ item, i });
  });
  return out;
});

let timer = 0;
let seq = 0;
watch(q, (v) => {
  clearTimeout(timer);
  index.value = 0;
  const text = v.trim();
  if (!text) {
    hits.value = null;
    loading.value = false;
    return;
  }
  // 新查询的结果回来之前不显示旧结果，免得按 Enter 打开上一次的第一条
  hits.value = null;
  loading.value = true;
  const mine = ++seq;
  timer = window.setTimeout(async () => {
    const res = await api<Hits>("GET", `/search?q=${encodeURIComponent(text)}`).catch(() => null);
    if (mine !== seq) return;
    hits.value = res;
    loading.value = false;
  }, 160);
});

function open(item: Item | undefined) {
  if (!item) return;
  emit("close");
  void router.push(item.to);
}
function move(delta: number) {
  const n = items.value.length;
  if (!n) return;
  index.value = (index.value + delta + n) % n;
  void nextTick(() => list.value?.querySelector(".cmd-row.on")?.scrollIntoView({ block: "nearest" }));
}
function onKey(e: KeyboardEvent) {
  if (e.key === "ArrowDown") move(1);
  else if (e.key === "ArrowUp") move(-1);
  else if (e.key === "Enter" && !e.isComposing) open(items.value[index.value]);
  else if (e.key === "Escape") emit("close");
  else return;
  e.preventDefault();
  e.stopPropagation();
}
onMounted(() => input.value?.focus());
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <Teleport to="body">
    <div class="mask" @mousedown.self="emit('close')">
      <div class="palette" role="dialog" aria-modal="true" aria-label="搜索" @keydown="onKey">
        <div class="bar">
          <Search :size="17" />
          <input ref="input" v-model="q" placeholder="搜索项目、设计稿、成员，或输入页面名称…" autocomplete="off" spellcheck="false" />
          <kbd>Esc</kbd>
        </div>
        <div ref="list" class="list">
          <template v-for="g in groups" :key="g.name">
            <div class="gname">{{ g.name }}</div>
            <button v-for="r in g.rows" :key="r.item.key" class="cmd-row" :class="{ on: r.i === index }" @mousemove="index = r.i" @click="open(r.item)">
              <Avatar v-if="r.item.avatar" :name="r.item.avatar" :size="20" />
              <span v-else class="ric"><component :is="r.item.icon" :size="15" /></span>
              <span class="rt">{{ r.item.title }}</span>
              <span v-if="r.item.sub" class="rs">{{ r.item.sub }}</span>
              <span class="spacer" />
              <CornerDownLeft v-if="r.i === index" :size="13" class="enter" />
            </button>
          </template>
          <div v-if="!items.length" class="none">{{ loading ? "搜索中…" : `没有找到「${q.trim()}」` }}</div>
        </div>
        <div class="foot"><kbd>↑</kbd><kbd>↓</kbd><span>选择</span><kbd>↵</kbd><span>打开</span></div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 120;
  background: rgba(16, 20, 34, 0.36);
  backdrop-filter: blur(2px);
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 14vh 16px 16px;
  animation: fade 0.12s var(--ease);
}
.palette {
  width: 600px;
  max-width: 100%;
  background: var(--panel);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  animation: pop 0.16s var(--ease);
}
.bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
  height: 50px;
  border-bottom: 1px solid var(--border);
  color: var(--muted);
}
.bar input {
  flex: 1;
  border: none;
  box-shadow: none;
  height: 48px;
  padding: 0;
  font-size: 15px;
  background: none;
}
.list {
  max-height: min(52vh, 420px);
  overflow-y: auto;
  padding: 6px;
}
.gname {
  font-size: 11px;
  font-weight: 550;
  color: var(--muted);
  padding: 8px 10px 4px;
}
.cmd-row {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 36px;
  justify-content: flex-start;
  border: none;
  background: none;
  box-shadow: none;
  padding: 0 10px;
  border-radius: var(--radius-sm);
  font-weight: 500;
  color: var(--text);
}
.cmd-row:hover:not(:disabled) {
  background: none;
}
.cmd-row.on,
.cmd-row.on:hover:not(:disabled) {
  background: var(--hover);
}
.ric {
  width: 20px;
  display: grid;
  place-items: center;
  color: var(--text-2);
}
.rt {
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 0;
  max-width: 60%;
}
.rs {
  min-width: 0;
  flex: 0 1 auto;
  color: var(--muted);
  font-weight: 400;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.enter {
  color: var(--muted);
}
.none {
  padding: 28px 0;
  text-align: center;
  color: var(--muted);
}
.foot {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-top: 1px solid var(--border);
  background: var(--panel-2);
  font-size: 12px;
  color: var(--muted);
}
.foot span {
  margin-right: 8px;
}
@keyframes fade {
  from {
    opacity: 0;
  }
}
@keyframes pop {
  from {
    opacity: 0;
    transform: scale(0.98) translateY(-6px);
  }
}
</style>
