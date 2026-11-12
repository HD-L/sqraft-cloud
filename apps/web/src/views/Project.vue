<script setup lang="ts">
/**
 * 项目详情（C2）：设计稿列表，可按状态筛选、搜索，网格 / 列表两种视图；
 * 编辑者可新建设计稿、改项目信息、删除设计稿；管理员可设置每个成员在这个项目里的权限、归档项目。
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  FileStack,
  LayoutGrid,
  List,
  Lock,
  MessageSquare,
  Pencil,
  Plus,
  RotateCw,
  Search,
  SearchX,
  Trash2,
  Users,
} from "lucide-vue-next";
import { api, formatTime, relativeTime, ROLE_LABEL, session, STATUS_LABEL, STATUS_TAG, type DesignStatus, type TeamRole } from "../api";
import { confirmDialog, toast } from "../ui";
import Avatar from "../components/Avatar.vue";
import DesignCover from "../components/DesignCover.vue";
import EmptyState from "../components/EmptyState.vue";
import Modal from "../components/Modal.vue";

const props = defineProps<{ id: string }>();
const router = useRouter();

interface Design {
  id: string;
  name: string;
  status: DesignStatus;
  currentVersion: number | null;
  latestVersion: number | null;
  pageCount: number;
  createdBy: string | null;
  commentCount: number;
  updatedAt: number;
}
interface Project {
  id: string;
  name: string;
  description: string;
  role: "editor" | "viewer";
  archived: boolean;
  designCount: number;
  createdBy?: string | null;
  updatedAt?: number;
}

const STATUSES: DesignStatus[] = ["draft", "review", "published"];

const project = ref<Project | null>(null);
const designs = ref<Design[]>([]);
const loading = ref(true);
const status = ref<DesignStatus | "all">("all");
const query = ref("");
const error = ref("");
const canEdit = computed(() => project.value?.role === "editor" && !project.value.archived);
const isAdmin = computed(() => session.user?.isAdmin === true);
const shown = computed(() =>
  designs.value.filter((d) => (status.value === "all" || d.status === status.value) && d.name.toLowerCase().includes(query.value.trim().toLowerCase())),
);
const countOf = (s: DesignStatus) => designs.value.filter((d) => d.status === s).length;
const filtered = computed(() => status.value !== "all" || query.value.trim() !== "");
function clearFilters() {
  status.value = "all";
  query.value = "";
}

// 视图：网格 / 列表，记住上次的选择
const VIEW_KEY = "sqraft.project.view";
const view = ref<"grid" | "list">(localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid");
watch(view, (v) => localStorage.setItem(VIEW_KEY, v));

async function load() {
  error.value = "";
  try {
    project.value = (await api<{ project: Project }>("GET", `/projects/${props.id}`)).project;
    designs.value = (await api<{ designs: Design[] }>("GET", `/projects/${props.id}/designs`)).designs;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
async function reload() {
  loading.value = true;
  await load();
}

const open = (d: Design) => router.push(`/designs/${d.id}`);

// ── 新建设计稿：建好后进详情页直接上传 ──
const creating = ref(false);
const newName = ref("");
const modalError = ref("");
const saving = ref(false);
function openCreate() {
  newName.value = "";
  modalError.value = "";
  creating.value = true;
}
async function create() {
  if (!newName.value.trim() || saving.value) return;
  modalError.value = "";
  saving.value = true;
  try {
    const res = await api<{ design: Design }>("POST", `/projects/${props.id}/designs`, { name: newName.value.trim() });
    toast.success("设计稿已创建");
    await router.push(`/designs/${res.design.id}`);
  } catch (e) {
    modalError.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}

// ── 编辑项目 ──
const editing = ref(false);
const editForm = ref({ name: "", description: "" });
function openEdit() {
  editForm.value = { name: project.value!.name, description: project.value!.description };
  modalError.value = "";
  editing.value = true;
}
async function saveEdit() {
  if (!editForm.value.name.trim() || saving.value) return;
  modalError.value = "";
  saving.value = true;
  try {
    project.value = (
      await api<{ project: Project }>("PATCH", `/projects/${props.id}`, { name: editForm.value.name.trim(), description: editForm.value.description.trim() })
    ).project;
    editing.value = false;
    toast.success("项目信息已保存");
  } catch (e) {
    modalError.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}

const archiving = ref(false);
async function toggleArchive() {
  const archived = !project.value!.archived;
  if (
    archived &&
    !(await confirmDialog({
      title: `归档项目「${project.value!.name}」？`,
      message: "归档后项目变为只读：不能再上传、改名或删除设计稿。之后可以随时取消归档。",
      confirmText: "归档",
      danger: true,
    }))
  )
    return;
  archiving.value = true;
  try {
    await api("PATCH", `/admin/projects/${props.id}`, { archived });
    await load();
    toast.success(archived ? "项目已归档" : "已取消归档");
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    archiving.value = false;
  }
}

async function remove(d: Design) {
  const ok = await confirmDialog({
    title: `删除设计稿「${d.name}」？`,
    message: "删除后进入回收站，管理员可在保留期内恢复。",
    confirmText: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    await api("DELETE", `/designs/${d.id}`);
    designs.value = designs.value.filter((x) => x.id !== d.id);
    toast.success("已移到回收站");
  } catch (e) {
    toast.error((e as Error).message);
  }
}

// ── 成员权限（管理员）──
interface Access {
  id: string;
  username: string;
  displayName: string;
  role: TeamRole;
  projectScope: "all" | "assigned";
  override: "editor" | "viewer" | "none" | null;
  effective: "editor" | "viewer" | "none";
}
const accessOpen = ref(false);
const access = ref<Access[]>([]);
const accessLoading = ref(false);
const accessError = ref("");
const accessQuery = ref("");
const accessBusy = ref<string | null>(null);
const accessShown = computed(() => {
  const q = accessQuery.value.trim().toLowerCase();
  return q ? access.value.filter((m) => m.displayName.toLowerCase().includes(q) || m.username.toLowerCase().includes(q)) : access.value;
});
async function fetchAccess() {
  access.value = (await api<{ members: Access[] }>("GET", `/projects/${props.id}/access`)).members;
}
async function openAccess() {
  accessOpen.value = true;
  accessQuery.value = "";
  accessError.value = "";
  accessLoading.value = true;
  try {
    await fetchAccess();
  } catch (e) {
    accessError.value = (e as Error).message;
  } finally {
    accessLoading.value = false;
  }
}
async function setOverride(m: Access, value: string) {
  accessBusy.value = m.id;
  try {
    if (value === "inherit") await api("DELETE", `/admin/projects/${props.id}/members/${m.id}`);
    else await api("PUT", `/admin/projects/${props.id}/members/${m.id}`, { role: value });
    await fetchAccess();
    toast.success(`已更新 ${m.displayName} 的权限`);
  } catch (e) {
    toast.error((e as Error).message);
    await fetchAccess().catch(() => undefined);
  } finally {
    accessBusy.value = null;
  }
}
const EFFECTIVE = { editor: "可编辑", viewer: "只读", none: "看不到" } as const;
const EFFECTIVE_TAG = { editor: "", viewer: "gray", none: "red" } as const;

onMounted(load);
// 从一个项目直接跳到另一个项目（命令面板、通知）时组件会被复用：清掉旧数据重新加载
watch(
  () => props.id,
  () => {
    project.value = null;
    designs.value = [];
    void load();
  },
);
</script>

<template>
  <div class="page">
    <nav class="breadcrumb">
      <RouterLink to="/">项目</RouterLink>
      <ChevronRight :size="14" class="sep" />
      <span v-if="project" class="current truncate">{{ project.name }}</span>
      <span v-else-if="loading" class="skeleton crumb-sk" />
    </nav>

    <!-- 加载中 -->
    <template v-if="loading && !project">
      <div class="page-head">
        <div class="head-main">
          <div class="skeleton" style="width: 220px; height: 24px" />
          <div class="skeleton" style="width: 320px; height: 14px; margin-top: 12px" />
        </div>
      </div>
      <div class="skeleton" style="width: 100%; height: 32px; margin-bottom: 16px" />
      <div class="design-grid">
        <div v-for="i in 8" :key="i" class="dcard sk">
          <div class="skeleton cover-sk" />
          <div class="dbody">
            <div class="skeleton" style="width: 60%; height: 14px" />
            <div class="skeleton" style="width: 40%; height: 12px; margin-top: 8px" />
          </div>
        </div>
      </div>
    </template>

    <!-- 加载失败 -->
    <div v-else-if="error && !project" class="card empty-card">
      <EmptyState :icon="SearchX" title="项目加载失败" :hint="error">
        <button @click="reload"><RotateCw :size="15" />重试</button>
        <RouterLink to="/" class="button ghost">返回项目列表</RouterLink>
      </EmptyState>
    </div>

    <template v-else-if="project">
      <header class="page-head">
        <div class="head-main">
          <div class="title-row">
            <h1 class="truncate">{{ project.name }}</h1>
            <span v-if="project.archived" class="tag gray"><Archive :size="12" />已归档</span>
            <span v-else-if="project.role === 'viewer'" class="tag gray"><Lock :size="12" />只读</span>
          </div>
          <p class="desc" :class="{ none: !project.description }">{{ project.description || "暂无描述" }}</p>
          <div class="meta">
            <span>{{ designs.length }} 个设计稿</span>
            <template v-if="project.createdBy">
              <span class="dot-sep" />
              <span class="row" style="gap: 6px"><Avatar :name="project.createdBy" :size="16" />{{ project.createdBy }} 创建</span>
            </template>
            <template v-if="project.updatedAt">
              <span class="dot-sep" />
              <span :title="formatTime(project.updatedAt)">{{ relativeTime(project.updatedAt) }}更新</span>
            </template>
          </div>
        </div>
        <div class="actions">
          <button v-if="isAdmin" @click="openAccess"><Users :size="15" />成员权限</button>
          <button v-if="canEdit" @click="openEdit"><Pencil :size="15" />编辑项目</button>
          <button v-if="isAdmin" :disabled="archiving" @click="toggleArchive">
            <component :is="project.archived ? ArchiveRestore : Archive" :size="15" />{{ project.archived ? "取消归档" : "归档" }}
          </button>
          <button v-if="canEdit" class="primary" @click="openCreate"><Plus :size="15" />新建设计稿</button>
        </div>
      </header>

      <div v-if="project.archived" class="archived-bar">
        <Archive :size="16" />
        <span>这个项目已归档，只能查看，不能上传、改名或删除设计稿。</span>
        <span class="spacer" />
        <button v-if="isAdmin" class="sm" :disabled="archiving" @click="toggleArchive"><ArchiveRestore :size="14" />取消归档</button>
      </div>

      <p v-if="error" class="error">{{ error }}</p>

      <div class="toolbar">
        <div class="tabs">
          <button class="tab" :class="{ active: status === 'all' }" @click="status = 'all'">全部 <span class="count">{{ designs.length }}</span></button>
          <button v-for="s in STATUSES" :key="s" class="tab" :class="{ active: status === s }" @click="status = s">
            {{ STATUS_LABEL[s] }} <span class="count">{{ countOf(s) }}</span>
          </button>
        </div>
        <span class="spacer" />
        <div class="search-box">
          <Search :size="15" />
          <input v-model="query" placeholder="搜索设计稿" aria-label="搜索设计稿" @keydown.esc="query = ''" />
        </div>
        <div class="segmented" role="group" aria-label="视图">
          <button :class="{ active: view === 'grid' }" title="网格" aria-label="网格视图" @click="view = 'grid'"><LayoutGrid :size="15" /></button>
          <button :class="{ active: view === 'list' }" title="列表" aria-label="列表视图" @click="view = 'list'"><List :size="15" /></button>
        </div>
      </div>

      <!-- 空 -->
      <div v-if="!shown.length" class="card empty-card">
        <EmptyState v-if="designs.length" :icon="SearchX" title="没有匹配的设计稿" hint="换个关键词，或者清除筛选条件再看看。">
          <button v-if="filtered" @click="clearFilters">清除筛选</button>
        </EmptyState>
        <EmptyState
          v-else
          :icon="FileStack"
          title="还没有设计稿"
          :hint="canEdit ? '新建一个设计稿，再用上传客户端把 .sqraft 文件发布上来。' : '有人上传设计稿后会显示在这里。'"
        >
          <button v-if="canEdit" class="primary" @click="openCreate"><Plus :size="15" />新建设计稿</button>
        </EmptyState>
      </div>

      <!-- 网格 -->
      <div v-else-if="view === 'grid'" class="design-grid">
        <article v-for="d in shown" :key="d.id" class="dcard">
          <RouterLink :to="`/designs/${d.id}`" class="dlink">
            <DesignCover :design-id="d.id" :version="d.currentVersion" class="dcover" />
            <div class="dbody">
              <div class="dname truncate" :title="d.name">{{ d.name }}</div>
              <div class="dmeta">
                <span class="tag dot" :class="STATUS_TAG[d.status]">{{ STATUS_LABEL[d.status] }}</span>
                <template v-if="d.currentVersion">
                  <span class="num">v{{ d.currentVersion }}</span>
                  <span class="dot-sep" />
                  <span class="num">{{ d.pageCount }} 页</span>
                </template>
                <span v-else>未上传</span>
              </div>
              <div class="dfoot">
                <span v-if="d.createdBy" class="row creator" :title="`${d.createdBy} 创建`">
                  <Avatar :name="d.createdBy" :size="18" />
                  <span class="truncate">{{ d.createdBy }}</span>
                </span>
                <span class="spacer" />
                <span v-if="d.commentCount" class="row comments" :title="`${d.commentCount} 条评论`"><MessageSquare :size="13" />{{ d.commentCount }}</span>
                <span class="time" :title="formatTime(d.updatedAt)">{{ relativeTime(d.updatedAt) }}</span>
              </div>
            </div>
          </RouterLink>
          <span v-if="d.latestVersion && d.latestVersion !== d.currentVersion" class="tag gray rolled" title="当前版本被回滚过">最新 v{{ d.latestVersion }}</span>
          <button v-if="canEdit" class="sm icon-btn del" title="删除" aria-label="删除设计稿" @click="remove(d)"><Trash2 :size="14" /></button>
        </article>
      </div>

      <!-- 列表 -->
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>状态</th>
              <th>版本</th>
              <th>创建者</th>
              <th>评论</th>
              <th>更新时间</th>
              <th v-if="canEdit" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in shown" :key="d.id" class="clickable" @click="open(d)">
              <td>
                <div class="name-cell">
                  <DesignCover :design-id="d.id" :version="d.currentVersion" class="thumb" />
                  <div style="min-width: 0">
                    <RouterLink :to="`/designs/${d.id}`" class="lname truncate" @click.stop>{{ d.name }}</RouterLink>
                    <div class="muted small">{{ d.currentVersion ? `${d.pageCount} 个页面` : "还没有上传" }}</div>
                  </div>
                </div>
              </td>
              <td><span class="tag dot" :class="STATUS_TAG[d.status]">{{ STATUS_LABEL[d.status] }}</span></td>
              <td class="muted num">
                <span class="row" style="gap: 6px; flex-wrap: nowrap">
                  {{ d.currentVersion ? `v${d.currentVersion}` : "—" }}
                  <span v-if="d.latestVersion && d.latestVersion !== d.currentVersion" class="tag gray" title="当前版本被回滚过">最新 v{{ d.latestVersion }}</span>
                </span>
              </td>
              <td>
                <span v-if="d.createdBy" class="row" style="gap: 6px; flex-wrap: nowrap"><Avatar :name="d.createdBy" :size="20" />{{ d.createdBy }}</span>
                <span v-else class="muted">—</span>
              </td>
              <td class="muted num">
                <span v-if="d.commentCount" class="row" style="gap: 4px; flex-wrap: nowrap"><MessageSquare :size="13" />{{ d.commentCount }}</span>
                <template v-else>—</template>
              </td>
              <td class="muted nowrap" :title="formatTime(d.updatedAt)">{{ relativeTime(d.updatedAt) }}</td>
              <td v-if="canEdit" style="text-align: right">
                <span class="row-actions">
                  <button class="ghost sm icon-btn" title="删除" aria-label="删除设计稿" @click.stop="remove(d)"><Trash2 :size="14" /></button>
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <Modal v-if="creating" title="新建设计稿" @close="creating = false">
      <form id="create-design" @submit.prevent="create">
        <label class="field">
          名称
          <input v-model="newName" maxlength="200" placeholder="例如：首页改版 V3" required autofocus />
        </label>
        <p class="field-hint">建好后用上传客户端选择这个设计稿发布 .sqraft（客户端里也能直接新建）。新设计稿默认是「草稿」。</p>
        <p v-if="modalError" class="error">{{ modalError }}</p>
      </form>
      <template #footer>
        <button type="button" @click="creating = false">取消</button>
        <button type="submit" form="create-design" class="primary" :disabled="!newName.trim() || saving">{{ saving ? "创建中…" : "创建" }}</button>
      </template>
    </Modal>

    <Modal v-if="editing" title="编辑项目" @close="editing = false">
      <form id="edit-project" class="form" @submit.prevent="saveEdit">
        <label class="field">
          项目名称
          <input v-model="editForm.name" maxlength="100" required autofocus />
        </label>
        <label class="field">
          <span class="label-row">项目描述<span class="muted num">{{ editForm.description.length }}/300</span></span>
          <textarea v-model="editForm.description" maxlength="300" rows="3" placeholder="简单说明这个项目包含什么" />
        </label>
        <p v-if="modalError" class="error">{{ modalError }}</p>
      </form>
      <template #footer>
        <button type="button" @click="editing = false">取消</button>
        <button type="submit" form="edit-project" class="primary" :disabled="!editForm.name.trim() || saving">{{ saving ? "保存中…" : "保存" }}</button>
      </template>
    </Modal>

    <Modal v-if="accessOpen" title="成员权限" :width="600" @close="accessOpen = false">
      <p class="field-hint intro">默认按团队角色：编辑者可编辑、查看者只读。可以给某个人在这个项目里单独设置，例如让查看者参与编辑，或对外包同事隐藏项目。</p>
      <div v-if="access.length > 6" class="search-box access-search">
        <Search :size="15" />
        <input v-model="accessQuery" placeholder="搜索成员" aria-label="搜索成员" />
      </div>
      <div v-if="accessLoading" class="access">
        <div v-for="i in 4" :key="i" class="arow">
          <span class="skeleton" style="width: 28px; height: 28px; border-radius: 50%" />
          <div class="who">
            <div class="skeleton" style="width: 120px; height: 13px" />
            <div class="skeleton" style="width: 180px; height: 11px; margin-top: 6px" />
          </div>
          <div class="skeleton" style="width: 140px; height: 32px" />
        </div>
      </div>
      <p v-else-if="accessError" class="error">{{ accessError }}</p>
      <div v-else-if="!accessShown.length" class="muted access-empty">{{ access.length ? "没有匹配的成员" : "团队里还没有其他成员" }}</div>
      <div v-else class="access">
        <div v-for="m in accessShown" :key="m.id" class="arow">
          <Avatar :name="m.displayName" :size="28" />
          <div class="who">
            <div class="truncate" style="font-weight: 600">{{ m.displayName }}</div>
            <div class="muted small truncate">@{{ m.username }} · {{ ROLE_LABEL[m.role] }}{{ m.projectScope === "assigned" ? " · 只看分配的项目" : "" }}</div>
          </div>
          <span class="tag dot" :class="EFFECTIVE_TAG[m.effective]">{{ EFFECTIVE[m.effective] }}</span>
          <select
            v-if="m.role !== 'admin'"
            class="acc-select"
            :value="m.override ?? 'inherit'"
            :disabled="accessBusy === m.id"
            :aria-label="`${m.displayName} 在这个项目的权限`"
            @change="setOverride(m, ($event.target as HTMLSelectElement).value)"
          >
            <option value="inherit">{{ m.projectScope === "assigned" ? "默认（看不到）" : `默认（${m.role === "editor" ? "可编辑" : "只读"}）` }}</option>
            <option value="editor">可编辑</option>
            <option value="viewer">只读</option>
            <option value="none">看不到</option>
          </select>
          <span v-else class="muted small acc-select admin-note">管理员始终可编辑</span>
        </div>
      </div>
      <template #footer>
        <button @click="accessOpen = false">完成</button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.breadcrumb .sep {
  color: var(--faint);
}
.crumb-sk {
  width: 96px;
  height: 14px;
}

/* ── 页头 ── */
.head-main {
  min-width: 0;
  flex: 1;
}
.title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.title-row h1 {
  margin: 0;
  min-width: 0;
}
.desc {
  margin: 4px 0 0;
  color: var(--text-2);
  max-width: 720px;
  line-height: 1.6;
}
.desc.none {
  color: var(--muted);
}
.meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
  color: var(--muted);
  font-size: 12px;
}
.dot-sep {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--faint);
}
.page-head .actions {
  flex-shrink: 0;
}

/* ── 归档提示条 ── */
.archived-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 4px 8px 4px 12px;
  margin-bottom: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--hover);
  color: var(--text-2);
}

/* ── 工具栏 ── */
.toolbar .tabs {
  margin-bottom: 0;
}
.toolbar .search-box {
  width: 220px;
}
.segmented button {
  padding: 0 8px;
}
.empty-card {
  padding: 0;
}

/* ── 卡片网格 ── */
.design-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 16px;
}
.dcard {
  position: relative;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-xs);
  overflow: hidden;
  transition:
    box-shadow 0.15s var(--ease),
    border-color 0.15s var(--ease),
    transform 0.15s var(--ease);
}
.dcard:not(.sk):hover {
  box-shadow: var(--shadow-md);
  border-color: var(--border-strong);
  transform: translateY(-1px);
}
.dlink {
  display: block;
  color: inherit;
}
.dlink:focus-visible {
  outline: none;
}
.dcard:has(.dlink:focus-visible) {
  box-shadow: var(--ring);
  border-color: var(--brand);
}
.dcover,
.cover-sk {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 10;
  border-bottom: 1px solid var(--border);
}
.cover-sk {
  border-radius: 0;
}
.dbody {
  padding: 12px;
}
.dname {
  font-weight: 600;
  color: var(--text);
}
.dmeta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  color: var(--muted);
  font-size: 12px;
}
.dfoot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-size: 12px;
}
.creator {
  gap: 6px;
  flex-wrap: nowrap;
  min-width: 0;
  color: var(--text-2);
}
.comments {
  gap: 4px;
  flex-wrap: nowrap;
  font-variant-numeric: tabular-nums;
}
.time {
  white-space: nowrap;
}
.num {
  font-variant-numeric: tabular-nums;
}
.rolled {
  position: absolute;
  top: 8px;
  left: 8px;
  box-shadow: var(--shadow-xs);
  background: var(--panel);
}
.del {
  position: absolute;
  top: 8px;
  right: 8px;
  background: var(--panel);
  color: var(--text-2);
  box-shadow: var(--shadow-xs);
  opacity: 0;
  transition: opacity 0.12s var(--ease);
}
.del:hover:not(:disabled) {
  color: var(--danger);
  background: var(--panel);
}
.dcard:hover .del,
.del:focus-visible {
  opacity: 1;
}

/* ── 列表 ── */
.clickable {
  cursor: pointer;
}
.name-cell {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 8px 0;
}
.thumb {
  width: 56px;
  height: 36px;
  border-radius: 6px;
  border: 1px solid var(--border);
  flex-shrink: 0;
}
.thumb :deep(.ph span) {
  display: none;
}
.lname {
  display: block;
  max-width: 360px;
  font-weight: 600;
  color: var(--text);
}
.lname:hover {
  color: var(--brand);
}
.small {
  font-size: 12px;
}
.nowrap {
  white-space: nowrap;
}

/* ── 弹窗 ── */
.form {
  display: flex;
  flex-direction: column;
}
.label-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.label-row .muted {
  font-size: 12px;
  font-weight: 400;
}
.intro {
  margin: 0 0 12px;
  line-height: 1.6;
}
.access-search {
  width: 100%;
  margin-bottom: 8px;
}
.access {
  display: flex;
  flex-direction: column;
}
.arow {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}
.arow:last-child {
  border-bottom: none;
}
.who {
  flex: 1;
  min-width: 0;
}
.acc-select {
  width: 140px !important;
  flex-shrink: 0;
}
.admin-note {
  text-align: right;
}
.access-empty {
  padding: 24px 0;
  text-align: center;
}

@media (max-width: 720px) {
  .toolbar .search-box {
    width: 100%;
  }
}
</style>
