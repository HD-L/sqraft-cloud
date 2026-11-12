<script setup lang="ts">
/**
 * 应用外壳：左侧深色导航（工作台 / 成员 / 接入 / 其他）、顶栏（全局搜索、通知），主区域放各页面。
 * 登录页与授权页不显示外壳。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api, logout, relativeTime, ROLE_LABEL, session } from "./api";
import { openClient, ui } from "./ui";
import Avatar from "./components/Avatar.vue";
import Modal from "./components/Modal.vue";

const route = useRoute();
const router = useRouter();
const showShell = computed(() => session.user && !route.meta.public && !route.meta.bare && !session.user.mustChangePassword);
const me = computed(() => session.user);

const nav = computed(() => [
  {
    label: "工作台",
    items: [
      { to: "/", icon: "📁", text: "项目", match: (p: string) => p === "/" || p.startsWith("/projects") || p.startsWith("/designs") },
      { to: "/recent", icon: "🕘", text: "最近浏览" },
    ],
  },
  { label: "成员", items: [{ to: "/members", icon: "👥", text: "人员管理" }] },
  { label: "接入", items: [{ to: "/tokens", icon: "🔑", text: "MCP 令牌" }] },
  {
    label: "其他",
    items: [
      { to: "/settings", icon: "⚙️", text: "个人设置" },
      ...(me.value?.isAdmin
        ? [
            { to: "/admin/audit", icon: "📜", text: "审计日志" },
            { to: "/admin/system", icon: "🛠", text: "系统维护" },
          ]
        : []),
    ],
  },
]);
const active = (item: { to: string; match?: (p: string) => boolean }) => (item.match ? item.match(route.path) : route.path.startsWith(item.to));

// ── 全局搜索 ──
interface Hits {
  projects: Array<{ id: string; name: string; description: string }>;
  designs: Array<{ id: string; name: string; projectName: string }>;
  members: Array<{ id: string; username: string; displayName: string }>;
}
const q = ref("");
const hits = ref<Hits | null>(null);
const searchOpen = ref(false);
let timer = 0;
watch(q, (v) => {
  clearTimeout(timer);
  if (!v.trim()) {
    hits.value = null;
    return;
  }
  timer = window.setTimeout(async () => {
    hits.value = await api<Hits>("GET", `/search?q=${encodeURIComponent(v.trim())}`).catch(() => null);
  }, 200);
});
const noHits = computed(() => hits.value && !hits.value.projects.length && !hits.value.designs.length && !hits.value.members.length);
function go(path: string) {
  searchOpen.value = false;
  bellOpen.value = false;
  q.value = "";
  void router.push(path);
}

// ── 通知 ──
interface Note {
  id: number;
  kind: string;
  actor: { displayName: string } | null;
  text: string;
  link: string | null;
  read: boolean;
  createdAt: number;
}
const notes = ref<Note[]>([]);
const unread = ref(0);
const bellOpen = ref(false);
async function loadNotes() {
  if (!showShell.value) return;
  const res = await api<{ notifications: Note[]; unread: number }>("GET", "/notifications?limit=30").catch(() => null);
  if (res) {
    notes.value = res.notifications;
    unread.value = res.unread;
  }
}
async function openNote(n: Note) {
  if (!n.read) {
    await api("POST", "/notifications/read", { ids: [n.id] }).catch(() => undefined);
    n.read = true;
    unread.value = Math.max(0, unread.value - 1);
  }
  if (n.link) go(n.link);
}
async function readAll() {
  await api("POST", "/notifications/read", {});
  notes.value.forEach((n) => (n.read = true));
  unread.value = 0;
}

let poll = 0;
watch(showShell, (v) => {
  if (v) void loadNotes();
}, { immediate: true });
watch(() => route.fullPath, () => {
  searchOpen.value = false;
  bellOpen.value = false;
});
onMounted(() => (poll = window.setInterval(() => void loadNotes(), 60_000)));
onBeforeUnmount(() => clearInterval(poll));

async function signOut() {
  await logout();
  await router.push("/login");
}
</script>

<template>
  <div v-if="showShell" class="app">
    <aside class="sidebar">
      <RouterLink to="/" class="logo"><span class="mark">云</span>云设计</RouterLink>
      <nav>
        <template v-for="g in nav" :key="g.label">
          <div class="group">{{ g.label }}</div>
          <RouterLink v-for="item in g.items" :key="item.to" :to="item.to" class="item" :class="{ active: active(item) }">
            <span class="ico">{{ item.icon }}</span>{{ item.text }}
          </RouterLink>
        </template>
      </nav>
      <button class="client" @click="openClient()">⬇ 下载上传客户端</button>
      <div class="me">
        <Avatar :name="me!.displayName" :size="30" />
        <div class="info">
          <div class="name">{{ me!.displayName }}</div>
          <div class="role">{{ ROLE_LABEL[me!.role] }}</div>
        </div>
        <button class="out" title="退出登录" @click="signOut">退出</button>
      </div>
    </aside>

    <div class="main">
      <header class="topbar">
        <div class="search" @focusin="searchOpen = true">
          <span>🔍</span>
          <input v-model="q" placeholder="搜索项目、设计稿、成员…" @keydown.esc="searchOpen = false" />
          <div v-if="searchOpen && hits" class="dropdown">
            <p v-if="noHits" class="muted pad">没有找到「{{ q }}」</p>
            <template v-if="hits.projects.length">
              <div class="sec">项目</div>
              <button v-for="p in hits.projects" :key="p.id" class="hit" @click="go(`/projects/${p.id}`)">📁 {{ p.name }}<span class="muted">{{ p.description }}</span></button>
            </template>
            <template v-if="hits.designs.length">
              <div class="sec">设计稿</div>
              <button v-for="d in hits.designs" :key="d.id" class="hit" @click="go(`/designs/${d.id}`)">🎨 {{ d.name }}<span class="muted">{{ d.projectName }}</span></button>
            </template>
            <template v-if="hits.members.length">
              <div class="sec">成员</div>
              <button v-for="m in hits.members" :key="m.id" class="hit" @click="go(`/members?q=${encodeURIComponent(m.username)}`)">
                <Avatar :name="m.displayName" :size="20" />{{ m.displayName }}<span class="muted">@{{ m.username }}</span>
              </button>
            </template>
          </div>
        </div>
        <div v-if="searchOpen && hits" class="veil" @click="searchOpen = false" />
        <span class="spacer" />
        <div class="bell-wrap">
          <button class="icon" title="通知" @click="bellOpen = !bellOpen">🔔<span v-if="unread" class="dot" /></button>
          <div v-if="bellOpen" class="dropdown notes">
            <div class="row nhead">
              <strong>通知</strong><span class="spacer" />
              <button v-if="unread" class="link sm" @click="readAll">全部已读</button>
            </div>
            <p v-if="!notes.length" class="muted pad">暂无通知</p>
            <button v-for="n in notes" :key="n.id" class="note" :class="{ unread: !n.read }" @click="openNote(n)">
              <Avatar :name="n.actor?.displayName ?? '系'" :size="26" />
              <span class="ntext">{{ n.text }}<span class="muted ntime">{{ relativeTime(n.createdAt) }}</span></span>
            </button>
          </div>
          <div v-if="bellOpen" class="veil" @click="bellOpen = false" />
        </div>
      </header>
      <div class="content"><RouterView /></div>
    </div>

    <Modal v-if="ui.clientOpen" title="下载上传客户端" @close="ui.clientOpen = false">
      <p class="muted" style="margin-top: 0">
        设计师用上传客户端把本地 <b>.sqraft</b> 文件（Sketch 先用 sketch2sqraft 转换）发布到这里。
        客户端在浏览器里登录，只上传改动过的页面，大稿更新也很快。
      </p>
      <a class="button primary" style="width: 100%" :href="ui.clientUrl" target="_blank" rel="noopener">⬇ 下载 macOS（Apple Silicon）</a>
      <p class="muted" style="font-size: 12px; margin-bottom: 0">首次打开如提示「无法验证开发者」，到「系统设置 → 隐私与安全性」里点「仍要打开」。</p>
    </Modal>
  </div>
  <RouterView v-else />
</template>

<style scoped>
.app {
  display: flex;
  height: 100vh;
}
.sidebar {
  width: 232px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: linear-gradient(180deg, var(--sidebar-bg), var(--sidebar-bg2));
  color: var(--sidebar-text);
}
.logo {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 18px 18px 10px;
  color: #fff;
  font-weight: 700;
  font-size: 16px;
}
.mark {
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: linear-gradient(135deg, #4d7cff, #2f5cff);
  display: grid;
  place-items: center;
  font-size: 13px;
}
nav {
  flex: 1;
  overflow-y: auto;
  padding: 6px 12px;
}
.group {
  font-size: 11px;
  letter-spacing: 0.5px;
  color: #6b7290;
  padding: 10px 10px 4px;
}
.item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  color: var(--sidebar-text);
  margin-bottom: 1px;
  transition: background 0.13s;
}
.item:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
}
.item.active {
  background: var(--brand);
  color: #fff;
}
.ico {
  width: 18px;
  text-align: center;
}
.client {
  margin: 6px 12px 10px;
  justify-content: flex-start;
  background: rgba(79, 124, 255, 0.16);
  border: 1px solid rgba(79, 124, 255, 0.35);
  color: #cfe0ff;
}
.client:hover:not(:disabled) {
  background: rgba(79, 124, 255, 0.28);
  color: #fff;
  border-color: rgba(79, 124, 255, 0.5);
}
.me {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 12px 14px 12px 18px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}
.me .info {
  flex: 1;
  min-width: 0;
}
.me .name {
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.me .role {
  font-size: 11px;
  color: #8b93ad;
}
.out {
  border: none;
  background: none;
  color: #8b93ad;
  padding: 4px 6px;
  font-size: 12px;
}
.out:hover:not(:disabled) {
  color: #fff;
}
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.topbar {
  height: 56px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 24px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  position: relative;
  z-index: 20;
}
.search {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--bg);
  border-radius: 9px;
  padding: 0 12px;
  width: 320px;
  max-width: 50vw;
  z-index: 2;
}
.search input {
  border: none;
  background: none;
  box-shadow: none;
  padding: 8px 0;
  width: 100%;
}
.dropdown {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  width: 380px;
  max-width: 90vw;
  max-height: 70vh;
  overflow-y: auto;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  padding: 6px;
  z-index: 3;
}
.veil {
  position: fixed;
  inset: 0;
  z-index: 1;
}
.sec {
  font-size: 11px;
  color: var(--muted);
  padding: 8px 10px 2px;
}
.hit {
  display: flex;
  gap: 8px;
  width: 100%;
  justify-content: flex-start;
  border: none;
  padding: 7px 10px;
  color: var(--text);
  font-weight: 500;
}
.hit:hover:not(:disabled) {
  background: var(--brand-soft);
}
.hit .muted {
  font-weight: 400;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pad {
  padding: 10px;
  margin: 0;
}
.bell-wrap {
  position: relative;
}
.icon {
  position: relative;
  z-index: 2;
  border: none;
  width: 34px;
  height: 34px;
  padding: 0;
  font-size: 16px;
}
.icon:hover:not(:disabled) {
  background: var(--bg);
}
.dot {
  position: absolute;
  top: 6px;
  right: 7px;
  width: 8px;
  height: 8px;
  background: var(--danger);
  border: 1.5px solid #fff;
  border-radius: 50%;
}
.notes {
  left: auto;
  right: 0;
}
.nhead {
  padding: 6px 10px;
}
.note {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  justify-content: flex-start;
  border: none;
  text-align: left;
  white-space: normal;
  padding: 9px 10px;
  color: var(--text-2);
  font-weight: 400;
}
.note.unread {
  color: var(--text);
  background: #f7f9ff;
}
.note:hover:not(:disabled) {
  background: var(--brand-soft);
}
.ntext {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
}
.ntime {
  font-size: 11px;
}
.content {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
@media (max-width: 760px) {
  .sidebar {
    display: none;
  }
}
</style>
