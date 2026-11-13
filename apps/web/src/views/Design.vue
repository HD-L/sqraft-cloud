<script setup lang="ts">
/**
 * 设计稿查看：左侧按分组列出画板，中间两种视图——
 * - 总览：全部画板按画布位置铺开（缩略图），单击选中、双击进入；
 * - 单页：只看一个画板，上一个 / 下一个翻页（← →），Esc 回总览；画布缩放与图层导航有快捷键（? 查看）。
 * 右侧面板是标注、切图、评论与版本变更。新版本只通过上传客户端发布，网页不提供上传。
 * 状态只由评审动作驱动：顶栏按状态与身份给出「提交评审 / 通过 / 退回 / 撤回 / 直接发布 / 改回草稿」，
 * 评论面板里评审事件与评论按时间混排，评论可标为已解决。
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
import Modal from "../components/Modal.vue";
import { api, ApiError, formatBytes, formatTime, relativeTime, session, STATUS_LABEL, STATUS_TAG, type DesignStatus } from "../api";
import { confirmDialog, openClient, toast } from "../ui";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleX,
  ClipboardCheck,
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
  Rocket,
  RotateCcw,
  Search,
  Send,
  SquareMousePointer,
  Trash2,
  Undo2,
  Upload,
  UserPen,
} from "lucide-vue-next";
import EmptyState from "../components/EmptyState.vue";

const props = defineProps<{ id: string }>();
const route = useRoute();
const router = useRouter();

interface Person {
  id: string;
  displayName: string;
}
/** 进行中的一轮评审（只在评审中时有值） */
interface OpenReview {
  id: string;
  /** 跟着评审中上传 / 回滚的版本变化 */
  version: number | null;
  note: string;
  requestedBy: Person | null;
  /** valid=false：评审人已停用或已看不到这个项目 */
  reviewers: Array<Person & { valid: boolean }>;
  createdAt: number;
}
interface Design {
  id: string;
  projectId: string;
  name: string;
  status: DesignStatus;
  currentVersion: number | null;
  latestVersion: number | null;
  commentCount: number;
  /** 最近一次通过评审（或直接发布）的版本；改回草稿后仍保留 */
  approvedVersion: number | null;
  approvedAt: number | null;
  /** approvedVersion 有值而它为 null：评审功能上线前就已发布 */
  approvedBy: Person | null;
  openReview: OpenReview | null;
  /** 当前用户能否通过 / 退回（服务端计算） */
  canReview: boolean;
  unresolvedCount: number;
}
type ReviewAction = "submit" | "approve" | "reject" | "withdraw" | "publish" | "unpublish" | "reviewers";
/** 评审时间线上的一个事件（服务端已整理好） */
interface ReviewEvent {
  type: "submit" | "approve" | "reject" | "withdraw" | "publish_direct" | "unpublish" | "reviewers";
  at: number;
  actor: Person | null;
  version: number | null;
  note: string | null;
  reviewId: string | null;
  reviewers?: Person[];
  byAdmin?: boolean;
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
  resolved: boolean;
  resolvedAt: number | null;
  resolvedBy: { id: string; username: string; displayName: string } | null;
  /** 评审上线前已发布设计稿上的旧评论（已自动标为已解决） */
  legacy: boolean;
  canResolve: boolean;
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

// ── 评审 ──
const reviewEvents = ref<ReviewEvent[]>([]);
const reviewBusy = ref(false);
/** 状态下拉里能做的事：只有编辑者有 */
const statusMenu = computed<Array<"submit" | "publish" | "withdraw" | "reviewers" | "resubmit" | "unpublish">>(() => {
  const d = design.value;
  if (!d || !canEdit.value) return [];
  if (d.status === "draft") return ["submit", "publish"];
  if (d.status === "review") return ["withdraw", "reviewers"];
  return ["resubmit", "unpublish"];
});
/** 已发布后又上传了新版本 */
const changedSincePublish = computed(() => {
  const d = design.value;
  return !!d && d.status === "published" && d.approvedVersion !== null && d.approvedVersion !== d.currentVersion;
});
const statusTitle = computed(() => {
  const d = design.value;
  if (!d) return "";
  if (d.status === "review" && d.openReview) {
    const r = d.openReview;
    const who = r.requestedBy ? `${r.requestedBy.displayName} ` : "";
    const names = r.reviewers.map((x) => x.displayName).join("、");
    return `${who}提交评审 v${r.version ?? "—"}${names ? ` · 评审人 ${names}` : " · 未指定评审人，任一编辑者可评审"}`;
  }
  if (d.status === "published" && d.approvedVersion !== null) {
    if (!d.approvedBy) return `v${d.approvedVersion} 在评审功能上线前已发布`;
    return `${d.approvedBy.displayName} 于 ${formatTime(d.approvedAt)} 发布 v${d.approvedVersion}`;
  }
  return canEdit.value ? "修改状态" : "";
});

async function loadReviews() {
  reviewEvents.value = (await api<{ events: ReviewEvent[] }>("GET", `/designs/${props.id}/reviews`).catch(() => ({ events: [] }))).events;
}

/** 发一个评审动作，成功返回 true；409（版本冲突、状态已变）时提示并刷新 */
async function review(action: ReviewAction, body: { reviewers?: string[]; note?: string; version?: number } = {}, done?: string): Promise<boolean> {
  statusOpen.value = false;
  if (reviewBusy.value) return false;
  reviewBusy.value = true;
  try {
    design.value = (await api<{ design: Design }>("POST", `/designs/${props.id}/review`, { action, ...body })).design;
    if (done) toast.success(done);
    void loadReviews();
    return true;
  } catch (e) {
    toast.error((e as Error).message);
    if (e instanceof ApiError && e.status === 409) {
      // 状态已被别人改过：弹窗里的操作不再适用，关掉免得一直 409
      submitMode.value = null;
      rejecting.value = false;
      await loadDesign();
      void loadReviews();
    }
    return false;
  } finally {
    reviewBusy.value = false;
  }
}

async function approve() {
  const d = design.value;
  if (!d?.currentVersion) return;
  const v = d.currentVersion;
  const n = unresolved.value;
  if (n > 0 && !(await confirmDialog({ title: `还有 ${n} 条未解决评论，仍要通过？`, message: `通过后「${d.name}」v${v} 会变成已发布。`, confirmText: "仍要通过" }))) return;
  await review("approve", { version: v }, `已通过 v${v}`);
}

async function publishDirect() {
  statusOpen.value = false;
  const d = design.value;
  if (!d) return;
  const ok = await confirmDialog({
    title: `直接发布 v${d.currentVersion ?? "—"}？`,
    message: "跳过评审直接变成已发布，评审记录里会标「未经评审」。",
    confirmText: "直接发布",
  });
  if (ok) await review("publish", {}, "已发布（未经评审）");
}

async function withdraw() {
  statusOpen.value = false;
  if (await confirmDialog({ title: "撤回这次评审？", message: "设计稿会回到提交评审前的状态。", confirmText: "撤回" })) await review("withdraw", {}, "已撤回评审");
}

async function unpublish() {
  statusOpen.value = false;
  if (await confirmDialog({ title: "改回草稿？", message: "设计稿会变回草稿，之前通过的版本记录会保留。", confirmText: "改回草稿" })) await review("unpublish", {}, "已改回草稿");
}

// 提交评审 / 修改评审人 弹窗
interface Candidate {
  id: string;
  username: string;
  displayName: string;
}
const submitMode = ref<"submit" | "reviewers" | null>(null);
const pickedReviewers = ref<string[]>([]);
const submitNote = ref("");
const reviewerQuery = ref("");
const candidates = ref<Candidate[]>([]);
const candidatesLoading = ref(false);
const shownCandidates = computed(() => {
  const q = reviewerQuery.value.trim().toLowerCase();
  return candidates.value.filter((c) => !q || c.displayName.toLowerCase().includes(q) || c.username.toLowerCase().includes(q));
});

/** 可评审的人：服务端按「未停用且能看到这个项目」过滤好的成员 */
async function loadCandidates() {
  candidatesLoading.value = true;
  try {
    candidates.value = (await api<{ members: Candidate[] }>("GET", `/designs/${props.id}/reviewer-candidates`)).members;
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    candidatesLoading.value = false;
  }
}

function openSubmit(mode: "submit" | "reviewers") {
  statusOpen.value = false;
  submitMode.value = mode;
  submitNote.value = "";
  reviewerQuery.value = "";
  // 已失效的评审人（停用 / 看不到项目）不在候选里、取消不了勾选，不预选，保存时自然去掉
  pickedReviewers.value = mode === "reviewers" ? (design.value?.openReview?.reviewers.filter((r) => r.valid).map((r) => r.id) ?? []) : [];
  void loadCandidates();
}

/** 搜索框里按 Enter：勾选第一个还没选的匹配项，不提交表单 */
function pickFirstMatch() {
  if (!reviewerQuery.value.trim()) return;
  const c = shownCandidates.value.find((x) => !pickedReviewers.value.includes(x.id));
  if (c) pickedReviewers.value.push(c.id);
}

function toggleReviewer(id: string) {
  const i = pickedReviewers.value.indexOf(id);
  if (i >= 0) pickedReviewers.value.splice(i, 1);
  else pickedReviewers.value.push(id);
}

async function confirmSubmit() {
  if (submitMode.value === "reviewers") {
    if (await review("reviewers", { reviewers: pickedReviewers.value }, "评审人已更新")) submitMode.value = null;
    return;
  }
  const note = submitNote.value.trim();
  const picked = pickedReviewers.value.length > 0;
  if (await review("submit", { reviewers: pickedReviewers.value, ...(note ? { note } : {}) }, picked ? "已提交评审，评审人会收到通知" : "已提交评审")) submitMode.value = null;
}

// 退回弹窗：原因必填
const rejecting = ref(false);
const rejectReason = ref("");
function openReject() {
  rejectReason.value = "";
  rejecting.value = true;
}
async function confirmReject() {
  const reason = rejectReason.value.trim();
  if (!reason) return;
  const v = design.value?.currentVersion;
  if (await review("reject", { note: reason }, v ? `已退回 v${v}` : "已退回")) rejecting.value = false;
}

/** 时间线上一个评审事件的文字 */
function eventText(e: ReviewEvent): string {
  const who = e.actor?.displayName ?? "有人";
  const admin = e.byAdmin ? "（管理员）" : "";
  const v = e.version ? ` v${e.version}` : "";
  const names = (e.reviewers ?? []).map((r) => r.displayName).join("、");
  switch (e.type) {
    case "submit":
      return `${who} 提交评审${v}${names ? ` · 评审人 ${names}` : ""}`;
    case "approve":
      return `${who}${admin} 通过了${v}`;
    case "reject":
      return `${who}${admin} 退回了${v}${e.note ? `：${e.note}` : ""}`;
    case "withdraw":
      return `${who} 撤回评审`;
    case "publish_direct":
      return `${who} 直接发布${v}（未经评审）`;
    case "unpublish":
      return `${who} 改回草稿`;
    case "reviewers":
      return names ? `${who} 修改评审人为 ${names}` : `${who} 清空了评审人`;
    default:
      return who;
  }
}
const EVENT_ICON = { submit: ClipboardCheck, approve: CircleCheck, reject: CircleX, withdraw: Undo2, publish_direct: Rocket, unpublish: RotateCcw, reviewers: UserPen };

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
    void loadReviews();
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

/** 未解决评论数：评论加载好后以本地列表为准（标记 / 新增 / 删除后立即更新），否则用设计稿上的计数 */
const unresolved = computed(() => (commentsLoading.value || commentsError.value ? (design.value?.unresolvedCount ?? 0) : comments.value.filter((c) => !c.resolved).length));
/** 隐藏已解决的评论（默认开） */
const hideResolved = ref(true);
const resolvedCount = computed(() => comments.value.filter((c) => c.resolved).length);
/** 已解决的评论默认折叠，点开看全文 */
const expanded = reactive(new Set<string>());

async function setResolved(c: Comment, resolved: boolean) {
  try {
    const res = await api<{ comment: Comment }>("POST", `/comments/${c.id}/resolve`, { resolved });
    const i = comments.value.findIndex((x) => x.id === c.id);
    if (i >= 0) comments.value[i] = res.comment;
    expanded.delete(c.id);
    if (resolved && hideResolved.value) toast.success("已标为已解决");
  } catch (e) {
    toast.error((e as Error).message);
  }
}

/** 评论与评审事件按时间混排 */
type FeedItem = { kind: "comment"; at: number; key: string; comment: Comment } | { kind: "event"; at: number; key: string; event: ReviewEvent };
const feed = computed<FeedItem[]>(() => {
  const items: FeedItem[] = [
    ...comments.value.filter((c) => !hideResolved.value || !c.resolved).map((c) => ({ kind: "comment" as const, at: c.createdAt, key: `c${c.id}`, comment: c })),
    ...reviewEvents.value.map((e, i) => ({ kind: "event" as const, at: e.at, key: `e${e.reviewId}-${e.type}-${i}`, event: e })),
  ];
  return items.sort((a, b) => a.at - b.at);
});

/** 把 @用户名 拆出来高亮 */
function parts(body: string): Array<{ text: string; at: boolean }> {
  return body.split(/(@[A-Za-z0-9._-]{2,64})/g).filter(Boolean).map((text) => ({ text, at: text.startsWith("@") && members.value.some((m) => `@${m.username}` === text) }));
}

watch(version, () => void loadPages());
watch(pageId, () => {
  highlightIds.value = [];
  showHelp.value = false;
});
// 状态变了（刷新拿到别人改过的结果）：关掉不再适用的评审弹窗
watch(
  () => design.value?.status,
  (s) => {
    if (s !== "review") rejecting.value = false;
    if (submitMode.value === "reviewers" && s !== "review") submitMode.value = null;
    if (submitMode.value === "submit" && s === "review") submitMode.value = null;
  },
);
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
  void loadReviews();
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
          <button class="status" :class="STATUS_TAG[design.status]" :disabled="!statusMenu.length || reviewBusy" :title="statusTitle" @click="statusOpen = !statusOpen">
            <span class="sdot" />{{ STATUS_LABEL[design.status] }}<ChevronDown v-if="statusMenu.length" :size="12" />
          </button>
          <div v-if="statusOpen" class="popover statusmenu">
            <template v-for="a in statusMenu" :key="a">
              <button v-if="a === 'submit' || a === 'resubmit'" class="menu-item" @click="openSubmit('submit')"><ClipboardCheck :size="15" />{{ a === "submit" ? "提交评审…" : "重新提交评审…" }}</button>
              <button v-else-if="a === 'publish'" class="menu-item" :disabled="!design.currentVersion" @click="publishDirect"><Rocket :size="15" />直接发布</button>
              <button v-else-if="a === 'withdraw'" class="menu-item" @click="withdraw"><Undo2 :size="15" />撤回</button>
              <button v-else-if="a === 'reviewers'" class="menu-item" @click="openSubmit('reviewers')"><UserPen :size="15" />修改评审人…</button>
              <button v-else-if="a === 'unpublish'" class="menu-item" @click="unpublish"><RotateCcw :size="15" />改回草稿</button>
            </template>
          </div>
          <div v-if="statusOpen" class="veil" @click="statusOpen = false" />
        </div>
        <span v-if="design?.status === 'review' && design.openReview?.reviewers.length" class="reviewers" :title="statusTitle">
          <span v-for="r in design.openReview.reviewers" :key="r.id" class="rv" :class="{ invalid: !r.valid }" :title="r.valid ? r.displayName : `${r.displayName}（已停用或看不到此项目）`">
            <Avatar :name="r.displayName" :size="20" />
          </span>
        </span>
        <span v-if="changedSincePublish" class="tag gray" :title="`发布的是 v${design?.approvedVersion}，当前是 v${design?.currentVersion}`">发布后有新改动</span>
      </div>
      <template v-if="design?.status === 'draft' && canEdit">
        <button class="sm" :disabled="reviewBusy" @click="openSubmit('submit')"><ClipboardCheck :size="13" />提交评审…</button>
      </template>
      <template v-if="design?.status === 'review' && design.canReview">
        <button class="sm primary" :disabled="reviewBusy || !design.currentVersion" :title="`通过 v${design.currentVersion ?? '—'}，变成已发布`" @click="approve"><Check :size="13" />通过</button>
        <button class="sm" :disabled="reviewBusy" @click="openReject"><CircleX :size="13" />退回…</button>
      </template>

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
          <button :class="{ active: panel === 'comments' }" @click="panel = 'comments'">评论<span v-if="unresolved" class="pcount" :title="`${unresolved} 条未解决`">{{ unresolved }}</span></button>
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
            <template v-else>
              <div v-if="resolvedCount" class="cfilter">
                <label class="only"><input v-model="hideResolved" type="checkbox" />隐藏已解决</label>
                <span class="spacer" />
                <span class="muted">{{ resolvedCount }} 条已解决</span>
              </div>
              <EmptyState v-if="!feed.length" :icon="MessageSquare" :title="comments.length ? '没有未解决的评论' : '还没有评论'" :hint="comments.length ? '已解决的评论被隐藏了。' : '对当前画板说点什么，输入 @ 可以提到成员。'" />
              <template v-for="item in feed" :key="item.key">
                <!-- 评审事件：一行灰字 -->
                <div v-if="item.kind === 'event'" class="revent" :class="item.event.type">
                  <component :is="EVENT_ICON[item.event.type] ?? ClipboardCheck" :size="13" class="eicon" />
                  <span class="etext">
                    {{ eventText(item.event) }}
                    <span class="etime" :title="formatTime(item.event.at)">· {{ relativeTime(item.event.at) }}</span>
                    <span v-if="item.event.type === 'submit' && item.event.note" class="enote">{{ item.event.note }}</span>
                  </span>
                </div>
                <div v-else class="comment" :class="{ resolved: item.comment.resolved, folded: item.comment.resolved && !expanded.has(item.comment.id) }">
                  <Avatar :name="item.comment.author?.displayName ?? '?'" :size="28" />
                  <div class="cb">
                    <div class="chead">
                      <span class="cname">{{ item.comment.author?.displayName ?? "已删除的用户" }}</span>
                      <span class="ctime" :title="formatTime(item.comment.createdAt)">{{ relativeTime(item.comment.createdAt) }}</span>
                      <span v-if="item.comment.legacy" class="tag gray rtag" title="评审功能上线前已发布设计稿上的评论，已自动标为已解决">上线前的评论</span>
                      <span
                        v-else-if="item.comment.resolved"
                        class="tag green rtag"
                        :title="item.comment.resolvedBy ? `${item.comment.resolvedBy.displayName} ${formatTime(item.comment.resolvedAt)} 标为已解决` : '已解决'"
                        >已解决</span
                      >
                      <span class="spacer" />
                      <button
                        v-if="item.comment.canResolve"
                        class="ghost sm icon-btn cact"
                        :title="item.comment.resolved ? '取消解决' : '标为已解决'"
                        :aria-label="item.comment.resolved ? '取消解决' : '标为已解决'"
                        @click="setResolved(item.comment, !item.comment.resolved)"
                      >
                        <Undo2 v-if="item.comment.resolved" :size="13" /><CircleCheck v-else :size="13" />
                      </button>
                      <button v-if="item.comment.canDelete" class="ghost sm icon-btn cact" title="删除评论" @click="removeComment(item.comment)"><Trash2 :size="13" /></button>
                    </div>
                    <button v-if="item.comment.resolved && !expanded.has(item.comment.id)" class="ctext cfold" title="展开" @click="expanded.add(item.comment.id)">{{ item.comment.body }}</button>
                    <div v-else class="ctext"><span v-for="(seg, i) in parts(item.comment.body)" :key="i" :class="{ at: seg.at }">{{ seg.text }}</span></div>
                    <div v-if="!(item.comment.resolved && !expanded.has(item.comment.id)) && (item.comment.version || (item.comment.pageId && pageName(item.comment.pageId)))" class="cmeta">
                      <span v-if="item.comment.version" class="chip" :class="{ old: item.comment.version !== design?.currentVersion }" :title="item.comment.version !== design?.currentVersion ? `评论时看的是 v${item.comment.version}，当前是 v${design?.currentVersion ?? '—'}` : ''">
                        {{ item.comment.version !== design?.currentVersion ? `针对 v${item.comment.version}` : `v${item.comment.version}` }}
                      </span>
                      <button v-if="item.comment.pageId && pageName(item.comment.pageId)" class="chip link" @click="go({ v: item.comment.version ?? undefined, board: item.comment.pageId!, mode: 'detail' })">
                        <Hash :size="11" />{{ pageName(item.comment.pageId) }}
                      </button>
                    </div>
                  </div>
                </div>
              </template>
            </template>
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

    <!-- 提交评审 / 修改评审人 -->
    <Modal v-if="submitMode" :title="submitMode === 'reviewers' ? '修改评审人' : `提交评审 v${design?.currentVersion ?? '—'}`" :width="480" @close="submitMode = null">
      <form id="submit-review-form" @submit.prevent="confirmSubmit">
        <div class="field">
          <span class="flabel">评审人<span class="muted"> · 可选，可多选</span></span>
          <div class="search-box rsearch">
            <Search :size="14" />
            <input v-model="reviewerQuery" placeholder="搜索成员" @keydown.enter.prevent="pickFirstMatch" />
          </div>
          <div class="rlist">
            <template v-if="candidatesLoading">
              <div v-for="i in 4" :key="i" class="ritem"><span class="skeleton" style="width: 20px; height: 20px; border-radius: 50%" /><span class="skeleton" style="width: 120px; height: 12px" /></div>
            </template>
            <p v-else-if="!shownCandidates.length" class="rnone">没有匹配的成员</p>
            <template v-else>
              <label v-for="c in shownCandidates" :key="c.id" class="ritem" :class="{ on: pickedReviewers.includes(c.id) }">
                <input type="checkbox" :checked="pickedReviewers.includes(c.id)" @change="toggleReviewer(c.id)" />
                <Avatar :name="c.displayName" :size="20" />
                <span class="truncate">{{ c.displayName }}</span>
                <span class="smuted">@{{ c.username }}</span>
                <span v-if="c.id === session.user?.id" class="smuted">（我）</span>
              </label>
            </template>
          </div>
          <span class="field-hint">{{ pickedReviewers.length ? `已选 ${pickedReviewers.length} 人，他们会收到通知；只有评审人能通过或退回。` : "不指定时，任一项目编辑者都能通过或退回。" }}</span>
        </div>
        <label v-if="submitMode === 'submit'" class="field">
          <span>说明<span class="muted"> · 可选</span></span>
          <textarea v-model="submitNote" rows="3" maxlength="2000" placeholder="这一版改了什么、希望重点看哪里" />
        </label>
      </form>
      <template #footer>
        <button @click="submitMode = null">取消</button>
        <button class="primary" type="submit" form="submit-review-form" :disabled="reviewBusy">{{ submitMode === "reviewers" ? "保存" : "提交评审" }}</button>
      </template>
    </Modal>

    <!-- 退回 -->
    <Modal v-if="rejecting" :title="`退回 v${design?.currentVersion ?? '—'}`" @close="rejecting = false">
      <form id="reject-review-form" @submit.prevent="confirmReject">
        <label class="field">
          原因
          <textarea v-model="rejectReason" rows="4" maxlength="2000" placeholder="哪里需要修改" required autofocus />
          <span class="field-hint">设计稿会变回草稿，提交者会收到通知。</span>
        </label>
      </form>
      <template #footer>
        <button @click="rejecting = false">取消</button>
        <button class="primary" type="submit" form="reject-review-form" :disabled="reviewBusy || !rejectReason.trim()">退回</button>
      </template>
    </Modal>
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
  min-width: 160px;
}
.reviewers {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  padding-left: 2px;
}
.rv {
  display: inline-flex;
  border-radius: 50%;
  box-shadow: 0 0 0 2px var(--panel);
}
.rv + .rv {
  margin-left: -6px;
}
.rv.invalid {
  opacity: 0.4;
  filter: grayscale(1);
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
.comment.resolved .cname,
.comment.resolved .ctext {
  color: var(--muted);
}
.comment.folded {
  padding: 8px 0;
}
.rtag {
  height: 18px;
  font-size: 11px;
}
.cfold {
  display: block;
  width: 100%;
  height: auto;
  padding: 0;
  border: none;
  background: none;
  box-shadow: none;
  text-align: left;
  font-weight: 400;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  justify-content: flex-start;
}
.cfold:hover:not(:disabled) {
  background: none;
  color: var(--text-2);
}
.cfilter {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 0 4px;
  font-size: 12px;
}
/* 评审事件：一行灰字 */
.revent {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 0 10px 7px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
}
.revent:last-child {
  border-bottom: none;
}
.eicon {
  flex-shrink: 0;
  margin-top: 2px;
}
.revent.approve .eicon,
.revent.publish_direct .eicon {
  color: var(--ok);
}
.revent.reject .eicon {
  color: var(--danger);
}
.etext {
  min-width: 0;
  word-break: break-word;
}
.etime {
  color: var(--faint);
}
.enote {
  display: block;
  margin-top: 2px;
  color: var(--text-2);
  white-space: pre-wrap;
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
.cact {
  opacity: 0;
  color: var(--muted);
}
.comment:hover .cact,
.cact:focus-visible {
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
.chip.old {
  background: var(--warning-soft);
  color: var(--warning);
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
/* 提交评审弹窗 */
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
  font-size: 12px;
  font-weight: 550;
  color: var(--text-2);
}
.rsearch {
  width: 100%;
  height: 32px;
}
.rlist {
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 4px;
}
.ritem {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 8px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 450;
  color: var(--text);
  cursor: pointer;
}
.ritem:hover {
  background: var(--hover);
}
.ritem.on {
  background: var(--brand-soft);
}
.rnone {
  margin: 0;
  padding: 12px 8px;
  color: var(--muted);
  font-weight: 400;
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
