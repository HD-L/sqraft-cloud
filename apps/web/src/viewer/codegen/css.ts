/**
 * NodeSpec → CSS。目标是「复制出来就能用」：
 * - 尺寸按父级布局解释：flex 主轴 fill → flex: 1 1 0（不写该轴尺寸），交叉轴 fill → align-self: stretch，
 *   hug / 文本自动尺寸 → 不写该轴尺寸；
 * - 父级没有自动布局、或自身绝对定位 → position: absolute + left / top（相对父级），父级写 position: relative；
 * - Sqraft 的描边居中：用 outline + 负的 outline-offset 表达（不占布局，与画面一致），文字用 -webkit-text-stroke；
 * - 绑定 Token 的值可写成 var(--token-name, 字面量)；
 * - 长度一律经调用方给的 len() 换算单位（px / rem / rpx …）。
 * 输出按分区组织，面板可逐个分区复制。纯函数，无 DOM 依赖。
 */
import type { NodeSpec } from "./spec";

export interface CssOptions {
  /** 设计稿长度 → 带单位的 CSS 值，如 "16px"、"1rem"、"32rpx"；text 表示字号 / 行高 / 字距 */
  len: (v: number, opts?: { text?: boolean }) => string;
  /** 绑定 Token 的值输出成 var(--token-name, 字面量) */
  tokenVars: boolean;
}

export type CssSectionKey = "layout" | "size" | "position" | "appearance" | "stroke" | "effects" | "text" | "autolayout";

export interface CssSection {
  key: CssSectionKey;
  title: string;
  lines: string[];
}

const SECTION_TITLES: Record<CssSectionKey, string> = {
  layout: "排布",
  size: "尺寸",
  position: "定位",
  appearance: "外观",
  stroke: "描边",
  effects: "效果",
  text: "文字",
  autolayout: "自动布局",
};
const SECTION_ORDER: CssSectionKey[] = ["layout", "size", "position", "appearance", "stroke", "effects", "text", "autolayout"];

/** Token 路径 → CSS 变量名："color/brand primary" → "--color-brand-primary"，"颜色/主色" → "--颜色-主色"（转小写，字母、数字、"-"、"_" 以外的字符换成 "-"） */
export function cssVarName(token: string): string {
  // CSS 自定义属性名可以含中文等非 ASCII 字符（含泰文、天城文的组合符号），只把分隔符和符号换成 "-"：
  // 按非法字符切段再用 "-" 连起来；原文里的 "-" 保留，"space/-4" → "--space--4"，不会与 "space/4" 撞名
  const name = token
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}_-]+/u)
    .filter(Boolean)
    .join("-");
  return `--${name || "token"}`;
}

/** 非长度数值（不透明度、角度、字重）：最多两位小数，去掉 -0 */
function num(n: number): string {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
}

const GENERIC_FAMILIES = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "emoji", "math", "fangsong"]);

/** font-family：已经是列表（含逗号）或带引号的原样输出；通用族名不加引号；其余加双引号 */
function fontFamilyCss(family: string): string {
  const f = family.trim();
  if (/[,"']/.test(f) || GENERIC_FAMILIES.has(f.toLowerCase())) return f;
  return `"${f}"`;
}

/** 四个值的简写：全同 → 1 个，上下 / 左右各自相同 → 2 个，否则 4 个 */
function box4(top: string, right: string, bottom: string, left: string): string {
  if (top === right && top === bottom && top === left) return top;
  if (top === bottom && right === left) return `${top} ${right}`;
  return `${top} ${right} ${bottom} ${left}`;
}

const JUSTIFY: Record<string, string> = { start: "flex-start", center: "center", end: "flex-end", "space-between": "space-between" };
const ALIGN: Record<string, string> = { start: "flex-start", center: "center", end: "flex-end", stretch: "stretch" };
const ALIGN_CONTENT: Record<string, string> = { start: "flex-start", center: "center", end: "flex-end", "space-between": "space-between", stretch: "stretch" };

/** 一个轴在 CSS 里怎么写尺寸 */
type AxisMode = "fixed" | "hug" | "fill-main" | "fill-cross";

function axisMode(spec: NodeSpec, axis: "w" | "h"): AxisMode {
  const pl = spec.position.mode === "flow" ? spec.parentLayout : null;
  if (pl && spec.sizing[axis] === "fill") {
    const main = pl.direction === "horizontal" ? "w" : "h";
    // Sqraft 换行布局里主轴 fill 不分配剩余空间（见 core solveLayout），按固定尺寸写
    if (axis === main) return pl.wrap ? "fixed" : "fill-main";
    return "fill-cross";
  }
  if (spec.text) {
    if (spec.text.autoResize === "auto-width") return "hug";
    if (spec.text.autoResize === "auto-height" && axis === "h") return "hug";
  }
  // hug 只对自动布局容器有意义（尺寸由内容撑开）；其他节点仍写固定尺寸
  if (spec.sizing[axis] === "hug" && spec.layout) return "hug";
  return "fixed";
}

export function cssFor(spec: NodeSpec, opts: CssOptions): { sections: CssSection[]; text: string } {
  const L = (v: number) => opts.len(v);
  const T = (v: number) => opts.len(v, { text: true });
  /** 绑定 Token 时写成 var(--name, 字面量) */
  const tv = (value: string, token: string | undefined) => (opts.tokenVars && token ? `var(${cssVarName(token)}, ${value})` : value);

  const out: Record<CssSectionKey, string[]> = { layout: [], size: [], position: [], appearance: [], stroke: [], effects: [], text: [], autolayout: [] };
  const isText = !!spec.text;
  const pl = spec.position.mode === "flow" ? spec.parentLayout : null;
  const wMode = axisMode(spec, "w");
  const hMode = axisMode(spec, "h");

  // ── 排布：作为 flex 子项 ──
  if (pl) {
    const mainMode = pl.direction === "horizontal" ? wMode : hMode;
    const crossMode = pl.direction === "horizontal" ? hMode : wMode;
    if (mainMode === "fill-main") out.layout.push("flex: 1 1 0;");
    // Sqraft 的子项不会被压缩：CSS flex 子项默认可收缩，要关掉
    else out.layout.push("flex-shrink: 0;");
    if (crossMode === "fill-cross") out.layout.push("align-self: stretch;");
    // 父级 align-items: stretch 时，CSS 会拉伸没写交叉轴尺寸的子项；Sqraft 里 hug / 文本自动尺寸不参与拉伸，贴起点
    else if (crossMode === "hug" && pl.crossAlign === "stretch") out.layout.push("align-self: flex-start;");
  }

  // ── 尺寸 ──
  if (wMode === "fixed") out.size.push(`width: ${L(spec.width)};`);
  if (hMode === "fixed") out.size.push(`height: ${L(spec.height)};`);
  if (spec.minW !== undefined) out.size.push(`min-width: ${L(spec.minW)};`);
  if (spec.maxW !== undefined) out.size.push(`max-width: ${L(spec.maxW)};`);
  if (spec.minH !== undefined) out.size.push(`min-height: ${L(spec.minH)};`);
  if (spec.maxH !== undefined) out.size.push(`max-height: ${L(spec.maxH)};`);
  // Sqraft 的宽高含内边距（border box），CSS 默认 content-box
  const p = spec.layout?.padding;
  const hasPadding = !!p && !!(p.top || p.right || p.bottom || p.left);
  if (hasPadding && (out.size.length || wMode === "fill-main" || hMode === "fill-main")) out.size.push("box-sizing: border-box;");
  if (spec.isVector) out.size.push("/* 矢量图形：建议在「切图」里导出 SVG 使用 */");

  // ── 定位 ──
  if (spec.position.mode === "absolute") {
    out.position.push("position: absolute; /* 相对父级定位：父级需 position: relative */", `left: ${L(spec.position.x)};`, `top: ${L(spec.position.y)};`);
  } else if (spec.containsAbsolute) {
    out.position.push("position: relative;");
  }
  if (spec.ownRotation) out.position.push(`transform: rotate(${num(spec.ownRotation)}deg);`);

  // ── 外观 ──
  if (spec.opacity < 1) out.appearance.push(`opacity: ${num(spec.opacity)};`);
  if (!spec.isVector) {
    if (spec.fill && !isText && !spec.isImage) out.appearance.push(`background: ${tv(spec.fill.color, spec.fill.token)};`);
    if (spec.type === "ellipse") out.appearance.push("border-radius: 50%;");
    else if (spec.radius) {
      const { corners: c, tokens: t } = spec.radius;
      const tl = tv(L(c.topLeft), t.topLeft);
      const tr = tv(L(c.topRight), t.topRight);
      const br = tv(L(c.bottomRight), t.bottomRight);
      const bl = tv(L(c.bottomLeft), t.bottomLeft);
      // border-radius 的顺序是 左上 右上 右下 左下
      out.appearance.push(`border-radius: ${tl === tr && tl === br && tl === bl ? tl : `${tl} ${tr} ${br} ${bl}`};`);
    }
    if (spec.clip) out.appearance.push("overflow: hidden;");
    if (spec.isImage) out.appearance.push("/* 图片：用 <img> + object-fit: cover，或在「切图」里导出 */");
    if (spec.isMask) out.appearance.push("/* 蒙版：裁剪上方相邻的图层，可改用 clip-path / mask-image */");
  }

  // ── 描边 ──
  if (spec.stroke && !spec.isVector) {
    const s = spec.stroke;
    const w = tv(L(s.width), s.widthToken);
    const color = tv(s.color, s.token);
    if (isText) out.stroke.push(`-webkit-text-stroke: ${w} ${color};`);
    else {
      const offset = opts.tokenVars && s.widthToken ? `calc(${w} / -2)` : L(-s.width / 2);
      out.stroke.push(`outline: ${w} solid ${color};`, `outline-offset: ${offset}; /* 居中描边 */`);
    }
  }

  // ── 效果 ──
  const dropShadows: string[] = [];
  if (!spec.isVector) {
    if (isText) {
      // text-shadow 没有扩展、没有内阴影
      const ts = spec.shadows.filter((e) => !e.inset).map((e) => `${L(e.x)} ${L(e.y)} ${L(e.blur)} ${tv(e.color, e.token)}`);
      if (ts.length) out.effects.push(`text-shadow: ${ts.join(", ")};`);
      if (spec.shadows.some((e) => e.inset || e.spread)) out.effects.push("/* 文字阴影不支持扩展与内阴影，已忽略 */");
    } else if (spec.shadows.length && (!spec.fill || spec.isImage)) {
      // 自身没有填充（编组、无底色容器）或是图片：投影跟着内容轮廓走，对应 filter: drop-shadow，而不是矩形盒的 box-shadow
      const ds = spec.shadows.filter((e) => !e.inset).map((e) => `drop-shadow(${L(e.x)} ${L(e.y)} ${L(e.blur)} ${tv(e.color, e.token)})`);
      if (ds.length) dropShadows.push(...ds);
      if (spec.shadows.some((e) => e.inset || e.spread)) out.effects.push("/* drop-shadow 不支持扩展与内阴影，已忽略 */");
    } else if (spec.shadows.length) {
      const bs = spec.shadows.map((e) => `${e.inset ? "inset " : ""}${L(e.x)} ${L(e.y)} ${L(e.blur)} ${L(e.spread)} ${tv(e.color, e.token)}`);
      out.effects.push(`box-shadow: ${bs.join(", ")};`);
    }
    const layer = [...dropShadows, ...spec.blurs.filter((b) => b.type === "layer").map((b) => `blur(${L(b.radius)})`)];
    const backdrop = spec.blurs.filter((b) => b.type === "backdrop").map((b) => `blur(${L(b.radius)})`);
    if (layer.length) out.effects.push(`filter: ${layer.join(" ")};`);
    if (backdrop.length) out.effects.push(`backdrop-filter: ${backdrop.join(" ")};`);
  }

  // ── 文字 ──
  const t = spec.text;
  if (t) {
    out.text.push(`font-family: ${fontFamilyCss(t.family)};`);
    out.text.push(`font-size: ${tv(T(t.size), t.tokens.size)};`);
    if (t.weight !== 400) out.text.push(`font-weight: ${num(t.weight)};`);
    if (t.italic) out.text.push("font-style: italic;");
    out.text.push(`line-height: ${tv(T(t.lineHeight), t.tokens.lineHeight)};`);
    if (t.letterSpacing || t.tokens.letterSpacing) out.text.push(`letter-spacing: ${tv(T(t.letterSpacing), t.tokens.letterSpacing)};`);
    if (t.align !== "left") out.text.push(`text-align: ${t.align};`);
    if (spec.fill) out.text.push(`color: ${tv(spec.fill.color, spec.fill.token)};`);
    if (t.case === "upper") out.text.push("text-transform: uppercase;");
    else if (t.case === "lower") out.text.push("text-transform: lowercase;");
    else if (t.case === "title") out.text.push("text-transform: capitalize;");
    if (t.decoration === "underline") out.text.push("text-decoration: underline;");
    else if (t.decoration === "strikethrough") out.text.push("text-decoration: line-through;");
    if (t.autoResize === "auto-width") out.text.push("white-space: nowrap;");
    if (t.truncate) {
      // 固定高度能放下几行：一行用 ellipsis，多行用 line-clamp
      const lines = t.lineHeight > 0 ? Math.max(1, Math.floor((spec.height + 0.5) / t.lineHeight)) : 1;
      if (lines <= 1) out.text.push("white-space: nowrap;", "overflow: hidden;", "text-overflow: ellipsis;");
      else out.text.push("display: -webkit-box;", "-webkit-box-orient: vertical;", `-webkit-line-clamp: ${lines};`, "overflow: hidden;");
    }
    if (t.autoResize === "fixed" && t.verticalAlign !== "top") {
      out.text.push(`/* 垂直${t.verticalAlign === "middle" ? "居中" : "底对齐"}：可用 display: flex; flex-direction: column; justify-content: ${t.verticalAlign === "middle" ? "center" : "flex-end"}; */`);
    }
    if (t.paragraphSpacing > 0) out.text.push(`/* 段间距 ${L(t.paragraphSpacing)}：可用 p + p { margin-top: ${L(t.paragraphSpacing)}; } */`);
  }

  // ── 自动布局 ──
  const l = spec.layout;
  if (l) {
    const horizontal = l.direction === "horizontal";
    out.autolayout.push("display: flex;", `flex-direction: ${horizontal ? "row" : "column"};`);
    if (l.wrap) out.autolayout.push("flex-wrap: wrap;");
    const gap = tv(L(l.gap), l.gapToken);
    if (l.wrap) {
      const cross = tv(L(l.crossGap), l.crossGapToken);
      // CSS gap 是「行距 列距」：横向布局的主轴间距是列距、换行间距是行距；纵向反过来
      if (gap === cross) {
        if (l.gap || l.gapToken) out.autolayout.push(`gap: ${gap};`);
      } else out.autolayout.push(`gap: ${horizontal ? `${cross} ${gap}` : `${gap} ${cross}`};`);
    } else if (l.gap || l.gapToken) out.autolayout.push(`gap: ${gap};`);
    if (p && (hasPadding || Object.keys(l.paddingTokens ?? {}).length)) {
      const pt = l.paddingTokens ?? {};
      out.autolayout.push(`padding: ${box4(tv(L(p.top), pt.top), tv(L(p.right), pt.right), tv(L(p.bottom), pt.bottom), tv(L(p.left), pt.left))};`);
    }
    if (l.mainAlign !== "start") out.autolayout.push(`justify-content: ${JUSTIFY[l.mainAlign]};`);
    // CSS 的 align-items 缺省是 stretch，与 Sqraft 的缺省（起点）不同，始终写出
    out.autolayout.push(`align-items: ${ALIGN[l.crossAlign]};`);
    if (l.wrap) out.autolayout.push(`align-content: ${ALIGN_CONTENT[l.alignContent]};`);
  }

  const sections = SECTION_ORDER.filter((k) => out[k].length).map((k) => ({ key: k, title: SECTION_TITLES[k], lines: out[k] }));
  // 图层名进注释：去掉换行，拆开 "*/" 免得提前结束注释
  const name = (spec.name || spec.type).replace(/[\r\n]+/g, " ").replace(/\*\//g, "* /");
  const text = `/* ${name} */\n${sections.flatMap((s) => s.lines).join("\n")}`;
  return { sections, text };
}
