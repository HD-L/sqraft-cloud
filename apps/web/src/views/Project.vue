<script setup lang="ts">
/**
 * 项目详情（C2）：设计稿列表，可按状态筛选、搜索；
 * 编辑者可新建设计稿、改项目信息、删除设计稿；管理员可设置每个成员在这个项目里的权限、归档项目。
 */
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { api, colorOf, relativeTime, ROLE_LABEL, session, STATUS_LABEL, STATUS_TAG, type DesignStatus, type TeamRole } from "../api";
import Avatar from "../components/Avatar.vue";
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
}

const project = ref<Project | null>(null);
const designs = ref<Design[]>([]);
const status = ref<DesignStatus | "all">("all");
const query = ref("");
const error = ref("");
const canEdit = computed(() => project.value?.role === "editor" && !project.value.archived);
const isAdmin = computed(() => session.user?.isAdmin === true);
const shown = computed(() =>
  designs.value.filter((d) => (status.value === "all" || d.status === status.value) && d.name.toLowerCase().includes(query.value.trim().toLowerCase())),
);
const countOf = (s: DesignStatus) => designs.value.filter((d) => d.status === s).length;

async function load() {
  error.value = "";
  try {
    project.value = (await api<{ project: Project }>("GET", `/projects/${props.id}`)).project;
    designs.value = (await api<{ designs: Design[] }>("GET", `/projects/${props.id}/designs`)).designs;
  } catch (e) {
    error.value = (e as Error).message;
  }
}

// ── 新建设计稿：建好后进详情页直接上传 ──
const creating = ref(false);
const newName = ref("");
const modalError = ref("");
async function create() {
  modalError.value = "";
  try {
    const res = await api<{ design: Design }>("POST", `/projects/${props.id}/designs`, { name: newName.value.trim() });
    await router.push({ path: `/designs/${res.design.id}`, query: { upload: "1" } });
  } catch (e) {
    modalError.value = (e as Error).message;
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
  modalError.value = "";
  try {
    project.value = (await api<{ project: Project }>("PATCH", `/projects/${props.id}`, { name: editForm.value.name.trim(), description: editForm.value.description.trim() })).project;
    editing.value = false;
  } catch (e) {
    modalError.value = (e as Error).message;
  }
}

async function toggleArchive() {
  const archived = !project.value!.archived;
  if (archived && !confirm("归档后项目变为只读：不能再上传、改名或删除设计稿。确定归档？")) return;
  await api("PATCH", `/admin/projects/${props.id}`, { archived });
  await load();
}

async function remove(d: Design) {
  if (!confirm(`删除设计稿「${d.name}」？删除后进入回收站，管理员可在保留期内恢复。`)) return;
  try {
    await api("DELETE", `/designs/${d.id}`);
    designs.value = designs.value.filter((x) => x.id !== d.id);
  } catch (e) {
    error.value = (e as Error).message;
  }
}

// ── 成员权限（管理员）──
interface Access {
  id: string;
  username: string;
  displayName: string;
  role: TeamRole;
  override: "editor" | "viewer" | "none" | null;
  effective: "editor" | "viewer" | "none";
}
const accessOpen = ref(false);
const access = ref<Access[]>([]);
async function openAccess() {
  accessOpen.value = true;
  access.value = (await api<{ members: Access[] }>("GET", `/projects/${props.id}/access`)).members;
}
async function setOverride(m: Access, value: string) {
  if (value === "inherit") await api("DELETE", `/admin/projects/${props.id}/members/${m.id}`);
  else await api("PUT", `/admin/projects/${props.id}/members/${m.id}`, { role: value });
  access.value = (await api<{ members: Access[] }>("GET", `/projects/${props.id}/access`)).members;
}
const EFFECTIVE = { editor: "可编辑", viewer: "只读", none: "看不到" } as const;

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="breadcrumb">
      <RouterLink to="/">项目</RouterLink><span>/</span><span class="current">{{ project?.name ?? "…" }}</span>
    </div>
    <p v-if="error" class="error">{{ error }}</p>
    <template v-if="project">
      <div class="page-head">
        <div>
          <div class="row">
            <h1>{{ project.name }}</h1>
            <span v-if="project.archived" class="tag gray">已归档（只读）</span>
          </div>
          <div class="sub">{{ project.description || "暂无描述" }} · {{ designs.length }} 个设计稿</div>
        </div>
        <div class="actions">
          <button v-if="isAdmin" @click="openAccess">👥 成员权限</button>
          <button v-if="canEdit" @click="openEdit">编辑项目</button>
          <button v-if="isAdmin" @click="toggleArchive">{{ project.archived ? "取消归档" : "归档" }}</button>
          <button v-if="canEdit" class="primary" @click="creating = true">＋ 新建设计稿</button>
        </div>
      </div>

      <div class="tabs">
        <button class="tab" :class="{ active: status === 'all' }" @click="status = 'all'">全部 {{ designs.length }}</button>
        <button v-for="s in (['draft', 'review', 'published'] as DesignStatus[])" :key="s" class="tab" :class="{ active: status === s }" @click="status = s">
          {{ STATUS_LABEL[s] }} {{ countOf(s) }}
        </button>
        <span class="spacer" />
        <div class="search-box"><span>🔍</span><input v-model="query" placeholder="搜索设计稿" /></div>
      </div>

      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>名称</th><th>创建者</th><th>状态</th><th>更新时间</th><th>版本</th><th>评论</th><th v-if="canEdit" /></tr>
          </thead>
          <tbody>
            <tr v-for="d in shown" :key="d.id" class="clickable" @click="router.push(`/designs/${d.id}`)">
              <td>
                <div class="row" style="gap: 10px; flex-wrap: nowrap">
                  <div class="ico" :style="{ background: `linear-gradient(135deg, ${colorOf(project.id)}22, ${colorOf(project.id)}0d)` }">🎨</div>
                  <div>
                    <div style="font-weight: 600">{{ d.name }}</div>
                    <div class="muted" style="font-size: 12px">{{ d.currentVersion ? `${d.pageCount} 个页面` : "还没有上传" }}</div>
                  </div>
                </div>
              </td>
              <td>
                <span v-if="d.createdBy" class="row" style="gap: 6px; flex-wrap: nowrap"><Avatar :name="d.createdBy" :size="22" />{{ d.createdBy }}</span>
                <span v-else class="muted">—</span>
              </td>
              <td><span class="tag" :class="STATUS_TAG[d.status]">{{ STATUS_LABEL[d.status] }}</span></td>
              <td class="muted">{{ relativeTime(d.updatedAt) }}</td>
              <td class="muted">
                {{ d.currentVersion ? `v${d.currentVersion}` : "—" }}
                <span v-if="d.latestVersion && d.latestVersion !== d.currentVersion" class="tag gray" title="当前版本被回滚过">最新 v{{ d.latestVersion }}</span>
              </td>
              <td class="muted">{{ d.commentCount || "—" }}</td>
              <td v-if="canEdit" style="text-align: right"><button class="link danger" @click.stop="remove(d)">删除</button></td>
            </tr>
            <tr v-if="!shown.length">
              <td :colspan="canEdit ? 7 : 6" class="empty">{{ designs.length ? "没有匹配的设计稿" : canEdit ? "还没有设计稿，点右上角「新建设计稿」" : "还没有设计稿" }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <Modal v-if="creating" title="新建设计稿" @close="creating = false">
      <form @submit.prevent="create">
        <label class="field">名称<input v-model="newName" maxlength="200" placeholder="例如：首页改版 V3" required autofocus /></label>
        <p class="muted" style="font-size: 12px; margin-top: 0">建好后在详情页上传 .sqraft；也可以用上传客户端发布。新设计稿默认是「草稿」。</p>
        <p v-if="modalError" class="error">{{ modalError }}</p>
        <button class="primary" style="width: 100%">创建并上传</button>
      </form>
    </Modal>

    <Modal v-if="editing" title="编辑项目" @close="editing = false">
      <form @submit.prevent="saveEdit">
        <label class="field">项目名称<input v-model="editForm.name" maxlength="100" required /></label>
        <label class="field">项目描述<input v-model="editForm.description" maxlength="300" /></label>
        <p v-if="modalError" class="error">{{ modalError }}</p>
        <button class="primary" style="width: 100%">保存</button>
      </form>
    </Modal>

    <Modal v-if="accessOpen" title="成员权限" :width="560" @close="accessOpen = false">
      <p class="muted" style="margin-top: 0; font-size: 13px">
        默认按团队角色：编辑者可编辑、查看者只读。可以给某个人在这个项目里单独设置，例如让查看者参与编辑，或对外包同事隐藏项目。
      </p>
      <div class="access">
        <div v-for="m in access" :key="m.id" class="arow">
          <Avatar :name="m.displayName" :size="28" />
          <div class="who">
            <div style="font-weight: 600">{{ m.displayName }}</div>
            <div class="muted" style="font-size: 12px">@{{ m.username }} · 团队{{ ROLE_LABEL[m.role] }}</div>
          </div>
          <span class="tag" :class="{ gray: m.effective === 'viewer', red: m.effective === 'none' }">{{ EFFECTIVE[m.effective] }}</span>
          <select v-if="m.role !== 'admin'" :value="m.override ?? 'inherit'" style="width: 130px" @change="setOverride(m, ($event.target as HTMLSelectElement).value)">
            <option value="inherit">按团队角色</option>
            <option value="editor">可编辑</option>
            <option value="viewer">只读</option>
            <option value="none">看不到</option>
          </select>
          <span v-else class="muted" style="width: 130px; font-size: 12px">管理员始终可编辑</span>
        </div>
      </div>
    </Modal>
  </div>
</template>

<style scoped>
.page-head .row h1 {
  margin: 0;
}
.tabs {
  align-items: center;
}
.clickable {
  cursor: pointer;
}
.ico {
  width: 38px;
  height: 38px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  flex-shrink: 0;
}
.access {
  display: flex;
  flex-direction: column;
}
.arow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 0;
  border-bottom: 1px solid var(--border);
}
.arow:last-child {
  border-bottom: none;
}
.who {
  flex: 1;
  min-width: 0;
}
</style>
