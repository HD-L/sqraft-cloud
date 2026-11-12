<script setup lang="ts">
/**
 * 人员管理（E2–E5）：成员列表、按姓名搜索、按角色筛选；管理员可添加成员（直接建账号，给初始密码）、
 * 改角色、设置能看哪些项目、重置密码、移除（停用账号，可恢复）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import {
  Check,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  FolderLock,
  Globe,
  KeyRound,
  MoreHorizontal,
  RotateCcw,
  Search,
  ShieldAlert,
  UserMinus,
  UserPlus,
  Users,
  X,
} from "lucide-vue-next";
import { api, formatTime, relativeTime, ROLE_LABEL, ROLE_TAG, session, type TeamRole } from "../api";
import { confirmDialog, confirmState, toast } from "../ui";
import Avatar from "../components/Avatar.vue";
import EmptyState from "../components/EmptyState.vue";
import Modal from "../components/Modal.vue";

interface Member {
  id: string;
  username: string;
  displayName: string;
  email: string;
  role: TeamRole;
  projectScope: "all" | "assigned";
  disabled: boolean;
  mustChangePassword: boolean;
  createdAt: number;
  lastLoginAt?: number | null;
}
type Filter = TeamRole | "all" | "removed";

const route = useRoute();
const members = ref<Member[]>([]);
const loading = ref(true);
const q = ref(typeof route.query.q === "string" ? route.query.q : "");
const roleFilter = ref<Filter>("all");
const error = ref("");
const isAdmin = computed(() => session.user?.isAdmin === true);
const origin = window.location.origin;
const active = computed(() => members.value.filter((m) => !m.disabled));
const adminCount = computed(() => active.value.filter((m) => m.role === "admin").length);

// 已在本页时，命令面板再跳过来也要更新搜索词
watch(
  () => route.query.q,
  (v) => {
    if (typeof v === "string") {
      q.value = v;
      roleFilter.value = "all";
    }
  },
);

const tabs = computed(() => {
  const list: Array<{ key: Filter; label: string; count: number }> = [
    { key: "all", label: "全部", count: active.value.length },
    { key: "admin", label: "管理员", count: adminCount.value },
    { key: "editor", label: "编辑者", count: active.value.filter((m) => m.role === "editor").length },
    { key: "viewer", label: "查看者", count: active.value.filter((m) => m.role === "viewer").length },
  ];
  if (isAdmin.value) list.push({ key: "removed", label: "已停用", count: members.value.length - active.value.length });
  return list;
});

const shown = computed(() => {
  const k = q.value.trim().toLowerCase();
  return members.value.filter((m) => {
    if (roleFilter.value === "removed" ? !m.disabled : m.disabled) return false;
    if (roleFilter.value !== "all" && roleFilter.value !== "removed" && m.role !== roleFilter.value) return false;
    return !k || m.displayName.toLowerCase().includes(k) || m.username.toLowerCase().includes(k) || m.email.toLowerCase().includes(k);
  });
});
const colCount = computed(() => (isAdmin.value ? 6 : 4));
const isMe = (m: Member) => m.id === session.user?.id;
const scopeLabel = (m: Member) => (m.projectScope === "assigned" ? "指定项目" : "全部项目");
const ROLE_DESC: Record<TeamRole, string> = {
  editor: "新建项目、上传和更新设计稿",
  viewer: "查看设计稿和评论",
  admin: "拥有全部管理权限",
};
const ROLE_ORDER: TeamRole[] = ["editor", "viewer", "admin"];

async function load() {
  members.value = (await api<{ members: Member[] }>("GET", `/team/members${isAdmin.value ? "?all=1" : ""}`)).members;
}
async function reload() {
  loading.value = true;
  error.value = "";
  try {
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
function clearFilters() {
  q.value = "";
  roleFilter.value = "all";
}

// ── 添加成员 ──
const adding = ref(false);
const saving = ref(false);
const emptyForm = () => ({ username: "", displayName: "", email: "", role: "editor" as TeamRole, projectScope: "all" as "all" | "assigned" });
const form = ref(emptyForm());
const formError = ref("");
const issued = ref<{ name: string; username: string; password: string; reset: boolean } | null>(null);
function openAdd() {
  form.value = emptyForm();
  formError.value = "";
  adding.value = true;
}
async function add() {
  formError.value = "";
  saving.value = true;
  try {
    const res = await api<{ member: Member; initialPassword: string }>("POST", "/team/members", {
      username: form.value.username.trim(),
      displayName: form.value.displayName.trim(),
      email: form.value.email.trim(),
      role: form.value.role,
      projectScope: form.value.projectScope,
    });
    adding.value = false;
    issued.value = { name: res.member.displayName, username: res.member.username, password: res.initialPassword, reset: false };
    form.value = emptyForm();
    toast.success(`已添加成员「${res.member.displayName}」`);
    await load();
  } catch (e) {
    formError.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}

async function act(fn: () => Promise<unknown>, ok: string) {
  try {
    await fn();
    toast.success(ok);
  } catch (e) {
    toast.error((e as Error).message);
  }
  await load().catch((e) => toast.error((e as Error).message));
}

async function setRole(m: Member, el: HTMLSelectElement) {
  const role = el.value as TeamRole;
  if (role === m.role) return;
  if (role === "admin" || m.role === "admin") {
    const ok = await confirmDialog(
      role === "admin"
        ? { title: `把「${m.displayName}」设为管理员？`, message: "管理员可以管理成员、项目和团队设置，能看到全部项目。", confirmText: "设为管理员" }
        : { title: `取消「${m.displayName}」的管理员？`, message: `改为${ROLE_LABEL[role]}后，他将失去成员和团队设置的管理权限。`, confirmText: "确认修改" },
    );
    if (!ok) {
      el.value = m.role;
      return;
    }
  }
  await act(() => api("PATCH", `/team/members/${m.id}`, { role }), `已将「${m.displayName}」改为${ROLE_LABEL[role]}`);
}
async function remove(m: Member) {
  const ok = await confirmDialog({
    title: `移除「${m.displayName}」？`,
    message: "他会立即被登出，令牌全部失效；评论等记录保留，之后可以在「已停用」里恢复。",
    confirmText: "移除",
    danger: true,
  });
  if (ok) await act(() => api("DELETE", `/team/members/${m.id}`), `已移除「${m.displayName}」`);
}
const restore = (m: Member) => act(() => api("POST", `/team/members/${m.id}/restore`), `已恢复「${m.displayName}」`);
async function reset(m: Member) {
  const ok = await confirmDialog({
    title: `重置「${m.displayName}」的密码？`,
    message: "他会被立即登出，下次需要用新的初始密码登录并修改。",
    confirmText: "重置密码",
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await api<{ initialPassword: string }>("PATCH", `/team/members/${m.id}`, { resetPassword: true });
    issued.value = { name: m.displayName, username: m.username, password: res.initialPassword, reset: true };
    await load();
  } catch (e) {
    toast.error((e as Error).message);
  }
}

// ── 行内「…」菜单：fixed 定位，避免被表格的 overflow 裁掉 ──
const MENU_W = 188;
const menu = ref<{ member: Member; top: number; left: number } | null>(null);
const menuEl = ref<HTMLElement>();
/** 打开菜单的按钮：菜单关闭后焦点回到这里（键盘用户不会迷路） */
let menuTrigger: HTMLElement | null = null;
function openMenu(m: Member, e: MouseEvent) {
  if (menu.value?.member.id === m.id) {
    closeMenu();
    return;
  }
  menuTrigger = e.currentTarget as HTMLElement;
  const r = menuTrigger.getBoundingClientRect();
  const h = m.role === "admin" ? 92 : 128;
  const below = r.bottom + 4 + h < window.innerHeight;
  menu.value = { member: m, left: Math.max(8, r.right - MENU_W), top: below ? r.bottom + 4 : r.top - 4 - h };
  // 菜单在 body 末尾：把焦点移进去，↑ ↓ 切换、Esc / Tab 关闭
  void nextTick(() => menuEl.value?.querySelector<HTMLElement>(".menu-item")?.focus({ preventScroll: true }));
}
function runMenu(fn: (m: Member) => unknown) {
  const m = menu.value?.member;
  menu.value = null;
  if (m) void fn(m);
}
function closeMenu(restoreFocus = false) {
  if (!menu.value) return;
  menu.value = null;
  if (restoreFocus) menuTrigger?.focus();
}
function onMenuKey(e: KeyboardEvent) {
  const items = [...(menuEl.value?.querySelectorAll<HTMLElement>(".menu-item") ?? [])];
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus({ preventScroll: true });
  } else if (e.key === "Escape" || e.key === "Tab") {
    e.preventDefault();
    e.stopPropagation();
    closeMenu(true);
  }
}
function onDocDown(e: MouseEvent) {
  if (!menu.value) return;
  const t = e.target as HTMLElement;
  if (!t.closest(".row-menu") && !t.closest(".more-btn")) menu.value = null;
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") closeMenu(true);
}
const onScrollOrResize = () => closeMenu();

// ── 项目权限：这个人能看哪些项目、在每个项目里是什么权限 ──
interface ProjectAccess {
  id: string;
  name: string;
  archived: boolean;
  override: "editor" | "viewer" | "none" | null;
  effective: "editor" | "viewer" | "none";
}
const accessFor = ref<Member | null>(null);
const accessList = ref<ProjectAccess[]>([]);
const accessLoading = ref(false);
const accessBusy = ref("");
const EFFECTIVE = { editor: "可编辑", viewer: "只读", none: "看不到" } as const;
const EFFECTIVE_TAG = { editor: "", viewer: "gray", none: "red" } as const;
async function loadAccess(m: Member) {
  const res = await api<{ member: Member; projects: ProjectAccess[] }>("GET", `/team/members/${m.id}/projects`);
  accessFor.value = res.member;
  accessList.value = res.projects;
}
async function openAccess(m: Member) {
  accessFor.value = m;
  accessList.value = [];
  accessLoading.value = true;
  try {
    await loadAccess(m);
  } catch (e) {
    accessFor.value = null;
    toast.error((e as Error).message);
  } finally {
    accessLoading.value = false;
  }
}
async function setScope(scope: "all" | "assigned") {
  const m = accessFor.value!;
  if (m.projectScope === scope) return;
  accessBusy.value = "scope";
  try {
    await api("PATCH", `/team/members/${m.id}`, { projectScope: scope });
    await loadAccess(m);
    await load();
    toast.success(scope === "all" ? "已改为可见全部项目" : "已改为只看指定项目");
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    accessBusy.value = "";
  }
}
async function setProjectAccess(p: ProjectAccess, value: string) {
  const m = accessFor.value!;
  accessBusy.value = p.id;
  try {
    if (value === "inherit") await api("DELETE", `/admin/projects/${p.id}/members/${m.id}`);
    else await api("PUT", `/admin/projects/${p.id}/members/${m.id}`, { role: value });
    await loadAccess(m);
    toast.success(`已更新「${p.name}」的权限`);
  } catch (e) {
    toast.error((e as Error).message);
    await loadAccess(m).catch(() => undefined);
  } finally {
    accessBusy.value = "";
  }
}
const defaultLabel = computed(() =>
  accessFor.value?.projectScope === "assigned" ? "默认（看不到）" : `默认（${accessFor.value?.role === "editor" ? "可编辑" : "只读"}）`,
);
const visibleCount = computed(() => accessList.value.filter((p) => p.effective !== "none").length);

// ── 初始密码 ──
const showPw = ref(true);
const copied = ref("");
const copiedAny = ref(false);
const loginUrl = `${origin}/login`;
const loginText = computed(() => (issued.value ? `地址：${loginUrl}\n用户名：${issued.value.username}\n初始密码：${issued.value.password}` : ""));
async function copy(text: string, key: string) {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = key;
    if (key === "all" || key === "pw") copiedAny.value = true;
    window.setTimeout(() => {
      if (copied.value === key && key !== "all") copied.value = "";
    }, 1600);
    if (key === "all") toast.success("登录信息已复制");
  } catch {
    toast.error("复制失败，请手动选中复制");
  }
}
async function closeIssued() {
  if (confirmState.open) return; // Esc 同时会触发确认框的取消，这里忽略
  if (!copiedAny.value) {
    const ok = await confirmDialog({
      title: "还没有复制密码",
      message: "关闭后无法再查看这个初始密码，忘记了只能重新重置。",
      confirmText: "仍然关闭",
    });
    if (!ok) return;
  }
  issued.value = null;
}
watch(issued, () => {
  showPw.value = true;
  copied.value = "";
  copiedAny.value = false;
});

onMounted(() => {
  void reload();
  document.addEventListener("mousedown", onDocDown);
  window.addEventListener("keydown", onKey);
  window.addEventListener("resize", onScrollOrResize);
  window.addEventListener("scroll", onScrollOrResize, true);
});
onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDocDown);
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("resize", onScrollOrResize);
  window.removeEventListener("scroll", onScrollOrResize, true);
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>成员</h1>
        <div class="sub">
          <template v-if="loading">正在加载成员…</template>
          <template v-else><span class="num">{{ active.length }}</span> 名成员 · <span class="num">{{ adminCount }}</span> 名管理员</template>
        </div>
      </div>
      <div class="actions">
        <button v-if="isAdmin" class="primary" @click="openAdd"><UserPlus :size="15" />添加成员</button>
      </div>
    </div>

    <div class="toolbar">
      <div class="tabs filter-tabs" role="tablist" aria-label="按角色筛选">
        <button
          v-for="t in tabs"
          :key="t.key"
          class="tab"
          :class="{ active: roleFilter === t.key }"
          role="tab"
          :aria-selected="roleFilter === t.key"
          @click="roleFilter = t.key"
        >
          {{ t.label }} <span v-if="!loading" class="count">{{ t.count }}</span>
        </button>
      </div>
      <span class="spacer" />
      <div class="search-box">
        <Search :size="15" />
        <input v-model="q" placeholder="搜索姓名、用户名或邮箱" aria-label="搜索成员" />
        <button v-if="q" class="ghost sm icon-btn clear" aria-label="清空搜索" @click="q = ''"><X :size="14" /></button>
      </div>
    </div>

    <div v-if="error" class="load-error">
      <ShieldAlert :size="16" />
      <span>成员列表加载失败：{{ error }}</span>
      <span class="spacer" />
      <button class="sm" @click="reload">重试</button>
    </div>

    <div v-else class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>成员</th>
            <th class="c-role">角色</th>
            <th class="c-scope">可见项目</th>
            <th class="c-time">加入时间</th>
            <th v-if="isAdmin" class="c-time">最近登录</th>
            <th v-if="isAdmin" class="c-act"><span class="sr-only">操作</span></th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 6" :key="i" class="static-row">
            <td>
              <div class="user">
                <span class="skeleton sk-avatar" />
                <div class="sk-lines">
                  <span class="skeleton" style="width: 96px; height: 12px" />
                  <span class="skeleton" style="width: 168px; height: 10px" />
                </div>
              </div>
            </td>
            <td><span class="skeleton sk" style="width: 64px; height: 20px; border-radius: 999px" /></td>
            <td><span class="skeleton sk" style="width: 72px; height: 12px" /></td>
            <td><span class="skeleton sk" style="width: 56px; height: 12px" /></td>
            <td v-if="isAdmin"><span class="skeleton sk" style="width: 56px; height: 12px" /></td>
            <td v-if="isAdmin" />
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="m in shown" :key="m.id" :class="{ off: m.disabled }">
            <td>
              <div class="user">
                <Avatar :name="m.displayName" :size="32" class="av" />
                <div class="who">
                  <div class="n">
                    <span class="name truncate">{{ m.displayName }}</span>
                    <span v-if="isMe(m)" class="tag gray">我</span>
                    <span v-if="m.disabled" class="tag gray dot">已停用</span>
                    <span v-else-if="m.mustChangePassword" class="tag yellow" title="还没有用初始密码登录并改密码">待激活</span>
                  </div>
                  <div class="e truncate">
                    @{{ m.username }}<template v-if="m.email"> · {{ m.email }}</template>
                  </div>
                </div>
              </div>
            </td>
            <td class="c-role">
              <select
                v-if="isAdmin && !m.disabled && !isMe(m)"
                :value="m.role"
                class="role-select"
                :aria-label="`${m.displayName} 的角色`"
                @change="setRole(m, $event.target as HTMLSelectElement)"
              >
                <option value="admin">管理员</option>
                <option value="editor">编辑者</option>
                <option value="viewer">查看者</option>
              </select>
              <span v-else class="tag" :class="m.disabled ? 'gray' : ROLE_TAG[m.role]">{{ ROLE_LABEL[m.role] }}</span>
            </td>
            <td class="c-scope">
              <span v-if="m.role === 'admin'" class="scope muted"><Globe :size="14" />全部项目</span>
              <button v-else-if="isAdmin && !m.disabled" class="scope-btn" :title="`设置 ${m.displayName} 能看到的项目`" @click="openAccess(m)">
                <component :is="m.projectScope === 'assigned' ? FolderLock : Globe" :size="14" />
                {{ scopeLabel(m) }}
                <ChevronRight :size="14" class="chev" />
              </button>
              <span v-else class="scope muted">
                <component :is="m.projectScope === 'assigned' ? FolderLock : Globe" :size="14" />{{ scopeLabel(m) }}
              </span>
            </td>
            <td class="c-time muted" :title="formatTime(m.createdAt)">{{ relativeTime(m.createdAt) }}</td>
            <td v-if="isAdmin" class="c-time muted" :title="m.lastLoginAt ? formatTime(m.lastLoginAt) : '暂无有效会话（已登出或会话已过期）'">
              {{ m.lastLoginAt ? relativeTime(m.lastLoginAt) : "—" }}
            </td>
            <td v-if="isAdmin" class="c-act">
              <div v-if="!isMe(m)" class="row-actions">
                <button v-if="m.disabled" class="ghost sm" @click="restore(m)"><RotateCcw :size="14" />恢复</button>
                <button
                  v-else
                  class="ghost sm icon-btn more-btn"
                  :class="{ on: menu?.member.id === m.id }"
                  :aria-label="`${m.displayName} 的更多操作`"
                  aria-haspopup="menu"
                  :aria-expanded="menu?.member.id === m.id"
                  @click="openMenu(m, $event)"
                >
                  <MoreHorizontal :size="16" />
                </button>
              </div>
            </td>
          </tr>
          <tr v-if="!shown.length" class="static-row empty-row">
            <td :colspan="colCount">
              <EmptyState v-if="q.trim()" :icon="Search" title="没有匹配的成员" :hint="`没有找到包含「${q.trim()}」的成员，换个关键词试试。`">
                <button @click="clearFilters">清除筛选</button>
              </EmptyState>
              <EmptyState v-else-if="roleFilter === 'removed'" :icon="UserMinus" title="没有已停用的成员" hint="被移除的成员会出现在这里，可以随时恢复。" />
              <EmptyState v-else-if="roleFilter !== 'all'" :icon="Users" :title="`还没有${ROLE_LABEL[roleFilter]}`" hint="可以在成员的角色下拉里调整。">
                <button @click="roleFilter = 'all'">查看全部成员</button>
              </EmptyState>
              <EmptyState v-else :icon="Users" title="还没有成员" hint="添加同事后，他们就能登录查看项目和设计稿。">
                <button v-if="isAdmin" class="primary" @click="openAdd"><UserPlus :size="15" />添加成员</button>
              </EmptyState>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 行内菜单 -->
    <Teleport to="body">
      <div v-if="menu" ref="menuEl" class="popover row-menu" role="menu" @keydown="onMenuKey" :style="{ top: `${menu.top}px`, left: `${menu.left}px`, width: `${MENU_W}px` }">
        <button v-if="menu.member.role !== 'admin'" class="menu-item" role="menuitem" @click="runMenu(openAccess)"><FolderLock :size="15" />可见项目</button>
        <button class="menu-item" role="menuitem" @click="runMenu(reset)"><KeyRound :size="15" />重置密码</button>
        <div class="menu-sep" />
        <button class="menu-item danger" role="menuitem" @click="runMenu(remove)"><UserMinus :size="15" />移除成员</button>
      </div>
    </Teleport>

    <!-- 添加成员 -->
    <Modal v-if="adding" title="添加成员" :width="520" @close="adding = false">
      <form id="add-member-form" class="form" @submit.prevent="add">
        <div class="two">
          <label class="field">
            用户名
            <input v-model="form.username" maxlength="64" placeholder="例如 zhangsan" required autofocus autocomplete="off" />
            <span class="field-hint">登录时使用</span>
          </label>
          <label class="field">
            姓名
            <input v-model="form.displayName" maxlength="50" placeholder="例如 张三" autocomplete="off" />
            <span class="field-hint">显示在评论和成员列表里</span>
          </label>
        </div>
        <label class="field">
          <span>邮箱<span class="opt">可选</span></span>
          <input v-model="form.email" type="email" maxlength="200" placeholder="name@company.com" autocomplete="off" />
        </label>
        <div class="field-group" role="radiogroup" aria-label="角色">
          <div class="group-label">角色</div>
          <div class="choices">
            <label v-for="r in ROLE_ORDER" :key="r" class="choice" :class="{ on: form.role === r }">
              <input v-model="form.role" type="radio" name="role" :value="r" />
              <span class="c-title">{{ ROLE_LABEL[r] }}</span>
              <span class="c-desc">{{ ROLE_DESC[r] }}</span>
            </label>
          </div>
        </div>
        <label class="field">
          可见项目
          <select v-model="form.projectScope" :disabled="form.role === 'admin'">
            <option value="all">全部项目（包括之后新建的）</option>
            <option value="assigned">指定项目（创建后在「可见项目」里分配）</option>
          </select>
          <span class="field-hint">{{ form.role === "admin" ? "管理员始终能看到全部项目" : "创建后会生成初始密码，对方首次登录时需要修改" }}</span>
        </label>
        <p v-if="formError" class="error">{{ formError }}</p>
      </form>
      <template #footer>
        <button type="button" @click="adding = false">取消</button>
        <button type="submit" form="add-member-form" class="primary" :disabled="saving">{{ saving ? "创建中…" : "创建账号" }}</button>
      </template>
    </Modal>

    <!-- 可见项目 -->
    <Modal v-if="accessFor" :title="`${accessFor.displayName} 的可见项目`" :width="560" @close="accessFor = null">
      <div class="choices two-col" role="radiogroup" aria-label="默认可见范围">
        <label class="choice" :class="{ on: accessFor.projectScope === 'all' }">
          <input type="radio" :checked="accessFor.projectScope === 'all'" :disabled="!!accessBusy || accessLoading" @change="setScope('all')" />
          <span class="c-title"><Globe :size="15" />全部项目</span>
          <span class="c-desc">按角色（{{ ROLE_LABEL[accessFor.role] }}）访问，之后新建的项目也能看到</span>
        </label>
        <label class="choice" :class="{ on: accessFor.projectScope === 'assigned' }">
          <input type="radio" :checked="accessFor.projectScope === 'assigned'" :disabled="!!accessBusy || accessLoading" @change="setScope('assigned')" />
          <span class="c-title"><FolderLock :size="15" />指定项目</span>
          <span class="c-desc">适合外包、临时协作的同事；只能看到下面单独开放的项目</span>
        </label>
      </div>

      <div class="plist-head">
        <span>单个项目设置 <span class="muted">· 优先于上面的默认</span></span>
        <span v-if="!accessLoading && accessList.length" class="muted num">可见 {{ visibleCount }} / {{ accessList.length }}</span>
      </div>
      <div class="plist">
        <template v-if="accessLoading">
          <div v-for="i in 4" :key="i" class="prow">
            <span class="skeleton" style="width: 140px; height: 12px" />
            <span class="spacer" />
            <span class="skeleton" style="width: 140px; height: 28px" />
          </div>
        </template>
        <template v-else>
          <div v-for="p in accessList" :key="p.id" class="prow" :class="{ busy: accessBusy === p.id }">
            <span class="pname">
              <span class="truncate">{{ p.name }}</span>
              <span v-if="p.archived" class="tag gray">已归档</span>
            </span>
            <span class="tag dot" :class="EFFECTIVE_TAG[p.effective]">{{ EFFECTIVE[p.effective] }}</span>
            <select
              :value="p.override ?? 'inherit'"
              class="psel"
              :disabled="!!accessBusy"
              :aria-label="`${p.name} 的权限`"
              @change="setProjectAccess(p, ($event.target as HTMLSelectElement).value)"
            >
              <option value="inherit">{{ defaultLabel }}</option>
              <option value="editor">可编辑</option>
              <option value="viewer">只读</option>
              <option value="none">看不到</option>
            </select>
          </div>
          <EmptyState v-if="!accessList.length" title="还没有项目" hint="新建项目后可以在这里单独设置权限。" />
        </template>
      </div>
      <template #footer>
        <button class="primary" @click="accessFor = null">完成</button>
      </template>
    </Modal>

    <!-- 初始密码 -->
    <Modal v-if="issued" :title="issued.reset ? '密码已重置' : '成员已创建'" :width="460" @close="closeIssued">
      <p class="issued-lead">
        把下面的登录信息发给 <b>{{ issued.name }}</b>，对方首次登录后需要修改密码。
      </p>
      <div class="cred">
        <div class="cred-row">
          <span class="k">登录地址</span>
          <span class="v mono truncate">{{ loginUrl }}</span>
          <button class="ghost sm icon-btn" aria-label="复制登录地址" @click="copy(loginUrl, 'url')">
            <Check v-if="copied === 'url'" :size="14" class="ok" /><Copy v-else :size="14" />
          </button>
        </div>
        <div class="cred-row">
          <span class="k">用户名</span>
          <span class="v mono truncate">{{ issued.username }}</span>
          <button class="ghost sm icon-btn" aria-label="复制用户名" @click="copy(issued.username, 'user')">
            <Check v-if="copied === 'user'" :size="14" class="ok" /><Copy v-else :size="14" />
          </button>
        </div>
        <div class="cred-row">
          <span class="k">初始密码</span>
          <span class="v mono pw">{{ showPw ? issued.password : "•".repeat(Math.min(issued.password.length, 16)) }}</span>
          <button class="ghost sm icon-btn" :aria-label="showPw ? '隐藏密码' : '显示密码'" @click="showPw = !showPw">
            <EyeOff v-if="showPw" :size="14" /><Eye v-else :size="14" />
          </button>
          <button class="ghost sm icon-btn" aria-label="复制密码" @click="copy(issued.password, 'pw')">
            <Check v-if="copied === 'pw'" :size="14" class="ok" /><Copy v-else :size="14" />
          </button>
        </div>
      </div>
      <div class="once">
        <ShieldAlert :size="15" />
        <span>密码只显示这一次，关闭后无法再查看；忘记了只能重新重置。</span>
      </div>
      <template #footer>
        <button @click="closeIssued">{{ copiedAny ? "完成" : "关闭" }}</button>
        <button class="primary" @click="copy(loginText, 'all')">
          <Check v-if="copied === 'all'" :size="15" /><Copy v-else :size="15" />{{ copied === "all" ? "已复制" : "复制登录信息" }}
        </button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.num {
  font-variant-numeric: tabular-nums;
}
.toolbar {
  gap: 12px;
}
.filter-tabs {
  margin-bottom: 0;
}
.search-box .clear {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  color: var(--muted);
}

.load-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-radius: var(--radius);
  background: var(--danger-soft);
  color: var(--danger);
}

/* 表格列 */
td {
  height: 56px;
}
.c-role {
  width: 132px;
}
.c-scope {
  width: 148px;
}
.c-time {
  width: 112px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
td.c-time {
  font-size: 12px;
}
.c-act {
  width: 72px;
  text-align: right;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}

.user {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.who {
  min-width: 0;
}
.n {
  display: flex;
  gap: 8px;
  align-items: center;
  min-width: 0;
}
.name {
  font-weight: 600;
}
.e {
  margin-top: 2px;
  font-size: 12px;
  color: var(--muted);
  max-width: 360px;
}

/* 角色下拉：平时像文字，悬停才显出控件 */
.role-select {
  height: 28px;
  width: 104px;
  padding-left: 8px;
  margin-left: -8px;
  font-size: 12px;
  background-color: transparent;
  border-color: transparent;
  box-shadow: none;
}
.role-select:hover,
.role-select:focus {
  background-color: var(--panel);
  border-color: var(--border-strong);
}

.scope {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
.scope-btn {
  height: 28px;
  gap: 6px;
  padding: 0 4px 0 8px;
  margin-left: -8px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-2);
  border-color: transparent;
  background: none;
  box-shadow: none;
}
.scope-btn:hover:not(:disabled) {
  background: var(--hover);
  color: var(--text);
}
.scope-btn .chev {
  color: var(--faint);
}

.more-btn.on {
  background: var(--active);
  opacity: 1;
}
.row-actions .ghost.sm:not(.icon-btn) {
  gap: 4px;
}

/* 已停用：降低对比，但仍可读 */
tr.off .av {
  filter: grayscale(1);
  opacity: 0.45;
}
tr.off .name {
  color: var(--text-2);
  font-weight: 500;
}
tr.off .c-role .tag {
  opacity: 0.7;
}
tr.off td .row-actions {
  opacity: 1;
}

/* 骨架、空状态行 */
tbody tr.static-row:hover {
  background: none;
}
.sk-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  flex-shrink: 0;
}
.sk-lines {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sk-lines .skeleton,
.sk {
  display: block;
}
.empty-row td {
  height: auto;
  padding: 0;
}

/* 行内菜单 */
.row-menu {
  position: fixed;
  z-index: 60;
}

/* 添加成员表单 */
.form {
  display: flex;
  flex-direction: column;
}
.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.opt {
  margin-left: 4px;
  color: var(--muted);
  font-weight: 400;
}
.field-group {
  margin-bottom: 12px;
}
.group-label {
  margin-bottom: 6px;
  font-size: 12px;
  font-weight: 550;
  color: var(--text-2);
}
.choices {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}
.choices.two-col {
  grid-template-columns: 1fr 1fr;
}
.choice {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--panel);
  cursor: pointer;
  transition:
    border-color 0.12s var(--ease),
    background 0.12s var(--ease),
    box-shadow 0.12s var(--ease);
}
.choice:hover {
  border-color: var(--faint);
}
.choice.on {
  border-color: var(--brand);
  background: var(--brand-soft);
}
.choice:focus-within {
  box-shadow: var(--ring);
}
.choice input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
.c-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.choice.on .c-title {
  color: var(--brand);
}
.c-desc {
  font-size: 12px;
  line-height: 1.5;
  color: var(--muted);
}

/* 可见项目 */
.plist-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 20px 0 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}
.plist-head .muted {
  font-weight: 400;
}
.plist {
  display: flex;
  flex-direction: column;
  max-height: 44vh;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.prow {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 8px 8px 12px;
  border-bottom: 1px solid var(--border);
  transition: opacity 0.12s var(--ease);
}
.prow:last-child {
  border-bottom: none;
}
.prow.busy {
  opacity: 0.6;
}
.pname {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 550;
}
.prow .psel {
  width: 140px;
  height: 28px;
  font-size: 12px;
  flex-shrink: 0;
}
.plist :deep(.empty) {
  padding: 32px 16px;
}

/* 初始密码 */
.issued-lead {
  margin: 0 0 12px;
  color: var(--text-2);
  line-height: 1.6;
}
.cred {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
}
.cred-row {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 44px;
  padding: 0 8px 0 12px;
  border-bottom: 1px solid var(--border);
}
.cred-row:last-child {
  border-bottom: none;
}
.cred-row .k {
  width: 64px;
  flex-shrink: 0;
  font-size: 12px;
  color: var(--muted);
}
.cred-row .v {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--text);
}
.cred-row .pw {
  font-weight: 600;
  letter-spacing: 0.04em;
  user-select: all;
}
.cred-row .ok {
  color: var(--ok);
}
.once {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 12px;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  background: var(--warning-soft);
  color: var(--warning);
  font-size: 12px;
  line-height: 1.6;
}
.once svg {
  flex-shrink: 0;
  margin-top: 2px;
}

@media (max-width: 720px) {
  .two,
  .choices,
  .choices.two-col {
    grid-template-columns: 1fr;
  }
  .search-box {
    width: 100%;
  }
}
</style>
