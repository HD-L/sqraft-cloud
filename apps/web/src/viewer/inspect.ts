/**
 * 标注的几何与图层信息：命中、包围盒、相对父级 / 画板的位置、实际不透明度、蒙版、所属组件、文字与布局取值。
 * 间距测量见 measure.ts，单位见 units.ts，颜色见 color.ts，CSS 见 codegen/。
 *
 * 坐标约定与 Sqraft 渲染器一致：子节点位置相对父节点，旋转绕自身中心；页面（画板）的位置是画布世界坐标。
 * 标注里显示的 X / Y 是相对画板左上角的轴对齐包围盒。
 */
import { parseColor, type Color } from "./color";
import {
  fontFamilyOf,
  fontSizeOf,
  fontWeightOf,
  letterSpacingPx,
  lineHeightPx,
  maskPlan,
  resolveNumericLayout,
  resolveNumericStyle,
  resolvePaint,
  worldQuad,
  worldRotation,
  type DocNode,
  type DocState,
  type Effect,
  type LayoutSpec,
  type NodeStyle,
} from "@sqraft/core";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
type Pt = { x: number; y: number };

/**
 * 点在节点形状里吗：把点换算成节点自身的 (u, v)（0–1，左上为 0），矩形看范围，椭圆看椭圆方程。
 * 面积为 0 的节点（宽或高为 0）点不中。
 */
function pointInShape(p: Pt, q: Pt[], ellipse: boolean): boolean {
  const ex = { x: q[1].x - q[0].x, y: q[1].y - q[0].y };
  const ey = { x: q[3].x - q[0].x, y: q[3].y - q[0].y };
  const lx = ex.x * ex.x + ex.y * ex.y;
  const ly = ey.x * ey.x + ey.y * ey.y;
  if (lx < 1e-9 || ly < 1e-9) return false;
  const dx = p.x - q[0].x;
  const dy = p.y - q[0].y;
  const u = (dx * ex.x + dy * ex.y) / lx;
  const v = (dx * ey.x + dy * ey.y) / ly;
  if (ellipse) return (u - 0.5) ** 2 + (v - 0.5) ** 2 <= 0.25;
  return u >= 0 && u <= 1 && v >= 0 && v <= 1;
}

/** 渲染器只对这几类节点按自身矩形裁剪子内容（见 @sqraft/render drawNode） */
const CLIPPING_TYPES = new Set(["frame", "component", "instance"]);

/** 一个页面文档上的几何查询，结果按节点缓存。 */
export class PageGeometry {
  private readonly quads = new Map<string, Pt[] | null>();

  constructor(
    readonly doc: DocState,
    readonly pageId: string,
  ) {}

  get page(): DocNode {
    return this.doc.nodes[this.pageId];
  }

  quad(id: string): Pt[] | null {
    let q = this.quads.get(id);
    if (q === undefined) {
      q = worldQuad(this.doc, id);
      this.quads.set(id, q);
    }
    return q;
  }

  /** 世界坐标的轴对齐包围盒 */
  bounds(id: string): Rect | null {
    const q = this.quad(id);
    if (!q) return null;
    const xs = q.map((p) => p.x);
    const ys = q.map((p) => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }

  /** 相对画板左上角的包围盒 */
  local(id: string): Rect | null {
    const b = this.bounds(id);
    if (!b) return null;
    return { x: b.x - this.page.x, y: b.y - this.page.y, width: b.width, height: b.height };
  }

  /** 点是否落在节点的形状里（椭圆按椭圆，其余按矩形） */
  contains(id: string, p: Pt): boolean {
    const q = this.quad(id);
    return !!q && pointInShape(p, q, this.doc.nodes[id]?.type === "ellipse");
  }

  /**
   * 点中的最深一层图层（世界坐标），与渲染器的规则一致：
   * - 隐藏的不参与；蒙版本身不参与，被蒙版遮住的图层只在蒙版形状内能点中（蒙版或目标隐藏时整对都没有）；
   * - 只有容器 / 组件 / 实例会裁剪子内容，裁剪范围外点不中其子节点；
   * - 编组只通过子图层点中；后画的在上面，先查。
   * 点在画板内但没有图层时返回画板 id；画板外返回 null。
   */
  hit(x: number, y: number): string | null {
    const p = { x, y };
    const nodes = this.doc.nodes;
    const visitChildren = (children: readonly string[]): string | null => {
      const plan = maskPlan(children, (id) => nodes[id]?.isMask === true);
      for (let i = plan.length - 1; i >= 0; i--) {
        const e = plan[i];
        if (e.kind === "plain") {
          const hit = visit(e.id);
          if (hit) return hit;
          continue;
        }
        const mask = nodes[e.maskId];
        const target = nodes[e.targetId];
        if (!mask?.visible || !target?.visible || !this.contains(e.maskId, p)) continue;
        const hit = visit(e.targetId);
        if (hit) return hit;
      }
      return null;
    };
    const visit = (id: string): string | null => {
      const n = nodes[id];
      if (!n || !n.visible) return null;
      const inside = this.contains(id, p);
      if (n.clip && CLIPPING_TYPES.has(n.type) && !inside) return null;
      // 编组自己不画任何东西：只能通过子图层点中，空白处落到下面的图层
      return visitChildren(n.children) ?? (inside && n.type !== "group" ? id : null);
    };
    const page = this.page;
    if (!page || !this.contains(this.pageId, p)) return null;
    return visitChildren(page.children) ?? this.pageId;
  }

  /** 图层自身（未旋转）的宽高与累计旋转角：标注「尺寸」与 CSS 用这个；X / Y 与间距用包围盒 */
  frame(id: string): { width: number; height: number; rotation: number } | null {
    const n = this.doc.nodes[id];
    if (!n) return null;
    return { width: n.width, height: n.height, rotation: worldRotation(this.doc, id) % 360 };
  }

  /** 祖先链（从画板到父节点，不含自身） */
  ancestors(id: string): DocNode[] {
    const out: DocNode[] = [];
    let cur = this.doc.nodes[id]?.parentId;
    while (cur) {
      const n = this.doc.nodes[cur];
      if (!n) break;
      out.unshift(n);
      cur = n.parentId;
    }
    return out;
  }

  isAncestor(maybeAncestor: string, id: string): boolean {
    let cur = this.doc.nodes[id]?.parentId;
    while (cur) {
      if (cur === maybeAncestor) return true;
      cur = this.doc.nodes[cur]?.parentId ?? null;
    }
    return false;
  }
}

// ── 图层信息 ──

export const TYPE_LABEL: Record<string, string> = {
  page: "画板",
  frame: "容器",
  group: "编组",
  rect: "矩形",
  ellipse: "椭圆",
  line: "线条",
  polygon: "多边形",
  star: "星形",
  path: "路径",
  text: "文本",
  image: "图片",
  component: "主组件",
  instance: "组件实例",
  slot: "插槽",
};

export const WEIGHT_LABEL: Record<number, string> = {
  100: "Thin",
  200: "ExtraLight",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "Semibold",
  700: "Bold",
  800: "ExtraBold",
  900: "Black",
};

/** 数值 Token 已解析的样式 */
export function styleOf(doc: DocState, node: DocNode): NodeStyle {
  return resolveNumericStyle(doc, node.style);
}

export function paintColor(doc: DocState, paint: { token?: string; value?: string } | null | undefined): Color | null {
  return parseColor(resolvePaint(doc, paint));
}

/** 相对父级的包围盒（父级是画板时等于相对画板）；父级有旋转时按包围盒近似 */
export function parentLocal(geo: PageGeometry, id: string): Rect | null {
  const n = geo.doc.nodes[id];
  const b = geo.bounds(id);
  if (!n || !b) return null;
  const parent = n.parentId ? geo.bounds(n.parentId) : null;
  if (!parent) return geo.local(id);
  return { x: b.x - parent.x, y: b.y - parent.y, width: b.width, height: b.height };
}

/** 层叠后的实际不透明度（自身 × 所有祖先） */
export function effectiveOpacity(geo: PageGeometry, id: string): number {
  let o = 1;
  let cur: DocNode | undefined = geo.doc.nodes[id];
  while (cur) {
    o *= cur.opacity ?? 1;
    cur = cur.parentId ? geo.doc.nodes[cur.parentId] : undefined;
  }
  return o;
}

/** 蒙版信息：自己是不是蒙版；被哪个蒙版裁切（按渲染器的 maskPlan：蒙版裁切紧跟其后的一个兄弟） */
export function maskInfo(geo: PageGeometry, id: string): { isMask: boolean; maskedBy: DocNode | null } {
  const n = geo.doc.nodes[id];
  if (!n) return { isMask: false, maskedBy: null };
  const parent = n.parentId ? geo.doc.nodes[n.parentId] : undefined;
  let maskedBy: DocNode | null = null;
  if (parent) {
    for (const e of maskPlan(parent.children, (cid) => geo.doc.nodes[cid]?.isMask === true)) {
      if (e.kind === "masked" && e.targetId === id) maskedBy = geo.doc.nodes[e.maskId] ?? null;
    }
  }
  return { isMask: n.isMask === true, maskedBy };
}

/** 自己或最近的祖先实例（所属组件） */
export function owningInstance(geo: PageGeometry, id: string): DocNode | null {
  let cur: DocNode | undefined = geo.doc.nodes[id];
  while (cur) {
    if (cur.type === "instance") return cur;
    cur = cur.parentId ? geo.doc.nodes[cur.parentId] : undefined;
  }
  return null;
}

export function visibleEffects(style: NodeStyle): Effect[] {
  return (style.effects ?? []).filter((e) => e.visible !== false);
}

/** 文字的实际排版参数（缺省值与渲染器一致：字号 20、行高自动 = 字号 × 1.4） */
export interface TextInfo {
  family: string;
  size: number;
  weight: number;
  lineHeight: number;
  lineHeightAuto: boolean;
  letterSpacing: number;
}

export function textInfo(s: NodeStyle): TextInfo {
  return {
    family: fontFamilyOf(s),
    size: fontSizeOf(s),
    weight: fontWeightOf(s),
    lineHeight: lineHeightPx(s),
    lineHeightAuto: (s.lineHeightUnit ?? "auto") === "auto" || s.lineHeight === undefined,
    letterSpacing: letterSpacingPx(s),
  };
}

/** 自动布局（间距、内边距的数值 Token 已解析） */
export function layoutOf(doc: DocState, node: DocNode): LayoutSpec | null {
  return node.layout ? resolveNumericLayout(doc, node.layout) : null;
}

/** 屏幕类型：按画板宽度粗略判断 */
export function deviceOf(width: number): { label: string; icon: string } {
  if (width <= 480) return { label: "移动端", icon: "📱" };
  if (width <= 1100) return { label: "平板 / Web", icon: "💻" };
  return { label: "Web", icon: "🖥" };
}
