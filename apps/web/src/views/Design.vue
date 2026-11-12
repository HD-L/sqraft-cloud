<script setup lang="ts">
/**
 * 设计稿查看（W1–W3）：左侧页面列表（可搜索），中间只读画布，顶部切换版本；编辑者可在这里上传新版本。
 * 地址栏记住版本与页面（?v=&page=），链接发给别人能直接打开同一页。
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import CanvasViewer from "../components/CanvasViewer.vue";
import { api, formatBytes, formatTime, uploadDesign } from "../api";

const props = defineProps<{ id: string }>();
const route = useRoute();
const router = useRouter();

interface Design {
  id: string;
  projectId: string;
  name: string;
  currentVersion: number | null;
  latestVersion: number | null;
}
interface Version {
  number: number;
  note: string;
  uploader: string | null;
  size: number;
  nodeCount: number;
  pageCount: number;
  current: boolean;
  createdAt: number;
}
interface Page {
  id: string;
  name: string;
  width: number;
  height: number;
  nodeCount: number;
}

const design = ref<Design | null>(null);
const projectName = ref("");
const role = ref<"editor" | "viewer" | null>(null);
const versions = ref<Version[]>([]);
const pages = ref<Page[]>([]);
const filter = ref("");
const error = ref("");

const version = computed(() => {
  const v = Number(route.query.v);
  return Number.isInteger(v) && v > 0 ? v : (design.value?.currentVersion ?? null);
});
const pageId = computed(() => (typeof route.query.page === "string" ? route.query.page : (pages.value[0]?.id ?? null)));
const shownPages = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return q ? pages.value.filter((p) => p.name.toLowerCase().includes(q)) : pages.value;
});
const currentPage = computed(() => pages.value.find((p) => p.id === pageId.value) ?? null);

function go(query: Record<string, string | number | undefined>) {
  void router.replace({ query: { ...route.query, ...query } });
}

async function loadDesign() {
  error.value = "";
  try {
    design.value = (await api<{ design: Design }>("GET", `/designs/${props.id}`)).design;
    const projects = (await api<{ projects: Array<{ id: string; name: string; role: "editor" | "viewer"; archived: boolean }> }>("GET", "/projects")).projects;
    const project = projects.find((p) => p.id === design.value!.projectId);
    projectName.value = project?.name ?? "";
    role.value = project && !project.archived ? project.role : "viewer";
    versions.value = (await api<{ versions: Version[] }>("GET", `/designs/${props.id}/versions`)).versions;
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function loadPages() {
  pages.value = [];
  if (!version.value) return;
  try {
    pages.value = (await api<{ pages: Page[] }>("GET", `/designs/${props.id}/versions/${version.value}/pages`)).pages;
    if (route.query.page && !pages.value.some((p) => p.id === route.query.page)) go({ page: undefined });
  } catch (e) {
    error.value = (e as Error).message;
  }
}

// ── 上传 ──
const fileInput = ref<HTMLInputElement>();
const note = ref("");
const progress = ref<{ sent: number; total: number } | null>(null);
const uploadMsg = ref("");
let abort: AbortController | null = null;

async function upload(file: File) {
  uploadMsg.value = "";
  abort = new AbortController();
  progress.value = { sent: 0, total: file.size };
  try {
    const res = await uploadDesign(props.id, file, note.value.trim(), (sent, total) => (progress.value = { sent, total }), abort.signal);
    uploadMsg.value = res.duplicate ? `内容与当前版本 v${res.version.number} 相同，没有生成新版本` : `已发布 v${res.version.number}`;
    note.value = "";
    await loadDesign();
    go({ v: undefined, page: undefined });
    await loadPages();
  } catch (e) {
    uploadMsg.value = (e as Error).message;
  } finally {
    progress.value = null;
    abort = null;
    if (fileInput.value) fileInput.value.value = "";
  }
}

function onFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) void upload(file);
}

async function rollback(n: number) {
  if (!confirm(`把当前版本切回 v${n}？AI 和其他人默认读到的会变成 v${n}。`)) return;
  try {
    await api("POST", `/designs/${props.id}/rollback`, { version: n });
    await loadDesign();
    go({ v: undefined });
  } catch (e) {
    error.value = (e as Error).message;
  }
}

watch(version, () => void loadPages());
onMounted(async () => {
  await loadDesign();
  await loadPages();
});
</script>

<template>
  <div class="layout">
    <aside class="side">
      <p class="muted crumb">
        <RouterLink to="/">项目</RouterLink> /
        <RouterLink v-if="design" :to="`/projects/${design.projectId}`">{{ projectName }}</RouterLink>
      </p>
      <h1 class="title">{{ design?.name ?? "…" }}</h1>

      <label class="field" v-if="versions.length">
        <span class="muted">版本</span>
        <select :value="version ?? ''" @change="go({ v: ($event.target as HTMLSelectElement).value, page: undefined })">
          <option v-for="v in versions" :key="v.number" :value="v.number">
            v{{ v.number }}{{ v.current ? "（当前）" : "" }} · {{ v.note || "无说明" }}
          </option>
        </select>
      </label>
      <p v-if="version && versions.find((v) => v.number === version)" class="muted meta">
        {{ versions.find((v) => v.number === version)!.uploader }} · {{ formatTime(versions.find((v) => v.number === version)!.createdAt) }} ·
        {{ formatBytes(versions.find((v) => v.number === version)!.size) }}
        <button
          v-if="role === 'editor' && !versions.find((v) => v.number === version)!.current"
          class="link"
          @click="rollback(version!)"
        >
          设为当前版本
        </button>
      </p>

      <input v-model="filter" placeholder="搜索页面" class="search" />
      <div class="pages">
        <button
          v-for="p in shownPages"
          :key="p.id"
          class="page-item"
          :class="{ active: p.id === pageId }"
          :title="`${p.width} × ${p.height} · ${p.nodeCount} 个节点`"
          @click="go({ page: p.id })"
        >
          {{ p.name }}
        </button>
        <p v-if="version && !shownPages.length" class="muted">没有匹配的页面</p>
      </div>

      <div v-if="role === 'editor'" class="upload">
        <input v-model="note" placeholder="版本说明（可选）" maxlength="500" :disabled="!!progress" />
        <div class="row">
          <button class="primary" :disabled="!!progress" @click="fileInput?.click()">上传新版本</button>
          <button v-if="progress" @click="abort?.abort()">取消</button>
        </div>
        <input ref="fileInput" type="file" accept=".sqraft" hidden @change="onFile" />
        <div v-if="progress" class="bar"><div :style="{ width: `${(progress.sent / progress.total) * 100}%` }" /></div>
        <p v-if="progress" class="muted">{{ formatBytes(progress.sent) }} / {{ formatBytes(progress.total) }}{{ progress.sent === progress.total ? "，正在校验…" : "" }}</p>
        <p v-if="uploadMsg" class="muted">{{ uploadMsg }}</p>
      </div>
    </aside>

    <section class="main">
      <p v-if="error" class="error pad">{{ error }}</p>
      <div v-else-if="design && !design.currentVersion" class="empty muted">还没有上传任何版本{{ role === "editor" ? "，在左下角上传 .sqraft" : "" }}。</div>
      <template v-else-if="version && pageId">
        <div class="pagebar">
          <strong>{{ currentPage?.name }}</strong>
          <span class="muted" v-if="currentPage">{{ currentPage.width }} × {{ currentPage.height }} · {{ currentPage.nodeCount }} 个节点 · v{{ version }}</span>
          <span class="spacer" />
          <a class="button" :href="`/api/v1/designs/${id}/versions/${version}/nodes/${encodeURIComponent(pageId)}/svg`" title="把当前页面导出为自包含的 SVG（图片内嵌）">导出 SVG</a>
        </div>
        <CanvasViewer :design-id="id" :version="version" :page-id="pageId" />
      </template>
    </section>
  </div>
</template>

<style scoped>
.layout {
  display: flex;
  height: calc(100vh - 52px);
}
.side {
  width: 280px;
  flex: none;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  background: var(--panel);
  padding: 16px;
  gap: 8px;
  min-height: 0;
}
.crumb {
  margin: 0;
}
.title {
  margin: 0;
  font-size: 17px;
  word-break: break-all;
}
.meta {
  margin: 0;
  font-size: 12px;
}
.search {
  width: 100%;
}
.pages {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  margin: 0 -8px;
}
.page-item {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  border-radius: 6px;
  padding: 6px 8px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.page-item.active {
  background: var(--accent-weak);
  color: var(--accent);
}
.link {
  border: none;
  padding: 0;
  color: var(--accent);
  background: none;
  margin-left: 6px;
}
.upload {
  border-top: 1px solid var(--border);
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bar {
  height: 6px;
  background: var(--border);
  border-radius: 3px;
  overflow: hidden;
}
.bar div {
  height: 100%;
  background: var(--accent);
}
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.pagebar {
  display: flex;
  gap: 12px;
  align-items: baseline;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}
.empty {
  margin: auto;
}
.pad {
  padding: 16px;
}
</style>
