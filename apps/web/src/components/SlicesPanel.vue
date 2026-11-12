<script setup lang="ts">
/**
 * 切图（v2）：
 * - 导出：选中的图层（没选时为整个画板）按当前平台的档位（iOS @1x/@2x/@3x、Android mdpi…xxxhdpi、Web / 小程序 1x/2x）
 *   导出 PNG / JPG / WEBP，多个档位自动打成 zip；也可导出 SVG（矢量保留，图片内嵌）；
 * - 位图：这个画板用到的位图（按图片去重），悬停在画布上高亮所有用到它的图层，点击选中并定位；
 *   可下载原图，或按当前档位导出；「打包本页位图」一次导出全部。
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import type { DocNode, DocState } from "@sqraft/core";
import { getPageDoc } from "../viewer/pageDocs";
import { EFFECT_LAYER_MAX_SIDE } from "@sqraft/core";
import { canExport, downloadBlob, effectLayerLimited, exportBounds, exportMany, exportSize, exportTargets, extFor, MAX_EXPORT_SIDE, renderNode, safeFileName, type ExportFormat as BitmapFormat, type ExportTarget } from "../viewer/exportImage";
import { zipStore } from "../viewer/zip";
import { prefs, type ExportFormat } from "../viewer/prefs";
import { PLATFORM_LABEL, unitCtx, type Platform } from "../viewer/units";

const props = defineProps<{ designId: string; version: number; pageId: string; nodeId: string | null }>();
const emit = defineEmits<{ select: [id: string]; locate: [id: string]; highlight: [ids: string[]] }>();

const doc = shallowRef<DocState | null>(null);
let seq = 0;
watch(
  () => [props.designId, props.version, props.pageId] as const,
  async ([d, v, p]) => {
    const mine = ++seq;
    const loaded = await getPageDoc(d, v, p).catch(() => null);
    if (mine === seq) doc.value = loaded;
  },
  { immediate: true },
);

const page = computed(() => doc.value?.nodes[props.pageId] ?? null);
const selectedNode = computed(() => (props.nodeId ? doc.value?.nodes[props.nodeId] : null) ?? null);
/** 导出对象：选中的图层，没选时为整个画板 */
const subject = computed<DocNode | null>(() => selectedNode.value ?? page.value);

// ── 档位与格式 ──
const designScale = computed(() => unitCtx(prefs, props.designId, page.value?.width ?? 0).scale);
const targets = computed(() => exportTargets(prefs.platform, designScale.value));
const picked = ref<Set<string>>(new Set());
watch(
  () => targets.value.map((t) => t.label).join("|"),
  () => {
    // 换平台时默认全选；同一平台下保留之前的勾选
    const labels = targets.value.map((t) => t.label);
    const kept = labels.filter((l) => picked.value.has(l));
    picked.value = new Set(kept.length ? kept : labels);
  },
  { immediate: true },
);
function togglePick(label: string) {
  const next = new Set(picked.value);
  if (next.has(label)) {
    if (next.size > 1) next.delete(label);
  } else next.add(label);
  picked.value = next;
}
const chosen = computed(() => targets.value.filter((t) => picked.value.has(t.label)));
const webpOk = ref(true);
onMounted(() => (webpOk.value = canExport("webp")));
const FORMATS: Array<{ id: ExportFormat; label: string }> = [
  { id: "png", label: "PNG" },
  { id: "jpeg", label: "JPG" },
  { id: "webp", label: "WEBP" },
  { id: "svg", label: "SVG" },
];
const isSvg = computed(() => prefs.exportFormat === "svg");

/**
 * 每个档位导出后的像素尺寸。warn：shrunk = 超过单边上限被等比缩小；
 * soft = 带投影 / 模糊的图层超过渲染器离屏层上限，效果部分会发糊
 */
function sizesOf(id: string): Array<{ target: ExportTarget; w: number; h: number; shrunk: boolean; soft: boolean }> {
  const d = doc.value;
  const b = d ? exportBounds(d, id) : null;
  if (!d || !b) return [];
  return chosen.value.map((t) => {
    const s = exportSize(b, t.scale);
    const shrunk = s.scale < t.scale - 1e-9;
    return { target: t, w: s.width, h: s.height, shrunk, soft: !shrunk && effectLayerLimited(d, id, s.scale, b) };
  });
}
const SHRUNK_TIP = `超过 ${MAX_EXPORT_SIDE}px 上限，会等比缩小`;
const SOFT_TIP = `带投影 / 模糊的图层超过 ${EFFECT_LAYER_MAX_SIDE}px 渲染上限，该图层连同其中的文字、图片都会降采样发糊；可降低倍率，或去掉效果后单独导出`;
const subjectSizes = computed(() => (subject.value ? sizesOf(subject.value.id) : []));

// ── 预览（选中图层的小图） ──
const preview = ref("");
let previewSeq = 0;
let previewTimer = 0;
watch(
  () => [subject.value?.id, props.version] as const,
  ([id]) => {
    clearTimeout(previewTimer);
    const mine = ++previewSeq;
    if (!id || !doc.value) return setPreview("");
    previewTimer = window.setTimeout(async () => {
      const b = doc.value ? exportBounds(doc.value, id) : null;
      if (!b) return;
      const scale = Math.min(2, 360 / Math.max(b.width, b.height));
      // 预览用宽松模式：有图片缺失（链接图等）也照常出图，真正导出时才报错说明
      const blob = await renderNode({ designId: props.designId, version: props.version, pageId: props.pageId, nodeId: id, scale, format: "png", strict: false }).catch(() => null);
      if (mine === previewSeq) setPreview(blob ? URL.createObjectURL(blob) : "");
    }, 120);
  },
  { immediate: true },
);
function setPreview(url: string) {
  if (preview.value) URL.revokeObjectURL(preview.value);
  preview.value = url;
}
onBeforeUnmount(() => {
  clearTimeout(previewTimer);
  previewSeq++;
  setPreview("");
  abort?.abort();
  emit("highlight", []);
});

// ── 导出 ──
const busy = ref(false);
const progress = ref({ done: 0, total: 0 });
const message = ref("");
let abort: AbortController | null = null;

const base = computed(() => `/api/v1/designs/${props.designId}/versions/${props.version}`);
const svgUrl = (id: string) => `${base.value}/nodes/${encodeURIComponent(id)}/svg?root=${encodeURIComponent(props.pageId)}`;
const assetUrl = (id: string) => `${base.value}/assets/${encodeURIComponent(id)}`;
const originalUrl = (s: Slice) => `${assetUrl(s.assetId)}?download=${encodeURIComponent(s.nodes[0]?.name || "切图")}`;

/** 单个文件的下载名：Android 的同名文件靠目录区分密度，单独下载时把密度写进文件名 */
function singleName(t: ExportTarget, name: string, ext: string, platform: Platform) {
  const b = safeFileName(name, platform);
  return t.folder ? `${b}${platform === "android" ? "_" : "-"}${t.label}.${ext}` : t.fileName(b, ext);
}

/** 「a、b、c 等」 */
const listNames = (names: string[]) => `${names.slice(0, 3).join("、")}${names.length > 3 ? " 等" : ""}`;

async function run(items: Array<{ nodeId: string; name: string }>, zipName: string) {
  if (busy.value || !items.length) return;
  // 开始时就定下格式、档位、平台与文件名：导出途中改设置不影响这一次
  const format = prefs.exportFormat as BitmapFormat;
  const platform = prefs.platform;
  const targets = chosen.value;
  const ctl = new AbortController();
  abort = ctl;
  busy.value = true;
  message.value = "";
  progress.value = { done: 0, total: items.length * targets.length };
  try {
    if (items.length === 1 && targets.length === 1) {
      const t = targets[0];
      const fileName = singleName(t, items[0].name, extFor(format), platform);
      const size = sizesOf(items[0].nodeId).find((s) => s.target.label === t.label);
      const blob = await renderNode({ designId: props.designId, version: props.version, pageId: props.pageId, nodeId: items[0].nodeId, scale: t.scale, format, signal: ctl.signal });
      ctl.signal.throwIfAborted();
      await downloadBlob(blob, fileName);
      if (size?.shrunk) message.value = `图片${SHRUNK_TIP.replace("会", "已")}`;
      else if (size?.soft) message.value = SOFT_TIP;
      return;
    }
    const r = await exportMany(items, {
      designId: props.designId,
      version: props.version,
      pageId: props.pageId,
      platform,
      designScale: designScale.value,
      format,
      targets,
      signal: ctl.signal,
      onProgress: (done, total) => (progress.value = { done, total }),
    });
    ctl.signal.throwIfAborted();
    if (r.files.length) await downloadBlob(new Blob([zipStore(r.files)], { type: "application/zip" }), `${safeFileName(zipName, "web")}.zip`);
    const notes: string[] = [];
    if (r.failed.length) notes.push(`${r.failed.length} 个图层没能导出（${r.failed[0].error}）：${listNames(r.failed.map((f) => f.name || "未命名"))}`);
    const shrunk = r.downscaled.filter((d) => d.reason === "size");
    const soft = r.downscaled.filter((d) => d.reason === "effects");
    if (shrunk.length) notes.push(`${shrunk.length} 个文件超过 ${MAX_EXPORT_SIDE}px 上限，已等比缩小：${listNames(shrunk.map((d) => `${d.name || "未命名"} ${d.label}`))}`);
    if (soft.length) notes.push(`${soft.length} 个文件里带投影 / 模糊的图层超过渲染上限，连同其中的文字、图片会发糊：${listNames(soft.map((d) => `${d.name || "未命名"} ${d.label}`))}`);
    message.value = notes.join("；");
  } catch (e) {
    if (!ctl.signal.aborted) message.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (abort === ctl) abort = null;
    busy.value = false;
  }
}
function cancel() {
  abort?.abort();
}
function exportSubject() {
  const n = subject.value;
  if (n) void run([{ nodeId: n.id, name: n.name || "画板" }], n.name || "切图");
}
function exportSlice(s: Slice) {
  const n = s.nodes[0];
  if (n) void run([{ nodeId: n.id, name: n.name || "image" }], n.name || "切图");
}
function packAll() {
  void run(
    slices.value.map((s) => ({ nodeId: s.nodes[0].id, name: s.nodes[0].name || "image" })),
    `${page.value?.name || "画板"}-位图`,
  );
}

// ── 位图列表 ──
interface Slice {
  assetId: string;
  w: number;
  h: number;
  nodes: DocNode[];
}
const slices = computed<Slice[]>(() => {
  const d = doc.value;
  if (!d) return [];
  const map = new Map<string, Slice>();
  const visit = (id: string) => {
    const n = d.nodes[id];
    if (!n || !n.visible) return;
    const img = n.image?.assetId ? n.image : n.backgroundImage?.assetId ? n.backgroundImage : null;
    if (img?.assetId && n.id !== props.pageId) {
      let s = map.get(img.assetId);
      if (!s) map.set(img.assetId, (s = { assetId: img.assetId, w: img.naturalWidth ?? 0, h: img.naturalHeight ?? 0, nodes: [] }));
      s.nodes.push(n);
    }
    for (const c of n.children) visit(c);
  };
  visit(props.pageId);
  return [...map.values()];
});
const activeAsset = computed(() => slices.value.find((s) => s.nodes.some((n) => n.id === props.nodeId))?.assetId ?? null);
function hover(s: Slice | null) {
  emit("highlight", s ? s.nodes.map((n) => n.id) : []);
}
function pick(s: Slice) {
  // 多处使用时依次切换到下一处
  const i = s.nodes.findIndex((n) => n.id === props.nodeId);
  const n = s.nodes[(i + 1) % s.nodes.length];
  emit("select", n.id);
  emit("locate", n.id);
}
</script>

<template>
  <div class="slices">
    <section class="card">
      <div class="head">
        <h4>导出</h4>
        <span class="muted plat" :title="`在「标注」面板顶部的设置里切换平台；设计稿 @${designScale}x`">{{ PLATFORM_LABEL[prefs.platform] }} · 设计稿 @{{ designScale }}x</span>
      </div>
      <div v-if="subject" class="subject">
        <div class="pv">
          <img v-if="preview" :src="preview" alt="" />
          <span v-else class="muted">…</span>
        </div>
        <div class="sinfo">
          <span class="sname" :title="subject.name">{{ selectedNode ? subject.name || "未命名" : `整个画板「${subject.name}」` }}</span>
          <span v-if="!selectedNode" class="muted tiny">在画布上选中图层可单独导出</span>
        </div>
      </div>
      <div class="segs">
        <button
          v-for="f in FORMATS"
          :key="f.id"
          class="seg"
          :class="{ on: prefs.exportFormat === f.id }"
          :disabled="f.id === 'webp' && !webpOk"
          :title="f.id === 'webp' && !webpOk ? '当前浏览器不能编码 WEBP' : ''"
          @click="prefs.exportFormat = f.id"
        >
          {{ f.label }}
        </button>
      </div>
      <template v-if="!isSvg">
        <div class="targets">
          <button v-for="t in targets" :key="t.label" class="tg" :class="{ on: picked.has(t.label) }" @click="togglePick(t.label)">
            <span class="ck">{{ picked.has(t.label) ? "✓" : "" }}</span>{{ t.label }}
          </button>
        </div>
        <div v-if="subjectSizes.length" class="sizes">
          <span v-for="s in subjectSizes" :key="s.target.label" class="size" :class="{ shrunk: s.shrunk || s.soft }" :title="s.shrunk ? SHRUNK_TIP : s.soft ? SOFT_TIP : ''">
            <span class="muted">{{ s.target.label }}</span> {{ s.w }}×{{ s.h }}{{ s.shrunk || s.soft ? " ⚠" : "" }}
          </span>
        </div>
        <div v-if="busy" class="prog">
          <div class="bar"><span :style="{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }" /></div>
          <span class="muted tiny">{{ progress.done }}/{{ progress.total }}</span>
          <button class="sm" @click="cancel">取消</button>
        </div>
        <button v-else class="sm primary full" :disabled="!subject" @click="exportSubject">
          导出 {{ chosen.length > 1 ? `${chosen.length} 个尺寸（zip）` : chosen[0]?.label }}
        </button>
      </template>
      <a v-else-if="subject" class="button sm primary full" :href="svgUrl(subject.id)">导出 SVG</a>
      <p v-if="message" class="err">{{ message }}</p>
    </section>

    <section>
      <div class="head">
        <h4>位图 <span class="muted cnt">{{ slices.length }}</span></h4>
        <span class="spacer" />
        <button v-if="slices.length && !isSvg" class="sm" :disabled="busy" title="按上面选的格式与尺寸，导出本画板所有位图并打包" @click="packAll">打包本页位图</button>
      </div>
      <p v-if="!slices.length" class="muted hint">这个画板没有用到位图。</p>
      <div
        v-for="s in slices"
        :key="s.assetId"
        class="item"
        :class="{ active: activeAsset === s.assetId }"
        @mouseenter="hover(s)"
        @mouseleave="hover(null)"
      >
        <button class="thumb" :title="`在画布上选中「${s.nodes[0]?.name}」`" @click="pick(s)"><img :src="assetUrl(s.assetId)" alt="" loading="lazy" /></button>
        <button class="info" @click="pick(s)">
          <span class="nm">{{ s.nodes[0]?.name || "未命名" }}</span>
          <span class="muted meta">原图 {{ s.w }} × {{ s.h }}{{ s.nodes.length > 1 ? ` · ${s.nodes.length} 处使用` : "" }}</span>
        </button>
        <div class="acts">
          <button v-if="!isSvg" class="sm" :disabled="busy" title="按上面选的格式与尺寸导出" @click="exportSlice(s)">导出</button>
          <a class="button sm" :href="originalUrl(s)" title="下载上传时的原图">原图</a>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.slices {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
section {
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
}
h4 {
  margin: 0;
  font-size: 14px;
  display: flex;
  gap: 6px;
  align-items: center;
}
.plat {
  margin-left: auto;
  font-size: 12px;
}
.cnt {
  font-weight: 400;
  font-size: 12px;
}
.subject {
  display: flex;
  gap: 10px;
  align-items: center;
}
.pv {
  width: 72px;
  height: 72px;
  flex-shrink: 0;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: repeating-conic-gradient(#eee 0 25%, #fff 0 50%) 0 0 / 10px 10px;
  display: grid;
  place-items: center;
  overflow: hidden;
}
.pv img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.sinfo {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.sname {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tiny {
  font-size: 11px;
}
.segs {
  display: flex;
  gap: 4px;
}
.seg {
  flex: 1;
  padding: 4px 0;
  font-size: 12px;
  border-radius: 6px;
}
.seg.on,
.tg.on {
  background: var(--brand-soft);
  border-color: var(--brand);
  color: var(--brand);
}
.targets {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.tg {
  padding: 3px 8px 3px 5px;
  font-size: 12px;
  border-radius: 6px;
  gap: 4px;
}
.ck {
  width: 12px;
  height: 12px;
  border-radius: 3px;
  border: 1px solid currentColor;
  font-size: 9px;
  line-height: 10px;
  text-align: center;
  display: inline-block;
}
.sizes {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.size.shrunk {
  color: #ad6800;
}
.prog {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bar {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: var(--bg);
  overflow: hidden;
}
.bar span {
  display: block;
  height: 100%;
  background: var(--brand);
  transition: width 0.15s;
}
.full {
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.err {
  margin: 0;
  font-size: 12px;
  color: var(--danger, #f5222d);
}
.hint {
  margin: 0;
  font-size: 12px;
}
.item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px;
  margin: 0 -4px;
  border-radius: 8px;
}
.item:hover {
  background: #f5f7ff;
}
.item.active {
  background: var(--brand-soft);
}
.thumb {
  width: 48px;
  height: 48px;
  padding: 0;
  flex-shrink: 0;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: repeating-conic-gradient(#eee 0 25%, #fff 0 50%) 0 0 / 10px 10px;
  display: grid;
  place-items: center;
  overflow: hidden;
}
.thumb img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  border: none;
  background: none;
  padding: 0;
}
.nm {
  max-width: 100%;
  color: var(--text);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta {
  font-size: 11px;
  font-weight: 400;
}
.acts {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.info,
.thumb {
  height: auto;
  box-shadow: none;
}
.thumb {
  height: 48px;
}
.tg,
.seg {
  height: 26px;
  box-shadow: none;
}
</style>
