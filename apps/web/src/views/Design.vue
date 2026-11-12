<script setup lang="ts">
/**
 * 设计稿详情（C3–C5、D1、W1–W3）：只读画布预览 + 右侧面板（页面 / 评论 / 变更），顶部切换版本、回滚、改状态、上传新版本。
 * 地址栏记住版本与页面（?v=&page=），链接发给别人能直接打开同一页；?upload=1 打开时直接弹出上传。
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import CanvasViewer from "../components/CanvasViewer.vue";
import Avatar from "../components/Avatar.vue";
import Modal from "../components/Modal.vue";
import { api, formatBytes, relativeTime, STATUS_LABEL, STATUS_TAG, uploadDesign, type DesignStatus } from "../api";

const props = defineProps<{ id: string }>();
const route = useRoute();
const router = useRouter();

interface Design {
  id: string;
  projectId: string;
  name: string;
  status: DesignStatus;
  currentVersion: number | null;
  latestVersion: number | null;
  commentCount: number;
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
  current: boolean;
  createdAt: number;
}
interface Page {
  id: string;
  name: string;
  width: number;
  height: number;
  nodeCount: number;
  changedIn: number | null;
}
interface Comment {
  id: string;
  body: string;
  author: { id: string; username: string; displayName: string } | null;
  version: number | null;
  pageId: string | null;
  createdAt: number;
  canDelete: boolean;
}

const design = ref<Design | null>(null);
const project = ref<{ id: string; name: string; role: "editor" | "viewer"; archived: boolean } | null>(null);
const versions = ref<Version[]>([]);
const pages = ref<Page[]>([]);
const changes = ref<Changes | null>(null);
const filter = ref("");
const onlyChanged = ref(false);
const panel = ref<"pages" | "comments" | "changes">("pages");
const error = ref("");

const canEdit = computed(() => project.value?.role === "editor" && !project.value.archived);
const version = computed(() => {
  const v = Number(route.query.v);
  return Number.isInteger(v) && v > 0 ? v : (design.value?.currentVersion ?? null);
});
const versionRow = computed(() => versions.value.find((v) => v.number === version.value) ?? null);
const pageId = computed(() => (typeof route.query.page === "string" ? route.query.page : (pages.value[0]?.id ?? null)));
const currentPage = computed(() => pages.value.find((p) => p.id === pageId.value) ?? null);
const pageName = (id: string | null) => pages.value.find((p) => p.id === id)?.name ?? null;
/** 本版内容有变化的页面（新增或修改） */
const changedHere = computed(() => new Set(changes.value?.base == null ? [] : pages.value.filter((p) => p.changedIn === version.value).map((p) => p.id)));
const shownPages = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return pages.value.filter((p) => (!q || p.name.toLowerCase().includes(q)) && (!onlyChanged.value || changedHere.value.has(p.id)));
});

function go(query: Record<string, string | number | undefined>) {
  void router.replace({ query: { ...route.query, ...query } });
}

/** 「修改 2 页、新增 1 页」 */
function summaryText(c: ChangeSummary | null | undefined): string {
  if (!c) return "";
  if (c.base === null) return "首个版本";
  const p = c.pages;
  const bits = [
    p.modified && `修改 ${p.modified} 页`,
    p.added && `新增 ${p.added} 页`,
    p.removed && `删除 ${p.removed} 页`,
    p.renamed && `改名 ${p.renamed} 页`,
    p.moved && `挪动 ${p.moved} 页`,
  ].filter(Boolean) as string[];
  const comp = c.components.added + c.components.modified + c.components.removed;
  if (comp) bits.push(`组件 ${comp} 个`);
  if (c.tokens) bits.push(`Token ${c.tokens} 个`);
  return bits.length ? bits.join("、") : "页面内容没有变化";
}

async function loadDesign() {
  error.value = "";
  try {
    design.value = (await api<{ design: Design }>("GET", `/designs/${props.id}`)).design;
    project.value = (await api<{ project: NonNullable<typeof project.value> }>("GET", `/projects/${design.value.projectId}`)).project;
    versions.value = (await api<{ versions: Version[] }>("GET", `/designs/${props.id}/versions`)).versions;
  } catch (e) {
    error.value = (e as Error).message;
  }
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

async function setStatus(s: DesignStatus) {
  try {
    design.value = (await api<{ design: Design }>("PATCH", `/designs/${props.id}`, { status: s })).design;
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function rollback(n: number) {
  if (!confirm(`把当前版本切回 v${n}？团队成员和 AI 默认看到的会变成 v${n}，之后的版本仍保留在历史里，可随时切回。`)) return;
  try {
    await api("POST", `/designs/${props.id}/rollback`, { version: n });
    await loadDesign();
    go({ v: undefined });
  } catch (e) {
    error.value = (e as Error).message;
  }
}

// ── 上传新版本 ──
const uploadOpen = ref(false);
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
    go({ v: undefined, page: undefined, upload: undefined });
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

function closeUpload() {
  if (progress.value) return;
  uploadOpen.value = false;
  uploadMsg.value = "";
  if (route.query.upload) go({ upload: undefined });
}

// ── 评论 ──
const comments = ref<Comment[]>([]);
const draft = ref("");
const sending = ref(false);
const commentBox = ref<HTMLTextAreaElement>();
const members = ref<Array<{ username: string; displayName: string }>>([]);
const mention = ref<string | null>(null);
const suggestions = computed(() => {
  if (mention.value === null) return [];
  const k = mention.value.toLowerCase();
  return members.value.filter((m) => m.username.toLowerCase().includes(k) || m.displayName.toLowerCase().includes(k)).slice(0, 6);
});

async function loadComments() {
  comments.value = (await api<{ comments: Comment[] }>("GET", `/designs/${props.id}/comments`)).comments;
}

function onDraftInput() {
  const el = commentBox.value!;
  const m = /@([A-Za-z0-9._-]*)$/.exec(el.value.slice(0, el.selectionStart));
  mention.value = m ? m[1] : null;
}

function pickMention(username: string) {
  const el = commentBox.value!;
  const before = el.value.slice(0, el.selectionStart).replace(/@([A-Za-z0-9._-]*)$/, `@${username} `);
  draft.value = before + el.value.slice(el.selectionStart);
  mention.value = null;
  void nextTick(() => {
    el.focus();
    el.setSelectionRange(before.length, before.length);
  });
}

async function send() {
  if (!draft.value.trim() || sending.value) return;
  sending.value = true;
  try {
    const res = await api<{ comment: Comment }>("POST", `/designs/${props.id}/comments`, { body: draft.value.trim(), version: version.value, pageId: pageId.value });
    comments.value.push(res.comment);
    draft.value = "";
    mention.value = null;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    sending.value = false;
  }
}

async function removeComment(c: Comment) {
  if (!confirm("删除这条评论？")) return;
  await api("DELETE", `/comments/${c.id}`);
  comments.value = comments.value.filter((x) => x.id !== c.id);
}

/** 把 @用户名 拆出来高亮 */
function parts(body: string): Array<{ text: string; at: boolean }> {
  return body.split(/(@[A-Za-z0-9._-]{2,64})/g).filter(Boolean).map((text) => ({ text, at: text.startsWith("@") && members.value.some((m) => `@${m.username}` === text) }));
}

watch(version, () => void loadPages());
onMounted(async () => {
  await loadDesign();
  await loadPages();
  if (route.query.upload && canEdit.value) uploadOpen.value = true;
  await loadComments().catch(() => undefined);
  members.value = (await api<{ members: Array<{ username: string; displayName: string }> }>("GET", "/team/members").catch(() => ({ members: [] }))).members;
});
</script>

<template>
  <div class="dpage">
    <div class="top">
      <div class="breadcrumb">
        <RouterLink to="/">项目</RouterLink><span>/</span>
        <RouterLink v-if="project" :to="`/projects/${project.id}`">{{ project.name }}</RouterLink><span>/</span>
        <span class="current">{{ design?.name ?? "…" }}</span>
      </div>
      <div class="row titlebar">
        <h1>{{ design?.name ?? "…" }}</h1>
        <template v-if="design">
          <select v-if="canEdit" class="status" :class="STATUS_TAG[design.status]" :value="design.status" aria-label="设计稿状态" @change="setStatus(($event.target as HTMLSelectElement).value as DesignStatus)">
            <option v-for="s in (['draft', 'review', 'published'] as DesignStatus[])" :key="s" :value="s">{{ STATUS_LABEL[s] }}</option>
          </select>
          <span v-else class="tag" :class="STATUS_TAG[design.status]">{{ STATUS_LABEL[design.status] }}</span>
        </template>
        <span class="spacer" />
        <a v-if="version && pageId" class="button sm" :href="`/api/v1/designs/${id}/versions/${version}/nodes/${encodeURIComponent(pageId)}/svg`" title="把当前页面导出为自包含的 SVG（图片内嵌）">导出 SVG</a>
        <button v-if="canEdit" class="sm primary" @click="uploadOpen = true">⬆ 上传新版本</button>
      </div>

      <div v-if="versions.length" class="vbar">
        <span class="vlabel">版本</span>
        <select :value="version ?? ''" @change="go({ v: ($event.target as HTMLSelectElement).value, page: undefined })">
          <option v-for="v in versions" :key="v.number" :value="v.number">v{{ v.number }}{{ v.current ? "（当前）" : "" }} · {{ v.note || "无说明" }}</option>
        </select>
        <span v-if="versionRow" class="vnote">
          {{ relativeTime(versionRow.createdAt) }} · {{ versionRow.uploader ?? "未知" }} 上传 · {{ formatBytes(versionRow.size) }}
          <template v-if="versionRow.changes && versionRow.changes.base !== null">
            · <button class="link" @click="panel = 'changes'">相对 v{{ versionRow.changes.base }}：{{ summaryText(versionRow.changes) }}</button>
          </template>
        </span>
        <span class="spacer" />
        <button v-if="canEdit && versionRow && !versionRow.current" class="sm" @click="rollback(versionRow.number)">↩ 回滚到此版本</button>
        <span v-else-if="versionRow && !versionRow.current" class="tag gray">历史版本</span>
      </div>
    </div>

    <p v-if="error" class="error" style="padding: 0 32px">{{ error }}</p>

    <div class="body">
      <div class="stage">
        <div v-if="design && !design.currentVersion" class="blank">
          <div class="big">🎨</div>
          还没有上传任何版本{{ canEdit ? "" : "。" }}
          <button v-if="canEdit" class="primary" style="margin-top: 12px" @click="uploadOpen = true">上传 .sqraft</button>
        </div>
        <template v-else-if="version && pageId">
          <div class="pagebar">
            <strong>{{ currentPage?.name }}</strong>
            <span v-if="currentPage" class="muted">{{ currentPage.width }} × {{ currentPage.height }} · {{ currentPage.nodeCount }} 个节点</span>
          </div>
          <CanvasViewer :design-id="id" :version="version" :page-id="pageId" />
        </template>
      </div>

      <aside class="panel">
        <div class="ptabs">
          <button :class="{ active: panel === 'pages' }" @click="panel = 'pages'">页面 {{ pages.length || "" }}</button>
          <button :class="{ active: panel === 'comments' }" @click="panel = 'comments'">评论 {{ comments.length || "" }}</button>
          <button :class="{ active: panel === 'changes' }" @click="panel = 'changes'">变更</button>
        </div>

        <!-- 页面 -->
        <div v-if="panel === 'pages'" class="pbody">
          <input v-model="filter" placeholder="搜索页面" class="full" />
          <label v-if="changedHere.size" class="only"><input v-model="onlyChanged" type="checkbox" /> 只看本版改动（{{ changedHere.size }}）</label>
          <div class="list">
            <button v-for="p in shownPages" :key="p.id" class="pitem" :class="{ active: p.id === pageId }" :title="`${p.width} × ${p.height} · ${p.nodeCount} 个节点`" @click="go({ page: p.id })">
              <span v-if="changedHere.has(p.id)" class="dot" title="本版改动" />{{ p.name }}
            </button>
            <p v-if="version && !shownPages.length" class="muted">没有匹配的页面</p>
          </div>
        </div>

        <!-- 评论 -->
        <div v-else-if="panel === 'comments'" class="pbody comments">
          <div class="list">
            <p v-if="!comments.length" class="muted">还没有评论。对当前页面说点什么吧，输入 @ 可以提到成员。</p>
            <div v-for="c in comments" :key="c.id" class="comment">
              <Avatar :name="c.author?.displayName ?? '?'" :size="26" />
              <div class="cb">
                <div class="row" style="gap: 6px">
                  <span class="cname">{{ c.author?.displayName ?? "已删除的用户" }}</span>
                  <span class="muted ctime">{{ relativeTime(c.createdAt) }}</span>
                  <span class="spacer" />
                  <button v-if="c.canDelete" class="link danger ctime" @click="removeComment(c)">删除</button>
                </div>
                <div class="ctext"><span v-for="(seg, i) in parts(c.body)" :key="i" :class="{ at: seg.at }">{{ seg.text }}</span></div>
                <div class="cmeta">
                  <span v-if="c.version" class="chip">v{{ c.version }}</span>
                  <button v-if="c.pageId && pageName(c.pageId)" class="chip link" @click="go({ v: c.version ?? undefined, page: c.pageId! })">{{ pageName(c.pageId) }}</button>
                </div>
              </div>
            </div>
          </div>
          <div class="composer">
            <div v-if="suggestions.length" class="suggest">
              <button v-for="m in suggestions" :key="m.username" @mousedown.prevent="pickMention(m.username)">
                <Avatar :name="m.displayName" :size="20" />{{ m.displayName }}<span class="muted">@{{ m.username }}</span>
              </button>
            </div>
            <textarea
              ref="commentBox"
              v-model="draft"
              rows="3"
              maxlength="2000"
              :placeholder="currentPage ? `评论「${currentPage.name}」…（⌘/Ctrl + Enter 发送）` : '添加评论…'"
              @input="onDraftInput"
              @keydown.enter.meta.prevent="send"
              @keydown.enter.ctrl.prevent="send"
              @keydown.esc="mention = null"
            />
            <button class="primary sm" :disabled="!draft.trim() || sending" @click="send">发送</button>
          </div>
        </div>

        <!-- 变更 -->
        <div v-else class="pbody">
          <p v-if="!changes" class="muted">选择一个版本查看变更。</p>
          <p v-else-if="changes.base === null" class="muted">这是第一个版本，所有页面都是新增的。</p>
          <template v-else>
            <p class="muted" style="margin-top: 0">相对 v{{ changes.base }}：{{ summaryText(versionRow?.changes) }}</p>
            <ul class="clist">
              <li v-for="c in changes.pages.modified" :key="`m${c.id}`">
                <span class="tag">修改</span><button class="link" @click="go({ page: c.id })">{{ c.name }}</button>
                <span v-if="c.from" class="muted">（原名 {{ c.from }}）</span>
              </li>
              <li v-for="c in changes.pages.added" :key="`a${c.id}`"><span class="tag green">新增</span><button class="link" @click="go({ page: c.id })">{{ c.name }}</button></li>
              <li v-for="c in changes.pages.removed" :key="`r${c.id}`"><span class="tag red">删除</span><span class="muted">{{ c.name }}</span></li>
              <li v-for="c in changes.pages.renamed" :key="`n${c.id}`">
                <span class="tag gray">改名</span><button class="link" @click="go({ page: c.id })">{{ c.name }}</button><span class="muted">（原名 {{ c.from }}）</span>
              </li>
              <li v-for="c in changes.pages.moved" :key="`v${c.id}`"><span class="tag gray">挪动</span><button class="link" @click="go({ page: c.id })">{{ c.name }}</button></li>
              <li v-if="changes.components.added.length + changes.components.modified.length + changes.components.removed.length" class="muted">
                组件：新增 {{ changes.components.added.length }}、修改 {{ changes.components.modified.length }}、删除 {{ changes.components.removed.length }}
              </li>
              <li v-if="changes.tokens.added.length + changes.tokens.modified.length + changes.tokens.removed.length" class="muted">
                Token：{{ [...changes.tokens.added, ...changes.tokens.modified, ...changes.tokens.removed].slice(0, 8).join("、") }}
              </li>
            </ul>
          </template>
        </div>
      </aside>
    </div>

    <Modal v-if="uploadOpen" title="上传新版本" @close="closeUpload">
      <p class="muted" style="margin-top: 0; font-size: 13px">
        选择 .sqraft 文件（Sketch 先用 sketch2sqraft 转换）。大稿建议用上传客户端，只传改动过的页面更快。
      </p>
      <label class="field">版本说明（可选）<input v-model="note" maxlength="500" placeholder="例如：首页改版、修正按钮颜色" :disabled="!!progress" /></label>
      <input ref="fileInput" type="file" accept=".sqraft" hidden @change="onFile" />
      <div v-if="progress" class="progress">
        <div class="bar"><div :style="{ width: `${(progress.sent / progress.total) * 100}%` }" /></div>
        <div class="row">
          <span class="muted">{{ formatBytes(progress.sent) }} / {{ formatBytes(progress.total) }}{{ progress.sent === progress.total ? "，正在校验…" : "" }}</span>
          <span class="spacer" />
          <button class="sm" @click="abort?.abort()">取消</button>
        </div>
      </div>
      <button v-else class="primary" style="width: 100%" @click="fileInput?.click()">选择文件并上传</button>
      <p v-if="uploadMsg" class="muted">{{ uploadMsg }}</p>
    </Modal>
  </div>
</template>

<style scoped>
.dpage {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.top {
  padding: 20px 32px 0;
}
.titlebar {
  gap: 10px;
  margin-bottom: 12px;
  flex-wrap: nowrap;
}
.titlebar h1 {
  margin: 0;
  font-size: 20px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status {
  padding: 2px 8px;
  font-size: 12px;
  font-weight: 600;
  border-radius: 6px;
  border: none;
  background: var(--brand-soft);
  color: var(--brand);
}
.status.yellow {
  background: #fef3e2;
  color: #c97f05;
}
.status.green {
  background: #e6f6ef;
  color: #18946a;
}
.vbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 14px;
  box-shadow: var(--shadow);
  margin-bottom: 14px;
}
.vbar select {
  max-width: 320px;
}
.vlabel {
  font-size: 12px;
  color: var(--muted);
  font-weight: 600;
}
.vnote {
  font-size: 12px;
  color: var(--text-2);
}
.vnote .link {
  font-size: 12px;
}
.body {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 16px;
  padding: 0 32px 20px;
}
.stage {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: #e9ebf2;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.pagebar {
  display: flex;
  gap: 12px;
  align-items: baseline;
  padding: 9px 14px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}
.blank {
  margin: auto;
  text-align: center;
  color: var(--muted);
  display: flex;
  flex-direction: column;
  align-items: center;
}
.blank .big {
  font-size: 36px;
}
.panel {
  width: 290px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  min-height: 0;
}
.ptabs {
  display: flex;
  border-bottom: 1px solid var(--border);
}
.ptabs button {
  flex: 1;
  border: none;
  border-radius: 0;
  background: none;
  padding: 11px 0;
  color: var(--muted);
}
.ptabs button.active {
  color: var(--brand);
  box-shadow: inset 0 -2px 0 var(--brand);
}
.pbody {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  overflow-y: auto;
}
.full {
  width: 100%;
}
.only {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
}
.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 0 -4px;
}
.pitem {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  font-weight: 500;
  color: var(--text);
  padding: 6px 8px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pitem.active {
  background: var(--brand-soft);
  color: var(--brand);
}
.dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 3px;
  background: var(--brand);
  margin-right: 6px;
  vertical-align: middle;
}
.comments {
  overflow: hidden;
}
.comment {
  display: flex;
  gap: 9px;
  padding: 9px 4px;
  border-bottom: 1px solid var(--border);
}
.cb {
  flex: 1;
  min-width: 0;
}
.cname {
  font-size: 12px;
  font-weight: 600;
}
.ctime {
  font-size: 11px;
}
.ctext {
  font-size: 13px;
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-word;
}
.at {
  color: var(--brand);
  font-weight: 600;
}
.cmeta {
  display: flex;
  gap: 6px;
  margin-top: 4px;
}
.chip {
  font-size: 11px;
  background: var(--bg);
  border-radius: 5px;
  padding: 0 6px;
  color: var(--text-2);
  font-weight: 500;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.composer {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-end;
  border-top: 1px solid var(--border);
  padding-top: 10px;
}
.composer textarea {
  width: 100%;
  resize: none;
}
.suggest {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: var(--shadow-lg);
  padding: 4px;
}
.suggest button {
  display: flex;
  gap: 6px;
  width: 100%;
  justify-content: flex-start;
  border: none;
  padding: 5px 8px;
  font-weight: 500;
}
.suggest button:hover {
  background: var(--brand-soft);
}
.suggest .muted {
  font-size: 12px;
  font-weight: 400;
}
.clist {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
}
.clist .tag {
  margin-right: 6px;
  font-size: 11px;
}
.clist .link {
  font-size: 13px;
  font-weight: 500;
}
.progress .bar {
  height: 6px;
  background: var(--border);
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 8px;
}
.progress .bar div {
  height: 100%;
  background: var(--brand);
}
@media (max-width: 900px) {
  .body {
    flex-direction: column;
  }
  .panel {
    width: auto;
    height: 320px;
  }
  .stage {
    min-height: 420px;
  }
}
</style>
