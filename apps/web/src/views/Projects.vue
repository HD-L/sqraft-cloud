<script setup lang="ts">
/**
 * 项目总览（B1–B4）：卡片网格 / 列表两种视图，可按「全部 / 我创建的」筛选、按名称搜索、按更新时间或名称排序；
 * 管理员与编辑者可以新建项目。封面用项目里最近更新的设计稿第一个画板拼出来。
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { Archive, Download, Eye, FolderOpen, LayoutGrid, LayoutTemplate, List, Plus, RotateCw, Search, X } from "lucide-vue-next";
import { api, colorOf, formatTime, relativeTime, session } from "../api";
import { openClient, toast } from "../ui";
import Modal from "../components/Modal.vue";
import EmptyState from "../components/EmptyState.vue";
import DesignCover from "../components/DesignCover.vue";

interface Project {
  id: string;
  name: string;
  description: string;
  archived: boolean;
  role: "editor" | "viewer";
  createdBy: string | null;
  createdByMe: boolean;
  designCount: number;
  covers?: Array<{ designId: string; version: number }>;
  updatedAt: number;
}

const router = useRouter();
const projects = ref<Project[]>([]);
const loaded = ref(false);
const loading = ref(false);
const error = ref("");
const tab = ref<"all" | "mine">("all");
const q = ref("");
const sort = ref<"updated" | "name">("updated");
const canCreate = computed(() => session.user?.role === "admin" || session.user?.role === "editor");
const mineCount = computed(() => projects.value.filter((p) => p.createdByMe).length);

// ── 视图：网格 / 列表，记在 localStorage ──
const VIEW_KEY = "sqraft.projects.view";
function readView(): "grid" | "list" {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}
const view = ref<"grid" | "list">(readView());
watch(view, (v) => {
  try {
    localStorage.setItem(VIEW_KEY, v);
  } catch {
    /* 隐私模式等情况下写不进去，忽略 */
  }
});

const shown = computed(() => {
  const k = q.value.trim().toLowerCase();
  const list = projects.value.filter(
    (p) =>
      (tab.value === "all" || p.createdByMe) &&
      (!k || p.name.toLowerCase().includes(k) || p.description.toLowerCase().includes(k) || (p.createdBy ?? "").toLowerCase().includes(k)),
  );
  return [...list].sort((a, b) => (sort.value === "name" ? a.name.localeCompare(b.name, "zh-CN") : b.updatedAt - a.updatedAt));
});

async function load() {
  loading.value = true;
  error.value = "";
  try {
    projects.value = (await api<{ projects: Project[] }>("GET", "/projects")).projects;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loaded.value = true;
    loading.value = false;
  }
}

/** 没有封面时的占位：由项目名派生的柔和渐变 */
function tint(name: string) {
  const c = colorOf(name);
  return {
    background: `linear-gradient(135deg, color-mix(in srgb, ${c} 16%, var(--panel)), color-mix(in srgb, ${c} 6%, var(--panel)))`,
    color: c,
  };
}
function initial(name: string) {
  return [...name.trim()][0]?.toUpperCase() ?? "";
}

// ── 新建项目 ──
const creating = ref(false);
const submitting = ref(false);
const form = ref({ name: "", description: "" });
const formError = ref("");
function openCreate() {
  formError.value = "";
  creating.value = true;
}
async function create() {
  if (submitting.value) return;
  formError.value = "";
  submitting.value = true;
  try {
    const res = await api<{ project: Project }>("POST", "/projects", { name: form.value.name.trim(), description: form.value.description.trim() });
    creating.value = false;
    form.value = { name: "", description: "" };
    toast.success("项目已创建");
    await router.push(`/projects/${res.project.id}`);
  } catch (e) {
    formError.value = (e as Error).message;
  } finally {
    submitting.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>项目</h1>
        <div class="sub">{{ loaded && !error ? `共 ${projects.length} 个项目` : "团队的全部设计项目" }}</div>
      </div>
      <div class="actions">
        <button @click="openClient()"><Download :size="15" />上传客户端</button>
        <button v-if="canCreate" class="primary" @click="openCreate"><Plus :size="15" />新建项目</button>
      </div>
    </div>

    <div class="tabs">
      <button class="tab" :class="{ active: tab === 'all' }" @click="tab = 'all'">
        全部 <span v-if="loaded" class="count">{{ projects.length }}</span>
      </button>
      <button class="tab" :class="{ active: tab === 'mine' }" @click="tab = 'mine'">
        我创建的 <span v-if="loaded" class="count">{{ mineCount }}</span>
      </button>
      <button class="tab" @click="router.push('/recent')">最近浏览</button>
    </div>

    <div class="toolbar">
      <div class="search-box">
        <Search :size="15" />
        <input v-model="q" placeholder="搜索项目名称、描述或创建者" aria-label="搜索项目" />
        <button v-if="q" class="ghost sm icon-btn clear" aria-label="清空搜索" @click="q = ''"><X :size="14" /></button>
      </div>
      <span class="spacer" />
      <select v-model="sort" aria-label="排序">
        <option value="updated">最近更新</option>
        <option value="name">名称</option>
      </select>
      <div class="segmented" role="group" aria-label="视图">
        <button :class="{ active: view === 'grid' }" title="网格视图" aria-label="网格视图" @click="view = 'grid'"><LayoutGrid :size="15" /></button>
        <button :class="{ active: view === 'list' }" title="列表视图" aria-label="列表视图" @click="view = 'list'"><List :size="15" /></button>
      </div>
    </div>

    <!-- 错误 -->
    <div v-if="error" class="error-box card">
      <div>
        <div class="error-title">项目加载失败</div>
        <div class="error">{{ error }}</div>
      </div>
      <button :disabled="loading" @click="load"><RotateCw :size="15" />重试</button>
    </div>

    <!-- 加载中 -->
    <template v-else-if="!loaded || (loading && !projects.length)">
      <div v-if="view === 'grid'" class="grid">
        <div v-for="i in 8" :key="i" class="pcard sk">
          <div class="skeleton thumb" />
          <div class="body">
            <div class="skeleton" style="height: 14px; width: 60%" />
            <div class="skeleton" style="height: 12px; width: 85%; margin-top: 8px" />
            <div class="skeleton" style="height: 12px; width: 40%; margin-top: 16px" />
          </div>
        </div>
      </div>
      <div v-else class="list card">
        <div v-for="i in 6" :key="i" class="lrow sk">
          <div class="skeleton lthumb" />
          <div class="lmain">
            <div class="skeleton" style="height: 13px; width: 30%" />
            <div class="skeleton" style="height: 12px; width: 50%; margin-top: 6px" />
          </div>
        </div>
      </div>
    </template>

    <!-- 空 -->
    <EmptyState
      v-else-if="!shown.length && (q || tab === 'mine')"
      :icon="Search"
      title="没有匹配的项目"
      :hint="q ? `没有找到与「${q.trim()}」相关的项目` : '你还没有创建过项目'"
    >
      <button v-if="q" @click="q = ''">清空搜索</button>
      <button v-else @click="tab = 'all'">查看全部项目</button>
    </EmptyState>
    <EmptyState
      v-else-if="!shown.length"
      :icon="FolderOpen"
      title="还没有项目"
      :hint="canCreate ? '项目用来归类同一产品的设计稿。新建一个项目，再用上传客户端把 Sketch 文件传上来。' : '你还没有加入任何项目，请联系管理员把你加进来。'"
    >
      <button v-if="canCreate" class="primary" @click="openCreate"><Plus :size="15" />新建项目</button>
    </EmptyState>

    <!-- 网格 -->
    <div v-else-if="view === 'grid'" class="grid">
      <RouterLink v-for="p in shown" :key="p.id" :to="`/projects/${p.id}`" class="pcard">
        <div class="thumb" :class="`n${Math.min(p.covers?.length ?? 0, 3)}`">
          <template v-if="p.covers?.length">
            <DesignCover v-for="c in p.covers.slice(0, 3)" :key="c.designId" :design-id="c.designId" :version="c.version" class="tile" />
          </template>
          <div v-else class="placeholder" :style="tint(p.name)">
            <span v-if="initial(p.name)" class="letter">{{ initial(p.name) }}</span>
            <LayoutTemplate v-else :size="22" />
          </div>
          <div class="badges">
            <span v-if="p.archived" class="tag gray"><Archive :size="12" />已归档</span>
            <span v-else-if="p.role === 'viewer'" class="tag gray"><Eye :size="12" />只读</span>
          </div>
        </div>
        <div class="body">
          <div class="title truncate" :title="p.name">{{ p.name }}</div>
          <div class="desc truncate" :class="{ none: !p.description }" :title="p.description || undefined">{{ p.description || "暂无描述" }}</div>
          <div class="meta">
            <span class="num">{{ p.designCount }} 个设计稿</span>
            <span class="sep" />
            <span :title="formatTime(p.updatedAt)">{{ relativeTime(p.updatedAt) }}更新</span>
            <template v-if="p.createdBy">
              <span class="sep" />
              <span class="truncate">{{ p.createdBy }}</span>
            </template>
          </div>
        </div>
      </RouterLink>
    </div>

    <!-- 列表 -->
    <div v-else class="list card">
      <div class="lhead">
        <span class="lmain">项目</span>
        <span class="c-num">设计稿</span>
        <span class="c-owner">创建者</span>
        <span class="c-time">更新时间</span>
      </div>
      <RouterLink v-for="p in shown" :key="p.id" :to="`/projects/${p.id}`" class="lrow">
        <div class="lthumb">
          <DesignCover v-if="p.covers?.length" :design-id="p.covers[0].designId" :version="p.covers[0].version" class="tile" />
          <div v-else class="placeholder" :style="tint(p.name)">
            <span class="letter sm">{{ initial(p.name) }}</span>
          </div>
        </div>
        <div class="lmain">
          <div class="lname">
            <span class="truncate">{{ p.name }}</span>
            <span v-if="p.archived" class="tag gray">已归档</span>
            <span v-else-if="p.role === 'viewer'" class="tag gray">只读</span>
          </div>
          <div class="desc truncate" :class="{ none: !p.description }">{{ p.description || "暂无描述" }}</div>
        </div>
        <span class="c-num num">{{ p.designCount }}</span>
        <span class="c-owner truncate">{{ p.createdBy ?? "—" }}</span>
        <span class="c-time" :title="formatTime(p.updatedAt)">{{ relativeTime(p.updatedAt) }}</span>
      </RouterLink>
    </div>

    <Modal v-if="creating" title="新建项目" @close="creating = false">
      <form id="create-project" @submit.prevent="create">
        <label class="field">项目名称<input v-model="form.name" maxlength="100" placeholder="例如：官网改版 3.0" required autofocus /></label>
        <label class="field">项目描述<input v-model="form.description" maxlength="300" placeholder="一句话说明这个项目（可选）" /></label>
        <p v-if="formError" class="error">{{ formError }}</p>
      </form>
      <template #footer>
        <button type="button" @click="creating = false">取消</button>
        <button type="submit" form="create-project" class="primary" :disabled="submitting || !form.name.trim()">
          {{ submitting ? "创建中…" : "创建项目" }}
        </button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.search-box .clear {
  width: 20px;
  height: 20px;
  margin-right: -4px;
  color: var(--muted);
  flex-shrink: 0;
}
.segmented button {
  width: 32px;
  padding: 0;
}

/* 错误 */
.error-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px;
}
.error-title {
  font-weight: 600;
  margin-bottom: 4px;
}
.error-box .error {
  margin: 0;
}

/* ── 网格卡片 ── */
.pcard {
  display: flex;
  flex-direction: column;
  min-width: 0;
  color: inherit;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-xs);
  overflow: hidden;
  transition:
    transform 0.16s var(--ease),
    box-shadow 0.16s var(--ease),
    border-color 0.16s var(--ease);
}
a.pcard:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
  border-color: var(--border-strong);
}
.thumb {
  position: relative;
  aspect-ratio: 16 / 10;
  display: grid;
  gap: 2px;
  background: var(--border);
  border-bottom: 1px solid var(--border);
  overflow: hidden;
}
.pcard.sk .thumb {
  border-radius: 0;
  border-bottom: none;
}
.thumb.n2 {
  grid-template-columns: 1fr 1fr;
}
.thumb.n3 {
  grid-template-columns: 3fr 2fr;
  grid-template-rows: 1fr 1fr;
}
.thumb.n3 .tile:first-child {
  grid-row: span 2;
}
.tile {
  width: 100%;
  height: 100%;
  min-height: 0;
}
.thumb .tile :deep(img) {
  transition: transform 0.3s var(--ease);
}
a.pcard:hover .thumb .tile :deep(img) {
  transform: scale(1.02);
}
.placeholder {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
}
.letter {
  width: 48px;
  height: 48px;
  display: grid;
  place-items: center;
  border-radius: 12px;
  background: var(--panel);
  box-shadow: var(--shadow-xs);
  font-size: 20px;
  font-weight: 650;
}
.letter.sm {
  width: auto;
  height: auto;
  background: none;
  box-shadow: none;
  font-size: 14px;
}
.badges {
  position: absolute;
  top: 8px;
  left: 8px;
  display: flex;
  gap: 4px;
}
.badges .tag {
  gap: 4px;
  background: var(--panel);
  box-shadow: var(--shadow-xs);
}
.body {
  padding: 12px 16px 16px;
  min-width: 0;
}
.title {
  font-weight: 600;
  font-size: 14px;
}
.desc {
  color: var(--text-2);
  font-size: 12px;
  margin-top: 2px;
}
.desc.none {
  color: var(--faint);
}
.meta {
  margin-top: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-size: 12px;
  min-width: 0;
  white-space: nowrap;
}
.num {
  font-variant-numeric: tabular-nums;
}
.sep {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--faint);
  flex-shrink: 0;
}

/* ── 列表 ── */
.list {
  padding: 0;
  overflow: hidden;
}
.lhead,
.lrow {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr) 80px 140px 120px;
  align-items: center;
  gap: 16px;
  padding: 0 16px;
}
.lhead {
  height: 36px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--muted);
  font-size: 12px;
  font-weight: 500;
}
.lhead .lmain {
  grid-column: 1 / 3;
}
.lrow {
  height: 60px;
  color: inherit;
  border-bottom: 1px solid var(--border);
  transition: background 0.12s var(--ease);
}
.lrow:last-child {
  border-bottom: none;
}
a.lrow:hover {
  background: var(--hover);
}
.lrow.sk {
  grid-template-columns: 64px minmax(0, 1fr);
}
.lthumb {
  width: 64px;
  height: 40px;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--border);
}
.lrow.sk .lthumb {
  border: none;
}
.lmain {
  min-width: 0;
}
.lname {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  min-width: 0;
}
.lname .tag {
  flex-shrink: 0;
}
.c-num,
.c-owner,
.c-time {
  color: var(--text-2);
  font-size: 12px;
}
.lrow .c-num {
  color: var(--text);
}
@media (max-width: 860px) {
  .lhead,
  .lrow {
    grid-template-columns: 64px minmax(0, 1fr) 80px;
  }
  .c-owner,
  .c-time {
    display: none;
  }
}
</style>
