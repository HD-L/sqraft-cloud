<script setup lang="ts">
/**
 * 只读画布（W2、W3）：用 Sqraft 自己的渲染器（@sqraft/render，Canvas2D）绘制单个页面，效果与桌面端一致。
 * 只加载当前页面的节点与用到的切图；滚轮平移、⌘/Ctrl + 滚轮或触控板捏合缩放、拖动或按住空格拖动平移。
 *
 * 标注（叠加层，悬停不重画设计稿本身）：
 * - 单击选中图层（最深一层），悬停显示蓝框与尺寸；选中框带四角手柄，四边延长成贯穿画板的参考线；
 * - 选中后：悬停另一个图层 → 两者间距；悬停在选中图层自身 → 到父容器四边的内距；
 *   悬停画板空白处 → 到画板四边；指针移到画板外 → 到对应画板边；
 * - 按住 ⌥ 把距离显示为相对画板宽 / 高的百分比；
 * - 选中图层属于某个组件实例时，用紫色点线框标出实例并挂上组件名。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { DocState } from "@sqraft/core";
import { Canvas2DBackend, drawDocument, type ResolvedImage, type Viewport } from "@sqraft/render";
import { getPageDoc } from "../viewer/pageDocs";
import { imageStore } from "../viewer/images";
import { owningInstance, PageGeometry, type Rect } from "../viewer/inspect";
import { edgeTarget, measure, percent, type MeasureLine, type MeasureResult } from "../viewer/measure";
import { drawOverlay as paintOverlay, type OverlayLayer } from "../viewer/overlay";
import { prefs } from "../viewer/prefs";
import { fmtLen, unitCtx } from "../viewer/units";
import { componentsOf, type ComponentMeta } from "../viewer/components";

const props = defineProps<{
  designId: string;
  version: number;
  pageId: string;
  selected?: string | null;
  /** 额外高亮的图层（切图列表悬停时，用到同一张图的所有图层） */
  highlightIds?: string[];
}>();
const emit = defineEmits<{ select: [id: string | null]; zoom: [pct: number] }>();

const host = ref<HTMLDivElement>();
const canvas = ref<HTMLCanvasElement>();
const overlay = ref<HTMLCanvasElement>();
const loading = ref(false);
const error = ref("");
const zoomPct = ref(100);
const hovered = ref<string | null>(null);
const altDown = ref(false);
const spaceDown = ref(false);
const pageWidth = ref(0);
const components = ref<Map<string, ComponentMeta>>(new Map());

let backend: Canvas2DBackend | null = null;
let doc: DocState | null = null;
let geo: PageGeometry | null = null;
let raf = 0;
let overlayRaf = 0;
let observer: ResizeObserver | null = null;
/** 指针最后的世界坐标（画板外测到画板边用） */
let pointer: { x: number; y: number } | null = null;
/** 指针最后的屏幕坐标：视口平移 / 缩放后光标没动，但它下面的图层变了，靠它重新取悬停目标 */
let lastClient: { clientX: number; clientY: number } | null = null;
const vp: Viewport = { x: 0, y: 0, zoom: 1, width: 1, height: 1, dpr: window.devicePixelRatio || 1 };

const ctx = computed(() => unitCtx(prefs, props.designId, pageWidth.value));

function requestDraw() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (!backend) return;
    if (!doc) {
      // 没有可画的页面（加载失败）：清掉主画布上残留的上一页
      backend.beginFrame(vp);
      backend.endFrame();
      drawOverlay();
      return;
    }
    pending = [];
    backend.beginFrame(vp);
    drawDocument(backend, doc, { resolveImage });
    backend.endFrame();
    if (pending.length) void Promise.all(pending).then(requestDraw);
    if (zoomPct.value !== Math.round(vp.zoom * 100)) {
      zoomPct.value = Math.round(vp.zoom * 100);
      emit("zoom", zoomPct.value);
    }
    // 视口可能刚平移 / 缩放过（滚轮、快捷键、适应、定位）：按光标位置重新取悬停目标再画叠加层
    refreshHover();
    drawOverlay();
  });
}

function requestOverlay() {
  if (overlayRaf) return;
  overlayRaf = requestAnimationFrame(() => {
    overlayRaf = 0;
    drawOverlay();
  });
}

/** 本帧还没加载好的切图：加载完再画一遍 */
let pending: Promise<void>[] = [];
function resolveImage(assetId: string): ResolvedImage | null {
  return imageStore(props.designId, props.version).resolve(assetId, pending);
}

function layerOf(id: string, withSize: boolean): OverlayLayer | null {
  if (!geo) return null;
  const quad = geo.quad(id);
  const bounds = geo.bounds(id);
  const f = geo.frame(id);
  if (!quad || !bounds || !f) return null;
  return { quad, bounds, size: withSize ? `${fmtLen(f.width, ctx.value)} × ${fmtLen(f.height, ctx.value)}` : "" };
}

/** 选中图层要量到的目标：见文件头注释的四种情况 */
function measureTarget(sel: string): { result: MeasureResult; hovered: string | null; parentBox: Rect | null } | null {
  if (!geo) return null;
  const a = geo.bounds(sel);
  if (!a) return null;
  const hov = hovered.value;
  const page = geo.bounds(props.pageId);
  // 指针在画板外：到对应的画板边
  if (!hov) {
    if (!pointer || !page) return null;
    const t = edgeTarget(page, pointer);
    return t ? { result: measure(a, t, { alignThreshold: 0 }), hovered: null, parentBox: null } : null;
  }
  // 悬停在选中图层自身（或它的子图层）上：到父容器
  if (hov === sel || geo.isAncestor(sel, hov)) {
    const parentId = geo.doc.nodes[sel]?.parentId;
    const parent = parentId ? geo.bounds(parentId) : null;
    if (!parent) return null;
    return { result: measure(a, parent, { alignThreshold: 0 }), hovered: null, parentBox: parentId === props.pageId ? null : parent };
  }
  // 画板空白处：到画板四边
  if (hov === props.pageId) return page ? { result: measure(a, page, { alignThreshold: 0 }), hovered: null, parentBox: null } : null;
  const b = geo.bounds(hov);
  return b ? { result: measure(a, b), hovered: hov, parentBox: null } : null;
}

function drawOverlay() {
  const c = overlay.value;
  if (!c) return;
  const pw = Math.round(vp.width * vp.dpr);
  const ph = Math.round(vp.height * vp.dpr);
  if (c.width !== pw || c.height !== ph) {
    c.width = pw;
    c.height = ph;
  }
  const g = c.getContext("2d");
  if (!g) return;
  g.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
  g.clearRect(0, 0, vp.width, vp.height);
  if (!geo) return;
  const sel = props.selected && geo.doc.nodes[props.selected] ? props.selected : null;
  const page = geo.bounds(props.pageId);
  const m = sel ? measureTarget(sel) : null;
  const hoverId = sel ? (m?.hovered ?? null) : hovered.value && hovered.value !== props.pageId ? hovered.value : null;
  const inst = sel ? owningInstance(geo, sel) : null;
  const instBounds = inst ? geo.bounds(inst.id) : null;
  const label = (l: MeasureLine) =>
    altDown.value && page ? `${percent(l.value, l.axis === "h" ? page.width : page.height)}%` : fmtLen(l.value, ctx.value);
  paintOverlay(g, {
    view: { x: vp.x, y: vp.y, zoom: vp.zoom, width: vp.width, height: vp.height },
    page,
    // 测量时把位置让给测量值
    selected: sel ? layerOf(sel, !m || !m.result.lines.length) : null,
    hovered: hoverId ? layerOf(hoverId, true) : null,
    parentBox: m?.parentBox ?? null,
    component: inst && instBounds && inst.id !== sel ? { bounds: instBounds, name: components.value.get(inst.componentId ?? "")?.name ?? inst.name } : null,
    measure: m ? m.result : null,
    label,
    highlights: (props.highlightIds ?? []).map((id) => geo!.bounds(id)).filter((r): r is Rect => !!r),
  });
}

// ── 视图 ──

function fitRect(r: Rect, maxZoom: number, pad = 40) {
  const zoom = Math.min((vp.width - pad * 2) / Math.max(1, r.width), (vp.height - pad * 2) / Math.max(1, r.height), maxZoom);
  vp.zoom = Math.max(0.02, zoom);
  vp.x = r.x - (vp.width / vp.zoom - r.width) / 2;
  vp.y = r.y - (vp.height / vp.zoom - r.height) / 2;
  requestDraw();
}

function fit() {
  const page = doc?.nodes[props.pageId];
  if (page) fitRect({ x: page.x, y: page.y, width: page.width, height: page.height }, 2);
}

function zoomAt(sx: number, sy: number, next: number) {
  const z = Math.min(16, Math.max(0.02, next));
  const wx = vp.x + sx / vp.zoom;
  const wy = vp.y + sy / vp.zoom;
  vp.zoom = z;
  vp.x = wx - sx / z;
  vp.y = wy - sy / z;
  requestDraw();
}

const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 8, 16];
function zoomIn() {
  zoomAt(vp.width / 2, vp.height / 2, ZOOM_STEPS.find((s) => s > vp.zoom + 0.001) ?? vp.zoom * 1.25);
}
function zoomOut() {
  zoomAt(vp.width / 2, vp.height / 2, [...ZOOM_STEPS].reverse().find((s) => s < vp.zoom - 0.001) ?? vp.zoom / 1.25);
}
function zoomTo(z: number) {
  zoomAt(vp.width / 2, vp.height / 2, z);
}

/** 按容器当前尺寸更新视口（布局刚变、ResizeObserver 还没回调时用） */
function syncSize() {
  const r = host.value?.getBoundingClientRect();
  if (!r) return;
  vp.width = Math.max(1, r.width);
  vp.height = Math.max(1, r.height);
}

/** 把图层放进视野：已经完整可见就不动；ensureZoom 时缩放到合适大小 */
function focusNode(id: string, ensureZoom = false) {
  const b = geo?.bounds(id);
  if (!b) return;
  // 调用方可能刚展开 / 收起右侧面板：按最新的容器宽高判断是否可见
  syncSize();
  const vw = vp.width / vp.zoom;
  const vh = vp.height / vp.zoom;
  // 每个方向上：能放进视口的要完整可见；比视口大的只要有交集就算可见（否则选中大容器时视图会被拉到它的中心）
  const axisOk = (start: number, size: number, vs: number, vsize: number) => (size <= vsize ? start >= vs && start + size <= vs + vsize : start < vs + vsize && start + size > vs);
  const visible = axisOk(b.x, b.width, vp.x, vw) && axisOk(b.y, b.height, vp.y, vh);
  if (ensureZoom) fitRect(b, 4, 80);
  else if (!visible) {
    vp.x = b.x + b.width / 2 - vp.width / vp.zoom / 2;
    vp.y = b.y + b.height / 2 - vp.height / vp.zoom / 2;
    requestDraw();
  }
}

/**
 * 图层树导航（快捷键用）：child = 最上层的可见子图层，parent = 父图层（到画板为止返回 null），
 * next / prev = 同级里下一个 / 上一个可见图层（按图层面板从上到下的顺序，首尾循环）。
 */
function relative(id: string, dir: "child" | "parent" | "next" | "prev"): string | null {
  const d = doc;
  const n = d?.nodes[id];
  if (!d || !n) return null;
  const visible = (cid: string) => !!d.nodes[cid]?.visible;
  if (dir === "child") return [...n.children].reverse().find(visible) ?? null;
  if (!n.parentId) return null;
  if (dir === "parent") return n.parentId === props.pageId ? null : n.parentId;
  // 图层面板里上层在前：children 数组倒过来就是面板顺序
  const siblings = [...(d.nodes[n.parentId]?.children ?? [])].reverse().filter(visible);
  const i = siblings.indexOf(id);
  if (i < 0 || siblings.length < 2) return null;
  return siblings[(i + (dir === "next" ? 1 : -1) + siblings.length) % siblings.length];
}

defineExpose({ fit, zoomIn, zoomOut, zoomTo, focusNode, relative });

function onWheel(e: WheelEvent) {
  e.preventDefault();
  const rect = canvas.value!.getBoundingClientRect();
  if (e.ctrlKey || e.metaKey) zoomAt(e.clientX - rect.left, e.clientY - rect.top, vp.zoom * Math.exp(-e.deltaY * 0.01));
  else {
    vp.x += e.deltaX / vp.zoom;
    vp.y += e.deltaY / vp.zoom;
    requestDraw();
  }
}

// ── 指针 ──

function worldOf(e: { clientX: number; clientY: number }) {
  const rect = canvas.value!.getBoundingClientRect();
  return { x: vp.x + (e.clientX - rect.left) / vp.zoom, y: vp.y + (e.clientY - rect.top) / vp.zoom };
}

const dragging = ref(false);
let drag: { x: number; y: number; moved: boolean } | null = null;
/** 按光标最后的屏幕位置重新算世界坐标与悬停图层（拖动中不算） */
function refreshHover() {
  if (!lastClient || drag || !canvas.value) return;
  pointer = worldOf(lastClient);
  const h = geo ? geo.hit(pointer.x, pointer.y) : null;
  if (h !== hovered.value) hovered.value = h;
}

function onPointerDown(e: PointerEvent) {
  // 焦点移到画布上：键盘焦点不再停在刚点过的按钮上，Enter / Tab / 空格交给画布的快捷键
  host.value?.focus({ preventScroll: true });
  // 中键或按住空格：只拖动，不选中
  drag = { x: e.clientX, y: e.clientY, moved: e.button === 1 || spaceDown.value };
  if (drag.moved) dragging.value = true;
  canvas.value!.setPointerCapture(e.pointerId);
}
function onPointerMove(e: PointerEvent) {
  lastClient = { clientX: e.clientX, clientY: e.clientY };
  if (!drag) {
    refreshHover();
    requestOverlay();
    return;
  }
  if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
  drag.moved = true;
  dragging.value = true;
  vp.x -= (e.clientX - drag.x) / vp.zoom;
  vp.y -= (e.clientY - drag.y) / vp.zoom;
  drag.x = e.clientX;
  drag.y = e.clientY;
  requestDraw();
}
function onPointerUp(e: PointerEvent) {
  const click = drag && !drag.moved;
  drag = null;
  dragging.value = false;
  refreshHover();
  requestOverlay();
  if (!click || !geo) return;
  // 点在画板空白处或画板外：取消选中
  const w = worldOf(e);
  const id = geo.hit(w.x, w.y);
  emit("select", id && id !== props.pageId ? id : null);
}
function onPointerCancel() {
  drag = null;
  dragging.value = false;
}
function onPointerLeave() {
  pointer = null;
  lastClient = null;
  if (hovered.value) hovered.value = null;
  requestOverlay();
}

// ⌥ 百分比、空格拖动：按键状态（窗口失焦时复位）
function isTyping(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}
function onKeyDown(e: KeyboardEvent) {
  if (e.key === "Alt" && !altDown.value) {
    altDown.value = true;
    e.preventDefault();
    requestOverlay();
  }
  // 空格平移：焦点在按钮、链接上时留给它们（空格激活按钮）
  if (e.code === "Space" && !isTyping(e.target) && !(e.target as Element | null)?.closest?.("button, a[href], [role='button'], [role='dialog']")) {
    spaceDown.value = true;
    e.preventDefault();
  }
}
function onKeyUp(e: KeyboardEvent) {
  if (e.key === "Alt") {
    altDown.value = false;
    requestOverlay();
  }
  if (e.code === "Space") spaceDown.value = false;
}
function onBlur() {
  altDown.value = false;
  spaceDown.value = false;
  requestOverlay();
}

// ── 加载 ──

/** 每次加载递增；回来的结果不是最新一次请求的就丢掉（快速翻页、切版本时先发的请求可能后回来） */
let loadSeq = 0;
async function load() {
  const seq = ++loadSeq;
  loading.value = true;
  error.value = "";
  // 新页面到之前不再用旧页面做命中：否则旧画板会被画上悬停框，点一下还会把旧页面的图层 id 当成选中
  // （doc 留着，主画布继续显示旧画面直到新页面就绪）
  geo = null;
  hovered.value = null;
  requestOverlay();
  try {
    const [next, comps] = await Promise.all([getPageDoc(props.designId, props.version, props.pageId), componentsOf(props.designId, props.version)]);
    if (seq !== loadSeq) return;
    doc = next;
    geo = new PageGeometry(next, props.pageId);
    components.value = comps;
    pageWidth.value = next.nodes[props.pageId]?.width ?? 0;
    hovered.value = null;
    fit();
  } catch (e) {
    if (seq !== loadSeq) return;
    doc = null;
    geo = null;
    error.value = (e as Error).message;
    requestDraw();
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

watch(
  () => [props.designId, props.version, props.pageId],
  () => void load(),
);
watch(() => [props.selected, props.highlightIds, ctx.value], requestOverlay, { deep: true });

onMounted(() => {
  const g = canvas.value!.getContext("2d");
  if (!g) {
    error.value = "浏览器不支持 Canvas";
    return;
  }
  backend = new Canvas2DBackend(g);
  canvas.value!.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  observer = new ResizeObserver(() => {
    const r = host.value!.getBoundingClientRect();
    const first = vp.width <= 1;
    vp.width = Math.max(1, r.width);
    vp.height = Math.max(1, r.height);
    vp.dpr = window.devicePixelRatio || 1;
    if (first) fit();
    else requestDraw();
  });
  observer.observe(host.value!);
  void load();
});

onBeforeUnmount(() => {
  observer?.disconnect();
  if (raf) cancelAnimationFrame(raf);
  if (overlayRaf) cancelAnimationFrame(overlayRaf);
  canvas.value?.removeEventListener("wheel", onWheel);
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("keyup", onKeyUp);
  window.removeEventListener("blur", onBlur);
});

const ZOOM_MENU = [0.25, 0.5, 1, 2, 4];
const zoomMenu = ref(false);
</script>

<template>
  <div ref="host" class="viewer" tabindex="-1">
    <canvas
      ref="canvas"
      :class="{ dragging, grab: spaceDown && !dragging, pointing: !spaceDown && hovered && hovered !== pageId }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
      @pointerleave="onPointerLeave"
    />
    <canvas ref="overlay" class="overlay" />
    <div v-if="altDown && selected" class="mode">百分比（相对画板宽 / 高）</div>
    <div class="tools">
      <button class="sm" title="缩小（⌘−）" @click="zoomOut">−</button>
      <div class="pctwrap">
        <button class="sm pct" title="缩放档位" @click="zoomMenu = !zoomMenu">{{ zoomPct }}%</button>
        <div v-if="zoomMenu" class="menu" @mouseleave="zoomMenu = false">
          <button v-for="z in ZOOM_MENU" :key="z" @click="(zoomTo(z), (zoomMenu = false))">{{ z * 100 }}%</button>
        </div>
      </div>
      <button class="sm" title="放大（⌘=）" @click="zoomIn">+</button>
      <button class="sm" title="适应窗口（⇧1）" @click="fit">适应</button>
      <button v-if="selected" class="sm" title="缩放到选中（⇧2）" @click="focusNode(selected!, true)">选中</button>
    </div>
    <div v-if="loading" class="status">加载中…</div>
    <div v-else-if="error" class="status error">{{ error }}</div>
  </div>
</template>

<style scoped>
.viewer {
  position: relative;
  flex: 1;
  min-width: 0;
  background: #e9ebef;
  overflow: hidden;
}
.viewer:focus {
  outline: none;
}
canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  cursor: default;
  touch-action: none;
}
canvas.pointing {
  cursor: pointer;
}
canvas.grab {
  cursor: grab;
}
canvas.dragging {
  cursor: grabbing;
}
canvas.overlay {
  pointer-events: none;
}
.tools {
  position: absolute;
  right: 16px;
  bottom: 16px;
  display: flex;
  gap: 6px;
  align-items: center;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px;
  box-shadow: var(--shadow);
  font-size: 12px;
}
.pctwrap {
  position: relative;
}
.pct {
  min-width: 56px;
  font-variant-numeric: tabular-nums;
}
.menu {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: var(--shadow-lg);
  padding: 4px;
  display: flex;
  flex-direction: column;
}
.menu button {
  border: none;
  font-size: 12px;
  padding: 4px 12px;
}
.mode {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  background: #232837;
  color: #fff;
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 6px;
  pointer-events: none;
}
.status {
  position: absolute;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 12px;
}
</style>
