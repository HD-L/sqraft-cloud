<script setup lang="ts">
/**
 * 只读画布（W2、W3）：用 Sqraft 自己的渲染器（@sqraft/render，Canvas2D）绘制单个页面，效果与桌面端一致。
 * 只加载当前页面的节点与用到的切图；滚轮平移、⌘/Ctrl + 滚轮或触控板捏合缩放、拖动平移。
 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { DocState } from "@sqraft/core";
import { Canvas2DBackend, drawDocument, type ResolvedImage, type Viewport } from "@sqraft/render";
import { api } from "../api";

const props = defineProps<{ designId: string; version: number; pageId: string }>();

const host = ref<HTMLDivElement>();
const canvas = ref<HTMLCanvasElement>();
const loading = ref(false);
const error = ref("");
const zoomPct = ref(100);

let backend: Canvas2DBackend | null = null;
let doc: DocState | null = null;
let raf = 0;
let observer: ResizeObserver | null = null;
const vp: Viewport = { x: 0, y: 0, zoom: 1, width: 1, height: 1, dpr: window.devicePixelRatio || 1 };
const images = new Map<string, { img: HTMLImageElement; ready: boolean }>();

function requestDraw() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (!backend || !doc) return;
    backend.beginFrame(vp);
    drawDocument(backend, doc, { resolveImage });
    backend.endFrame();
    zoomPct.value = Math.round(vp.zoom * 100);
  });
}

function resolveImage(assetId: string): ResolvedImage | null {
  let entry = images.get(assetId);
  if (!entry) {
    const img = new Image();
    entry = { img, ready: false };
    images.set(assetId, entry);
    img.onload = () => {
      entry!.ready = true;
      requestDraw();
    };
    img.src = `/api/v1/designs/${props.designId}/versions/${props.version}/assets/${encodeURIComponent(assetId)}`;
  }
  return entry.ready ? { source: entry.img, width: entry.img.naturalWidth, height: entry.img.naturalHeight } : null;
}

function fit() {
  if (!doc) return;
  const page = doc.nodes[doc.rootIds[0]];
  if (!page) return;
  const pad = 40;
  const zoom = Math.min((vp.width - pad * 2) / page.width, (vp.height - pad * 2) / page.height, 2);
  vp.zoom = Math.max(0.02, zoom);
  vp.x = page.x - (vp.width / vp.zoom - page.width) / 2;
  vp.y = page.y - (vp.height / vp.zoom - page.height) / 2;
  requestDraw();
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

function actualSize() {
  zoomAt(vp.width / 2, vp.height / 2, 1);
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

let drag: { x: number; y: number } | null = null;
function onPointerDown(e: PointerEvent) {
  drag = { x: e.clientX, y: e.clientY };
  canvas.value!.setPointerCapture(e.pointerId);
}
function onPointerMove(e: PointerEvent) {
  if (!drag) return;
  vp.x -= (e.clientX - drag.x) / vp.zoom;
  vp.y -= (e.clientY - drag.y) / vp.zoom;
  drag = { x: e.clientX, y: e.clientY };
  requestDraw();
}
function onPointerUp() {
  drag = null;
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const res = await api<{ doc: DocState }>("GET", `/designs/${props.designId}/versions/${props.version}/pages/${encodeURIComponent(props.pageId)}`);
    doc = res.doc;
    fit();
  } catch (e) {
    doc = null;
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.designId, props.version, props.pageId],
  (next, prev) => {
    if (prev && (next[0] !== prev[0] || next[1] !== prev[1])) images.clear();
    void load();
  },
);

onMounted(() => {
  const ctx = canvas.value!.getContext("2d");
  if (!ctx) {
    error.value = "浏览器不支持 Canvas";
    return;
  }
  backend = new Canvas2DBackend(ctx);
  canvas.value!.addEventListener("wheel", onWheel, { passive: false });
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
  canvas.value?.removeEventListener("wheel", onWheel);
});
</script>

<template>
  <div ref="host" class="viewer">
    <canvas ref="canvas" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerUp" />
    <div class="tools">
      <button @click="zoomAt(vp.width / 2, vp.height / 2, vp.zoom / 1.25)">−</button>
      <span class="pct">{{ zoomPct }}%</span>
      <button @click="zoomAt(vp.width / 2, vp.height / 2, vp.zoom * 1.25)">+</button>
      <button @click="fit">适应窗口</button>
      <button @click="actualSize">100%</button>
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
canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  cursor: grab;
  touch-action: none;
}
canvas:active {
  cursor: grabbing;
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
  padding: 6px;
}
.pct {
  min-width: 48px;
  text-align: center;
  font-variant-numeric: tabular-nums;
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
