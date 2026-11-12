/**
 * 画布叠加层 v2 的绘制：选中框与角点、选中边延长线、悬停框与尺寸小牌、父容器框、所属组件框与徽标、
 * 高亮、测量线与标签。
 *
 * 只管画：CanvasViewer 算好 OverlayState（世界坐标）交进来，这里换算成屏幕坐标画出来。
 * 坐标单位是叠加层 canvas 的 CSS 像素，调用方已经按 dpr setTransform 并清过屏。
 * 标签先全部算出矩形，再统一做贪心避让和视口夹紧（layoutLabels，纯函数，单独导出给测试），最后画在最上层。
 */
import type { Guide, MeasureLine, Rect } from "./measure";

/** 视口：世界坐标 → 屏幕坐标是 (wx - x) * zoom；width / height 是叠加层的 CSS 像素尺寸 */
export interface OverlayView {
  x: number;
  y: number;
  zoom: number;
  width: number;
  height: number;
}

export interface Pt {
  x: number;
  y: number;
}

/** 选中 / 悬停的图层：quad 是旋转后的四个角（世界坐标），bounds 是轴对齐包围盒，size 是格式化好的尺寸文字（空串不画） */
export interface OverlayLayer {
  quad: Pt[];
  bounds: Rect;
  size: string;
}

export interface OverlayState {
  view: OverlayView;
  /** 画板范围（世界坐标）：选中边延长线画到这里为止 */
  page: Rect | null;
  selected: OverlayLayer | null;
  hovered: OverlayLayer | null;
  /** 正在被测量的父容器：灰色虚线框 */
  parentBox: Rect | null;
  /** 选中图层所属的组件：紫色点线框，左上角外侧挂「◇ 组件名」徽标 */
  component: { bounds: Rect; name: string } | null;
  measure: { lines: MeasureLine[]; guides: Guide[] } | null;
  /** 测量值的显示文字（单位换算或百分比由调用方决定） */
  label: (line: MeasureLine) => string;
  /** 额外高亮的区域（例如用到同一张位图的所有图层） */
  highlights: Rect[];
}

export type LabelAnchor = "below" | "right" | "above";

/** 一个待摆放的标签：x / y 是期望的左上角，anchor 说明它挂在锚点的哪一侧（碰撞时往这一侧再挪） */
export interface LabelRect {
  x: number;
  y: number;
  w: number;
  h: number;
  anchor: LabelAnchor;
}

const BRAND = "#2f5cff";
const BRAND_GUIDE = "rgba(47, 92, 255, 0.4)";
const BRAND_FILL = "rgba(47, 92, 255, 0.16)";
const BRAND_FILL_EDGE = "rgba(47, 92, 255, 0.7)";
const MEASURE = "#f5222d";
const ALIGN = "#fa8c16";
const PARENT = "#8c8c8c";
const COMPONENT = "#9747ff";
const TAG_BG = "#737373";

const FONT = "600 11px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif";
const TAG_FONT = "500 10px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif";
const PILL_H = 18;
const TAG_H = 16;
const PILL_PAD_X = 5;
const PILL_RADIUS = 4;
/** 标签离线 / 框的距离（要让开 T 形端帽） */
const LABEL_GAP = 6;
/** T 形端帽的半长 */
const CAP = 4;
/** 选中框角点手柄的边长 */
const HANDLE = 5;
/** 标签夹紧时离视口边的距离 */
const VIEW_MARGIN = 4;
/** 标签之间至少留的空隙；碰撞时每次挪「标签尺寸 + 这个值」 */
const LABEL_SPACING = 2;
/** 碰撞时最多再试几个位置 */
const LABEL_TRIES = 3;
/** 选中边与悬停图层的边相差小于这个值（世界单位）算对齐 */
const ALIGN_EPS = 0.5;
/** 组件徽标里的名字最多显示多少个字 */
const BADGE_MAX_CHARS = 24;
/** 组件徽标底边离组件框顶边的距离 */
const BADGE_GAP = 4;

// ── 标签布局（纯函数） ──

/** 按 anchor 往外挪第 k 次的位置（k = 0 是原位） */
function shifted(r: LabelRect, k: number): Pt {
  if (r.anchor === "below") return { x: r.x, y: r.y + k * (r.h + LABEL_SPACING) };
  if (r.anchor === "above") return { x: r.x, y: r.y - k * (r.h + LABEL_SPACING) };
  return { x: r.x + k * (r.w + LABEL_SPACING), y: r.y };
}

function clampTo(v: number, size: number, extent: number): number {
  const max = extent - VIEW_MARGIN - size;
  return max < VIEW_MARGIN ? VIEW_MARGIN : Math.min(Math.max(v, VIEW_MARGIN), max);
}

/** 两个标签（按 LABEL_SPACING / 2 外扩后）的重叠面积；只是挨着不算 */
function overlapArea(a: Pt, aw: number, ah: number, b: Pt, bw: number, bh: number): number {
  const pad = LABEL_SPACING / 2;
  const ox = Math.min(a.x + aw, b.x + bw) - Math.max(a.x, b.x) + pad;
  const oy = Math.min(a.y + ah, b.y + bh) - Math.max(a.y, b.y) + pad;
  return ox > 1e-6 && oy > 1e-6 ? ox * oy : 0;
}

/**
 * 标签的避让与夹紧：按顺序逐个摆放（前面的优先占位）。每个标签先试原位，和已摆好的重叠就沿 anchor 方向
 * 往外挪，最多再试 LABEL_TRIES 次（被视口边挡住、挪不动时改往反方向挪）；每个候选位置都先夹进视口
 * [4, width − 4] × [4, height − 4]。都重叠时取重叠面积最小的那个。返回每个标签的左上角。
 */
export function layoutLabels(rects: LabelRect[], bounds: { width: number; height: number }): Pt[] {
  const placed: Array<{ p: Pt; w: number; h: number }> = [];
  return rects.map((r) => {
    const clamp = (p: Pt): Pt => ({ x: clampTo(p.x, r.w, bounds.width), y: clampTo(p.y, r.h, bounds.height) });
    const tried: Pt[] = [];
    let best = clamp(r);
    let bestScore = Infinity;
    for (let k = 0; k <= LABEL_TRIES; k++) {
      let c = clamp(shifted(r, k));
      if (k > 0 && tried.some((t) => t.x === c.x && t.y === c.y)) c = clamp(shifted(r, -k));
      tried.push(c);
      const score = placed.reduce((sum, o) => sum + overlapArea(c, r.w, r.h, o.p, o.w, o.h), 0);
      if (score < bestScore) {
        best = c;
        bestScore = score;
      }
      if (score === 0) break;
    }
    placed.push({ p: best, w: r.w, h: r.h });
    return best;
  });
}

// ── 绘制 ──

interface PendingLabel {
  text: string;
  font: string;
  bg: string;
  rect: LabelRect;
}

/** 落到半像素上，1px 线不发虚 */
const crisp = (v: number) => Math.floor(v) + 0.5;

export function drawOverlay(ctx: CanvasRenderingContext2D, s: OverlayState): void {
  const { view } = s;
  const sx = (wx: number) => (wx - view.x) * view.zoom;
  const sy = (wy: number) => (wy - view.y) * view.zoom;
  const screenRect = (r: Rect) => ({ x: sx(r.x), y: sy(r.y), w: r.width * view.zoom, h: r.height * view.zoom });

  const textWidth = (text: string, font: string) => {
    ctx.font = font;
    return Math.ceil(ctx.measureText(text).width) + PILL_PAD_X * 2;
  };

  const strokeRect = (r: Rect, color: string, dash: number[]) => {
    const sr = screenRect(r);
    const x1 = crisp(sr.x);
    const y1 = crisp(sr.y);
    ctx.beginPath();
    ctx.rect(x1, y1, crisp(sr.x + sr.w) - x1, crisp(sr.y + sr.h) - y1);
    ctx.setLineDash(dash);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
  };

  const quadPath = (quad: Pt[]): boolean => {
    if (quad.length < 2) return false;
    ctx.beginPath();
    quad.forEach((p, i) => {
      const x = crisp(sx(p.x));
      const y = crisp(sy(p.y));
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.closePath();
    return true;
  };

  /** 世界坐标的线段；横竖线落到半像素上 */
  const segment = (x1: number, y1: number, x2: number, y2: number) => {
    let ax = sx(x1);
    let ay = sy(y1);
    let bx = sx(x2);
    let by = sy(y2);
    if (y1 === y2) ay = by = crisp(ay);
    if (x1 === x2) ax = bx = crisp(ax);
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    return { a: { x: ax, y: ay }, b: { x: bx, y: by } };
  };

  /** 尺寸胶囊：放在框下方居中，下方出了视口就翻到上方 */
  const sizeLabel = (layer: OverlayLayer, font: string, h: number, bg: string): PendingLabel | null => {
    if (!layer.size) return null;
    const r = screenRect(layer.bounds);
    const w = textWidth(layer.size, font);
    const below = r.y + r.h + LABEL_GAP;
    const fits = below + h <= view.height - VIEW_MARGIN;
    return {
      text: layer.size,
      font,
      bg,
      rect: { x: r.x + r.w / 2 - w / 2, y: fits ? below : r.y - LABEL_GAP - h, w, h, anchor: fits ? "below" : "above" },
    };
  };

  const selCenter = s.selected
    ? { x: s.selected.bounds.x + s.selected.bounds.width / 2, y: s.selected.bounds.y + s.selected.bounds.height / 2 }
    : null;

  /**
   * 测量值标签：横线的放在线下方居中，竖线的放在线右侧居中。线比标签短时挪到线端外侧，
   * 取离选中图层中心远的那一端（不盖住选中图层）。
   */
  const lineLabel = (line: MeasureLine): PendingLabel => {
    const text = s.label(line);
    const w = textWidth(text, FONT);
    const h = PILL_H;
    const bg = line.kind === "align" ? ALIGN : MEASURE;
    const x1 = sx(line.x1);
    const y1 = sy(line.y1);
    const x2 = sx(line.x2);
    const y2 = sy(line.y2);
    // 离选中图层中心远的那一端是第二个点吗（没有选中时取右 / 下端）
    const secondIsFar = selCenter
      ? Math.hypot(line.x2 - selCenter.x, line.y2 - selCenter.y) >= Math.hypot(line.x1 - selCenter.x, line.y1 - selCenter.y)
      : line.axis === "h"
        ? x2 >= x1
        : y2 >= y1;
    let rect: LabelRect;
    if (line.axis === "h") {
      const left = Math.min(x1, x2);
      const right = Math.max(x1, x2);
      const farIsRight = secondIsFar ? x2 >= x1 : x1 > x2;
      if (right - left >= w + LABEL_SPACING) rect = { x: (left + right) / 2 - w / 2, y: y1 + LABEL_GAP, w, h, anchor: "below" };
      else if (farIsRight) rect = { x: right + LABEL_GAP, y: y1 - h / 2, w, h, anchor: "right" };
      else rect = { x: left - LABEL_GAP - w, y: y1 - h / 2, w, h, anchor: "below" };
    } else {
      const top = Math.min(y1, y2);
      const bottom = Math.max(y1, y2);
      const farIsBottom = secondIsFar ? y2 >= y1 : y1 > y2;
      if (bottom - top >= h + LABEL_SPACING) rect = { x: x1 + LABEL_GAP, y: (top + bottom) / 2 - h / 2, w, h, anchor: "right" };
      else if (farIsBottom) rect = { x: x1 - w / 2, y: bottom + LABEL_GAP, w, h, anchor: "below" };
      else rect = { x: x1 - w / 2, y: top - LABEL_GAP - h, w, h, anchor: "above" };
    }
    return { text, font: FONT, bg, rect };
  };

  ctx.save();
  ctx.lineWidth = 1;

  // 高亮：半透明品牌色
  for (const r of s.highlights) {
    const sr = screenRect(r);
    ctx.fillStyle = BRAND_FILL;
    ctx.fillRect(sr.x, sr.y, sr.w, sr.h);
    strokeRect(r, BRAND_FILL_EDGE, []);
  }

  // 所属组件：紫色点线框
  if (s.component) strokeRect(s.component.bounds, COMPONENT, [2, 2]);

  // 父容器：灰色虚线框
  if (s.parentBox) strokeRect(s.parentBox, PARENT, [4, 3]);

  // 选中边延长线：四条边贯穿整个画板（画板外的边不画）；悬停图层有边与之对齐时变成红色实线
  if (s.selected && s.page) {
    const b = s.selected.bounds;
    const pg = s.page;
    const hb = s.hovered?.bounds;
    const hEdges = hb ? [hb.y, hb.y + hb.height] : [];
    const vEdges = hb ? [hb.x, hb.x + hb.width] : [];
    const aligned = (v: number, edges: number[]) => edges.some((e) => Math.abs(e - v) < ALIGN_EPS);
    const guides: Array<{ x1: number; y1: number; x2: number; y2: number; hit: boolean }> = [];
    for (const y of [b.y, b.y + b.height]) {
      if (y >= pg.y && y <= pg.y + pg.height) guides.push({ x1: pg.x, y1: y, x2: pg.x + pg.width, y2: y, hit: aligned(y, hEdges) });
    }
    for (const x of [b.x, b.x + b.width]) {
      if (x >= pg.x && x <= pg.x + pg.width) guides.push({ x1: x, y1: pg.y, x2: x, y2: pg.y + pg.height, hit: aligned(x, vEdges) });
    }
    // 先画普通的，再画对齐的（红线在上）
    for (const hit of [false, true]) {
      const group = guides.filter((g) => g.hit === hit);
      if (!group.length) continue;
      ctx.beginPath();
      for (const g of group) segment(g.x1, g.y1, g.x2, g.y2);
      ctx.setLineDash(hit ? [] : [4, 4]);
      ctx.strokeStyle = hit ? MEASURE : BRAND_GUIDE;
      ctx.stroke();
    }
  }

  // 悬停：1px 品牌色框
  if (s.hovered && quadPath(s.hovered.quad)) {
    ctx.setLineDash([]);
    ctx.strokeStyle = BRAND;
    ctx.stroke();
  }

  // 选中：1px 品牌色框 + 四角白底蓝边手柄
  if (s.selected && quadPath(s.selected.quad)) {
    ctx.setLineDash([]);
    ctx.strokeStyle = BRAND;
    ctx.stroke();
    for (const p of s.selected.quad) {
      const x = Math.round(sx(p.x) - HANDLE / 2) + 0.5;
      const y = Math.round(sy(p.y) - HANDLE / 2) + 0.5;
      ctx.fillStyle = "#fff";
      ctx.fillRect(x - 0.5, y - 0.5, HANDLE, HANDLE);
      ctx.strokeStyle = BRAND;
      ctx.strokeRect(x, y, HANDLE - 1, HANDLE - 1);
    }
  }

  // 测量：虚线延长线 [4,3]，再画实线和 T 形端帽；对齐差用浅橙色
  const lineLabels: PendingLabel[] = [];
  if (s.measure) {
    for (const g of s.measure.guides) {
      ctx.beginPath();
      segment(g.x1, g.y1, g.x2, g.y2);
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = g.kind === "align" ? ALIGN : MEASURE;
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const line of s.measure.lines) {
      ctx.beginPath();
      const { a, b } = segment(line.x1, line.y1, line.x2, line.y2);
      for (const p of [a, b]) {
        if (line.axis === "h") {
          ctx.moveTo(p.x, p.y - CAP);
          ctx.lineTo(p.x, p.y + CAP);
        } else {
          ctx.moveTo(p.x - CAP, p.y);
          ctx.lineTo(p.x + CAP, p.y);
        }
      }
      ctx.strokeStyle = line.kind === "align" ? ALIGN : MEASURE;
      ctx.stroke();
      lineLabels.push(lineLabel(line));
    }
  }

  // 标签：选中尺寸先占位（位置稳定），再是测量值、悬停尺寸、组件徽标
  const pending: PendingLabel[] = [];
  const selSize = s.selected ? sizeLabel(s.selected, FONT, PILL_H, BRAND) : null;
  if (selSize) pending.push(selSize);
  pending.push(...lineLabels);
  const hovSize = s.hovered ? sizeLabel(s.hovered, TAG_FONT, TAG_H, TAG_BG) : null;
  if (hovSize) pending.push(hovSize);
  if (s.component) {
    const name = s.component.name.length > BADGE_MAX_CHARS ? `${s.component.name.slice(0, BADGE_MAX_CHARS - 1)}…` : s.component.name;
    const text = `◇ ${name}`;
    const w = textWidth(text, FONT);
    const r = screenRect(s.component.bounds);
    pending.push({ text, font: FONT, bg: COMPONENT, rect: { x: r.x, y: r.y - BADGE_GAP - PILL_H, w, h: PILL_H, anchor: "above" } });
  }

  const positions = layoutLabels(
    pending.map((l) => l.rect),
    view,
  );
  // 胶囊落到整像素上，边缘和文字清楚
  ctx.setLineDash([]);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  pending.forEach((l, i) => {
    const x = Math.round(positions[i].x);
    const y = Math.round(positions[i].y);
    const { w, h } = l.rect;
    ctx.fillStyle = l.bg;
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, PILL_RADIUS);
    else ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.font = l.font;
    ctx.fillStyle = "#fff";
    ctx.fillText(l.text, x + w / 2, y + h / 2 + 0.5);
  });

  ctx.restore();
}
