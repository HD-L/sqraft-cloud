/**
 * 代码生成的第一步：把一个节点归一成平台无关的描述（NodeSpec），各语言的生成器（CSS、以后的 SwiftUI /
 * Compose / Flutter）只读这份描述，不再各自去翻 DocNode、解析 Token、推断布局关系。
 *
 * 约定：
 * - 数值都是设计稿单位（@1x），单位换算交给生成器；
 * - 颜色已解析成 CSS 颜色串（不透明 #RRGGBB，半透明 rgba()），绑定的 Token 名单独给出；
 * - 数值 Token 只在文档里确有这个数值 Token 时才给出（缺失时渲染器回退到字面量，生成器也应只用字面量）。
 *
 * 纯函数，无 DOM 依赖。
 */
import { cssColor, parsePureColor } from "../color";
import {
  CORNER_RADIUS_KEYS,
  fontFamilyOf,
  fontSizeOf,
  fontWeightOf,
  isShadowEffect,
  letterSpacingPx,
  lineHeightPx,
  PADDING_SIDE_KEYS,
  resolveNumericLayout,
  resolveNumericStyle,
  resolvePaint,
  textAutoResizeOf,
  worldRotation,
  type CornerRadius,
  type CornerRadiusTokens,
  type DocState,
  type LayoutSizing,
  type LayoutSpec,
  type NodeType,
  type Paint,
  type PaddingTokens,
  type TextAlign,
  type TextAutoResize,
  type TextCase,
  type TextDecoration,
  type TextVerticalAlign,
} from "@sqraft/core";

/** 颜色：CSS 颜色串 + 绑定的颜色 Token（路径，如 "color/brand/primary"） */
export interface SpecPaint {
  color: string;
  token?: string;
}

export interface SpecStroke {
  /** 描边宽度（Sqraft 只有居中描边） */
  width: number;
  color: string;
  token?: string;
  widthToken?: string;
}

export interface SpecRadius {
  /** 四角数值与 Token 都相同时为该值，否则 null（看 corners） */
  uniform: number | null;
  corners: CornerRadius;
  /** 逐角绑定的数值 Token（只列出有效的） */
  tokens: CornerRadiusTokens;
}

export interface SpecShadow {
  /** 内阴影 */
  inset: boolean;
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: string;
  token?: string;
}

export interface SpecBlur {
  /** layer：模糊图层自身；backdrop：模糊下层内容 */
  type: "layer" | "backdrop";
  radius: number;
}

export interface SpecText {
  family: string;
  size: number;
  weight: number;
  italic: boolean;
  /** 实际行高（px）：自动行高 = 字号 × 1.4，百分比已换算 */
  lineHeight: number;
  lineHeightAuto: boolean;
  /** 字距（px）：百分比已换算 */
  letterSpacing: number;
  paragraphSpacing: number;
  align: TextAlign;
  verticalAlign: TextVerticalAlign;
  case: TextCase;
  decoration: TextDecoration;
  autoResize: TextAutoResize;
  /** 固定尺寸下超出截断并显示省略号（只有 fixed 模式才有意义） */
  truncate: boolean;
  /**
   * 绑定的数值 Token。行高 / 字距只在 Token 值就是 px 数值时给出（单位是 percent 时 Token 值是百分数，
   * 不能直接当长度用）。
   */
  tokens: { size?: string; lineHeight?: string; letterSpacing?: string };
}

/** 父级自动布局里与子项相关的部分 */
export interface SpecParentLayout {
  direction: LayoutSpec["direction"];
  wrap: boolean;
  crossAlign: LayoutSpec["crossAlign"];
}

export interface NodeSpec {
  id: string;
  name: string;
  type: NodeType;
  /** 图层自身（未旋转）的宽高 */
  width: number;
  height: number;
  /** 累计旋转角（自身 + 祖先，度，取模 360）：画面上实际呈现的角度 */
  rotation: number;
  /** 自身旋转角（度，取模 360）：CSS 用它——位置是父级内的局部坐标，父元素自己的 rotate 会叠加上去 */
  ownRotation: number;
  /** 自身不透明度（0–1，不含祖先） */
  opacity: number;
  /** 在父自动布局里的尺寸行为（原样取 layoutSizingW/H，缺省 fixed；生成器结合父级与文本模式解释） */
  sizing: { w: LayoutSizing; h: LayoutSizing };
  minW?: number;
  maxW?: number;
  minH?: number;
  maxH?: number;
  /**
   * 定位：父级没有自动布局，或自身 layoutAbsolute 时为 absolute；x / y 是相对父级左上角的（未旋转）位置。
   * 根节点（画板、根级主组件）没有父级，按 flow 处理，x / y 为 0。
   */
  position: { mode: "flow" | "absolute"; x: number; y: number };
  /** 父级有自动布局时给出（即使自身是绝对定位，也照样给出父级方向） */
  parentLayout: SpecParentLayout | null;
  /** 有可见子节点按绝对定位摆放（父级不是自动布局，或子项 layoutAbsolute）：CSS 里自身要做定位容器 */
  containsAbsolute: boolean;
  /** 填充；文本节点的填充就是文字颜色（没设时与渲染器一致按黑色）。编组不绘制填充，恒为 null */
  fill: SpecPaint | null;
  stroke: SpecStroke | null;
  /** 圆角；椭圆、文本、编组、矢量没有圆角（椭圆由生成器按类型处理），全 0 时为 null */
  radius: SpecRadius | null;
  /** 可见的投影 / 内阴影，按文档顺序 */
  shadows: SpecShadow[];
  /** 可见的模糊 */
  blurs: SpecBlur[];
  /** 裁剪子内容（只有容器 / 组件 / 实例会裁剪，与渲染器一致） */
  clip: boolean;
  text: SpecText | null;
  /** 自身的自动布局：间距 / 内边距是 Token 解析后的值；gapToken / crossGapToken / paddingTokens 只保留有效的 */
  layout: LayoutSpec | null;
  /** 路径 / 多边形 / 星形 / 线条：代码里建议导出 SVG */
  isVector: boolean;
  isImage: boolean;
  isMask: boolean;
}

const VECTOR_TYPES = new Set<NodeType>(["path", "polygon", "star", "line"]);
/** 渲染器只对这几类节点按自身矩形裁剪子内容（见 @sqraft/render drawNode） */
const CLIPPING_TYPES = new Set<NodeType>(["frame", "component", "instance"]);
/** 没有圆角的类型 */
const NO_RADIUS_TYPES = new Set<NodeType>(["ellipse", "text", "group", "path", "polygon", "star", "line"]);
/** 渲染器（@sqraft/render drawSelf）不画填充 / 描边的类型：编组本身什么都不画，直线只画描边，图片不画描边 */
const NO_FILL_TYPES = new Set<NodeType>(["group", "line"]);
const NO_STROKE_TYPES = new Set<NodeType>(["group", "image"]);

/** 去掉浮点误差（如 89.99999999）与 -0 */
function clean(n: number): number {
  const r = Math.round(n * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}

/** 文档里确有这个数值 Token 才返回路径 */
function numberToken(doc: DocState, path: string | undefined): string | undefined {
  return path && doc.tokens[path]?.type === "number" ? path : undefined;
}

/**
 * 把任意 Paint 解析出的颜色串规范成 CSS 写法：能解析的统一成 #RRGGBB（不透明）或 rgba()（半透明），
 * 透明度取能还原同一个 8 位 alpha 档的最短小数（#2F5CFF7F → 0.498，不会变成 0.5 的 80 档）；
 * 解析不了的写法（颜色名等）原样返回——它们本身就是合法的 CSS。不依赖 DOM。
 */
export function normalizeCssColor(input: string): string {
  const c = parsePureColor(input);
  return c ? cssColor(c) : input.trim();
}

function paintOf(doc: DocState, paint: Paint | null | undefined): SpecPaint | null {
  const raw = resolvePaint(doc, paint);
  if (!raw) return null;
  const out: SpecPaint = { color: normalizeCssColor(raw) };
  // 颜色 Token 缺失时渲染器画洋红示警，这里照样保留 Token 名，开发看到的与画面一致
  if (paint?.token) out.token = paint.token;
  return out;
}

/** 归一化一个节点；节点不存在返回 null。 */
export function buildSpec(doc: DocState, nodeId: string): NodeSpec | null {
  const node = doc.nodes[nodeId];
  if (!node) return null;
  const parent = node.parentId ? doc.nodes[node.parentId] : undefined;
  const raw = node.style ?? {};
  const s = resolveNumericStyle(doc, raw);
  const isText = node.type === "text";
  const isVector = VECTOR_TYPES.has(node.type);

  const absolute = !!parent && (!parent.layout || node.layoutAbsolute === true);
  const position = parent ? { mode: absolute ? ("absolute" as const) : ("flow" as const), x: clean(node.x), y: clean(node.y) } : { mode: "flow" as const, x: 0, y: 0 };
  const parentLayout: SpecParentLayout | null = parent?.layout
    ? { direction: parent.layout.direction, wrap: parent.layout.wrap, crossAlign: parent.layout.crossAlign }
    : null;
  const containsAbsolute = node.children.some((id) => {
    const c = doc.nodes[id];
    return !!c && c.visible !== false && (!node.layout || c.layoutAbsolute === true);
  });

  // 描边：设了描边色才有，宽度缺省 1（与旧版标注一致）；直线没设描边色时渲染器按黑色画，这里同样补上；
  // 渲染器不给图片画描边（@sqraft/render drawSelf），这里也不报告
  let stroke: SpecStroke | null = null;
  const strokePaint = NO_STROKE_TYPES.has(node.type) || node.isMask === true ? null : (paintOf(doc, raw.stroke) ?? (node.type === "line" ? { color: "#000000" } : null));
  const strokeWidth = s.strokeWidth ?? 1;
  if (strokePaint && strokeWidth > 0) {
    stroke = { width: strokeWidth, color: strokePaint.color };
    if (strokePaint.token) stroke.token = strokePaint.token;
    const wt = numberToken(doc, raw.strokeWidthToken);
    if (wt) stroke.widthToken = wt;
  }

  // 圆角
  let radius: SpecRadius | null = null;
  if (!NO_RADIUS_TYPES.has(node.type) && s.cornerRadius) {
    const c = s.cornerRadius;
    const tokens: CornerRadiusTokens = {};
    for (const k of CORNER_RADIUS_KEYS) {
      const t = numberToken(doc, raw.cornerRadiusTokens?.[k]);
      if (t) tokens[k] = t;
    }
    if (c.topLeft || c.topRight || c.bottomRight || c.bottomLeft) {
      const sameValue = c.topLeft === c.topRight && c.topLeft === c.bottomRight && c.topLeft === c.bottomLeft;
      const sameToken = tokens.topLeft === tokens.topRight && tokens.topLeft === tokens.bottomRight && tokens.topLeft === tokens.bottomLeft;
      radius = { uniform: sameValue && sameToken ? c.topLeft : null, corners: { ...c }, tokens };
    }
  }

  // 效果
  const visible = (s.effects ?? []).filter((e) => e.visible !== false);
  const shadows: SpecShadow[] = [];
  const blurs: SpecBlur[] = [];
  for (const e of visible) {
    if (isShadowEffect(e)) {
      const p = paintOf(doc, e.color);
      const sh: SpecShadow = { inset: e.type === "inner-shadow", x: e.x, y: e.y, blur: e.blur, spread: e.spread, color: p?.color ?? "transparent" };
      if (p?.token) sh.token = p.token;
      shadows.push(sh);
    } else if (e.radius > 0) {
      blurs.push({ type: e.type === "layer-blur" ? "layer" : "backdrop", radius: e.radius });
    }
  }

  // 文字
  let text: SpecText | null = null;
  if (isText) {
    const autoResize = textAutoResizeOf(node);
    const lineHeightAuto = (s.lineHeightUnit ?? "auto") === "auto" || s.lineHeight === undefined;
    const tokens: SpecText["tokens"] = {};
    const sizeToken = numberToken(doc, raw.fontSizeToken);
    if (sizeToken) tokens.size = sizeToken;
    const lhToken = numberToken(doc, raw.lineHeightToken);
    if (lhToken && !lineHeightAuto && s.lineHeightUnit === "px") tokens.lineHeight = lhToken;
    const lsToken = numberToken(doc, raw.letterSpacingToken);
    if (lsToken && (s.letterSpacingUnit ?? "px") === "px") tokens.letterSpacing = lsToken;
    text = {
      family: fontFamilyOf(s),
      size: fontSizeOf(s),
      weight: fontWeightOf(s),
      italic: s.fontStyle === "italic",
      lineHeight: clean(lineHeightPx(s)),
      lineHeightAuto,
      letterSpacing: clean(letterSpacingPx(s)),
      paragraphSpacing: s.paragraphSpacing ?? 0,
      align: s.textAlign ?? "left",
      verticalAlign: s.textVerticalAlign ?? "top",
      case: s.textCase ?? "none",
      decoration: s.textDecoration ?? "none",
      autoResize,
      truncate: node.truncate === true && autoResize === "fixed",
      tokens,
    };
  }

  // 自动布局：数值 Token 解析成值，同时只保留文档里存在的 Token 名
  let layout: LayoutSpec | null = null;
  if (node.layout) {
    const l = resolveNumericLayout(doc, node.layout);
    const paddingTokens: PaddingTokens = {};
    for (const side of PADDING_SIDE_KEYS) {
      const t = numberToken(doc, node.layout.paddingTokens?.[side]);
      if (t) paddingTokens[side] = t;
    }
    layout = {
      ...l,
      padding: { ...l.padding },
      gapToken: numberToken(doc, node.layout.gapToken),
      crossGapToken: numberToken(doc, node.layout.crossGapToken),
      paddingTokens,
    };
  }

  return {
    id: node.id,
    name: node.name,
    type: node.type,
    width: clean(node.width),
    height: clean(node.height),
    rotation: clean(worldRotation(doc, node.id) % 360),
    ownRotation: clean((node.rotation ?? 0) % 360),
    opacity: node.opacity ?? 1,
    sizing: { w: node.layoutSizingW ?? "fixed", h: node.layoutSizingH ?? "fixed" },
    minW: node.layoutMinW,
    maxW: node.layoutMaxW,
    minH: node.layoutMinH,
    maxH: node.layoutMaxH,
    position,
    parentLayout,
    containsAbsolute,
    // 文本没有填充时渲染器按黑色画（见 @sqraft/render drawNode）
    fill: NO_FILL_TYPES.has(node.type) ? null : (paintOf(doc, raw.fill) ?? (isText ? { color: "#000000" } : null)),
    stroke,
    radius,
    // 蒙版只取形状来裁别人：渲染器不画它的描边，也不给它施加效果
    shadows: node.isMask === true ? [] : shadows,
    blurs: node.isMask === true ? [] : blurs,
    clip: node.clip === true && CLIPPING_TYPES.has(node.type),
    text,
    layout,
    isVector,
    isImage: node.type === "image",
    isMask: node.isMask === true,
  };
}
