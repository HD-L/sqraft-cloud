/**
 * 节点子树 → SVG（图标 / 切图导出）。
 *
 * 绘制语义对齐 `@sqraft/render`（Canvas2D）：
 * - 子节点坐标相对父节点原点；旋转绕节点自身中心；
 * - 描边居中，路径描边圆角端点；frame / component / instance 开了 clip 时按（圆角）外框裁剪子内容；
 * - 蒙版只裁掉紧挨着的上一个兄弟（core 的 `maskPlan`），取蒙版的形状轮廓；
 * - 文本基线 = 行顶 + (行高 − 字号) / 2 + 字号 × 0.8；换行沿用 core 的 `layoutText`（服务端用估算宽度）；
 * - 投影 / 图层模糊用 SVG 滤镜近似；内阴影、背景模糊不支持（写进 warnings）。
 * 位图以 data URI 内嵌，导出的 SVG 自包含、离线可用。
 */

import {
  cornerRadiusOf,
  fontFamilyOf,
  fontSizeOf,
  fontWeightOf,
  imageCropOf,
  layoutText,
  letterSpacingPx,
  maskPlan,
  polygonPoints,
  resolveNumericStyle,
  resolvePaint,
  type CornerRadius,
  type DocNode,
  type DocState,
  type VectorPath,
} from "@sqraft/core";

export interface SvgAsset {
  mime: string;
  bytes: Buffer;
}

export interface SvgExportOptions {
  /** 按 assetId 取位图字节（内嵌用）；取不到返回 null，画占位 */
  asset(assetId: string): SvgAsset | null;
}

export interface SvgExportResult {
  svg: string;
  width: number;
  height: number;
  warnings: string[];
}

const CLIP_TYPES = new Set(["frame", "component", "instance"]);
const r2 = (n: number) => Math.round(n * 100) / 100;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** CSS 颜色 → SVG 属性：#rrggbbaa / rgba() 拆成颜色 + 不透明度，兼容不认 8 位 hex 的查看器。 */
export function paintAttrs(color: string | undefined, kind: "fill" | "stroke"): string {
  if (!color) return ` ${kind}="none"`;
  let m = /^#([0-9a-f]{3,4})$/i.exec(color);
  if (m) color = `#${[...m[1]].map((c) => c + c).join("")}`;
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color);
  if (m) {
    const alpha = m[2] ? parseInt(m[2], 16) / 255 : 1;
    return ` ${kind}="#${m[1].toLowerCase()}"${alpha < 1 ? ` ${kind}-opacity="${r2(alpha)}"` : ""}`;
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(color);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
    return ` ${kind}="rgb(${m[1]},${m[2]},${m[3]})"${a < 1 ? ` ${kind}-opacity="${r2(a)}"` : ""}`;
  }
  return ` ${kind}="${esc(color)}"`;
}

function roundedRectPath(w: number, h: number, r: CornerRadius): string {
  const max = Math.max(0, Math.min(w, h) / 2);
  const tl = Math.min(r.topLeft ?? 0, max);
  const tr = Math.min(r.topRight ?? 0, max);
  const br = Math.min(r.bottomRight ?? 0, max);
  const bl = Math.min(r.bottomLeft ?? 0, max);
  if (!tl && !tr && !br && !bl) return `M0 0H${r2(w)}V${r2(h)}H0Z`;
  return [
    `M${r2(tl)} 0`,
    `H${r2(w - tr)}`,
    tr ? `A${r2(tr)} ${r2(tr)} 0 0 1 ${r2(w)} ${r2(tr)}` : "",
    `V${r2(h - br)}`,
    br ? `A${r2(br)} ${r2(br)} 0 0 1 ${r2(w - br)} ${r2(h)}` : "",
    `H${r2(bl)}`,
    bl ? `A${r2(bl)} ${r2(bl)} 0 0 1 0 ${r2(h - bl)}` : "",
    `V${r2(tl)}`,
    tl ? `A${r2(tl)} ${r2(tl)} 0 0 1 ${r2(tl)} 0` : "",
    "Z",
  ].join("");
}

export function vectorPathData(v: VectorPath): string {
  const a = v.anchors;
  if (a.length < 2) return "";
  let d = `M${r2(a[0].x)} ${r2(a[0].y)}`;
  const segments = v.closed ? a.length : a.length - 1;
  for (let i = 0; i < segments; i++) {
    const p = a[i];
    const q = a[(i + 1) % a.length];
    const curved = p.outX !== 0 || p.outY !== 0 || q.inX !== 0 || q.inY !== 0;
    d += curved
      ? `C${r2(p.x + p.outX)} ${r2(p.y + p.outY)} ${r2(q.x + q.inX)} ${r2(q.y + q.inY)} ${r2(q.x)} ${r2(q.y)}`
      : `L${r2(q.x)} ${r2(q.y)}`;
  }
  return v.closed ? `${d}Z` : d;
}

/** 服务端没有 Canvas：按字符类别估算宽度，只用于换行（实际字形由查看 SVG 的浏览器排版）。 */
function estimateWidth(text: string, size: number): number {
  let w = 0;
  for (const ch of text) w += /[⺀-￿]/.test(ch) ? size : /[A-Z0-9mwMW@%]/.test(ch) ? size * 0.65 : ch === " " ? size * 0.3 : size * 0.52;
  return w;
}

class SvgWriter {
  private seq = 0;
  readonly defs: string[] = [];
  readonly warnings = new Set<string>();

  constructor(
    private readonly doc: DocState,
    private readonly opts: SvgExportOptions,
  ) {}

  private id(prefix: string): string {
    return `${prefix}${++this.seq}`;
  }

  private color(paint: Parameters<typeof resolvePaint>[1]): string | undefined {
    return resolvePaint(this.doc, paint);
  }

  /** 节点的局部形状（只有几何，蒙版 / 裁剪用）。 */
  private shape(n: DocNode, attrs = ""): string {
    const r = cornerRadiusOf(n.style);
    switch (n.type) {
      case "ellipse":
        return `<ellipse cx="${r2(n.width / 2)}" cy="${r2(n.height / 2)}" rx="${r2(Math.abs(n.width / 2))}" ry="${r2(Math.abs(n.height / 2))}"${attrs}/>`;
      case "path":
      case "line":
        return n.vector ? `<path d="${vectorPathData(n.vector)}"${attrs}/>` : `<path d="M0 0L${r2(n.width)} ${r2(n.height)}"${attrs}/>`;
      case "polygon":
        return `<polygon points="${polygonPoints(n.sides, n.width, n.height).map((p) => `${r2(p.x)},${r2(p.y)}`).join(" ")}"${attrs}/>`;
      default:
        return `<path d="${roundedRectPath(n.width, n.height, r)}"${attrs}/>`;
    }
  }

  private transform(n: DocNode): string {
    const parts = [];
    if (n.x || n.y) parts.push(`translate(${r2(n.x)} ${r2(n.y)})`);
    if (n.rotation) parts.push(`rotate(${r2(n.rotation)} ${r2(n.width / 2)} ${r2(n.height / 2)})`);
    return parts.length ? ` transform="${parts.join(" ")}"` : "";
  }

  private self(n: DocNode): string {
    const style = resolveNumericStyle(this.doc, n.style);
    const fill = this.color(style.fill);
    const stroke = this.color(style.stroke);
    const sw = style.strokeWidth ?? 1;
    const strokeAttrs = stroke ? `${paintAttrs(stroke, "stroke")} stroke-width="${r2(sw)}"` : "";
    switch (n.type) {
      case "page":
        return this.shape(n, paintAttrs(fill ?? "#ffffff", "fill"));
      case "group":
        return "";
      case "text":
        return this.text(n, fill ?? "#000000", stroke);
      case "image":
        return this.image(n);
      case "line":
        return this.shape(n, ` fill="none"${paintAttrs(stroke ?? "#000000", "stroke")} stroke-width="${r2(sw)}" stroke-linecap="round"`);
      case "path":
        if (!n.vector) return "";
        return this.shape(n, `${paintAttrs(fill, "fill")}${strokeAttrs}${stroke ? ' stroke-linecap="round" stroke-linejoin="round"' : ""}`);
      case "frame":
      case "component":
      case "instance":
      case "slot":
        // 容器：有填充 / 描边才画底
        if (!fill && !stroke) return "";
        return this.shape(n, `${paintAttrs(fill, "fill")}${strokeAttrs}`);
      default:
        if (!fill && !stroke) return "";
        return this.shape(n, `${paintAttrs(fill, "fill")}${strokeAttrs}`);
    }
  }

  private text(n: DocNode, fill: string, stroke: string | undefined): string {
    const style = resolveNumericStyle(this.doc, n.style);
    const size = fontSizeOf(style);
    const mode = n.textAutoResize ?? "auto-width";
    const layout = layoutText(n.text ?? "", style, {
      measure: (t: string) => estimateWidth(t, size),
      listType: n.listType,
      maxWidth: mode === "auto-width" ? undefined : n.width,
      maxHeight: mode === "fixed" ? n.height : undefined,
      truncate: n.truncate,
    });
    let offsetY = 0;
    if (mode !== "auto-width") {
      const va = style.textVerticalAlign ?? "top";
      if (va === "middle") offsetY = Math.max(0, (n.height - layout.height) / 2);
      else if (va === "bottom") offsetY = Math.max(0, n.height - layout.height);
    }
    const align = style.textAlign ?? "left";
    const anchor = align === "center" ? "middle" : align === "right" ? "end" : "start";
    const spacing = letterSpacingPx(style);
    const deco = style.textDecoration === "underline" ? "underline" : style.textDecoration === "strikethrough" ? "line-through" : "";
    let y = offsetY;
    const lines: string[] = [];
    layout.lines.forEach((line, i) => {
      const prev = layout.lines[i - 1];
      if (prev && prev.paragraph !== line.paragraph) y += style.paragraphSpacing ?? 0;
      const baseline = y + (layout.lineHeight - size) / 2 + size * 0.8;
      const avail = Math.max(1, n.width - line.indent);
      const x = line.indent + (anchor === "middle" ? avail / 2 : anchor === "end" ? avail : 0);
      if (line.marker) lines.push(`<tspan x="${r2(Math.max(0, line.indent - size * 1.2))}" y="${r2(baseline)}" text-anchor="start">${esc(line.marker)}</tspan>`);
      lines.push(`<tspan x="${r2(x)}" y="${r2(baseline)}">${esc(line.text)}</tspan>`);
      y += layout.lineHeight;
    });
    const attrs = [
      `font-family="${esc(fontFamilyOf(style))}"`,
      `font-size="${r2(size)}"`,
      fontWeightOf(style) !== 400 ? `font-weight="${fontWeightOf(style)}"` : "",
      style.fontStyle === "italic" ? 'font-style="italic"' : "",
      anchor !== "start" ? `text-anchor="${anchor}"` : "",
      spacing ? `letter-spacing="${r2(spacing)}"` : "",
      deco ? `text-decoration="${deco}"` : "",
      "xml:space=\"preserve\"",
    ]
      .filter(Boolean)
      .join(" ");
    const strokeAttrs = stroke ? `${paintAttrs(stroke, "stroke")} stroke-width="${r2(style.strokeWidth ?? 1)}"` : "";
    return `<text ${attrs}${paintAttrs(fill, "fill")}${strokeAttrs}>${lines.join("")}</text>`;
  }

  private image(n: DocNode): string {
    const ref = n.image;
    const asset = ref?.assetId ? this.opts.asset(ref.assetId) : null;
    if (!ref || !asset) {
      this.warnings.add("有图片没有内嵌（外链图或资源缺失），已画成灰色占位");
      return `<rect width="${r2(n.width)}" height="${r2(n.height)}" fill="#e5e7eb"/>`;
    }
    const crop = imageCropOf(n);
    const clip = this.id("c");
    this.defs.push(`<clipPath id="${clip}"><path d="${roundedRectPath(n.width, n.height, cornerRadiusOf(n.style))}"/></clipPath>`);
    const href = `data:${asset.mime};base64,${asset.bytes.toString("base64")}`;
    return (
      `<svg width="${r2(n.width)}" height="${r2(n.height)}" viewBox="${r2(crop.x)} ${r2(crop.y)} ${r2(crop.width)} ${r2(crop.height)}" ` +
      `preserveAspectRatio="none" clip-path="url(#${clip})" overflow="hidden">` +
      `<image width="${ref.naturalWidth}" height="${ref.naturalHeight}" href="${href}" preserveAspectRatio="none"/></svg>`
    );
  }

  private filter(n: DocNode): string {
    const effects = (resolveNumericStyle(this.doc, n.style).effects ?? []).filter((e) => e.visible !== false);
    if (!effects.length) return "";
    const parts: string[] = [];
    for (const e of effects) {
      if (e.type === "drop-shadow") {
        const color = this.color(e.color) ?? "#00000040";
        const p = paintAttrs(color, "fill");
        const c = /fill="([^"]+)"/.exec(p)?.[1] ?? "#000";
        const o = /fill-opacity="([^"]+)"/.exec(p)?.[1] ?? "1";
        if (e.spread) this.warnings.add("投影的扩展（spread）在 SVG 里不支持，已忽略");
        parts.push(`<feDropShadow dx="${r2(e.x)}" dy="${r2(e.y)}" stdDeviation="${r2(e.blur / 2)}" flood-color="${c}" flood-opacity="${o}"/>`);
      } else if (e.type === "layer-blur") {
        parts.push(`<feGaussianBlur stdDeviation="${r2(e.radius / 2)}"/>`);
      } else {
        this.warnings.add(e.type === "inner-shadow" ? "内阴影在 SVG 导出里不支持，已忽略" : "背景模糊在 SVG 导出里不支持，已忽略");
      }
    }
    if (!parts.length) return "";
    const id = this.id("f");
    this.defs.push(`<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">${parts.join("")}</filter>`);
    return ` filter="url(#${id})"`;
  }

  private children(ids: readonly string[]): string {
    let out = "";
    for (const entry of maskPlan(ids, (id) => this.doc.nodes[id]?.isMask === true)) {
      if (entry.kind === "plain") {
        const c = this.doc.nodes[entry.id];
        if (c) out += this.node(c);
        continue;
      }
      const mask = this.doc.nodes[entry.maskId];
      const target = this.doc.nodes[entry.targetId];
      if (!mask || !target || !mask.visible || !target.visible) continue;
      const id = this.id("m");
      // clipPath 里只允许形状元素（不能放 <g>，否则浏览器忽略、裁剪区为空、内容整块消失）：变换直接写在形状上
      this.defs.push(`<clipPath id="${id}">${this.shape(mask, this.transform(mask))}</clipPath>`);
      out += `<g clip-path="url(#${id})">${this.node(target)}</g>`;
    }
    return out;
  }

  node(n: DocNode): string {
    if (!n.visible) return "";
    const opacity = n.opacity ?? 1;
    const self = this.self(n);
    let kids = "";
    if (n.children.length) {
      kids = this.children(n.children);
      if (kids && n.clip && CLIP_TYPES.has(n.type)) {
        const id = this.id("k");
        this.defs.push(`<clipPath id="${id}"><path d="${roundedRectPath(n.width, n.height, cornerRadiusOf(n.style))}"/></clipPath>`);
        kids = `<g clip-path="url(#${id})">${kids}</g>`;
      }
    }
    if (!self && !kids) return "";
    const attrs = `${this.transform(n)}${opacity < 1 ? ` opacity="${r2(opacity)}"` : ""}${this.filter(n)}`;
    return `<g${attrs} data-name="${esc(n.name ?? "")}">${self}${kids}</g>`;
  }
}

/** 把一个节点（含子树）导出成独立 SVG：画布原点放在节点左上角，尺寸 = 节点尺寸 + 投影外扩。 */
export function exportNodeSvg(doc: DocState, nodeId: string, opts: SvgExportOptions): SvgExportResult {
  const root = doc.nodes[nodeId];
  if (!root) throw new Error(`节点 ${nodeId} 不存在`);
  const writer = new SvgWriter(doc, opts);
  const placed: DocNode = { ...root, x: 0, y: 0, rotation: 0, visible: true };
  if (root.rotation) writer.warnings.add("导出根节点的旋转已忽略（按未旋转的方向导出）");
  // 投影会画到节点框外：按最大的投影留边
  let pad = 0;
  for (const e of resolveNumericStyle(doc, root.style).effects ?? []) {
    if (e.visible === false) continue;
    if (e.type === "drop-shadow") pad = Math.max(pad, Math.abs(e.x) + e.blur + (e.spread ?? 0), Math.abs(e.y) + e.blur + (e.spread ?? 0));
    if (e.type === "layer-blur") pad = Math.max(pad, e.radius);
  }
  pad = Math.ceil(pad);
  const body = writer.node(placed);
  const width = r2(root.width + pad * 2);
  const height = r2(root.height + pad * 2);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${-pad} ${-pad} ${width} ${height}">` +
    (writer.defs.length ? `<defs>${writer.defs.join("")}</defs>` : "") +
    body +
    `</svg>`;
  return { svg, width, height, warnings: [...writer.warnings] };
}
