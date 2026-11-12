<script setup lang="ts">
/**
 * 总览画布：全部画板按分组排开——每组一个标题，组内按阅读顺序从左到右排、放不下换行；
 * 显示缩略图、名称、本版改动标记与选中状态。
 * - 滚轮平移，⌘/Ctrl + 滚轮或触控板捏合缩放，拖动平移；
 * - 单击选中，双击进入单页查看；
 * - 缩略图只在画板显示得够大时才加载（见 viewer/thumbs.ts），缩得很小时只画占位块。
 *
 * 排版坐标与设计稿里的画布坐标无关：Sketch 转换来的稿子各页面上下堆叠、跨度极大，原样铺开几乎看不清。
 * 缩略图仍按画板的原始坐标渲染，只是画到排版位置上。
 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { levelFor, ThumbStore, type Board } from "../viewer/thumbs";

export interface OverviewPage extends Board {
  name: string;
  section: string;
}

const props = defineProps<{
  designId: string;
  version: number;
  pages: OverviewPage[];
  sections: Array<{ name: string; pageIds: string[] }>;
  selected: string | null;
  changed: Set<string>;
}>();
const emit = defineEmits<{ select: [id: string]; open: [id: string] }>();

const host = ref<HTMLDivElement>();
const canvas = ref<HTMLCanvasElement>();
const zoomPct = ref(100);
const vp = { x: 0, y: 0, zoom: 1, width: 1, height: 1, dpr: window.devicePixelRatio || 1 };
let ctx: CanvasRenderingContext2D | null = null;
let raf = 0;
let observer: ResizeObserver | null = null;
let thumbs: ThumbStore | null = null;
let fitted = false;

/** 小于这个屏幕宽度（CSS 像素）的画板只画占位块、不加载缩略图 */
const MIN_THUMB_PX = 36;
/** 大于这个屏幕宽度才在画板上方写名字 */
const MIN_LABEL_PX = 56;

// ── 排版（世界单位）──
const GAP_X = 120;
const GAP_Y = 200;
const SECTION_GAP = 480;
const TITLE_SPACE = 260;

interface Item {
  page: OverviewPage;
  x: number;
  y: number;
  w: number;
  h: number;
}
interface SectionBox {
  name: string;
  x: number;
  y: number;
  r: number;
  b: number;
  items: Item[];
}
let items: Item[] = [];
let boxes: SectionBox[] = [];
const itemById = new Map<string, Item>();

function layout() {
  const byId = new Map(props.pages.map((p) => [p.id, p]));
  // 每行最宽：不小于最宽的画板，大致容纳十来张手机屏
  const widest = Math.max(0, ...props.pages.map((p) => p.width));
  const rowMax = Math.max(widest, 6400);
  items = [];
  boxes = [];
  itemById.clear();
  let y = 0;
  for (const s of props.sections) {
    const list = s.pageIds.map((id) => byId.get(id)).filter((p): p is OverviewPage => !!p);
    if (!list.length) continue;
    const top = y;
    y += TITLE_SPACE;
    const box: SectionBox = { name: s.name, x: 0, y: top, r: 0, b: 0, items: [] };
    let x = 0;
    let rowH = 0;
    for (const p of list) {
      if (x > 0 && x + p.width > rowMax) {
        y += rowH + GAP_Y;
        x = 0;
        rowH = 0;
      }
      const it: Item = { page: p, x, y, w: p.width, h: p.height };
      items.push(it);
      box.items.push(it);
      itemById.set(p.id, it);
      x += p.width + GAP_X;
      rowH = Math.max(rowH, p.height);
      box.r = Math.max(box.r, it.x + it.w);
    }
    y += rowH;
    box.b = y;
    boxes.push(box);
    y += SECTION_GAP;
  }
}

function makeThumbs() {
  thumbs?.dispose();
  thumbs = new ThumbStore(props.designId, props.version, requestDraw);
}

function requestDraw() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    draw();
  });
}

function truncate(text: string, max: number): string {
  if (!ctx || ctx.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid;
    else hi = mid - 1;
  }
  return lo ? `${text.slice(0, lo)}…` : "";
}

function draw() {
  const c = canvas.value;
  if (!ctx || !c) return;
  const pw = Math.round(vp.width * vp.dpr);
  const ph = Math.round(vp.height * vp.dpr);
  if (c.width !== pw || c.height !== ph) {
    c.width = pw;
    c.height = ph;
  }
  ctx.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
  ctx.fillStyle = "#e9ebf2";
  ctx.fillRect(0, 0, vp.width, vp.height);

  const z = vp.zoom;
  const left = vp.x;
  const top = vp.y;
  const right = vp.x + vp.width / z;
  const bottom = vp.y + vp.height / z;
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const wants: Array<{ board: Board; level: number; priority: number }> = [];

  ctx.font = "12px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif";
  ctx.textBaseline = "bottom";
  for (const box of boxes) {
    if (box.x > right || box.y > bottom || box.r < left || box.b < top) continue;
    for (const it of box.items) {
      if (it.x > right || it.y > bottom || it.x + it.w < left || it.y + it.h < top - 40 / z) continue;
      const p = it.page;
      const sx = (it.x - vp.x) * z;
      const sy = (it.y - vp.y) * z;
      const sw = it.w * z;
      const sh = it.h * z;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(sx, sy, sw, sh);
      let drawn = false;
      if (sw >= MIN_THUMB_PX && thumbs) {
        const level = levelFor(p, z * vp.dpr);
        const img = thumbs.best(p.id, level);
        if (img) {
          ctx.drawImage(img, sx, sy, sw, sh);
          drawn = true;
        }
        if (!thumbs.has(p.id, level)) wants.push({ board: p, level, priority: Math.hypot(it.x + it.w / 2 - cx, it.y + it.h / 2 - cy) });
      }
      if (!drawn && sw > 3) {
        ctx.strokeStyle = "#dde1ea";
        ctx.lineWidth = 1;
        ctx.strokeRect(sx + 0.5, sy + 0.5, sw - 1, sh - 1);
      }
      if (sw >= MIN_LABEL_PX) {
        let x = sx;
        if (props.changed.has(p.id)) {
          ctx.fillStyle = "#2f5cff";
          ctx.beginPath();
          ctx.arc(sx + 3, sy - 10, 3, 0, Math.PI * 2);
          ctx.fill();
          x += 10;
        }
        ctx.fillStyle = p.id === props.selected ? "#2f5cff" : "#5b6270";
        ctx.fillText(truncate(p.name, sw - (x - sx)), x, sy - 4);
      }
      if (p.id === props.selected) {
        ctx.strokeStyle = "#2f5cff";
        ctx.lineWidth = 2;
        ctx.strokeRect(sx - 1, sy - 1, sw + 2, sh + 2);
      }
    }
  }

  // 分组标题：写在每组左上角；挤在一起时只写放得下的
  ctx.font = "600 15px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif";
  ctx.fillStyle = "#1d2129";
  let lastY = -Infinity;
  for (const b of boxes) {
    const sx = (b.x - vp.x) * z;
    const sy = (b.y + TITLE_SPACE * 0.45 - vp.y) * z;
    if (sy - lastY < 22) continue;
    lastY = sy;
    if (sx > vp.width || sy < -20 || sy > vp.height + 20) continue;
    ctx.fillText(`${b.name}  ·  ${b.items.length}`, Math.max(8, sx), Math.max(20, sy));
  }

  zoomPct.value = Math.round(z * 100);
  thumbs?.want(wants);
}

function fitRect(r: { x: number; y: number; r: number; b: number }, maxZoom: number) {
  const pad = 48;
  const w = Math.max(1, r.r - r.x);
  const h = Math.max(1, r.b - r.y);
  vp.zoom = Math.max(0.005, Math.min((vp.width - pad * 2) / w, (vp.height - pad * 2) / h, maxZoom));
  vp.x = r.x - (vp.width / vp.zoom - w) / 2;
  vp.y = r.y - (vp.height / vp.zoom - h) / 2;
  requestDraw();
}

/** 适应全部：组很多时先看前几组（整体太小看不清），宽度撑满 */
function fitAll() {
  if (!boxes.length) return;
  const r = Math.max(...boxes.map((b) => b.r));
  const b = boxes[boxes.length - 1].b;
  const zoomForWidth = (vp.width - 96) / Math.max(1, r);
  if ((b * zoomForWidth) / vp.height > 3) {
    // 竖向太长：按宽度撑满，从第一组开始看
    vp.zoom = Math.max(0.005, Math.min(zoomForWidth, 1));
    vp.x = -48 / vp.zoom;
    vp.y = -24 / vp.zoom;
    requestDraw();
  } else fitRect({ x: 0, y: 0, r, b }, 1);
}

/** 把某个画板放进视野；已经完整可见且够大就不动 */
function focus(id: string) {
  const it = itemById.get(id);
  if (!it) return;
  const visible =
    it.x >= vp.x && it.y >= vp.y && it.x + it.w <= vp.x + vp.width / vp.zoom && it.y + it.h <= vp.y + vp.height / vp.zoom && it.w * vp.zoom >= 120;
  if (!visible) fitRect({ x: it.x, y: it.y - 40, r: it.x + it.w, b: it.y + it.h }, 1);
  else requestDraw();
}

/** 适应某一组 */
function focusSection(name: string) {
  const b = boxes.find((x) => x.name === name);
  if (b) fitRect({ x: b.x, y: b.y, r: b.r, b: b.b }, 1);
}

defineExpose({ fitAll, focus, focusSection });

function zoomAt(sx: number, sy: number, next: number) {
  const z = Math.min(8, Math.max(0.005, next));
  const wx = vp.x + sx / vp.zoom;
  const wy = vp.y + sy / vp.zoom;
  vp.zoom = z;
  vp.x = wx - sx / z;
  vp.y = wy - sy / z;
  requestDraw();
}

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

function hit(e: { clientX: number; clientY: number }): string | null {
  const rect = canvas.value!.getBoundingClientRect();
  const wx = vp.x + (e.clientX - rect.left) / vp.zoom;
  const wy = vp.y + (e.clientY - rect.top) / vp.zoom;
  for (const b of boxes) {
    if (wy < b.y || wy > b.b) continue;
    for (const it of b.items) if (wx >= it.x && wx <= it.x + it.w && wy >= it.y && wy <= it.y + it.h) return it.page.id;
  }
  return null;
}

let drag: { x: number; y: number; moved: boolean } | null = null;
function onPointerDown(e: PointerEvent) {
  drag = { x: e.clientX, y: e.clientY, moved: false };
  canvas.value!.setPointerCapture(e.pointerId);
}
function onPointerMove(e: PointerEvent) {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  drag.moved = true;
  vp.x -= dx / vp.zoom;
  vp.y -= dy / vp.zoom;
  drag.x = e.clientX;
  drag.y = e.clientY;
  requestDraw();
}
function onPointerUp(e: PointerEvent) {
  const wasClick = drag && !drag.moved;
  drag = null;
  if (wasClick) {
    const id = hit(e);
    if (id) emit("select", id);
  }
}
function onDblClick(e: MouseEvent) {
  const id = hit(e);
  if (id) emit("open", id);
}

function initialView() {
  if (fitted || !items.length || vp.width <= 1) return;
  fitted = true;
  if (props.selected && itemById.has(props.selected)) focus(props.selected);
  else fitAll();
}

watch(
  () => [props.designId, props.version],
  () => {
    makeThumbs();
    fitted = false;
  },
);
watch(
  () => [props.pages, props.sections],
  () => {
    layout();
    initialView();
    requestDraw();
  },
);
watch(() => [props.selected, props.changed], requestDraw);

onMounted(() => {
  ctx = canvas.value!.getContext("2d");
  makeThumbs();
  layout();
  canvas.value!.addEventListener("wheel", onWheel, { passive: false });
  observer = new ResizeObserver(() => {
    const r = host.value!.getBoundingClientRect();
    vp.width = Math.max(1, r.width);
    vp.height = Math.max(1, r.height);
    vp.dpr = window.devicePixelRatio || 1;
    initialView();
    requestDraw();
  });
  observer.observe(host.value!);
});

onBeforeUnmount(() => {
  thumbs?.dispose();
  thumbs = null;
  ctx = null;
  observer?.disconnect();
  if (raf) cancelAnimationFrame(raf);
  canvas.value?.removeEventListener("wheel", onWheel);
});
</script>

<template>
  <div ref="host" class="overview">
    <canvas ref="canvas" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="drag = null" @dblclick="onDblClick" />
    <div class="tools">
      <button class="sm" title="缩小" @click="zoomAt(vp.width / 2, vp.height / 2, vp.zoom / 1.25)">−</button>
      <span class="pct">{{ zoomPct }}%</span>
      <button class="sm" title="放大" @click="zoomAt(vp.width / 2, vp.height / 2, vp.zoom * 1.25)">+</button>
      <button class="sm" @click="fitAll">全部</button>
      <button v-if="selected" class="sm" @click="focus(selected!)">选中</button>
    </div>
    <div class="hint">双击画板进入查看 · 双击左侧分组定位到该组</div>
  </div>
</template>

<style scoped>
.overview {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  cursor: default;
  touch-action: none;
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
.pct {
  min-width: 44px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.hint {
  position: absolute;
  left: 16px;
  bottom: 16px;
  font-size: 12px;
  color: var(--muted);
  background: rgba(255, 255, 255, 0.8);
  border-radius: 6px;
  padding: 3px 8px;
  pointer-events: none;
}
</style>
