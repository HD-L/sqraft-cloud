<script setup lang="ts">
/**
 * 设计稿查看：左侧按分组列出画板，中间两种视图——
 * - 总览：全部画板按画布位置铺开（缩略图），单击选中、双击进入；
 * - 单页：只看一个画板，上一个 / 下一个翻页（← →），Esc 回总览；画布缩放与图层导航有快捷键（? 查看）。
 * 右侧面板是标注、切图、评论与版本变更。新版本只通过上传客户端发布，网页不提供上传。
 * 地址栏记住版本、画板与视图（?v=&board=&mode=detail），链接发给别人能直接打开同一处。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import CanvasViewer from "../components/CanvasViewer.vue";
import InspectPanel from "../components/InspectPanel.vue";
import SlicesPanel from "../components/SlicesPanel.vue";
import OverviewCanvas from "../components/OverviewCanvas.vue";
import { clearImages } from "../viewer/images";
import Avatar from "../components/Avatar.vue";
import { api, formatBytes, formatTime, relativeTime, STATUS_LABEL, STATUS_TAG, type DesignStatus } from "../api";
import { confirmDialog, openClient, toast } from "../ui";
import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileDiff,
  Folder,
  Hash,
  History,
  Keyboard,
  LayoutGrid,
  MessageSquare,
  PanelLeft,
  PanelRight,
  RotateCcw,
  Search,
  Send,
  SquareMousePointer,
  Trash2,
  Upload,
} from "lucide-vue-next";
import EmptyState from "../components/EmptyState.vue";

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
  section: string;
  x: number;
  y: number;
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
const sections = ref<Array<{ name: string; pageIds: string[]; inferred: boolean }>>([]);
const collapsed = reactive(new Set<string>());
const overview = ref<InstanceType<typeof OverviewCanvas>>();
const canvas = ref<InstanceType<typeof CanvasViewer>>();
/** 切图列表悬停时在画布上高亮的图层 */
const highlightIds = ref<string[]>([]);
const showHelp = ref(false);
const showPanel = ref(true);
const showTree = ref(true);
const statusOpen = ref(false);
const versionOpen = ref(false);
const loadingPages = ref(true);
const changes = ref<Changes | null>(null);
const filter = ref("");
const onlyChanged = ref(false);
const panel = ref<"inspect" | "slices" | "comments" | "changes">("comments");
const error = ref("");

const canEdit = computed(() => project.value?.role === "editor" && !project.value.archived);
const version = computed(() => {
  const v = Number(route.query.v);
  return Number.isInteger(v) && v > 0 ? v : (design.value?.currentVersion ?? null);
});
const versionRow = computed(() => versions.value.find((v) => v.number === version.value) ?? null);
/** 选中的画板；单页视图下没选就看第一个 */
const boardId = computed(() => (typeof route.query.board === "string" ? route.query.board : null));
/** 单页视图里选中的图层（标注） */
const nodeId = computed(() => (typeof route.query.node === "string" ? route.query.node : null));
const mode = computed<"overview" | "detail">(() => (route.query.mode === "detail" ? "detail" : "overview"));
const pageId = computed(() => boardId.value ?? (mode.value === "detail" ? (pages.value[0]?.id ?? null) : null));
const currentPage = computed(() => pages.value.find((p) => p.id === pageId.value) ?? null);
const pageIndex = computed(() => pages.value.findIndex((p) => p.id === pageId.value));
const pageName = (id: string | null) => pages.value.find((p) => p.id === id)?.name ?? null;
/** 本版内容有变化的页面（新增或修改） */
const changedHere = computed(() => new Set(changes.value?.base == null ? [] : pages.value.filter((p) => p.changedIn === version.value).map((p) => p.id)));
const shownPages = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return pages.value.filter((p) => (!q || p.name.toLowerCase().includes(q)) && (!onlyChanged.value || changedHere.value.has(p.id)));
});
/** 左侧树：按分组，过滤后为空的组不显示 */
const tree = computed(() => {
  const shown = new Set(shownPages.value.map((p) => p.id));
  const byId = new Map(pages.value.map((p) => [p.id, p]));
  return sections.value
    .map((s) => ({ name: s.name, total: s.pageIds.length, pages: s.pageIds.filter((id) => shown.has(id)).map((id) => byId.get(id)!) }))
    .filter((s) => s.pages.length);
});
const filtering = computed(() => !!filter.value.trim() || onlyChanged.value);

function go(query: Record<string, string | number | undefined>) {
  void router.replace({ query: { ...route.query, ...query } });
}

/** 选中画板：总览里定位过去，单页视图里直接切换 */
function select(id: string, locate = true) {
  go({ board: id, node: undefined });
  if (mode.value === "overview" && locate) overview.value?.focus(id);
  revealInTree(id);
}

/** 树里展开画板所在的组并滚到它 */
function revealInTree(id: string) {
  const sec = pages.value.find((p) => p.id === id)?.section;
  if (sec) collapsed.delete(sec);
  void nextTick(() => document.querySelector(".tree .pitem.active")?.scrollIntoView({ block: "nearest" }));
}
function openBoard(id: string) {
  go({ board: id, mode: "detail", node: undefined });
}
function toOverview() {
  go({ mode: undefined, node: undefined });
}
function selectNode(id: string | null) {
  go({ node: id ?? undefined });
  if (id && panel.value !== "inspect" && panel.value !== "slices") panel.value = "inspect";
  if (id && !showPanel.value) {
    // 面板展开会把画布从右侧挤窄：等布局更新后把刚选中的图层留在视野里
    showPanel.value = true;
    void nextTick(() => canvas.value?.focusNode(id));
  }
}
function step(delta: number) {
  const next = pages.value[pageIndex.value + delta];
  if (next) {
    go({ board: next.id, node: undefined });
    revealInTree(next.id);
  }
}
function toggleSection(name: string) {
  if (collapsed.has(name)) collapsed.delete(name);
  else collapsed.add(name);
}

/** 切图列表点到的图层：选中并在画布上滚到可见 */
function locateNode(id: string) {
  canvas.value?.focusNode(id);
}
/** 沿图层树移动选中（Enter 进子图层、⇧Enter 回父图层、Tab / ⇧Tab 同级切换） */
function moveSelection(dir: "child" | "parent" | "next" | "prev") {
  if (!nodeId.value) return;
  const next = canvas.value?.relative(nodeId.value, dir);
  if (dir === "parent" && next === null) return selectNode(null);
  if (next) {
    selectNode(next);
    // selectNode 可能刚展开右侧面板：等 DOM 更新、画布变窄后再判断要不要平移
    void nextTick(() => canvas.value?.focusNode(next));
  }
}

/** 快捷键说明（? 打开） */
const SHORTCUTS: Array<[string, string]> = [
  ["← →", "上一个 / 下一个画板"],
  ["Esc", "取消选中，再按回总览"],
  ["⌘+ / ⌘−", "放大 / 缩小"],
  ["⌘0", "缩放到 100%"],
  ["⇧1", "适应画布"],
  ["⇧2", "缩放到选中图层"],
  ["Enter", "选中子图层"],
  ["⇧Enter", "选中父图层"],
  ["Tab / ⇧Tab", "选中下一个 / 上一个同级图层"],
  ["⌥", "按住：间距显示为百分比"],
  ["Space", "按住拖动：平移画布"],
  ["?", "显示 / 隐藏这份说明"],
];

/**
 * ⌘ 缩放键：先按打出的字符判断（各种键盘布局下 "-" 都是缩小，Mac 法语布局的 "-" 在物理键 Equal 上）；
 * 字符不是可打印 ASCII 时（如法语布局 ⌘0 打出 "à"）才按物理键兜底——Dvorak 的 "[" "]" 不会被当成缩放。
 */
function zoomKey(e: KeyboardEvent): "in" | "out" | "reset" | null {
  if (e.key === "=" || e.key === "+") return "in";
  if (e.key === "-" || e.key === "_") return "out";
  if (e.key === "0") return "reset";
  if (/^[\x20-\x7e]$/.test(e.key)) return null;
  if (e.code === "Equal" || e.code === "NumpadAdd") return "in";
  if (e.code === "Minus" || e.code === "NumpadSubtract") return "out";
  if (e.code === "Digit0" || e.code === "Numpad0") return "reset";
  return null;
}

/**
 * 单页视图的快捷键（输入框里、弹窗打开时不触发）：
 * ← → 翻页；Esc 先关说明、再取消选中、再回总览；⌘= / ⌘− / ⌘0 缩放；⇧1 适应、⇧2 缩放到选中；
 * Enter / ⇧Enter / Tab 在图层树里移动（焦点在按钮、链接上时留给它们）；? 打开说明。
 */
function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  // 顶栏的状态 / 版本菜单开着时：Esc 只关菜单，其他键不在菜单背后翻页
  if (statusOpen.value || versionOpen.value) {
    if (e.key === "Escape") {
      statusOpen.value = versionOpen.value = false;
      e.preventDefault();
    }
    return;
  }
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
  if (mode.value !== "detail") return;
  // 弹窗（如「下载上传客户端」）打开时按键都归弹窗：不在背后翻页、取消选中
  if (document.querySelector("[role='dialog']")) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.altKey) {
    // ⌘ 组合只接管缩放，其余（⌘C、⌘F、⌘[ 等）交给浏览器
    const zoom = zoomKey(e);
    if (zoom === "in") canvas.value?.zoomIn();
    else if (zoom === "out") canvas.value?.zoomOut();
    else if (zoom === "reset") canvas.value?.zoomTo(1);
    else return;
    e.preventDefault();
    return;
  }
  if (e.altKey) return;
  // ⇧1 / ⇧2 按物理键判断：不同键盘布局下 ⇧1 打出的字符不一样
  if (e.shiftKey && e.code === "Digit1") canvas.value?.fit();
  else if (e.shiftKey && e.code === "Digit2") {
    if (nodeId.value) canvas.value?.focusNode(nodeId.value, true);
  } else if (e.key === "?") showHelp.value = !showHelp.value;
  else if (e.key === "Enter" || e.key === "Tab") {
    // 没选中图层、或焦点在按钮 / 链接上时不接管：Enter 激活按钮、Tab 切换焦点照常工作
    if (!nodeId.value || t?.closest?.("button, a[href], [role='button'], summary")) return;
    if (e.key === "Enter") moveSelection(e.shiftKey ? "parent" : "child");
    else moveSelection(e.shiftKey ? "prev" : "next");
  } else if (e.key === "ArrowLeft" && !e.shiftKey) step(-1);
  else if (e.key === "ArrowRight" && !e.shiftKey) step(1);
  else if (e.key === "Escape") {
    if (showHelp.value) showHelp.value = false;
    else if (nodeId.value) selectNode(null);
    else toOverview();
  } else return;
  e.preventDefault();
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
  if (!version.value) {
    loadingPages.value = false;
    return;
  }
  loadingPages.value = true;
  try {
    const v = version.value;
    const [list, ch] = await Promise.all([
      api<{ pages: Page[]; sections: Array<{ name: string; pageIds: string[]; inferred: boolean }> }>("GET", `/designs/${props.id}/versions/${v}/pages`),
      api<{ changes: Changes }>("GET", `/designs/${props.id}/versions/${v}/changes`),
    ]);
    if (v !== version.value) return;
    pages.value = list.pages;
    // 大稿默认把组都收起来（选中画板所在的组除外），树太长没法看
    if (!sections.value.length && list.sections.length > 1 && list.pages.length > 60) {
      const keep = list.pages.find((pg) => pg.id === boardId.value)?.section;
      for (const sec of list.sections) if (sec.name !== keep) collapsed.add(sec.name);
    }
    sections.value = list.sections;
    changes.value = ch.changes;
    if (ch.changes.base === null) onlyChanged.value = false;
    if (boardId.value && !pages.value.some((p) => p.id === boardId.value)) go({ board: undefined, mode: undefined });
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loadingPages.value = false;
  }
}

/** 单页 / 总览切换：进单页时没选画板就看第一个 */
function toDetail() {
  const id = boardId.value ?? pages.value[0]?.id;
  if (id) openBoard(id);
}

async function setStatus(s: DesignStatus) {
  statusOpen.value = false;
  try {
    design.value = (await api<{ design: Design }>("PATCH", `/designs/${props.id}`, { status: s })).design;
    toast.success(`状态已改为「${STATUS_LABEL[s]}」`);
  } catch (e) {
    toast.error((e as Error).message);
  }
}

async function rollback(n: number) {
  const ok = await confirmDialog({
    title: `回滚到 v${n}？`,
    message: `团队成员和 AI 默认看到的会变成 v${n}。之后的版本仍保留在历史里，可以随时切回。`,
    confirmText: "回滚",
  });
  if (!ok) return;
  try {
    await api("POST", `/designs/${props.id}/rollback`, { version: n });
    await loadDesign();
    go({ v: undefined });
    toast.success(`当前版本已切回 v${n}`);
  } catch (e) {
    toast.error((e as Error).message);
  }
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

const commentsLoading = ref(true);
const commentsError = ref("");
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
    toast.error((e as Error).message);
  } finally {
    sending.value = false;
  }
}

async function removeComment(c: Comment) {
  if (!(await confirmDialog({ title: "删除这条评论？", message: "删除后不能恢复。", confirmText: "删除", danger: true }))) return;
  try {
    await api("DELETE", `/comments/${c.id}`);
    comments.value = comments.value.filter((x) => x.id !== c.id);
  } catch (e) {
    toast.error((e as Error).message);
  }
}

/** 把 @用户名 拆出来高亮 */
function parts(body: string): Array<{ text: string; at: boolean }> {
  return body.split(/(@[A-Za-z0-9._-]{2,64})/g).filter(Boolean).map((text) => ({ text, at: text.startsWith("@") && members.value.some((m) => `@${m.username}` === text) }));
}

watch(version, () => void loadPages());
watch(pageId, () => {
  highlightIds.value = [];
  showHelp.value = false;
});
// 单页视图默认看标注；回到总览时标注 / 切图没有对象，换回评论
watch(
  mode,
  (m) => {
    if (m === "detail" && (panel.value === "comments" || panel.value === "changes") && !route.query.tab) panel.value = "inspect";
    if (m === "overview" && (panel.value === "inspect" || panel.value === "slices")) panel.value = "comments";
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  clearImages();
});
onMounted(async () => {
  window.addEventListener("keydown", onKey);
  // 旧链接 ?page= 换成单页视图
  if (typeof route.query.page === "string") go({ board: route.query.page, mode: "detail", page: undefined });
  await loadDesign();
  // 评论与画板列表并行加载：评论不用等大稿的页面数据
  const commentsDone = loadComments()
    .catch((e) => (commentsError.value = (e as Error).message))
    .finally(() => (commentsLoading.value = false));
  await loadPages();
  await commentsDone;
  members.value = (await api<{ members: Array<{ username: string; displayName: string }> }>("GET", "/team/members").catch(() => ({ members: [] }))).members;
});
</script>

<template>
  <div class="dpage">
    <!-- 顶栏：返回、名称与状态、版本、视图切换、操作 -->
    <header class="dtop">
      <RouterLink v-if="project" :to="`/projects/${project.id}`" class="button ghost icon-btn" :title="`返回「${project.name}」`"><ArrowLeft :size="16" /></RouterLink>
      <div class="dtitle">
        <RouterLink v-if="project" :to="`/projects/${project.id}`" class="crumb truncate">{{ project.name }}</RouterLink>
        <span class="slash">/</span>
        <strong class="truncate">{{ design?.name ?? "" }}</strong>
        <div v-if="design" class="pop-wrap">
          <button class="status" :class="STATUS_TAG[design.status]" :disabled="!canEdit" :title="canEdit ? '修改状态' : ''" @click="statusOpen = !statusOpen">
            <span class="sdot" />{{ STATUS_LABEL[design.status] }}<ChevronDown v-if="canEdit" :size="12" />
          </button>
          <div v-if="statusOpen" class="popover statusmenu">
            <button v-for="s in (['draft', 'review', 'published'] as DesignStatus[])" :key="s" class="menu-item" @click="setStatus(s)">
              <span class="tag dot" :class="STATUS_TAG[s]">{{ STATUS_LABEL[s] }}</span>
            </button>
          </div>
          <div v-if="statusOpen" class="veil" @click="statusOpen = false" />
        </div>
      </div>

      <div v-if="versions.length" class="pop-wrap">
        <button class="ghost vbtn" :class="{ on: versionOpen }" @click="versionOpen = !versionOpen">
          <History :size="15" />v{{ version }}<span v-if="versionRow && !versionRow.current" class="tag gray">历史</span><ChevronDown :size="13" />
        </button>
        <div v-if="versionOpen" class="popover versions">
          <div class="vhead">版本历史</div>
          <button v-for="v in versions" :key="v.number" class="vitem" :class="{ on: v.number === version }" @click="(go({ v: v.number }), (versionOpen = false))">
            <span class="vnum">v{{ v.number }}</span>
            <span class="vbody">
              <span class="vnote truncate">{{ v.note || "没有版本说明" }}</span>
              <span class="vmeta">{{ v.uploader ?? "未知" }} · <span :title="formatTime(v.createdAt)">{{ relativeTime(v.createdAt) }}</span> · {{ formatBytes(v.size) }}<template v-if="v.changes && v.changes.base !== null"> · {{ summaryText(v.changes) }}</template></span>
            </span>
            <span v-if="v.current" class="tag green">当前</span>
          </button>
        </div>
        <div v-if="versionOpen" class="veil" @click="versionOpen = false" />
      </div>
      <button v-if="canEdit && versionRow && !versionRow.current" class="sm" @click="rollback(versionRow.number)"><RotateCcw :size="13" />回滚到此版本</button>

      <span class="spacer" />

      <div v-if="pages.length" class="segmented">
        <button :class="{ active: mode === 'overview' }" title="全部画板" @click="toOverview"><LayoutGrid :size="14" />总览</button>
        <button :class="{ active: mode === 'detail' }" title="单个画板，查看标注与切图" @click="toDetail"><SquareMousePointer :size="14" />标注</button>
      </div>
      <span class="vsep" />
      <a v-if="version && pageId" class="button ghost icon-btn" :href="`/api/v1/designs/${id}/versions/${version}/nodes/${encodeURIComponent(pageId)}/svg`" title="把选中的画板导出为 SVG（图片内嵌）"><Download :size="16" /></a>
      <button v-if="canEdit" class="ghost" title="新版本用上传客户端发布" @click="openClient()"><Upload :size="15" />上传新版本</button>
      <button class="ghost icon-btn" :class="{ on: showTree }" :title="showTree ? '收起画板列表' : '展开画板列表'" @click="showTree = !showTree"><PanelLeft :size="16" /></button>
      <button class="ghost icon-btn" :class="{ on: showPanel }" :title="showPanel ? '收起右侧面板' : '展开右侧面板'" @click="showPanel = !showPanel"><PanelRight :size="16" /></button>
    </header>

    <p v-if="error" class="derror">{{ error }}</p>

    <div class="dbody">
      <!-- 画板列表 -->
      <aside v-if="showTree" class="tree">
        <div class="tsearch">
          <div class="search-box">
            <Search :size="14" />
            <input v-model="filter" placeholder="搜索画板" />
          </div>
        </div>
        <div class="tmeta">
          <span>{{ filtering ? `${shownPages.length} / ${pages.length}` : `${pages.length} 个画板` }}</span>
          <span class="spacer" />
          <label v-if="changedHere.size" class="only"><input v-model="onlyChanged" type="checkbox" />只看本版改动 {{ changedHere.size }}</label>
        </div>
        <div class="tlist">
          <template v-if="loadingPages">
            <div v-for="i in 10" :key="i" class="skeleton tsk" :style="{ width: `${60 + ((i * 37) % 35)}%` }" />
          </template>
          <template v-for="s in tree" :key="s.name">
            <button class="sec" :title="sections.find((x) => x.name === s.name)?.inferred ? '按画布位置自动分组' : s.name" @click="toggleSection(s.name)" @dblclick="mode === 'overview' && overview?.focusSection(s.name)">
              <ChevronRight :size="13" class="caret" :class="{ open: !collapsed.has(s.name) || filtering }" />
              <Folder :size="14" class="ficon" />
              <span class="sname">{{ s.name }}</span>
              <span class="cnt">{{ filtering ? `${s.pages.length}/${s.total}` : s.total }}</span>
            </button>
            <template v-if="!collapsed.has(s.name) || filtering">
              <button
                v-for="p in s.pages"
                :key="p.id"
                class="pitem"
                :class="{ active: p.id === pageId }"
                :title="`${p.name} · ${p.width} × ${p.height}`"
                @click="select(p.id)"
                @dblclick="openBoard(p.id)"
              >
                <Hash :size="12" class="hash" /><span class="pname">{{ p.name }}</span><span v-if="changedHere.has(p.id)" class="dot" title="本版改动" />
              </button>
            </template>
          </template>
          <p v-if="!loadingPages && version && !tree.length" class="tnone">没有匹配的画板</p>
        </div>
      </aside>

      <!-- 画布 -->
      <div class="stage">
        <EmptyState v-if="design && !design.currentVersion" :icon="Upload" title="还没有上传任何版本" :hint="canEdit ? '用上传客户端选择这个设计稿，发布 .sqraft 文件后就能在这里查看。' : '设计师发布第一个版本后就能在这里查看。'">
          <button v-if="canEdit" class="primary" @click="openClient()"><Download :size="15" />下载上传客户端</button>
        </EmptyState>
        <template v-else-if="version">
          <OverviewCanvas
            v-if="mode === 'overview'"
            ref="overview"
            :design-id="id"
            :version="version"
            :pages="pages"
            :sections="sections"
            :selected="boardId"
            :changed="changedHere"
            @select="(pid) => select(pid, false)"
            @open="openBoard"
          />
          <template v-else-if="pageId">
            <div class="pagebar">
              <button class="ghost sm" title="回到总览（Esc）" @click="toOverview"><LayoutGrid :size="13" />总览</button>
              <span class="psep" />
              <strong class="ptitle">{{ currentPage?.name }}</strong>
              <span v-if="currentPage" class="pmeta">{{ currentPage.section }} · {{ currentPage.width }} × {{ currentPage.height }}</span>
              <span class="spacer" />
              <button class="ghost sm icon-btn" :disabled="pageIndex <= 0" title="上一个（←）" @click="step(-1)"><ChevronLeft :size="15" /></button>
              <span class="pos">{{ pageIndex + 1 }} / {{ pages.length }}</span>
              <button class="ghost sm icon-btn" :disabled="pageIndex < 0 || pageIndex >= pages.length - 1" title="下一个（→）" @click="step(1)"><ChevronRight :size="15" /></button>
              <button class="ghost sm icon-btn" title="快捷键（?）" @click="showHelp = !showHelp"><Keyboard :size="15" /></button>
            </div>
            <CanvasViewer ref="canvas" :design-id="id" :version="version" :page-id="pageId" :selected="nodeId" :highlight-ids="highlightIds" @select="selectNode" />
            <div v-if="showHelp" class="help" @click.self="showHelp = false">
              <div class="hcard">
                <div class="hhead">
                  <strong>快捷键</strong>
                  <button class="ghost sm" @click="showHelp = false">关闭</button>
                </div>
                <div v-for="[k, d] in SHORTCUTS" :key="k" class="hrow"><span class="hdesc">{{ d }}</span><span class="hkeys"><kbd v-for="part in k.split(' / ')" :key="part">{{ part }}</kbd></span></div>
              </div>
            </div>
          </template>
        </template>
        <div v-else-if="!error" class="skeleton stage-sk" />
      </div>

      <!-- 右侧面板 -->
      <aside v-if="showPanel" class="panel" :class="{ wide: mode === 'detail' }">
        <div class="ptabs">
          <template v-if="mode === 'detail' && pageId">
            <button :class="{ active: panel === 'inspect' }" @click="panel = 'inspect'">标注</button>
            <button :class="{ active: panel === 'slices' }" @click="panel = 'slices'">切图</button>
          </template>
          <button :class="{ active: panel === 'comments' }" @click="panel = 'comments'">评论<span v-if="comments.length" class="pcount">{{ comments.length }}</span></button>
          <button :class="{ active: panel === 'changes' }" @click="panel = 'changes'">变更</button>
        </div>

        <InspectPanel
          v-if="panel === 'inspect' && mode === 'detail' && pageId && version"
          :design-id="id"
          :version="version"
          :page-id="pageId"
          :node-id="nodeId"
          @select="selectNode"
        />
        <SlicesPanel
          v-else-if="panel === 'slices' && mode === 'detail' && pageId && version"
          :design-id="id"
          :version="version"
          :page-id="pageId"
          :node-id="nodeId"
          @select="selectNode"
          @locate="locateNode"
          @highlight="(ids) => (highlightIds = ids)"
        />

        <!-- 评论 -->
        <div v-else-if="panel === 'comments'" class="pbody comments">
          <div class="clist-wrap">
            <template v-if="commentsLoading">
              <div v-for="i in 3" :key="i" class="comment">
                <div class="skeleton" style="width: 28px; height: 28px; border-radius: 50%" />
                <div class="cb"><div class="skeleton" style="height: 12px; width: 40%; margin: 5px 0 10px" /><div class="skeleton" style="height: 12px; width: 85%" /></div>
              </div>
            </template>
            <EmptyState v-else-if="commentsError" :icon="MessageSquare" title="评论加载失败" :hint="commentsError">
              <button class="sm" @click="((commentsError = ''), (commentsLoading = true), loadComments().catch((e) => (commentsError = e.message)).finally(() => (commentsLoading = false)))">重试</button>
            </EmptyState>
            <EmptyState v-else-if="!comments.length" :icon="MessageSquare" title="还没有评论" hint="对当前画板说点什么，输入 @ 可以提到成员。" />
            <div v-for="c in comments" :key="c.id" class="comment">
              <Avatar :name="c.author?.displayName ?? '?'" :size="28" />
              <div class="cb">
                <div class="chead">
                  <span class="cname">{{ c.author?.displayName ?? "已删除的用户" }}</span>
                  <span class="ctime" :title="formatTime(c.createdAt)">{{ relativeTime(c.createdAt) }}</span>
                  <span class="spacer" />
                  <button v-if="c.canDelete" class="ghost sm icon-btn cdel" title="删除评论" @click="removeComment(c)"><Trash2 :size="13" /></button>
                </div>
                <div class="ctext"><span v-for="(seg, i) in parts(c.body)" :key="i" :class="{ at: seg.at }">{{ seg.text }}</span></div>
                <div v-if="c.version || (c.pageId && pageName(c.pageId))" class="cmeta">
                  <span v-if="c.version" class="chip">v{{ c.version }}</span>
                  <button v-if="c.pageId && pageName(c.pageId)" class="chip link" @click="go({ v: c.version ?? undefined, board: c.pageId!, mode: 'detail' })"><Hash :size="11" />{{ pageName(c.pageId) }}</button>
                </div>
              </div>
            </div>
          </div>
          <div class="composer">
            <div v-if="suggestions.length" class="popover suggest">
              <button v-for="m in suggestions" :key="m.username" class="menu-item" @mousedown.prevent="pickMention(m.username)">
                <Avatar :name="m.displayName" :size="20" />{{ m.displayName }}<span class="smuted">@{{ m.username }}</span>
              </button>
            </div>
            <textarea
              ref="commentBox"
              v-model="draft"
              rows="3"
              maxlength="2000"
              :placeholder="currentPage ? `评论「${currentPage.name}」…` : '评论这个设计稿…'"
              @input="onDraftInput"
              @keydown.enter.meta.prevent="send"
              @keydown.enter.ctrl.prevent="send"
              @keydown.esc="mention = null"
            />
            <div class="cfoot">
              <span class="chint">@ 提到成员 · ⌘ Enter 发送</span>
              <button class="primary sm" :disabled="!draft.trim() || sending" @click="send"><Send :size="13" />发送</button>
            </div>
          </div>
        </div>

        <!-- 变更 -->
        <div v-else-if="panel === 'changes'" class="pbody">
          <EmptyState v-if="!changes" :icon="FileDiff" title="选择一个版本查看变更" />
          <EmptyState v-else-if="changes.base === null" :icon="FileDiff" title="这是第一个版本" hint="所有画板都是新增的。" />
          <template v-else>
            <div class="csum">相对 v{{ changes.base }}：{{ summaryText(versionRow?.changes) }}</div>
            <ul class="chglist">
              <li v-for="c in changes.pages.modified" :key="`m${c.id}`">
                <span class="tag">修改</span><button class="link truncate" @click="openBoard(c.id)">{{ c.name }}</button>
                <span v-if="c.from" class="cfrom">原名 {{ c.from }}</span>
              </li>
              <li v-for="c in changes.pages.added" :key="`a${c.id}`"><span class="tag green">新增</span><button class="link truncate" @click="openBoard(c.id)">{{ c.name }}</button></li>
              <li v-for="c in changes.pages.removed" :key="`r${c.id}`"><span class="tag red">删除</span><span class="truncate cgone">{{ c.name }}</span></li>
              <li v-for="c in changes.pages.renamed" :key="`n${c.id}`">
                <span class="tag gray">改名</span><button class="link truncate" @click="openBoard(c.id)">{{ c.name }}</button><span class="cfrom">原名 {{ c.from }}</span>
              </li>
              <li v-for="c in changes.pages.moved" :key="`v${c.id}`"><span class="tag gray">挪动</span><button class="link truncate" @click="openBoard(c.id)">{{ c.name }}</button></li>
            </ul>
            <div v-if="changes.components.added.length + changes.components.modified.length + changes.components.removed.length" class="cextra">
              组件：新增 {{ changes.components.added.length }}、修改 {{ changes.components.modified.length }}、删除 {{ changes.components.removed.length }}
            </div>
            <div v-if="changes.tokens.added.length + changes.tokens.modified.length + changes.tokens.removed.length" class="cextra">
              Token：{{ [...changes.tokens.added, ...changes.tokens.modified, ...changes.tokens.removed].slice(0, 8).join("、") }}
            </div>
          </template>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.dpage {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--panel);
}
/* ── 顶栏 ── */
.dtop {
  height: 48px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
  position: relative;
  z-index: 10;
}
.dtitle {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  margin-right: 6px;
}
.crumb {
  color: var(--muted);
  max-width: 180px;
}
.crumb:hover {
  color: var(--text);
}
.slash {
  color: var(--faint);
}
.dtitle strong {
  font-weight: 600;
  max-width: 320px;
}
.pop-wrap {
  position: relative;
  flex-shrink: 0;
}
.veil {
  position: fixed;
  inset: 0;
  z-index: 30;
}
.status {
  height: 22px;
  padding: 0 8px;
  gap: 5px;
  border: none;
  box-shadow: none;
  border-radius: 999px;
  font-size: 11.5px;
  background: var(--brand-soft);
  color: var(--brand);
}
.status:hover:not(:disabled) {
  background: var(--brand-soft-2);
}
.status:disabled {
  opacity: 1;
}
.status.yellow {
  background: var(--warning-soft);
  color: var(--warning);
}
.status.green {
  background: var(--ok-soft);
  color: var(--ok);
}
.sdot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.statusmenu {
  top: calc(100% + 6px);
  left: 0;
  min-width: 140px;
}
.vbtn {
  gap: 5px;
  font-variant-numeric: tabular-nums;
}
.vbtn.on,
.ghost.on {
  background: var(--active);
  color: var(--text);
}
.versions {
  top: calc(100% + 6px);
  left: 0;
  width: 400px;
  max-height: 60vh;
  overflow-y: auto;
}
.vhead {
  font-size: 11px;
  font-weight: 550;
  color: var(--muted);
  padding: 8px 10px 4px;
}
.vitem {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  height: auto;
  padding: 8px 10px;
  border: none;
  background: none;
  box-shadow: none;
  border-radius: 6px;
  text-align: left;
  font-weight: 400;
  justify-content: flex-start;
}
.vitem:hover:not(:disabled) {
  background: var(--hover);
}
.vitem.on {
  background: var(--brand-soft);
}
.vnum {
  font-weight: 650;
  min-width: 28px;
  font-variant-numeric: tabular-nums;
}
.vbody {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.vnote {
  color: var(--text);
  font-weight: 500;
}
.vmeta {
  font-size: 12px;
  color: var(--muted);
  white-space: normal;
}
.vsep {
  width: 1px;
  height: 20px;
  background: var(--border);
  margin: 0 4px;
}
.segmented button {
  gap: 5px;
}
.derror {
  margin: 0;
  padding: 8px 16px;
  background: var(--danger-soft);
  color: var(--danger);
  border-bottom: 1px solid var(--border);
}
/* ── 三栏 ── */
.dbody {
  flex: 1;
  min-height: 0;
  display: flex;
}
.tree {
  width: 248px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  background: var(--panel);
  min-height: 0;
}
.tsearch {
  padding: 10px 10px 6px;
}
.tsearch .search-box {
  width: 100%;
  height: 30px;
}
.tmeta {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 14px 6px;
  font-size: 12px;
  color: var(--muted);
}
.only {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--text-2);
  cursor: pointer;
}
.tlist {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 6px 12px;
}
.tsk {
  height: 14px;
  margin: 10px 8px;
}
.tnone {
  padding: 12px 10px;
  color: var(--muted);
}
.sec {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  height: 30px;
  border: none;
  background: none;
  box-shadow: none;
  padding: 0 6px;
  justify-content: flex-start;
  color: var(--text);
  font-weight: 600;
}
.sec:hover:not(:disabled) {
  background: var(--hover);
}
.caret {
  color: var(--muted);
  transition: transform 0.12s var(--ease);
}
.caret.open {
  transform: rotate(90deg);
}
.ficon {
  color: var(--muted);
}
.sname {
  flex: 1;
  min-width: 0;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cnt {
  font-size: 11px;
  font-weight: 450;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.pitem {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 28px;
  justify-content: flex-start;
  text-align: left;
  border: none;
  background: none;
  box-shadow: none;
  font-weight: 450;
  color: var(--text-2);
  padding: 0 8px 0 28px;
  white-space: nowrap;
}
.pitem:hover:not(:disabled) {
  background: var(--hover);
  color: var(--text);
}
.pitem.active,
.pitem.active:hover:not(:disabled) {
  background: var(--brand-soft);
  color: var(--brand);
  font-weight: 550;
}
.hash {
  color: var(--faint);
}
.pitem.active .hash {
  color: var(--brand);
}
.pname {
  overflow: hidden;
  text-overflow: ellipsis;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--brand);
  flex-shrink: 0;
}
/* ── 画布区 ── */
.stage {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--canvas-bg);
}
.stage > .empty {
  margin: auto;
}
.stage-sk {
  position: absolute;
  inset: 24px;
  border-radius: var(--radius);
}
.pagebar {
  height: 40px;
  flex-shrink: 0;
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 0 8px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}
.psep {
  width: 1px;
  height: 16px;
  background: var(--border);
  margin: 0 2px;
}
.ptitle {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex-shrink: 1;
}
.pmeta {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  flex-shrink: 2;
  font-size: 12px;
  color: var(--muted);
}
.pos {
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.help {
  position: absolute;
  inset: 0;
  z-index: 20;
  background: rgba(16, 20, 34, 0.24);
  display: grid;
  place-items: center;
  animation: fade 0.12s var(--ease);
}
.hcard {
  width: 380px;
  max-width: calc(100% - 32px);
  background: var(--panel);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  padding: 8px 16px 14px;
}
.hhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0 8px;
}
.hrow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 30px;
  border-top: 1px solid var(--border);
}
.hdesc {
  color: var(--text-2);
}
.hkeys {
  display: flex;
  gap: 4px;
}
/* ── 右侧面板 ── */
.panel {
  width: 300px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border-left: 1px solid var(--border);
  min-height: 0;
}
.panel.wide {
  width: 320px;
}
.ptabs {
  display: flex;
  gap: 2px;
  height: 40px;
  padding: 0 8px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.ptabs button {
  height: 40px;
  border: none;
  border-radius: 0;
  background: none;
  box-shadow: none;
  padding: 0 10px;
  color: var(--muted);
  font-weight: 550;
  gap: 5px;
}
.ptabs button:hover:not(:disabled) {
  background: none;
  color: var(--text);
}
.ptabs button.active {
  color: var(--text);
  box-shadow: inset 0 -2px 0 var(--text);
}
.pcount {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--hover);
  color: var(--text-2);
  font-size: 11px;
  display: inline-grid;
  place-items: center;
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
/* 评论 */
.comments {
  padding: 0;
  overflow: hidden;
  gap: 0;
}
.clist-wrap {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 12px;
}
.comment {
  display: flex;
  gap: 10px;
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
}
.comment:last-child {
  border-bottom: none;
}
.cb {
  flex: 1;
  min-width: 0;
}
.chead {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 22px;
}
.cname {
  font-weight: 600;
}
.ctime {
  font-size: 12px;
  color: var(--muted);
}
.cdel {
  opacity: 0;
  color: var(--muted);
}
.comment:hover .cdel,
.cdel:focus-visible {
  opacity: 1;
}
.ctext {
  color: var(--text);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.at {
  color: var(--brand);
  font-weight: 550;
}
.cmeta {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 20px;
  font-size: 11.5px;
  background: var(--hover);
  border-radius: 5px;
  padding: 0 6px;
  color: var(--text-2);
  font-weight: 500;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
}
button.chip:hover:not(:disabled) {
  background: var(--active);
  color: var(--text);
}
.composer {
  position: relative;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid var(--border);
  background: var(--panel);
}
.composer textarea {
  width: 100%;
  resize: none;
}
.cfoot {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.chint {
  font-size: 11.5px;
  color: var(--muted);
}
.suggest {
  bottom: calc(100% - 4px);
  left: 12px;
  right: 12px;
}
.smuted {
  color: var(--muted);
  font-size: 12px;
}
/* 变更 */
.csum {
  color: var(--text-2);
  padding: 2px 2px 6px;
}
.chglist {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
}
.chglist li {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  border-bottom: 1px solid var(--border);
}
.chglist .link {
  font-weight: 500;
  color: var(--text);
  max-width: 180px;
  display: block;
}
.chglist .link:hover:not(:disabled) {
  color: var(--brand);
}
.cfrom,
.cgone {
  color: var(--muted);
  font-size: 12px;
}
.cextra {
  color: var(--text-2);
  font-size: 12px;
  padding-top: 8px;
}
@keyframes fade {
  from {
    opacity: 0;
  }
}
@media (max-width: 1000px) {
  .tree {
    display: none;
  }
}
@media (max-width: 760px) {
  .dbody {
    flex-direction: column;
  }
  .panel,
  .panel.wide {
    width: auto;
    height: 320px;
    border-left: none;
    border-top: 1px solid var(--border);
  }
  .stage {
    min-height: 420px;
  }
}
</style>
