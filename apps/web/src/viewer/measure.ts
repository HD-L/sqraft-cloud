/**
 * 测距算法 v2：选中图层（a）与目标（b：悬停图层、父容器、画板边外的虚拟矩形）之间要画哪些测量线。
 * 纯函数，没有 DOM 依赖；输入输出都是世界坐标，数值是设计稿单位（未换算单位），一律为正。画法见 overlay.ts。
 *
 * 先判包含，再看两个轴上是否相离，分四种情况：
 * 1. 包含：里面那个到外面那个四条边的内距，线穿过里面那个的水平 / 竖直中线（inspectkit insideLines）；
 * 2. 两个轴都相离（对角）：从选中图层的中线出一横一竖两条空隙线；线端停在目标的 x / y 上时碰不到目标，
 *    所以再补一段虚线沿目标的边延长到目标角上，看得出量的是谁到谁（inspectkit gapLines 的 guide）；
 * 3. 一个轴相离、另一个轴重叠（上下排列的列表项等）：空隙线穿过重叠区的中点；重叠轴上两条对应边差得不多
 *    （0 < |Δ| ≤ alignThreshold）时再画「对齐差」，查出「差 2px 没对齐」（mastergo calculateMarkData 的 margins 分支）。
 *    对齐差画在「边更靠里」那个图层的中线上，从另一个图层的边补一条虚线过来；阈值是我们自己定的降噪规则；
 * 4. 部分相交：每个轴上两条起边之差、两条止边之差（即排序后的四条边两两相减），线穿过重叠区的中线。
 *    轴向包含时与 Penpot calculate-distance-lines 一致；部分重叠时 Penpot 只画一段，这里两段都画（mastergo 做法）。
 *
 * 小于 0.01 的值不画（浮点误差、贴边）。
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** gap：两个图层之间的空隙；inset：重叠 / 包含时边与边的差；align：对齐差（画成浅色） */
export type MeasureKind = "gap" | "inset" | "align";

/** 一条测量线（世界坐标，x1 ≤ x2、y1 ≤ y2）。h 是横线（量水平距离），v 是竖线。 */
export interface MeasureLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  value: number;
  axis: "h" | "v";
  kind: MeasureKind;
}

/** 虚线延长线（世界坐标）：把测量线接到目标的边上。kind 是它所属测量线的类型，用来配色。 */
export interface Guide {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  kind?: MeasureKind;
}

export interface MeasureResult {
  lines: MeasureLine[];
  guides: Guide[];
}

export interface MeasureOptions {
  /** 对齐差只在 0 < |Δ| ≤ 这个值时画（世界单位），默认 24；传 0 关掉对齐差（例如测到画板边时） */
  alignThreshold?: number;
}

const EPS = 0.01;
const DEFAULT_ALIGN_THRESHOLD = 24;

interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
  cx: number;
  cy: number;
}

function box(r: Rect): Box {
  return { l: r.x, t: r.y, r: r.x + r.width, b: r.y + r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
}

const containsBox = (o: Box, i: Box) => i.l >= o.l && i.r <= o.r && i.t >= o.t && i.b <= o.b;

/** 收集测量线与延长线；太短的不收 */
class Collector {
  readonly lines: MeasureLine[] = [];
  readonly guides: Guide[] = [];

  /** 在 y 处从 x1 到 x2 的横线；画了返回 true */
  h(x1: number, x2: number, y: number, kind: MeasureKind): boolean {
    const value = Math.abs(x2 - x1);
    if (!(value >= EPS)) return false;
    this.lines.push({ x1: Math.min(x1, x2), y1: y, x2: Math.max(x1, x2), y2: y, value, axis: "h", kind });
    return true;
  }

  /** 在 x 处从 y1 到 y2 的竖线；画了返回 true */
  v(y1: number, y2: number, x: number, kind: MeasureKind): boolean {
    const value = Math.abs(y2 - y1);
    if (!(value >= EPS)) return false;
    this.lines.push({ x1: x, y1: Math.min(y1, y2), x2: x, y2: Math.max(y1, y2), value, axis: "v", kind });
    return true;
  }

  guide(x1: number, y1: number, x2: number, y2: number, kind: MeasureKind): void {
    if (Math.abs(x2 - x1) < EPS && Math.abs(y2 - y1) < EPS) return;
    this.guides.push({ x1, y1, x2, y2, kind });
  }
}

/** 情况 1：inner 到 outer 四条边的内距（上、下、左、右），线穿过 inner 的中线 */
function insets(out: Collector, inner: Box, outer: Box): void {
  out.v(outer.t, inner.t, inner.cx, "inset");
  out.v(inner.b, outer.b, inner.cx, "inset");
  out.h(outer.l, inner.l, inner.cy, "inset");
  out.h(inner.r, outer.r, inner.cy, "inset");
}

/** 情况 2：两个轴都相离。线从选中图层 a 的中线出发，线端沿目标 b 的边补虚线到 b 的角上 */
function diagonal(out: Collector, a: Box, b: Box): void {
  // 横向空隙，画在 a 的水平中线上；edge 是线落在 b 上的那条竖边
  const y = a.cy;
  const [hx1, hx2, edgeX] = a.r <= b.l ? [a.r, b.l, b.l] : [b.r, a.l, b.r];
  if (out.h(hx1, hx2, y, "gap")) out.guide(edgeX, y, edgeX, y <= b.t ? b.t : b.b, "gap");
  // 竖向空隙，画在 a 的竖直中线上
  const x = a.cx;
  const [vy1, vy2, edgeY] = a.b <= b.t ? [a.b, b.t, b.t] : [b.b, a.t, b.b];
  if (out.v(vy1, vy2, x, "gap")) out.guide(x, edgeY, x <= b.l ? b.l : b.r, edgeY, "gap");
}

/**
 * 情况 3（上下排列）：竖向空隙穿过 x 方向重叠区的中点；左边、右边各自的对齐差。
 * 对齐差的横线画在「边更靠里」那个图层的水平中线上，从另一个图层（outer）的这条竖边补一条竖虚线，
 * 从这条中线延长到 outer 靠近它的那条横边。
 */
function stacked(out: Collector, a: Box, b: Box, threshold: number): void {
  const [top, bottom] = a.b <= b.t ? [a, b] : [b, a];
  const x = (Math.max(a.l, b.l) + Math.min(a.r, b.r)) / 2;
  out.v(top.b, bottom.t, x, "gap");
  const near = (o: Box) => (o === top ? o.b : o.t);
  if (alignable(a.l, b.l, threshold)) {
    const [inner, outer] = a.l > b.l ? [a, b] : [b, a];
    if (out.h(outer.l, inner.l, inner.cy, "align")) out.guide(outer.l, inner.cy, outer.l, near(outer), "align");
  }
  if (alignable(a.r, b.r, threshold)) {
    const [inner, outer] = a.r < b.r ? [a, b] : [b, a];
    if (out.h(inner.r, outer.r, inner.cy, "align")) out.guide(outer.r, inner.cy, outer.r, near(outer), "align");
  }
}

/** 情况 3（左右排列）：与 stacked 对称，横向空隙穿过 y 方向重叠区的中点；上边、下边的对齐差 */
function sideBySide(out: Collector, a: Box, b: Box, threshold: number): void {
  const [left, right] = a.r <= b.l ? [a, b] : [b, a];
  const y = (Math.max(a.t, b.t) + Math.min(a.b, b.b)) / 2;
  out.h(left.r, right.l, y, "gap");
  const near = (o: Box) => (o === left ? o.r : o.l);
  if (alignable(a.t, b.t, threshold)) {
    const [inner, outer] = a.t > b.t ? [a, b] : [b, a];
    if (out.v(outer.t, inner.t, inner.cx, "align")) out.guide(inner.cx, outer.t, near(outer), outer.t, "align");
  }
  if (alignable(a.b, b.b, threshold)) {
    const [inner, outer] = a.b < b.b ? [a, b] : [b, a];
    if (out.v(inner.b, outer.b, inner.cx, "align")) out.guide(inner.cx, outer.b, near(outer), outer.b, "align");
  }
}

function alignable(e1: number, e2: number, threshold: number): boolean {
  const d = Math.abs(e1 - e2);
  return d >= EPS && d <= threshold;
}

/** 情况 4：部分相交。上边差、下边差画在 x 重叠区中线上，左边差、右边差画在 y 重叠区中线上 */
function intersecting(out: Collector, a: Box, b: Box): void {
  const x = (Math.max(a.l, b.l) + Math.min(a.r, b.r)) / 2;
  const y = (Math.max(a.t, b.t) + Math.min(a.b, b.b)) / 2;
  out.v(a.t, b.t, x, "inset");
  out.v(a.b, b.b, x, "inset");
  out.h(a.l, b.l, y, "inset");
  out.h(a.r, b.r, y, "inset");
}

/**
 * 选中图层 selected 与目标 target 之间的测量线和虚线延长线（世界坐标）。
 * 判断「相离」用闭区间：贴边（空隙为 0）也算相离，0 值的线不画。
 */
export function measure(selected: Rect, target: Rect, opts: MeasureOptions = {}): MeasureResult {
  const a = box(selected);
  const b = box(target);
  const threshold = opts.alignThreshold ?? DEFAULT_ALIGN_THRESHOLD;
  const out = new Collector();
  if (containsBox(b, a)) insets(out, a, b);
  else if (containsBox(a, b)) insets(out, b, a);
  else {
    const hSep = a.r <= b.l || b.r <= a.l;
    const vSep = a.b <= b.t || b.b <= a.t;
    if (hSep && vSep) diagonal(out, a, b);
    else if (vSep) stacked(out, a, b, threshold);
    else if (hSep) sideBySide(out, a, b, threshold);
    else intersecting(out, a, b);
  }
  return { lines: out.lines, guides: out.guides };
}

/**
 * 指针在画板外时的测量目标：按九宫格在画板对应的边（或角）外侧生成一个 thickness 厚的虚拟矩形
 * （sketch-measure template.html 的 getEdgeRect）。上方 → 贴着顶边、与画板同宽；左上角外 → 角上的小方块；以此类推。
 * 拿它和选中图层 measure()，量出来的就是到画板边的距离（建议传 alignThreshold: 0，只看空隙）。
 * 指针在画板内（含边上）返回 null。page 与 p 都是世界坐标。
 */
export function edgeTarget(page: Rect, p: { x: number; y: number }, thickness = 10): Rect | null {
  const right = page.x + page.width;
  const bottom = page.y + page.height;
  const toLeft = p.x < page.x;
  const toRight = p.x > right;
  const above = p.y < page.y;
  const below = p.y > bottom;
  if (!toLeft && !toRight && !above && !below) return null;
  return {
    x: toLeft ? page.x - thickness : toRight ? right : page.x,
    y: above ? page.y - thickness : below ? bottom : page.y,
    width: toLeft || toRight ? thickness : page.width,
    height: above || below ? thickness : page.height,
  };
}

/** value 占 base 的百分比，保留 1 位小数（3.2 表示 3.2%）；base 为 0 时返回 0 */
export function percent(value: number, base: number): number {
  if (!base || !Number.isFinite(base)) return 0;
  const r = Math.round((value / base) * 1000) / 10;
  return Object.is(r, -0) ? 0 : r;
}
