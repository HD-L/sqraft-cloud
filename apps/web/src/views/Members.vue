<script setup lang="ts">
/**
 * 人员管理（E2–E5）：成员列表、按姓名搜索、按角色筛选；管理员可添加成员（直接建账号，给初始密码）、
 * 改角色、设置能看哪些项目、重置密码、移除（停用账号，可恢复）。
 */
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { api, formatTime, relativeTime, ROLE_LABEL, ROLE_TAG, session, type TeamRole } from "../api";
import Avatar from "../components/Avatar.vue";
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

const route = useRoute();
const members = ref<Member[]>([]);
const q = ref(typeof route.query.q === "string" ? route.query.q : "");
const roleFilter = ref<TeamRole | "all" | "removed">("all");
const error = ref("");
const isAdmin = computed(() => session.user?.isAdmin === true);
const origin = window.location.origin;
const active = computed(() => members.value.filter((m) => !m.disabled));
const shown = computed(() => {
  const k = q.value.trim().toLowerCase();
  return members.value.filter((m) => {
    if (roleFilter.value === "removed" ? !m.disabled : m.disabled) return false;
    if (roleFilter.value !== "all" && roleFilter.value !== "removed" && m.role !== roleFilter.value) return false;
    return !k || m.displayName.toLowerCase().includes(k) || m.username.toLowerCase().includes(k) || m.email.toLowerCase().includes(k);
  });
});

async function load() {
  members.value = (await api<{ members: Member[] }>("GET", `/team/members${isAdmin.value ? "?all=1" : ""}`)).members;
}

// ── 添加成员 ──
const adding = ref(false);
const form = ref({ username: "", displayName: "", email: "", role: "editor" as TeamRole, projectScope: "all" as "all" | "assigned" });
const formError = ref("");
const issued = ref<{ name: string; username: string; password: string } | null>(null);
async function add() {
  formError.value = "";
  try {
    const res = await api<{ member: Member; initialPassword: string }>("POST", "/team/members", {
      username: form.value.username.trim(),
      displayName: form.value.displayName.trim(),
      email: form.value.email.trim(),
      role: form.value.role,
      projectScope: form.value.projectScope,
    });
    adding.value = false;
    issued.value = { name: res.member.displayName, username: res.member.username, password: res.initialPassword };
    form.value = { username: "", displayName: "", email: "", role: "editor", projectScope: "all" };
    await load();
  } catch (e) {
    formError.value = (e as Error).message;
  }
}

async function act(fn: () => Promise<unknown>) {
  error.value = "";
  try {
    await fn();
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

const setRole = (m: Member, role: TeamRole) => act(() => api("PATCH", `/team/members/${m.id}`, { role }));
const remove = (m: Member) =>
  confirm(`移除「${m.displayName}」？他会立即被登出、令牌全部失效；评论等记录保留，之后可以恢复。`) && act(() => api("DELETE", `/team/members/${m.id}`));
const restore = (m: Member) => act(() => api("POST", `/team/members/${m.id}/restore`));
async function reset(m: Member) {
  if (!confirm(`重置「${m.displayName}」的密码？他会被登出，下次用新的初始密码登录并修改。`)) return;
  try {
    const res = await api<{ initialPassword: string }>("PATCH", `/team/members/${m.id}`, { resetPassword: true });
    issued.value = { name: m.displayName, username: m.username, password: res.initialPassword };
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

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
const EFFECTIVE = { editor: "可编辑", viewer: "只读", none: "看不到" } as const;
async function loadAccess(m: Member) {
  const res = await api<{ member: Member; projects: ProjectAccess[] }>("GET", `/team/members/${m.id}/projects`);
  accessFor.value = res.member;
  accessList.value = res.projects;
}
async function openAccess(m: Member) {
  error.value = "";
  await loadAccess(m).catch((e) => (error.value = (e as Error).message));
}
async function setScope(scope: "all" | "assigned") {
  const m = accessFor.value!;
  await api("PATCH", `/team/members/${m.id}`, { projectScope: scope });
  await loadAccess(m);
  await load();
}
async function setProjectAccess(p: ProjectAccess, value: string) {
  const m = accessFor.value!;
  if (value === "inherit") await api("DELETE", `/admin/projects/${p.id}/members/${m.id}`);
  else await api("PUT", `/admin/projects/${p.id}/members/${m.id}`, { role: value });
  await loadAccess(m);
}
const defaultLabel = computed(() =>
  accessFor.value?.projectScope === "assigned" ? "默认（看不到）" : `默认（${accessFor.value?.role === "editor" ? "可编辑" : "只读"}）`,
);

async function copy(text: string) {
  await navigator.clipboard.writeText(text);
}

onMounted(() => void load().catch((e) => (error.value = (e as Error).message)));
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>人员管理</h1>
        <div class="sub">共 {{ active.length }} 名成员 · {{ active.filter((m) => m.role === "admin").length }} 名管理员</div>
      </div>
      <div class="actions">
        <button v-if="isAdmin" class="primary" @click="adding = true">＋ 添加成员</button>
      </div>
    </div>

    <div class="toolbar">
      <div class="search-box"><span>🔍</span><input v-model="q" placeholder="搜索姓名、用户名或邮箱" /></div>
      <span class="spacer" />
      <select v-model="roleFilter" aria-label="按角色筛选">
        <option value="all">全部角色</option>
        <option value="admin">管理员</option>
        <option value="editor">编辑者</option>
        <option value="viewer">查看者</option>
        <option v-if="isAdmin" value="removed">已移除</option>
      </select>
    </div>
    <p v-if="error" class="error">{{ error }}</p>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>成员</th><th>角色</th><th>可见项目</th><th>加入时间</th><th v-if="isAdmin">最近登录</th><th v-if="isAdmin">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in shown" :key="m.id">
            <td>
              <div class="user">
                <Avatar :name="m.displayName" :size="34" />
                <div>
                  <div class="n">
                    {{ m.displayName }}
                    <span v-if="m.id === session.user?.id" class="tag gray">我</span>
                    <span v-if="m.mustChangePassword && !m.disabled" class="tag yellow" title="还没有用初始密码登录并改密码">待激活</span>
                  </div>
                  <div class="e">@{{ m.username }}{{ m.email ? ` · ${m.email}` : "" }}</div>
                </div>
              </div>
            </td>
            <td>
              <select v-if="isAdmin && !m.disabled && m.id !== session.user?.id" :value="m.role" class="role" @change="setRole(m, ($event.target as HTMLSelectElement).value as TeamRole)">
                <option value="admin">管理员</option>
                <option value="editor">编辑者</option>
                <option value="viewer">查看者</option>
              </select>
              <span v-else class="tag" :class="m.disabled ? 'gray' : ROLE_TAG[m.role]">{{ m.disabled ? "已移除" : ROLE_LABEL[m.role] }}</span>
            </td>
            <td>
              <span v-if="m.role === 'admin'" class="muted">全部（管理员）</span>
              <button v-else-if="isAdmin && !m.disabled" class="link" @click="openAccess(m)">{{ m.projectScope === "assigned" ? "仅分配的项目" : "全部项目" }} ›</button>
              <span v-else class="muted">{{ m.projectScope === "assigned" ? "仅分配的项目" : "全部项目" }}</span>
            </td>
            <td class="muted" :title="formatTime(m.createdAt)">{{ relativeTime(m.createdAt) }}</td>
            <td v-if="isAdmin" class="muted">{{ m.lastLoginAt ? relativeTime(m.lastLoginAt) : "—" }}</td>
            <td v-if="isAdmin">
              <template v-if="m.id !== session.user?.id">
                <template v-if="!m.disabled">
                  <button class="link" @click="reset(m)">重置密码</button>
                  &nbsp;&nbsp;<button class="link danger" @click="remove(m)">移除</button>
                </template>
                <button v-else class="link" @click="restore(m)">恢复</button>
              </template>
            </td>
          </tr>
          <tr v-if="!shown.length"><td :colspan="isAdmin ? 6 : 4" class="empty">没有匹配的成员</td></tr>
        </tbody>
      </table>
    </div>

    <Modal v-if="adding" title="添加成员" @close="adding = false">
      <form @submit.prevent="add">
        <label class="field">用户名（登录用）<input v-model="form.username" maxlength="64" placeholder="例如 zhangsan" required autofocus /></label>
        <label class="field">姓名<input v-model="form.displayName" maxlength="50" placeholder="显示在评论、成员列表里" /></label>
        <label class="field">邮箱（可选）<input v-model="form.email" type="email" maxlength="200" placeholder="name@company.com" /></label>
        <label class="field">
          角色
          <select v-model="form.role">
            <option value="editor">编辑者 — 可新建项目、上传和更新设计稿</option>
            <option value="viewer">查看者 — 可查看和评论</option>
            <option value="admin">管理员 — 拥有全部管理权限</option>
          </select>
        </label>
        <label class="field">
          可见项目
          <select v-model="form.projectScope" :disabled="form.role === 'admin'">
            <option value="all">所有项目（之后新建的项目也能看到）</option>
            <option value="assigned">只看分配的项目（建好后在「可见项目」里勾选）</option>
          </select>
        </label>
        <p v-if="formError" class="error">{{ formError }}</p>
        <button class="primary" style="width: 100%">创建账号</button>
        <p class="muted" style="font-size: 12px; margin-bottom: 0">创建后会生成一个初始密码，请发给对方；对方首次登录时必须改成自己的密码。</p>
      </form>
    </Modal>

    <Modal v-if="accessFor" :title="`${accessFor.displayName} 的可见项目`" :width="560" @close="accessFor = null">
      <div class="scope">
        <label>
          <input type="radio" :checked="accessFor.projectScope === 'all'" @change="setScope('all')" />
          <span><b>所有项目</b><span class="muted">按角色（{{ ROLE_LABEL[accessFor.role] }}）访问，之后新建的项目也能看到</span></span>
        </label>
        <label>
          <input type="radio" :checked="accessFor.projectScope === 'assigned'" @change="setScope('assigned')" />
          <span><b>只看分配的项目</b><span class="muted">适合外包、临时协作的同事；下面设为「可编辑」或「只读」的项目才能看到，新项目默认看不到</span></span>
        </label>
      </div>
      <p class="muted" style="font-size: 12px">可以对单个项目单独设置，优先于上面的默认：</p>
      <div class="plist">
        <div v-for="p in accessList" :key="p.id" class="prow">
          <span class="pname">{{ p.name }} <span v-if="p.archived" class="tag gray">已归档</span></span>
          <span class="tag" :class="{ gray: p.effective === 'viewer', red: p.effective === 'none' }">{{ EFFECTIVE[p.effective] }}</span>
          <select :value="p.override ?? 'inherit'" style="width: 140px" @change="setProjectAccess(p, ($event.target as HTMLSelectElement).value)">
            <option value="inherit">{{ defaultLabel }}</option>
            <option value="editor">可编辑</option>
            <option value="viewer">只读</option>
            <option value="none">看不到</option>
          </select>
        </div>
        <p v-if="!accessList.length" class="muted">还没有项目</p>
      </div>
    </Modal>

    <Modal v-if="issued" title="初始密码" @close="issued = null">
      <p style="margin-top: 0">把下面的登录信息发给 <b>{{ issued.name }}</b>。密码只显示这一次。</p>
      <pre class="code">地址：{{ `${origin}/login` }}
用户名：{{ issued.username }}
初始密码：{{ issued.password }}</pre>
      <button class="primary" style="width: 100%" @click="copy(`地址：${origin}/login\n用户名：${issued.username}\n初始密码：${issued.password}`)">复制登录信息</button>
    </Modal>
  </div>
</template>

<style scoped>
.user {
  display: flex;
  align-items: center;
  gap: 10px;
}
.n {
  font-weight: 600;
  display: flex;
  gap: 6px;
  align-items: center;
}
.e {
  font-size: 12px;
  color: var(--muted);
}
.role {
  padding: 3px 8px;
  font-size: 12px;
}
.scope {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: var(--bg);
  border-radius: var(--radius-sm);
}
.scope label {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  cursor: pointer;
}
.scope input {
  margin-top: 3px;
}
.scope label > span {
  display: flex;
  flex-direction: column;
}
.scope .muted {
  font-size: 12px;
}
.plist {
  display: flex;
  flex-direction: column;
  max-height: 50vh;
  overflow-y: auto;
}
.prow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}
.prow:last-child {
  border-bottom: none;
}
.pname {
  flex: 1;
  min-width: 0;
  font-weight: 600;
}
</style>
