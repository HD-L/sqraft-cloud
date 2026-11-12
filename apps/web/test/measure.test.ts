import { describe, expect, it } from "vitest";
import { edgeTarget, measure, percent, type MeasureLine, type Rect } from "../src/viewer/measure";
import { drawOverlay, layoutLabels, type LabelRect, type OverlayState } from "../src/viewer/overlay";

const R = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

describe("measure：包含", () => {
  it("里面的图层到外框四边，线穿过里面那个的中线；反过来测结果一样", () => {
    const inner = R(20, 150, 100, 30);
    const outer = R(0, 0, 343, 200);
    const expected: MeasureLine[] = [
      { x1: 70, y1: 0, x2: 70, y2: 150, value: 150, axis: "v", kind: "inset" },
      { x1: 70, y1: 180, x2: 70, y2: 200, value: 20, axis: "v", kind: "inset" },
      { x1: 0, y1: 165, x2: 20, y2: 165, value: 20, axis: "h", kind: "inset" },
      { x1: 120, y1: 165, x2: 343, y2: 165, value: 223, axis: "h", kind: "inset" },
    ];
    expect(measure(inner, outer)).toEqual({ lines: expected, guides: [] });
    expect(measure(outer, inner)).toEqual({ lines: expected, guides: [] });
  });

  it("贴边的那几条（0）不画；完全重合什么都不画", () => {
    expect(measure(R(0, 0, 50, 50), R(0, 0, 100, 100)).lines.map((l) => [l.axis, l.value])).toEqual([
      ["v", 50],
      ["h", 50],
    ]);
    expect(measure(R(5, 5, 10, 10), R(5, 5, 10, 10)).lines).toEqual([]);
  });
});

describe("measure：对角相离", () => {
  it("从选中图层的中线出一横一竖，虚线沿目标的边延长到目标角上", () => {
    const r = measure(R(0, 0, 10, 10), R(30, 50, 10, 10));
    expect(r.lines).toEqual([
      { x1: 10, y1: 5, x2: 30, y2: 5, value: 20, axis: "h", kind: "gap" },
      { x1: 5, y1: 10, x2: 5, y2: 50, value: 40, axis: "v", kind: "gap" },
    ]);
    expect(r.guides).toEqual([
      { x1: 30, y1: 5, x2: 30, y2: 50, kind: "gap" },
      { x1: 5, y1: 50, x2: 30, y2: 50, kind: "gap" },
    ]);
  });

  it("目标在左上方：线从目标的右边 / 下边量到选中图层，虚线接到目标右下角", () => {
    const r = measure(R(100, 100, 20, 20), R(0, 0, 50, 40));
    expect(r.lines).toEqual([
      { x1: 50, y1: 110, x2: 100, y2: 110, value: 50, axis: "h", kind: "gap" },
      { x1: 110, y1: 40, x2: 110, y2: 100, value: 60, axis: "v", kind: "gap" },
    ]);
    expect(r.guides).toEqual([
      { x1: 50, y1: 110, x2: 50, y2: 40, kind: "gap" },
      { x1: 110, y1: 40, x2: 50, y2: 40, kind: "gap" },
    ]);
  });

  it("一个轴上空隙为 0：那条线和它的虚线都不画", () => {
    const r = measure(R(0, 0, 10, 10), R(10, 30, 10, 10));
    expect(r.lines).toEqual([{ x1: 5, y1: 10, x2: 5, y2: 30, value: 20, axis: "v", kind: "gap" }]);
    expect(r.guides).toEqual([{ x1: 5, y1: 30, x2: 10, y2: 30, kind: "gap" }]);
  });
});

describe("measure：一个轴相离、另一个轴重叠", () => {
  it("上下排列：空隙穿过重叠区中点；左边差 2 画成对齐差（在更靠里的图层中线上，外侧图层的边补虚线）", () => {
    const r = measure(R(16, 100, 343, 48), R(18, 160, 341, 48));
    expect(r.lines).toEqual([
      { x1: 188.5, y1: 148, x2: 188.5, y2: 160, value: 12, axis: "v", kind: "gap" },
      { x1: 16, y1: 184, x2: 18, y2: 184, value: 2, axis: "h", kind: "align" },
    ]);
    expect(r.guides).toEqual([{ x1: 16, y1: 184, x2: 16, y2: 148, kind: "align" }]);
  });

  it("选中图层在下面、右边更靠里时，对齐差画在选中图层的中线上", () => {
    const r = measure(R(0, 100, 96, 20), R(0, 0, 100, 40));
    expect(r.lines).toEqual([
      { x1: 48, y1: 40, x2: 48, y2: 100, value: 60, axis: "v", kind: "gap" },
      { x1: 96, y1: 110, x2: 100, y2: 110, value: 4, axis: "h", kind: "align" },
    ]);
    expect(r.guides).toEqual([{ x1: 100, y1: 110, x2: 100, y2: 40, kind: "align" }]);
  });

  it("左右排列：上边差、下边差都画，虚线从外侧图层的边横向接过来", () => {
    const r = measure(R(0, 0, 100, 40), R(112, 4, 60, 40));
    expect(r.lines).toEqual([
      { x1: 100, y1: 22, x2: 112, y2: 22, value: 12, axis: "h", kind: "gap" },
      { x1: 142, y1: 0, x2: 142, y2: 4, value: 4, axis: "v", kind: "align" },
      { x1: 50, y1: 40, x2: 50, y2: 44, value: 4, axis: "v", kind: "align" },
    ]);
    expect(r.guides).toEqual([
      { x1: 142, y1: 0, x2: 100, y2: 0, kind: "align" },
      { x1: 50, y1: 44, x2: 112, y2: 44, kind: "align" },
    ]);
  });

  it("对齐差超过阈值不画；alignThreshold 可调，0 表示关掉", () => {
    const a = R(16, 100, 343, 48);
    const far = R(50, 160, 309, 48); // 左边差 34
    expect(measure(a, far).lines.map((l) => l.kind)).toEqual(["gap"]);
    expect(measure(a, far, { alignThreshold: 40 }).lines.map((l) => l.kind)).toEqual(["gap", "align"]);
    expect(measure(a, R(18, 160, 341, 48), { alignThreshold: 0 })).toEqual({
      lines: [{ x1: 188.5, y1: 148, x2: 188.5, y2: 160, value: 12, axis: "v", kind: "gap" }],
      guides: [],
    });
  });

  it("贴在一起（空隙 0）时只剩对齐差", () => {
    const r = measure(R(0, 0, 100, 50), R(3, 50, 97, 50));
    expect(r.lines).toEqual([{ x1: 0, y1: 75, x2: 3, y2: 75, value: 3, axis: "h", kind: "align" }]);
  });
});

describe("measure：部分相交", () => {
  it("每个轴上起边差、止边差各一段，画在重叠区中线上", () => {
    expect(measure(R(0, 0, 100, 100), R(50, 50, 100, 100))).toEqual({
      lines: [
        { x1: 75, y1: 0, x2: 75, y2: 50, value: 50, axis: "v", kind: "inset" },
        { x1: 75, y1: 100, x2: 75, y2: 150, value: 50, axis: "v", kind: "inset" },
        { x1: 0, y1: 75, x2: 50, y2: 75, value: 50, axis: "h", kind: "inset" },
        { x1: 100, y1: 75, x2: 150, y2: 75, value: 50, axis: "h", kind: "inset" },
      ],
      guides: [],
    });
  });

  it("十字交叉（每个轴上一个包住另一个）", () => {
    expect(measure(R(0, 40, 200, 20), R(80, 0, 40, 100)).lines).toEqual([
      { x1: 100, y1: 0, x2: 100, y2: 40, value: 40, axis: "v", kind: "inset" },
      { x1: 100, y1: 60, x2: 100, y2: 100, value: 40, axis: "v", kind: "inset" },
      { x1: 0, y1: 50, x2: 80, y2: 50, value: 80, axis: "h", kind: "inset" },
      { x1: 120, y1: 50, x2: 200, y2: 50, value: 80, axis: "h", kind: "inset" },
    ]);
  });

  it("小于 0.01 的值不画", () => {
    expect(measure(R(0, 0, 10, 10), R(10.005, 0, 10, 10)).lines).toEqual([]);
    expect(measure(R(0, 0, 10, 10), R(0.004, 3, 10, 10)).lines.map((l) => l.value)).toEqual([3, 3]);
    const tiny = measure(R(0, 0, 10, 10), R(10.02, 0, 10, 10)).lines;
    expect(tiny).toHaveLength(1);
    expect(tiny[0].value).toBeCloseTo(0.02, 6);
  });
});

describe("edgeTarget：画板外的九宫格虚拟矩形", () => {
  const page = R(100, 50, 375, 812); // 右边 475，底边 862

  it("指针在画板内（含边上）返回 null", () => {
    expect(edgeTarget(page, { x: 200, y: 300 })).toBeNull();
    expect(edgeTarget(page, { x: 100, y: 50 })).toBeNull();
    expect(edgeTarget(page, { x: 475, y: 862 })).toBeNull();
  });

  it("四条边：贴着边外侧、与画板等宽 / 等高", () => {
    expect(edgeTarget(page, { x: 200, y: 0 })).toEqual(R(100, 40, 375, 10));
    expect(edgeTarget(page, { x: 500, y: 300 })).toEqual(R(475, 50, 10, 812));
    expect(edgeTarget(page, { x: 200, y: 900 })).toEqual(R(100, 862, 375, 10));
    expect(edgeTarget(page, { x: 0, y: 300 })).toEqual(R(90, 50, 10, 812));
  });

  it("四个角：角外侧的小方块；厚度可调", () => {
    expect(edgeTarget(page, { x: 0, y: 0 })).toEqual(R(90, 40, 10, 10));
    expect(edgeTarget(page, { x: 500, y: 0 })).toEqual(R(475, 40, 10, 10));
    expect(edgeTarget(page, { x: 500, y: 900 })).toEqual(R(475, 862, 10, 10));
    expect(edgeTarget(page, { x: 0, y: 900 })).toEqual(R(90, 862, 10, 10));
    expect(edgeTarget(page, { x: 200, y: 0 }, 4)).toEqual(R(100, 46, 375, 4));
  });

  it("和选中图层 measure 得到到画板边的距离；角上同时量两条边", () => {
    const sel = R(120, 80, 100, 40);
    expect(measure(sel, edgeTarget(page, { x: 200, y: 0 })!, { alignThreshold: 0 }).lines).toEqual([
      { x1: 170, y1: 50, x2: 170, y2: 80, value: 30, axis: "v", kind: "gap" },
    ]);
    const corner = measure(sel, edgeTarget(page, { x: 0, y: 0 })!, { alignThreshold: 0 });
    expect(corner.lines.map((l) => [l.axis, l.value])).toEqual([
      ["h", 20],
      ["v", 30],
    ]);
    // 虚线沿画板的左边、顶边接到画板角上
    expect(corner.guides).toEqual([
      { x1: 100, y1: 100, x2: 100, y2: 50, kind: "gap" },
      { x1: 170, y1: 50, x2: 100, y2: 50, kind: "gap" },
    ]);
  });
});

describe("percent", () => {
  it("保留 1 位小数；基准为 0 时给 0", () => {
    expect(percent(12, 375)).toBe(3.2);
    expect(percent(1, 3)).toBe(33.3);
    expect(percent(375, 375)).toBe(100);
    expect(percent(5, 0)).toBe(0);
  });
});

// ── 叠加层 ──

type Box = { x: number; y: number; w: number; h: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (r: Box, width: number, height: number) => r.x >= 4 && r.y >= 4 && r.x + r.w <= width - 4 && r.y + r.h <= height - 4;

describe("layoutLabels", () => {
  const bounds = { width: 400, height: 400 };
  const withSize = (rects: LabelRect[], pos: Array<{ x: number; y: number }>): Box[] => pos.map((p, i) => ({ ...p, w: rects[i].w, h: rects[i].h }));
  const noOverlap = (boxes: Box[]) => {
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i], boxes[j]), `${i} vs ${j}`).toBe(false);
  };

  it("不重叠的保持原位", () => {
    const rects: LabelRect[] = [
      { x: 10, y: 10, w: 40, h: 18, anchor: "below" },
      { x: 100, y: 100, w: 40, h: 18, anchor: "right" },
    ];
    expect(layoutLabels(rects, bounds)).toEqual([
      { x: 10, y: 10 },
      { x: 100, y: 100 },
    ]);
  });

  it("重叠时沿 anchor 方向挪开：below 往下、above 往上、right 往右", () => {
    const pile = (anchor: LabelRect["anchor"]): LabelRect[] => [0, 1, 2, 3].map(() => ({ x: 180, y: 190, w: 40, h: 18, anchor }));
    for (const anchor of ["below", "above", "right"] as const) {
      const rects = pile(anchor);
      const pos = layoutLabels(rects, bounds);
      noOverlap(withSize(rects, pos));
      expect(pos[0]).toEqual({ x: 180, y: 190 });
      if (anchor === "below") expect(pos[1].y).toBeGreaterThan(190);
      if (anchor === "above") expect(pos[1].y).toBeLessThan(190);
      if (anchor === "right") expect(pos[1].x).toBeGreaterThan(180);
    }
  });

  it("全部夹进 [4, w−4] × [4, h−4]；比视口还宽时贴左边", () => {
    const rects: LabelRect[] = [
      { x: -50, y: -20, w: 40, h: 18, anchor: "below" },
      { x: 390, y: 395, w: 40, h: 18, anchor: "right" },
      { x: 100, y: 200, w: 500, h: 18, anchor: "below" },
    ];
    const pos = layoutLabels(rects, bounds);
    expect(pos[0]).toEqual({ x: 4, y: 4 });
    expect(pos[1]).toEqual({ x: 356, y: 378 });
    expect(pos[2].x).toBe(4);
  });

  it("挨着视口边挪不动时改往反方向挪，仍然不重叠且不出界", () => {
    const rects: LabelRect[] = [0, 1, 2].map(() => ({ x: 100, y: 390, w: 40, h: 18, anchor: "below" as const }));
    const pos = layoutLabels(rects, bounds);
    const boxes = withSize(rects, pos);
    noOverlap(boxes);
    for (const b of boxes) expect(inside(b, 400, 400)).toBe(true);
  });
});

/** 只记录调用的假 2D context（node 环境没有 canvas）；文字宽度按每字 6px 算 */
function fakeCtx() {
  const pills: Box[] = [];
  const texts: Array<{ text: string; x: number; y: number }> = [];
  const strokes: Array<{ style: string; dash: number[] }> = [];
  const state: Record<string, unknown> = { strokeStyle: "", fillStyle: "", font: "", lineWidth: 1 };
  let dash: number[] = [];
  const methods: Record<string, (...args: never[]) => unknown> = {
    measureText: (s: string) => ({ width: s.length * 6 }),
    roundRect: (x: number, y: number, w: number, h: number) => void pills.push({ x, y, w, h }),
    fillText: (text: string, x: number, y: number) => void texts.push({ text, x, y }),
    setLineDash: (d: number[]) => void (dash = [...d]),
    stroke: () => void strokes.push({ style: String(state.strokeStyle), dash }),
  };
  const ctx = new Proxy(state, {
    get(target, key) {
      if (typeof key !== "string") return undefined;
      if (key in methods) return methods[key];
      if (key in target) return target[key];
      return () => undefined;
    },
    set(target, key, value) {
      if (typeof key === "string") target[key] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, pills, texts, strokes };
}

const quadOf = (r: Rect) => [
  { x: r.x, y: r.y },
  { x: r.x + r.width, y: r.y },
  { x: r.x + r.width, y: r.y + r.height },
  { x: r.x, y: r.y + r.height },
];

function state(over: Partial<OverlayState> = {}): OverlayState {
  return {
    view: { x: 0, y: 0, zoom: 1, width: 800, height: 600 },
    page: R(50, 50, 375, 500),
    selected: null,
    hovered: null,
    parentBox: null,
    component: null,
    measure: null,
    label: (l) => String(l.value),
    highlights: [],
    ...over,
  };
}

describe("drawOverlay", () => {
  it("完整状态：标签都画出来、不出视口、互不重叠", () => {
    const sel = R(100, 100, 100, 40);
    const hov = R(100, 180, 100, 40);
    const { ctx, pills, texts } = fakeCtx();
    drawOverlay(
      ctx,
      state({
        selected: { quad: quadOf(sel), bounds: sel, size: "100 × 40" },
        hovered: { quad: quadOf(hov), bounds: hov, size: "100 × 40" },
        parentBox: R(60, 60, 300, 300),
        component: { bounds: R(90, 90, 120, 60), name: "Button/Primary" },
        measure: measure(sel, hov),
        highlights: [R(300, 300, 20, 20)],
      }),
    );
    expect(texts.map((t) => t.text).sort()).toEqual(["100 × 40", "100 × 40", "40", "◇ Button/Primary"].sort());
    for (const p of pills) expect(inside(p, 800, 600)).toBe(true);
    for (let i = 0; i < pills.length; i++) for (let j = i + 1; j < pills.length; j++) expect(overlaps(pills[i], pills[j])).toBe(false);
  });

  it("横线标签在线下方居中，竖线标签在线右侧居中；线太短时挪到远离选中图层的那一端外侧", () => {
    const { ctx, pills } = fakeCtx();
    const lines: MeasureLine[] = [
      { x1: 100, y1: 300, x2: 300, y2: 300, value: 200, axis: "h", kind: "gap" },
      { x1: 600, y1: 100, x2: 600, y2: 200, value: 100, axis: "v", kind: "gap" },
      { x1: 100, y1: 450, x2: 104, y2: 450, value: 4, axis: "h", kind: "align" },
    ];
    const sel = R(0, 400, 50, 100);
    drawOverlay(ctx, state({ selected: { quad: quadOf(sel), bounds: sel, size: "" }, measure: { lines, guides: [] } }));
    // "200" → 3×6 + 10 = 28 宽
    expect(pills[0]).toEqual({ x: 186, y: 306, w: 28, h: 18 });
    expect(pills[1]).toEqual({ x: 606, y: 141, w: 28, h: 18 });
    // 4px 的线放不下 → 右端外侧（离选中图层远），与线同高
    expect(pills[2]).toEqual({ x: 110, y: 441, w: 16, h: 18 });
  });

  it("短线标签挪到离选中图层远的一端：选中图层在右下时，横线放左端外侧、竖线放上端外侧", () => {
    const { ctx, pills } = fakeCtx();
    const lines: MeasureLine[] = [
      { x1: 100, y1: 450, x2: 104, y2: 450, value: 4, axis: "h", kind: "gap" },
      { x1: 300, y1: 100, x2: 300, y2: 104, value: 4, axis: "v", kind: "gap" },
    ];
    const sel = R(700, 400, 50, 100);
    drawOverlay(ctx, state({ selected: { quad: quadOf(sel), bounds: sel, size: "" }, measure: { lines, guides: [] } }));
    expect(pills[0]).toEqual({ x: 100 - 6 - 16, y: 441, w: 16, h: 18 });
    expect(pills[1]).toEqual({ x: 292, y: 100 - 6 - 18, w: 16, h: 18 });
  });

  it("选中尺寸胶囊在下方放不下时翻到上方", () => {
    const sel = R(100, 560, 100, 30);
    const { ctx, pills } = fakeCtx();
    drawOverlay(ctx, state({ selected: { quad: quadOf(sel), bounds: sel, size: "100 × 30" } }));
    expect(pills).toHaveLength(1);
    expect(pills[0].y).toBe(560 - 6 - 18);
  });

  it("选中边延长线：悬停图层的边对齐时变成红色实线，否则是浅色虚线", () => {
    const sel = R(100, 100, 100, 40);
    const aligned = R(100, 300, 50, 50); // 左边对齐
    const off = R(103, 300, 50, 50);
    const red = (strokes: Array<{ style: string; dash: number[] }>) => strokes.some((s) => s.style === "#f5222d" && s.dash.length === 0);
    const run = (hov: Rect) => {
      const f = fakeCtx();
      drawOverlay(f.ctx, state({ selected: { quad: quadOf(sel), bounds: sel, size: "" }, hovered: { quad: quadOf(hov), bounds: hov, size: "" } }));
      return f.strokes;
    };
    expect(red(run(aligned))).toBe(true);
    expect(red(run(off))).toBe(false);
    expect(run(off).some((s) => s.dash.join() === "4,4")).toBe(true);
  });
});
