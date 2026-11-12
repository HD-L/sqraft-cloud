<script setup lang="ts">
/**
 * 标注面板（v2）：选中图层的
 * - 位置与尺寸（相对父级 / 画板、尺寸模式、最小最大值、绝对定位、旋转、圆角、实际不透明度、裁剪 / 蒙版）；
 * - 所属组件（组件名、属性值、覆盖数）；填充、描边、文字、效果、自动布局；
 * - 可直接用的 CSS（语法高亮，每个分区可单独复制）。
 * 所有数值按顶部设置换算（平台、设计稿倍率、rem 基准、精度），绑定了 Token 的值下方挂 Token 标签，
 * 颜色未绑定但与某个 Token 相同时提示「≈ Token（未绑定）」。点任意值复制，点色块切换颜色格式。
 */
import { computed, ref, shallowRef, watch, type Component } from "vue";
import { Circle, Component as Component2, Monitor, Smartphone, Tablet, Diamond, Frame, Group, Image, Minus, PenTool, Settings2, Square, SquareDashed, Star, Triangle, Type } from "lucide-vue-next";
import type { DocNode, DocState } from "@sqraft/core";
import { getPageDoc } from "../viewer/pageDocs";
import { componentsOf, instanceProps, overrideCount, type ComponentMeta } from "../viewer/components";
import { deviceOf, effectiveOpacity, maskInfo, owningInstance, PageGeometry, parentLocal, TYPE_LABEL, WEIGHT_LABEL } from "../viewer/inspect";
import { buildSpec } from "../viewer/codegen/spec";
import { cssFor } from "../viewer/codegen/css";
import { highlightCss } from "../viewer/codegen/highlight";
import { alphaPercent, COLOR_FORMATS, defaultFormatFor, formatColor, matchTokens, nextFormat, parseColor, tokenIndex, type Color } from "../viewer/color";
import { autoDesignScale, fmtLen, fmtNum, lenUnit, PLATFORM_LABEL, summary, unitCtx, type Platform } from "../viewer/units";
import { prefs, setDesignScale } from "../viewer/prefs";
import { copyText } from "../viewer/copy";
import InspectValue from "./InspectValue.vue";
import InspectSection from "./InspectSection.vue";

const props = defineProps<{ designId: string; version: number; pageId: string; nodeId: string | null }>();
const emit = defineEmits<{ select: [id: string | null] }>();

const doc = shallowRef<DocState | null>(null);
const geo = shallowRef<PageGeometry | null>(null);
const comps = shallowRef<Map<string, ComponentMeta>>(new Map());
const showSettings = ref(false);

let seq = 0;
watch(
  () => [props.designId, props.version, props.pageId] as const,
  async ([d, v, p]) => {
    const mine = ++seq;
    const [loaded, c] = await Promise.all([getPageDoc(d, v, p).catch(() => null), componentsOf(d, v)]);
    if (mine !== seq) return;
    doc.value = loaded;
    geo.value = loaded ? new PageGeometry(loaded, p) : null;
    comps.value = c;
  },
  { immediate: true },
);

const page = computed(() => doc.value?.nodes[props.pageId] ?? null);
const node = computed<DocNode | null>(() => (props.nodeId && doc.value?.nodes[props.nodeId]) || null);
const spec = computed(() => (node.value && doc.value ? buildSpec(doc.value, node.value.id) : null));
const crumbs = computed(() => (node.value && geo.value ? geo.value.ancestors(node.value.id) : []));
const device = computed(() => deviceOf(page.value?.width ?? 0));
const tokens = computed(() => (doc.value ? tokenIndex(doc.value.tokens as Record<string, { type: string; value: string | number }>) : new Map<string, string[]>()));

// ── 单位 ──
const ctx = computed(() => unitCtx(prefs, props.designId, page.value?.width ?? 0));
const L = (v: number, text = false) => fmtLen(v, ctx.value, { text });
const U = (text = false) => lenUnit(ctx.value, { text });
/** CSS 用的长度：小程序用 rpx，其余平台的 CSS 一律按 Web（px / rem） */
const cssLen = (v: number, opts?: { text?: boolean }) =>
  ctx.value.platform === "mp" ? fmtLen(v, ctx.value, { withUnit: true }) : fmtLen(v, { ...ctx.value, platform: "web" }, { ...opts, withUnit: true });
const designScale = computed(() => prefs.designScale[props.designId] ?? "auto");
const targetWidth = ref("");
function setPlatform(p: Platform) {
  prefs.platform = p;
  prefs.color = defaultFormatFor(p);
}
function applyTargetWidth() {
  const w = Number(targetWidth.value);
  if (page.value && w > 0) setDesignScale(props.designId, page.value.width / w);
  targetWidth.value = "";
}

// ── 颜色 ──
interface ColorView {
  color: Color;
  text: string;
  swatch: string;
  alpha: string;
  token: string;
  similar: string;
}
function colorView(css: string | undefined, token?: string): ColorView | null {
  const c = parseColor(css);
  if (!c) return null;
  const similar = token ? "" : (matchTokens(tokens.value, c)[0] ?? "");
  return { color: c, text: formatColor(c, prefs.color), swatch: `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`, alpha: alphaPercent(c), token: token ?? "", similar };
}
/** 颜色值下方的说明：绑定了 Token 时写实际颜色；没绑定但和某个 Token 同色时提示；半透明时写不透明度 */
function colorSub(v: ColorView): string {
  return [v.token ? v.text : v.similar ? `≈ ${v.similar}（未绑定）` : "", v.color.a < 1 ? `不透明度 ${v.alpha}%` : ""].filter(Boolean).join(" · ");
}
function cycleColor() {
  prefs.color = nextFormat(prefs.color);
}
const fill = computed(() => (spec.value?.fill && spec.value.text === null ? colorView(spec.value.fill.color, spec.value.fill.token) : null));
const textColor = computed(() => (spec.value?.text && spec.value.fill ? colorView(spec.value.fill.color, spec.value.fill.token) : null));
const stroke = computed(() => (spec.value?.stroke ? colorView(spec.value.stroke.color, spec.value.stroke.token) : null));

// ── 位置与尺寸 ──
const pos = computed(() => {
  if (!node.value || !geo.value) return null;
  return prefs.positionBase === "parent" ? parentLocal(geo.value, node.value.id) : geo.value.local(node.value.id);
});
const parentIsPage = computed(() => node.value?.parentId === props.pageId);
const SIZING: Record<string, string> = { fixed: "固定", hug: "适应内容", fill: "填充容器" };
const showSizing = computed(() => !!spec.value && (!!spec.value.parentLayout || !!spec.value.layout) && spec.value.text === null);
const opacity = computed(() => {
  if (!node.value || !geo.value) return null;
  const own = node.value.opacity ?? 1;
  const real = effectiveOpacity(geo.value, node.value.id);
  return own < 1 || real < 1 ? { own, real } : null;
});
const mask = computed(() => (node.value && geo.value ? maskInfo(geo.value, node.value.id) : null));
const radius = computed(() => spec.value?.radius ?? null);

// ── 组件 ──
const instance = computed(() => (node.value && geo.value ? owningInstance(geo.value, node.value.id) : null));
const instanceInfo = computed(() => {
  const inst = instance.value;
  if (!inst) return null;
  const meta = inst.componentId ? comps.value.get(inst.componentId) : undefined;
  return { inst, name: meta?.name ?? inst.name, props: instanceProps(inst, meta, comps.value), overrides: overrideCount(inst), isSelf: inst.id === node.value?.id };
});

// ── 图片 ──
const image = computed(() => {
  const n = node.value;
  const assetId = n?.image?.assetId ?? n?.backgroundImage?.assetId;
  if (!n || !assetId) return null;
  const w = n.image?.naturalWidth ?? n.backgroundImage?.naturalWidth;
  const h = n.image?.naturalHeight ?? n.backgroundImage?.naturalHeight;
  const base = `/api/v1/designs/${props.designId}/versions/${props.version}/assets/${encodeURIComponent(assetId)}`;
  return { src: base, download: `${base}?download=${encodeURIComponent(n.name || "切图")}`, w, h };
});

// ── 文字 ──
const text = computed(() => spec.value?.text ?? null);
const ALIGN: Record<string, string> = { left: "左对齐", center: "居中", right: "右对齐", justify: "两端对齐" };
const VALIGN: Record<string, string> = { top: "顶部", middle: "垂直居中", bottom: "底部" };
const AUTO: Record<string, string> = { "auto-width": "自动宽度", "auto-height": "自动高度", fixed: "固定尺寸" };
const CASE: Record<string, string> = { upper: "全部大写", lower: "全部小写", title: "首字母大写" };
const DECO: Record<string, string> = { underline: "下划线", strikethrough: "删除线" };
const textFlags = computed(() => {
  const t = text.value;
  if (!t) return [];
  return [t.italic ? "斜体" : "", CASE[t.case] ?? "", DECO[t.decoration] ?? "", t.truncate ? "单行省略" : "", node.value?.listType && node.value.listType !== "none" ? (node.value.listType === "bulleted" ? "项目符号列表" : "编号列表") : ""].filter(Boolean);
});
const previewStyle = computed(() => {
  const t = text.value;
  if (!t) return {};
  return {
    fontFamily: t.family,
    fontWeight: String(t.weight),
    fontStyle: t.italic ? "italic" : "normal",
    fontSize: `${Math.min(20, Math.max(11, t.size / ctx.value.scale))}px`,
    color: textColor.value ? `rgba(${textColor.value.color.r}, ${textColor.value.color.g}, ${textColor.value.color.b}, ${textColor.value.color.a})` : undefined,
    textAlign: t.align as "left",
  };
});
const previewDark = computed(() => !!textColor.value && textColor.value.color.r + textColor.value.color.g + textColor.value.color.b > 640 && textColor.value.color.a > 0.5);

// ── 自动布局 ──
const layout = computed(() => spec.value?.layout ?? null);
const MAIN: Record<string, string> = { start: "起点", center: "居中", end: "终点", "space-between": "两端分布" };
const CROSS: Record<string, string> = { start: "起点", center: "居中", end: "终点", stretch: "拉伸" };

// ── CSS ──
const css = computed(() => (spec.value ? cssFor(spec.value, { len: cssLen, tokenVars: prefs.tokenVars }) : null));
const cssOf = (...keys: string[]) => (css.value ? css.value.sections.filter((s) => keys.includes(s.key)).flatMap((s) => s.lines).join("\n") : "");
const cssHtml = computed(() => (css.value ? highlightCss(css.value.text) : ""));
const cssCopied = ref(false);
function copyAllCss() {
  if (!css.value) return;
  void copyText(css.value.text);
  cssCopied.value = true;
  window.setTimeout(() => (cssCopied.value = false), 1000);
}

const TYPE_ICON: Record<string, Component> = {
  page: Frame,
  frame: Frame,
  group: Group,
  rect: Square,
  ellipse: Circle,
  line: Minus,
  polygon: Triangle,
  star: Star,
  path: PenTool,
  text: Type,
  image: Image,
  component: Component2,
  instance: Diamond,
  slot: SquareDashed,
};
</script>

<template>
  <div class="inspect">
    <div class="bar">
      <span class="dicon" :title="device.label"><component :is="device.icon === '📱' ? Smartphone : device.icon === '💻' ? Tablet : Monitor" :size="15" /></span>
      <span class="sum" :title="summary(ctx)">{{ summary(ctx) }}</span>
      <button class="gear" :class="{ on: showSettings }" title="单位、倍率与颜色格式" aria-label="单位、倍率与颜色格式" @click="showSettings = !showSettings"><Settings2 :size="15" /></button>
    </div>
    <div v-if="showSettings" class="settings">
      <div class="srow">
        <span class="sl">平台</span>
        <button v-for="p in (['web', 'ios', 'android', 'mp'] as Platform[])" :key="p" class="seg" :class="{ on: prefs.platform === p }" @click="setPlatform(p)">{{ PLATFORM_LABEL[p] }}</button>
      </div>
      <div v-if="prefs.platform === 'web'" class="srow">
        <span class="sl">单位</span>
        <button class="seg" :class="{ on: prefs.webUnit === 'px' }" @click="prefs.webUnit = 'px'">px</button>
        <button class="seg" :class="{ on: prefs.webUnit === 'rem' }" @click="prefs.webUnit = 'rem'">rem</button>
        <template v-if="prefs.webUnit === 'rem'">
          <span class="sl small">基准</span>
          <input v-model.number="prefs.remBase" type="number" min="1" max="100" class="num" />
          <span class="muted">px</span>
        </template>
      </div>
      <div class="srow">
        <span class="sl">设计稿</span>
        <button class="seg" :class="{ on: designScale === 'auto' }" @click="setDesignScale(designId, 'auto')">自动 @{{ autoDesignScale(page?.width ?? 0) }}x</button>
        <button v-for="x in [1, 2, 3]" :key="x" class="seg" :class="{ on: designScale === x }" @click="setDesignScale(designId, x)">@{{ x }}x</button>
      </div>
      <div class="srow">
        <span class="sl" />
        <input v-model="targetWidth" type="number" min="1" class="num wide" placeholder="或按目标宽度，如 375" @keydown.enter="applyTargetWidth" />
        <button class="seg" :disabled="!targetWidth" @click="applyTargetWidth">换算</button>
      </div>
      <div class="srow">
        <span class="sl">精度</span>
        <button v-for="x in ([2, 1, 0] as const)" :key="x" class="seg" :class="{ on: prefs.precision === x }" @click="prefs.precision = x">{{ x ? `${x} 位小数` : "取整" }}</button>
      </div>
      <div class="srow">
        <span class="sl">颜色</span>
        <select v-model="prefs.color" class="sel">
          <option v-for="f in COLOR_FORMATS" :key="f.id" :value="f.id">{{ f.label }}</option>
        </select>
      </div>
      <label class="srow chk"><input v-model="prefs.tokenVars" type="checkbox" /> CSS 里把 Token 写成 var(--token, 值)</label>
    </div>

    <div class="body">
      <!-- 没选中：画板信息 -->
      <template v-if="!node">
        <div v-if="page" class="head">
          <span class="ticon"><component :is="TYPE_ICON.page" :size="15" /></span>
          <div class="hname"><div class="htype">画板</div><button class="nm" @click="copyText(page.name)">{{ page.name }}</button></div>
        </div>
        <div v-if="page" class="pad">
          <div class="row"><span class="lb">尺寸</span><InspectValue :value="L(page.width)" :unit="U()" hint="宽" /><InspectValue :value="L(page.height)" :unit="U()" hint="高" /></div>
        </div>
        <p class="tip">
          单击画布上的图层查看标注。选中后：移到另一个图层看间距；移回选中图层看到父容器的距离；移到画板外看到画板边的距离；按住 <kbd>⌥</kbd> 显示百分比。
        </p>
      </template>

      <template v-else-if="spec && pos">
        <div v-if="crumbs.length > 1" class="crumbs">
          <template v-for="(a, i) in crumbs.slice(1)" :key="a.id">
            <span v-if="i" class="sep">›</span><button class="crumb" :title="a.name" @click="emit('select', a.id)">{{ a.name || TYPE_LABEL[a.type] }}</button>
          </template>
        </div>
        <div class="head">
          <span class="ticon"><component :is="TYPE_ICON[node.type] ?? Square" :size="15" /></span>
          <div class="hname">
            <div class="htype">{{ TYPE_LABEL[node.type] ?? node.type }}</div>
            <button class="nm" title="复制图层名" @click="copyText(node.name)">{{ node.name }}</button>
          </div>
        </div>
        <div v-if="instanceInfo" class="comp">
          <div class="crow">
            <span class="cname"><Diamond :size="13" />{{ instanceInfo.name }}</span>
            <span v-if="instanceInfo.overrides" class="muted cmeta">覆盖 {{ instanceInfo.overrides }} 处</span>
            <span class="spacer" />
            <button v-if="!instanceInfo.isSelf" class="mini" title="选中所属的组件实例" @click="emit('select', instanceInfo.inst.id)">选中实例</button>
          </div>
          <div v-if="instanceInfo.props.length" class="cprops">
            <span v-for="p in instanceInfo.props" :key="p.name" class="cprop">{{ p.name }} = {{ p.value }}</span>
          </div>
        </div>

        <InspectSection id="geometry" title="位置与尺寸" :css="cssOf('layout', 'size', 'position')">
          <template #extra>
            <span class="segs" @click.stop>
              <button class="seg tiny" :class="{ on: prefs.positionBase === 'parent' }" :disabled="parentIsPage" @click="prefs.positionBase = 'parent'">父级</button>
              <button class="seg tiny" :class="{ on: prefs.positionBase === 'artboard' || parentIsPage }" @click="prefs.positionBase = 'artboard'">画板</button>
            </span>
          </template>
          <div class="row"><span class="lb">位置</span><InspectValue :value="L(pos.x)" :unit="U()" hint="X" /><InspectValue :value="L(pos.y)" :unit="U()" hint="Y" /></div>
          <div class="row">
            <span class="lb">尺寸</span>
            <InspectValue :value="L(spec.width)" :unit="U()" hint="宽" :sub="showSizing ? SIZING[spec.sizing.w] : ''" />
            <InspectValue :value="L(spec.height)" :unit="U()" hint="高" :sub="showSizing ? SIZING[spec.sizing.h] : ''" />
          </div>
          <div v-if="spec.minW !== undefined || spec.maxW !== undefined" class="row">
            <span class="lb">宽度范围</span>
            <InspectValue :value="spec.minW !== undefined ? L(spec.minW) : '—'" hint="最小" /><InspectValue :value="spec.maxW !== undefined ? L(spec.maxW) : '—'" hint="最大" />
          </div>
          <div v-if="spec.minH !== undefined || spec.maxH !== undefined" class="row">
            <span class="lb">高度范围</span>
            <InspectValue :value="spec.minH !== undefined ? L(spec.minH) : '—'" hint="最小" /><InspectValue :value="spec.maxH !== undefined ? L(spec.maxH) : '—'" hint="最大" />
          </div>
          <div v-if="spec.rotation || spec.ownRotation" class="row">
            <span class="lb">旋转</span>
            <InspectValue :value="fmtNum(spec.ownRotation, 2)" unit="°" :sub="spec.rotation !== spec.ownRotation ? `叠加父级后 ${fmtNum(spec.rotation, 2)}°` : ''" />
          </div>
          <div v-if="radius && radius.uniform !== null" class="row">
            <span class="lb">圆角</span><InspectValue :value="L(radius.uniform)" :unit="U()" :token="radius.tokens.topLeft ?? ''" />
          </div>
          <div v-else-if="radius" class="row">
            <span class="lb">圆角</span>
            <InspectValue :value="L(radius.corners.topLeft)" hint="↖" :token="radius.tokens.topLeft ?? ''" />
            <InspectValue :value="L(radius.corners.topRight)" hint="↗" :token="radius.tokens.topRight ?? ''" />
            <InspectValue :value="L(radius.corners.bottomRight)" hint="↘" :token="radius.tokens.bottomRight ?? ''" />
            <InspectValue :value="L(radius.corners.bottomLeft)" hint="↙" :token="radius.tokens.bottomLeft ?? ''" />
          </div>
          <div v-if="opacity" class="row">
            <span class="lb">不透明度</span>
            <InspectValue :value="fmtNum(opacity.own * 100, 1)" unit="%" :sub="Math.abs(opacity.real - opacity.own) > 0.001 ? `叠加父级后实际 ${fmtNum(opacity.real * 100, 1)}%` : ''" />
          </div>
          <div v-if="spec.clip || mask?.isMask || mask?.maskedBy || (spec.position.mode === 'absolute' && spec.parentLayout)" class="flags">
            <span v-if="spec.position.mode === 'absolute' && spec.parentLayout" class="flag">绝对定位（不参与父级自动布局）</span>
            <span v-if="spec.clip" class="flag">裁剪超出的内容</span>
            <span v-if="mask?.isMask" class="flag">蒙版图层（自身不显示）</span>
            <button v-if="mask?.maskedBy" class="flag link" @click="emit('select', mask.maskedBy.id)">被「{{ mask.maskedBy.name }}」蒙版裁切</button>
          </div>
        </InspectSection>

        <InspectSection v-if="image" id="image" title="图片">
          <div class="img"><img :src="image.src" alt="" /></div>
          <div class="row">
            <span class="lb">原图</span>
            <InspectValue v-if="image.w" :value="`${image.w} × ${image.h}`" unit="px" wide />
            <a class="button sm" :href="image.download">下载</a>
          </div>
        </InspectSection>

        <InspectSection v-if="fill && !spec.isImage" id="fill" title="填充" :css="cssOf('appearance')">
          <div class="row">
            <span class="lb">颜色</span>
            <InspectValue
              :value="fill.token || fill.text"
              :copy="fill.text"
              :swatch="fill.swatch"
              :sub="colorSub(fill)"
              @swatch="cycleColor"
            />
          </div>
        </InspectSection>

        <InspectSection v-if="stroke && spec.stroke" id="stroke" title="描边" :css="cssOf('stroke')">
          <div class="row">
            <span class="lb">粗细</span>
            <InspectValue :value="L(spec.stroke.width)" :unit="U()" :token="spec.stroke.widthToken ?? ''" />
            <InspectValue value="居中" sub="内外各占一半" />
          </div>
          <div class="row">
            <span class="lb">颜色</span>
            <InspectValue
              :value="stroke.token || stroke.text"
              :copy="stroke.text"
              :swatch="stroke.swatch"
              :sub="colorSub(stroke)"
              @swatch="cycleColor"
            />
          </div>
        </InspectSection>

        <InspectSection v-if="text" id="text" title="文字" :css="cssOf('text')">
          <button class="preview" :class="{ dark: previewDark }" :style="previewStyle" title="点击复制文字内容" @click="copyText(node.text ?? '')">{{ node.text }}</button>
          <div class="row"><span class="lb">字体</span><InspectValue :value="text.family" wide /></div>
          <div class="row">
            <span class="lb">字重</span>
            <InspectValue :value="WEIGHT_LABEL[text.weight] ?? String(text.weight)" :copy="String(text.weight)" />
            <InspectValue :value="String(text.weight)" />
          </div>
          <div class="row">
            <span class="lb">字号</span>
            <InspectValue :value="L(text.size, true)" :unit="U(true)" :token="text.tokens.size ?? ''" />
            <InspectValue
              :value="L(text.lineHeight, true)"
              :unit="U(true)"
              hint="行高"
              :token="text.tokens.lineHeight ?? ''"
              :sub="`${fmtNum(text.lineHeight / text.size, 2)}×${text.lineHeightAuto ? ' · 自动' : ''}`"
            />
          </div>
          <div class="row">
            <span class="lb">字距</span>
            <InspectValue :value="L(text.letterSpacing, true)" :unit="U(true)" :token="text.tokens.letterSpacing ?? ''" :sub="text.letterSpacing ? `${fmtNum(text.letterSpacing / text.size, 2)}em` : ''" />
            <InspectValue v-if="text.paragraphSpacing" :value="L(text.paragraphSpacing, true)" :unit="U(true)" hint="段距" :token="node.style.paragraphSpacingToken ?? ''" />
          </div>
          <div class="row">
            <span class="lb">对齐</span>
            <InspectValue :value="ALIGN[text.align]" />
            <InspectValue :value="VALIGN[text.verticalAlign]" />
          </div>
          <div class="row"><span class="lb">尺寸</span><InspectValue :value="AUTO[text.autoResize]" /></div>
          <div v-if="textFlags.length" class="flags"><span v-for="f in textFlags" :key="f" class="flag">{{ f }}</span></div>
          <div v-if="textColor" class="row">
            <span class="lb">颜色</span>
            <InspectValue
              :value="textColor.token || textColor.text"
              :copy="textColor.text"
              :swatch="textColor.swatch"
              :sub="colorSub(textColor)"
              @swatch="cycleColor"
            />
          </div>
        </InspectSection>

        <InspectSection v-if="spec.shadows.length || spec.blurs.length" id="effects" title="效果" :css="cssOf('effects')">
          <template v-for="(e, i) in spec.shadows" :key="`s${i}`">
            <div class="row"><span class="lb">{{ e.inset ? "内阴影" : "投影" }}</span><InspectValue :value="L(e.x)" hint="X" /><InspectValue :value="L(e.y)" hint="Y" /></div>
            <div class="row"><span class="lb" /><InspectValue :value="L(e.blur)" hint="模糊" /><InspectValue :value="L(e.spread)" hint="扩展" /></div>
            <div v-for="c in [colorView(e.color, e.token)].filter((x) => !!x)" :key="`c${i}`" class="row">
              <span class="lb" />
              <InspectValue :value="c!.token || c!.text" :copy="c!.text" :swatch="c!.swatch" :sub="colorSub(c!)" @swatch="cycleColor" />
            </div>
          </template>
          <div v-for="(b, i) in spec.blurs" :key="`b${i}`" class="row">
            <span class="lb">{{ b.type === "backdrop" ? "背景模糊" : "图层模糊" }}</span><InspectValue :value="L(b.radius)" :unit="U()" />
          </div>
        </InspectSection>

        <InspectSection v-if="layout" id="layout" title="自动布局" :css="cssOf('autolayout')">
          <div class="row">
            <span class="lb">方向</span>
            <InspectValue :value="layout.direction === 'horizontal' ? '水平 →' : '垂直 ↓'" />
            <InspectValue :value="L(layout.gap)" :unit="U()" hint="间距" :token="layout.gapToken ?? ''" />
          </div>
          <div v-if="layout.wrap" class="row">
            <span class="lb">换行</span><InspectValue :value="L(layout.crossGap)" :unit="U()" hint="行间距" :token="layout.crossGapToken ?? ''" />
          </div>
          <div class="row">
            <span class="lb">内边距</span>
            <InspectValue :value="L(layout.padding.top)" hint="上" :token="layout.paddingTokens?.top ?? ''" />
            <InspectValue :value="L(layout.padding.right)" hint="右" :token="layout.paddingTokens?.right ?? ''" />
            <InspectValue :value="L(layout.padding.bottom)" hint="下" :token="layout.paddingTokens?.bottom ?? ''" />
            <InspectValue :value="L(layout.padding.left)" hint="左" :token="layout.paddingTokens?.left ?? ''" />
          </div>
          <div class="row">
            <span class="lb">对齐</span>
            <InspectValue :value="MAIN[layout.mainAlign]" hint="主轴" />
            <InspectValue :value="CROSS[layout.crossAlign]" hint="交叉轴" />
          </div>
        </InspectSection>

        <InspectSection id="code" title="CSS">
          <template #extra>
            <button class="mini" @click.stop="copyAllCss">{{ cssCopied ? "✓ 已复制" : "复制全部" }}</button>
          </template>
          <!-- highlightCss 已对全部文本做 HTML 转义（图层名可能含 <script> 之类） -->
          <pre class="code hl" v-html="cssHtml" />
        </InspectSection>
      </template>
    </div>
  </div>
</template>

<style scoped>
.inspect {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-2);
}
.dicon {
  font-size: 15px;
}
.sum {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gear {
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  background: none;
  box-shadow: none;
  color: var(--text-2);
}
.gear:hover:not(:disabled) {
  background: var(--hover);
}
.gear.on {
  color: var(--brand);
}
.settings {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  background: #fafbfe;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.srow {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.sl {
  width: 44px;
  font-size: 12px;
  color: var(--text-2);
}
.sl.small {
  width: auto;
  margin-left: 6px;
}
.seg {
  padding: 3px 8px;
  font-size: 12px;
  border-radius: 6px;
}
.seg.tiny {
  padding: 1px 6px;
  font-size: 11px;
  border-radius: 5px;
}
.seg.on {
  background: var(--brand-soft);
  border-color: var(--brand);
  color: var(--brand);
}
.segs {
  display: inline-flex;
  gap: 2px;
}
.num {
  width: 56px;
  padding: 3px 6px;
  font-size: 12px;
}
.num.wide {
  width: 170px;
}
.sel {
  padding: 3px 6px;
  font-size: 12px;
}
.chk {
  font-size: 12px;
  color: var(--text-2);
}
.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px 8px;
}
.ticon {
  width: 30px;
  height: 30px;
  border-radius: 7px;
  background: var(--bg);
  display: grid;
  place-items: center;
  font-size: 14px;
  color: var(--text-2);
  flex-shrink: 0;
}
.hname {
  min-width: 0;
  flex: 1;
}
.htype {
  font-size: 11px;
  color: var(--muted);
}
.nm {
  display: block;
  max-width: 100%;
  border: none;
  padding: 0;
  font-size: 14px;
  font-weight: 650;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}
.comp {
  margin: 0 12px 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: #f6f1ff;
  border: 1px solid #e6dcff;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.crow {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cname {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  color: var(--purple);
  font-weight: 600;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cmeta {
  font-size: 11px;
  white-space: nowrap;
}
.cprops {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.cprop {
  font-size: 11px;
  background: #fff;
  border: 1px solid #e6dcff;
  border-radius: 4px;
  padding: 0 5px;
  color: var(--text-2);
}
.row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}
.lb {
  width: 52px;
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-2);
  line-height: 30px;
}
.mini {
  padding: 2px 8px;
  font-size: 11px;
  border-radius: 6px;
  flex-shrink: 0;
}
.flags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.flag {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: #fff7e6;
  color: #ad6800;
  border: none;
  font-weight: 500;
}
.flag.link {
  cursor: pointer;
}
.crumbs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  padding: 8px 12px 0;
  font-size: 12px;
}
.crumb {
  border: none;
  padding: 1px 4px;
  font-weight: 400;
  font-size: 12px;
  color: var(--brand);
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sep {
  color: var(--muted);
}
.preview {
  display: block;
  width: 100%;
  text-align: left;
  white-space: pre-wrap;
  word-break: break-word;
  border: 1px solid var(--border);
  background: #fff;
  border-radius: 6px;
  padding: 8px 10px;
  max-height: 120px;
  overflow-y: auto;
  justify-content: flex-start;
  line-height: 1.4;
}
.preview.dark {
  background: #2b2f3a;
}
.img {
  background: repeating-conic-gradient(#eee 0 25%, #fff 0 50%) 0 0 / 12px 12px;
  border-radius: 6px;
  border: 1px solid var(--border);
  display: grid;
  place-items: center;
  max-height: 160px;
  overflow: hidden;
}
.img img {
  max-width: 100%;
  max-height: 158px;
  object-fit: contain;
}
pre.code {
  margin: 0;
  max-height: 320px;
  overflow: auto;
}
.hl :deep(.c-comment) {
  color: #7f8aa8;
}
.hl :deep(.c-prop) {
  color: #8fb8ff;
}
.hl :deep(.c-value) {
  color: #e6e9f5;
}
.hl :deep(.c-num) {
  color: #ffb86b;
}
.hl :deep(.c-func) {
  color: #c49bff;
}
.hl :deep(.c-punct) {
  color: #7f8aa8;
}
.pad {
  padding: 0 12px 12px;
}
.tip {
  padding: 4px 12px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.7;
}
kbd {
  font-family: inherit;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 4px;
}

/* 全局按钮固定 32px 高：面板里这些按钮是文字、标签或多行块，按内容撑开 */
.nm,
.crumb,
.preview,
.flag.link {
  height: auto;
  box-shadow: none;
}
.nm,
.crumb {
  background: none;
}
.seg,
.mini {
  height: 24px;
  box-shadow: none;
}
.seg.tiny {
  height: 20px;
}
.flag.link {
  line-height: 18px;
}
</style>
