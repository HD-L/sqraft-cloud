<script setup lang="ts">
/**
 * 应用外壳：左侧浅色导航（搜索入口、通知、各页面、上传客户端、当前用户），右侧是页面。
 * - 全局搜索是一个命令面板（⌘K / Ctrl+K）：搜项目、设计稿、成员，也能直接跳到各页面；
 * - 设计稿查看页是沉浸式的（路由 meta.immersive）：不显示侧栏，页面自己带顶栏；
 * - 登录页、授权页、改密码页不显示外壳。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  Bell,
  ChevronsUpDown,
  CircleCheck,
  ClipboardCheck,
  Menu,
  Clock,
  Download,
  FolderKanban,
  KeyRound,
  LogOut,
  RefreshCw,
  ScrollText,
  Search,
  Settings,
  Users,
  Wrench,
} from "lucide-vue-next";
import { api, logout, relativeTime, ROLE_LABEL, session } from "./api";
import { answerConfirm, confirmState, openClient, ui } from "./ui";
import Avatar from "./components/Avatar.vue";
import Modal from "./components/Modal.vue";
import Toaster from "./components/Toaster.vue";
import ConfirmHost from "./components/ConfirmHost.vue";
import CommandPalette from "./components/CommandPalette.vue";

const route = useRoute();
const router = useRouter();
const signedIn = computed(() => !!session.user && !route.meta.public && !route.meta.bare && !session.user.mustChangePassword);
const showShell = computed(() => signedIn.value && !route.meta.immersive);
const me = computed(() => session.user);

const nav = computed(() => [
  {
    label: "工作台",
    items: [
      { to: "/", icon: FolderKanban, text: "项目", match: (p: string) => p === "/" || p.startsWith("/projects") || p.startsWith("/designs") },
      { to: "/recent", icon: Clock, text: "最近浏览" },
    ],
  },
  {
    label: "团队",
    items: [
      { to: "/members", icon: Users, text: "成员" },
      { to: "/tokens", icon: KeyRound, text: "MCP 令牌" },
    ],
  },
  ...(me.value?.isAdmin
    ? [
        {
          label: "管理",
          items: [
            { to: "/admin/audit", icon: ScrollText, text: "审计日志" },
            { to: "/admin/system", icon: Wrench, text: "系统维护" },
          ],
        },
      ]
    : []),
]);
const active = (item: { to: string; match?: (p: string) => boolean }) => (item.match ? item.match(route.path) : route.path.startsWith(item.to));

// ── 命令面板 ──
const paletteOpen = ref(false);
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
function onKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k" && signedIn.value) {
    e.preventDefault();
    paletteOpen.value = !paletteOpen.value;
  }
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
/** 评审类通知在正文上方带一行图标 + 标题，一眼分出是待办还是结果 */
const NOTE_KIND: Record<string, { icon: typeof Bell; label: string }> = {
  review_request: { icon: ClipboardCheck, label: "请你评审" },
  review_result: { icon: CircleCheck, label: "评审结果" },
  review_updated: { icon: RefreshCw, label: "评审稿有更新" },
};
const notes = ref<Note[]>([]);
const unread = ref(0);
const bellOpen = ref(false);
const userOpen = ref(false);
/** 窄屏下侧栏收成抽屉 */
const drawerOpen = ref(false);
async function loadNotes() {
  if (!signedIn.value) return;
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
  bellOpen.value = false;
  if (n.link) void router.push(n.link);
}
async function readAll() {
  await api("POST", "/notifications/read", {});
  notes.value.forEach((n) => (n.read = true));
  unread.value = 0;
}

let poll = 0;
watch(
  signedIn,
  (v) => {
    if (v) void loadNotes();
  },
  { immediate: true },
);
watch(
  () => route.fullPath,
  () => {
    bellOpen.value = false;
    userOpen.value = false;
    paletteOpen.value = false;
    drawerOpen.value = false;
    // 确认框属于上一页的操作：换页后作废，免得在新页面上确认了旧页面的删除
    if (confirmState.open) answerConfirm(false);
  },
);
onMounted(() => {
  poll = window.setInterval(() => void loadNotes(), 60_000);
  window.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => {
  clearInterval(poll);
  window.removeEventListener("keydown", onKey);
});

async function signOut() {
  userOpen.value = false;
  await logout();
  await router.push("/login");
}
</script>

<template>
  <div v-if="showShell" class="app">
    <!-- 窄屏顶栏：菜单、logo、搜索（侧栏收成抽屉） -->
    <header class="mtop">
      <button class="ghost icon-btn" aria-label="打开菜单" @click="drawerOpen = true"><Menu :size="18" /></button>
      <RouterLink to="/" class="logo"><span class="mark">云</span>云设计</RouterLink>
      <span class="spacer" />
      <button class="ghost icon-btn" aria-label="搜索" @click="paletteOpen = true"><Search :size="17" /></button>
    </header>
    <div v-if="drawerOpen" class="drawer-veil" @click="drawerOpen = false" />
    <aside class="sidebar" :class="{ open: drawerOpen }">
      <div class="brand">
        <RouterLink to="/" class="logo"><span class="mark">云</span>云设计</RouterLink>
        <div class="bell-wrap">
          <button class="ghost sm icon-btn" :class="{ on: bellOpen }" title="通知" aria-label="通知" @click="bellOpen = !bellOpen">
            <Bell :size="16" /><span v-if="unread" class="dot" />
          </button>
          <div v-if="bellOpen" class="popover notes">
            <div class="nhead">
              <strong>通知</strong>
              <button v-if="unread" class="link" @click="readAll">全部已读</button>
            </div>
            <div v-if="!notes.length" class="nempty"><Bell :size="20" />暂无通知</div>
            <button v-for="n in notes" :key="n.id" class="note" :class="{ unread: !n.read }" @click="openNote(n)">
              <Avatar :name="n.actor?.displayName ?? '系'" :size="26" />
              <span class="ntext">
                <span v-if="NOTE_KIND[n.kind]" class="nkind" :class="n.kind"><component :is="NOTE_KIND[n.kind].icon" :size="12" />{{ NOTE_KIND[n.kind].label }}</span>
                {{ n.text }}<span class="ntime">{{ relativeTime(n.createdAt) }}</span>
              </span>
              <span v-if="!n.read" class="ndot" />
            </button>
          </div>
          <div v-if="bellOpen" class="veil" @click="bellOpen = false" />
        </div>
      </div>

      <button class="search" @click="paletteOpen = true">
        <Search :size="15" /><span>搜索</span><span class="spacer" /><kbd>{{ isMac ? "⌘" : "Ctrl" }}</kbd><kbd>K</kbd>
      </button>

      <nav>
        <template v-for="g in nav" :key="g.label">
          <div class="group">{{ g.label }}</div>
          <RouterLink v-for="item in g.items" :key="item.to" :to="item.to" class="item" :class="{ active: active(item) }">
            <component :is="item.icon" :size="16" :stroke-width="1.75" />{{ item.text }}
          </RouterLink>
        </template>
      </nav>

      <button class="client" @click="openClient()">
        <span class="cicon"><Download :size="15" /></span>
        <span class="ctext"><b>上传客户端</b><span>从 Sketch 发布设计稿</span></span>
      </button>

      <div class="me-wrap">
        <button class="me" :class="{ on: userOpen }" @click="userOpen = !userOpen">
          <Avatar :name="me!.displayName" :size="28" />
          <span class="info">
            <span class="name">{{ me!.displayName }}</span>
            <span class="role">{{ ROLE_LABEL[me!.role] }}</span>
          </span>
          <ChevronsUpDown :size="14" />
        </button>
        <div v-if="userOpen" class="popover usermenu">
          <RouterLink to="/settings" class="menu-item"><Settings :size="15" />个人设置</RouterLink>
          <div class="menu-sep" />
          <button class="menu-item" @click="signOut"><LogOut :size="15" />退出登录</button>
        </div>
        <div v-if="userOpen" class="veil" @click="userOpen = false" />
      </div>
    </aside>

    <main class="content"><RouterView /></main>
  </div>
  <RouterView v-else />

  <template v-if="signedIn">
    <CommandPalette v-if="paletteOpen" @close="paletteOpen = false" />
    <Modal v-if="ui.clientOpen" title="上传客户端" @close="ui.clientOpen = false">
      <p class="client-desc">
        设计师用上传客户端把本地 <b>.sqraft</b> 文件（Sketch 先用 sketch2sqraft 转换）发布到这里。客户端在浏览器里登录，只上传改动过的页面，大稿更新也很快。
      </p>
      <a class="button primary" style="width: 100%" :href="ui.clientUrl" target="_blank" rel="noopener"><Download :size="15" />下载 macOS 版（Apple Silicon）</a>
      <p class="client-hint">首次打开如提示「无法验证开发者」，到「系统设置 → 隐私与安全性」里点「仍要打开」。</p>
    </Modal>
  </template>
  <Toaster />
  <ConfirmHost />
</template>

<style scoped>
.app {
  display: flex;
  height: 100vh;
}
.sidebar {
  width: 236px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--panel-2);
  border-right: 1px solid var(--border);
  padding: 10px;
}
.brand {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 2px 10px 6px;
}
.logo {
  display: flex;
  align-items: center;
  gap: 9px;
  color: var(--text);
  font-weight: 650;
  font-size: 14px;
}
.mark {
  width: 24px;
  height: 24px;
  border-radius: 7px;
  background: linear-gradient(135deg, #5b82ff, #2f5cff);
  color: #fff;
  display: grid;
  place-items: center;
  font-size: 12px;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18);
}
.search {
  width: 100%;
  justify-content: flex-start;
  gap: 8px;
  color: var(--muted);
  font-weight: 450;
  margin-bottom: 8px;
}
.search kbd {
  margin-left: 2px;
}
nav {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.group {
  font-size: 11px;
  font-weight: 550;
  color: var(--muted);
  padding: 12px 8px 4px;
}
.item {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 32px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  color: var(--text-2);
  font-weight: 500;
  margin-bottom: 1px;
  transition: background 0.12s var(--ease);
}
.item:hover {
  background: var(--hover);
  color: var(--text);
}
.item.active {
  background: var(--active);
  color: var(--text);
  font-weight: 600;
}
.item.active svg {
  color: var(--brand);
}
.client {
  height: auto;
  width: 100%;
  justify-content: flex-start;
  gap: 10px;
  padding: 9px 10px;
  margin-bottom: 8px;
  text-align: left;
  border-color: var(--border);
}
.cicon {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: var(--brand-soft);
  color: var(--brand);
  display: grid;
  place-items: center;
  flex-shrink: 0;
}
.ctext {
  display: flex;
  flex-direction: column;
  line-height: 1.35;
  min-width: 0;
}
.ctext b {
  font-weight: 600;
  font-size: 12.5px;
}
.ctext span {
  font-size: 11.5px;
  font-weight: 400;
  color: var(--muted);
}
.me-wrap {
  position: relative;
}
.me {
  width: 100%;
  height: auto;
  justify-content: flex-start;
  gap: 9px;
  padding: 6px 8px;
  border-color: transparent;
  background: transparent;
  box-shadow: none;
  color: var(--muted);
}
.me:hover:not(:disabled),
.me.on {
  background: var(--hover);
}
.me .info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  line-height: 1.3;
}
.me .name {
  max-width: 100%;
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
}
.me .role {
  font-size: 11.5px;
  font-weight: 400;
  color: var(--muted);
}
.usermenu {
  left: 0;
  right: 0;
  bottom: calc(100% + 6px);
}
.veil {
  position: fixed;
  inset: 0;
  z-index: 30;
}
.bell-wrap {
  position: relative;
}
.bell-wrap > button {
  position: relative;
}
.bell-wrap > button.on {
  background: var(--active);
  color: var(--text);
}
.dot {
  position: absolute;
  top: 4px;
  right: 5px;
  width: 7px;
  height: 7px;
  background: var(--danger);
  border: 1.5px solid var(--panel-2);
  border-radius: 50%;
}
.notes {
  top: calc(100% + 6px);
  left: 0;
  width: 360px;
  max-width: 90vw;
  max-height: 70vh;
  overflow-y: auto;
}
.nhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
}
.nempty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 32px 0 36px;
  color: var(--muted);
}
.note {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  height: auto;
  justify-content: flex-start;
  border: none;
  background: none;
  box-shadow: none;
  text-align: left;
  white-space: normal;
  padding: 9px 10px;
  border-radius: 6px;
  color: var(--text-2);
  font-weight: 400;
}
.note.unread {
  color: var(--text);
}
.ntext {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  line-height: 1.5;
}
.nkind {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  font-weight: 550;
  color: var(--brand);
}
.nkind.review_result {
  color: var(--ok);
}
.nkind.review_updated {
  color: var(--muted);
}
.ntime {
  font-size: 11.5px;
  color: var(--muted);
}
.ndot {
  width: 7px;
  height: 7px;
  margin-top: 6px;
  border-radius: 50%;
  background: var(--brand);
  flex-shrink: 0;
}
.content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}
.client-desc {
  margin: 0 0 16px;
  color: var(--text-2);
  line-height: 1.65;
}
.client-hint {
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.6;
}
.mtop {
  display: none;
}
@media (max-width: 760px) {
  .app {
    flex-direction: column;
  }
  .mtop {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 48px;
    flex-shrink: 0;
    padding: 0 8px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
  }
  .sidebar {
    position: fixed;
    top: 0;
    bottom: 0;
    left: 0;
    z-index: 60;
    visibility: hidden;
    transform: translateX(-100%);
    transition:
      transform 0.2s var(--ease),
      visibility 0.2s;
  }
  .sidebar.open {
    visibility: visible;
    transform: none;
    box-shadow: var(--shadow-lg);
  }
  .drawer-veil {
    position: fixed;
    inset: 0;
    z-index: 55;
    background: rgba(16, 20, 34, 0.32);
  }
  .content {
    min-height: 0;
  }
}
</style>
