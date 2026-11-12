<script setup lang="ts">
/**
 * 设计稿查看（W1–W3）：左侧页面列表（可搜索），中间只读画布，顶部切换版本；编辑者可在这里上传新版本。
 * 地址栏记住版本与页面（?v=&page=），链接发给别人能直接打开同一页。
 * 每个版本显示相对上一版改了哪些页面，页面列表标出本版改动的页面，可以只看改动。
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
type Counts = { added: number; modified: number; removed: number; renamed: number; moved: number };
interface ChangeSummary {
  base: number | null;
  pages: Counts;
  components: Counts;
  tokens: number;
}
interface ChangeRef {
  id: string;
  name: string;
  from?: string;
}
interface ChangeSet {
  added: ChangeRef[];
  modified: ChangeRef[];
  removed: ChangeRef[];
  renamed: ChangeRef[];
  moved: ChangeRef[];
}
interface Changes {
  base: number | null;
  pages: ChangeSet;
  components: ChangeSet;
  tokens: { added: string[]; modified: string[]; removed: string[] };
}
interface Version {
  number: number;
  changes: ChangeSummary | null;
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
  /** 内容最后一次变化的版本；旧版本没有记录时为 null */
  changedIn: number | null;
}

const design = ref<Design | null>(null);
const projectName = ref("");
const role = ref<"editor" | "viewer" | null>(null);
const versions = ref<Version[]>([]);
const pages = ref<Page[]>([]);
const filter = ref("");
const onlyChanged = ref(false);
const changes = ref<Changes | null>(null);
const showChanges = ref(false);
const error = ref("");

const version = computed(() => {
  const v = Number(route.query.v);
  return Number.isInteger(v) && v > 0 ? v : (design.value?.currentVersion ?? null);
});
const pageId = computed(() => (typeof route.query.page === "string" ? route.query.page : (pages.value[0]?.id ?? null)));
/** 本版内容有变化的页面（新增或修改） */
const changedHere = computed(() => new Set(pages.value.filter((p) => p.changedIn === version.value && changes.value?.base !== null).map((p) => p.id)));
const shownPages = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return pages.value.filter((p) => (!q || p.name.toLowerCase().includes(q)) && (!onlyChanged.value || changedHere.value.has(p.id)));
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

/** 「修改 2 页、新增 1 页」；没有页面变化时说明是什么变了 */
function summaryText(c: ChangeSummary | null): string {
  if (!c) return "";
  if (c.base === null) return "首个版本";
  const p = c.pages;
  const bits = [
    p.modified && `修改 ${p.modified} 页`,
    p.added && `新增 ${p.added} 页`,
    p.removed && `删除 ${p.removed} 页`,
    p.renamed && `改名 ${p.renamed} 页`,
    p.moved && `挪动 ${p.moved} 页`,
  ].filter(Boolean);
  const comp = c.components.added + c.components.modified + c.components.removed;
  if (comp) bits.push(`组件 ${comp} 个`);
  if (c.tokens) bits.push(`Token ${c.tokens} 个`);
  return bits.length ? bits.join("、") : "页面内容没有变化";
}

async function loadPages() {
  pages.value = [];
  changes.value = null;
  if (!version.value) return;
  try {
    const v = version.value;
    const [list, ch] = await Promise.all([
      api<{ pages: Page[] }>("GET", `/designs/${props.id}/versions/${v}/pages`),
      api<{ changes: Changes }>("GET", `/designs/${props.id}/versions/${v}/changes`),
    ]);
    if (v !== version.value) return;
    pages.value = list.pages;
    changes.value = ch.changes;
    if (ch.changes.base === null) onlyChanged.value = false;
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
            v{{ v.number }}{{ v.current ? "（当前）" : "" }} · {{ v.note || "无说明" }}{{ v.changes && v.changes.base !== null ? ` · ${summaryText(v.changes)}` : "" }}
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

      <div v-if="changes && changes.base !== null" class="changes">
        <button class="link plain" @click="showChanges = !showChanges">
          相对 v{{ changes.base }}：{{ summaryText(versions.find((x) => x.number === version)?.changes ?? null) || "…" }}
          <span class="muted">{{ showChanges ? "收起" : "明细" }}</span>
        </button>
        <ul v-if="showChanges" class="change-list">
          <li v-for="c in changes.pages.modified" :key="`m${c.id}`">
            <span class="tag">修改</span><a href="#" @click.prevent="go({ page: c.id })">{{ c.name }}</a>
            <span v-if="c.from" class="muted">（原名 {{ c.from }}）</span>
          </li>
          <li v-for="c in changes.pages.added" :key="`a${c.id}`"><span class="tag ok">新增</span><a href="#" @click.prevent="go({ page: c.id })">{{ c.name }}</a></li>
          <li v-for="c in changes.pages.removed" :key="`r${c.id}`"><span class="tag danger">删除</span><span class="muted">{{ c.name }}</span></li>
          <li v-for="c in changes.pages.renamed" :key="`n${c.id}`">
            <span class="tag gray">改名</span><a href="#" @click.prevent="go({ page: c.id })">{{ c.name }}</a><span class="muted">（原名 {{ c.from }}）</span>
          </li>
          <li v-for="c in changes.pages.moved" :key="`v${c.id}`"><span class="tag gray">挪动</span><a href="#" @click.prevent="go({ page: c.id })">{{ c.name }}</a></li>
          <li v-if="changes.components.added.length + changes.components.modified.length + changes.components.removed.length" class="muted">
            组件：新增 {{ changes.components.added.length }}、修改 {{ changes.components.modified.length }}、删除 {{ changes.components.removed.length }}
          </li>
          <li v-if="changes.tokens.added.length + changes.tokens.modified.length + changes.tokens.removed.length" class="muted">
            Token：{{ [...changes.tokens.added, ...changes.tokens.modified, ...changes.tokens.removed].slice(0, 6).join("、") }}
          </li>
        </ul>
        <label class="only"><input v-model="onlyChanged" type="checkbox" /> 只看本版改动的页面（{{ changedHere.size }}）</label>
      </div>

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
          <span v-if="changedHere.has(p.id)" class="dot" title="本版改动" />{{ p.name }}
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
.changes {
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.link.plain {
  margin: 0;
  text-align: left;
  color: var(--text);
}
.change-list {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 180px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.change-list .tag {
  margin-right: 6px;
  font-size: 11px;
}
.tag.ok {
  background: #e6f4ea;
  color: var(--ok);
}
.tag.danger {
  background: #fce8e6;
  color: var(--danger);
}
.tag.gray {
  background: var(--bg);
  color: var(--muted);
}
.only {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
}
.dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 3px;
  background: var(--accent);
  margin-right: 6px;
  vertical-align: middle;
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
