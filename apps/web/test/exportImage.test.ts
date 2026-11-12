import { describe, expect, it } from "vitest";
import type { DocState } from "@sqraft/core";
import { BLUR_EXTENT } from "@sqraft/core";
import { assignBaseNames, effectLayerLimited, effectMargin, exportBounds, exportSize, exportTargets, imagesInOutput, safeFileName, targetPath } from "../src/viewer/exportImage";

const node = (id: string, type: string, parentId: string | null, children: string[], extra: Record<string, unknown> = {}) => ({
  id,
  type,
  name: id,
  parentId,
  children,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  rotation: 0,
  opacity: 1,
  visible: true,
  locked: false,
  style: {},
  ...extra,
});
function doc(nodes: ReturnType<typeof node>[]): DocState {
  return { version: 1, rootIds: [nodes[0].id], nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), tokens: {} } as unknown as DocState;
}
const page = (children: string[]) => node("pg", "page", null, children, { width: 375, height: 812 });
const shadow = (x: number, y: number, blur: number, spread = 0) => ({ type: "drop-shadow", visible: true, x, y, blur, spread, color: { value: "#000000" } });

describe("exportBounds", () => {
  it("蒙版组只算蒙版形状内的部分，蒙版本身不额外撑大", () => {
    const d = doc([
      page(["avatar"]),
      node("avatar", "group", "pg", ["m", "img"], { x: 100, y: 100, width: 40, height: 40 }),
      node("m", "ellipse", "avatar", [], { width: 40, height: 40, isMask: true, style: { fill: { value: "#000000" } } }),
      node("img", "rect", "avatar", [], { x: -20, y: -10, width: 80, height: 60, style: { fill: { value: "#ff0000" } } }),
    ]);
    expect(exportBounds(d, "avatar")).toEqual({ x: 100, y: 100, width: 40, height: 40 });
  });

  it("蒙版隐藏时整对不画，范围只剩其他兄弟", () => {
    const d = doc([
      page(["g"]),
      node("g", "group", "pg", ["m", "img", "dot"], { x: 0, y: 0, width: 200, height: 200 }),
      node("m", "rect", "g", [], { width: 40, height: 40, isMask: true, visible: false }),
      node("img", "rect", "g", [], { width: 200, height: 200 }),
      node("dot", "rect", "g", [], { x: 10, y: 20, width: 5, height: 6 }),
    ]);
    expect(exportBounds(d, "g")).toEqual({ x: 10, y: 20, width: 5, height: 6 });
  });

  it("投影按偏移往一侧外扩，而不是四周对称", () => {
    const d = doc([page(["r"]), node("r", "rect", "pg", [], { x: 10, y: 10, width: 24, height: 24, style: { effects: [shadow(0, 2, 4)] } })]);
    const g = 4 * BLUR_EXTENT;
    expect(exportBounds(d, "r")).toEqual({ x: 10 - g, y: 10 + 2 - g, width: 24 + g * 2, height: 24 + 2 + g * 2 - 2 });
  });

  it("没有偏移和模糊的投影不改变范围；隐藏的效果不算", () => {
    const d = doc([
      page(["a", "b"]),
      node("a", "rect", "pg", [], { x: 0, y: 0, width: 10, height: 10, style: { effects: [shadow(0, 0, 0)] } }),
      node("b", "rect", "pg", [], { x: 0, y: 0, width: 10, height: 10, style: { effects: [{ ...shadow(5, 5, 5), visible: false }] } }),
    ]);
    expect(exportBounds(d, "a")).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    expect(exportBounds(d, "b")).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });

  it("编组的效果作用在子图层合成后的范围上", () => {
    const d = doc([
      page(["g"]),
      node("g", "group", "pg", ["r"], { x: 50, y: 50, width: 20, height: 20, style: { effects: [shadow(4, 0, 0)] } }),
      node("r", "rect", "g", [], { width: 20, height: 20 }),
    ]);
    expect(exportBounds(d, "g")).toEqual({ x: 50, y: 50, width: 24, height: 20 });
  });

  it("裁切容器：子图层与阴影超出容器的部分不算，容器自身描边照算", () => {
    const d = doc([
      page(["f"]),
      node("f", "frame", "pg", ["r", "big"], { x: 10, y: 10, width: 50, height: 50, clip: true, style: { stroke: { value: "#000000" }, strokeWidth: 4 } }),
      node("r", "rect", "f", [], { width: 50, height: 50, style: { effects: [shadow(0, 0, 2)] } }),
      node("big", "rect", "f", [], { x: -100, y: -100, width: 500, height: 500 }),
    ]);
    expect(exportBounds(d, "f")).toEqual({ x: 8, y: 8, width: 54, height: 54 });
  });

  it("多层投影逐层累加：第二层投的是「内容 + 第一层投影」", () => {
    const d = doc([page(["r"]), node("r", "rect", "pg", [], { x: 100, y: 100, width: 40, height: 40, style: { effects: [shadow(0, 6, 0), shadow(0, 6, 0)] } })]);
    expect(exportBounds(d, "r")).toEqual({ x: 100, y: 100, width: 40, height: 52 });
  });

  it("图层模糊被裁在节点自身形状内，不往四周外扩；排在前面的投影一起被裁", () => {
    const blur = { type: "layer-blur", visible: true, radius: 10 };
    const d = doc([
      page(["img", "sb"]),
      node("img", "image", "pg", [], { x: 20, y: 20, width: 100, height: 100, style: { effects: [blur] } }),
      node("sb", "rect", "pg", [], { x: 0, y: 0, width: 50, height: 50, style: { effects: [shadow(10, 10, 0), blur] } }),
    ]);
    expect(exportBounds(d, "img")).toEqual({ x: 20, y: 20, width: 100, height: 100 });
    expect(exportBounds(d, "sb")).toEqual({ x: 0, y: 0, width: 50, height: 50 });
  });

  it("编组模糊：子图层模糊后最多铺满编组自身的矩形", () => {
    const d = doc([
      page(["g"]),
      node("g", "group", "pg", ["a", "b"], { x: 0, y: 0, width: 100, height: 100, style: { effects: [{ type: "layer-blur", visible: true, radius: 4 }] } }),
      node("a", "rect", "g", [], { x: 0, y: 0, width: 10, height: 10 }),
      node("b", "rect", "g", [], { x: 90, y: 90, width: 10, height: 10 }),
    ]);
    expect(exportBounds(d, "g")).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });

  it("图片节点的描边渲染器不画，不外扩", () => {
    const d = doc([page(["img"]), node("img", "image", "pg", [], { x: 10, y: 10, width: 100, height: 100, style: { stroke: { value: "#000000" }, strokeWidth: 1 } })]);
    expect(exportBounds(d, "img")).toEqual({ x: 10, y: 10, width: 100, height: 100 });
  });

  it("画板就是画板自身的矩形", () => {
    const d = doc([page(["r"]), node("r", "rect", "pg", [], { x: -50, y: 0, width: 1000, height: 10 })]);
    expect(exportBounds(d, "pg")).toEqual({ x: 0, y: 0, width: 375, height: 812 });
  });
});

describe("绘制边距与可见图片", () => {
  it("effectMargin：嵌套效果层沿祖先链累加，取最大的一条", () => {
    const blur = (radius: number) => ({ type: "layer-blur", visible: true, radius });
    const d = doc([
      page(["f"]),
      node("f", "frame", "pg", ["a", "b"], { style: { effects: [blur(2)] } }),
      node("a", "rect", "f", [], { style: { effects: [blur(4)] } }),
      node("b", "rect", "f", [], { visible: false, style: { effects: [blur(100)] } }),
    ]);
    expect(effectMargin(d, "f")).toBe(2 * BLUR_EXTENT + 4 * BLUR_EXTENT);
    expect(effectMargin(d, "a")).toBe(4 * BLUR_EXTENT);
    expect(effectMargin(d, "pg")).toBe(6 * BLUR_EXTENT);
  });

  it("imagesInOutput：只统计看得见的图片——裁切掉、蒙版遮掉、隐藏、在导出范围外的都不算", () => {
    const d = doc([
      page(["list", "far"]),
      node("list", "frame", "pg", ["in", "out", "hidden", "grp"], { x: 0, y: 0, width: 375, height: 200, clip: true }),
      node("in", "image", "list", [], { x: 10, y: 10, width: 100, height: 100, image: { assetId: "a1", naturalWidth: 1, naturalHeight: 1 } }),
      node("out", "image", "list", [], { x: 400, y: 10, width: 100, height: 100, image: { sourceUrl: "https://x/y.png", naturalWidth: 0, naturalHeight: 0 } }),
      node("hidden", "image", "list", [], { x: 10, y: 10, width: 100, height: 100, visible: false }),
      node("grp", "group", "list", ["m", "masked"], { x: 200, y: 10, width: 40, height: 40 }),
      node("m", "rect", "grp", [], { width: 40, height: 40, isMask: true }),
      node("masked", "image", "grp", [], { x: 100, y: 0, width: 50, height: 50 }),
      node("far", "image", "pg", [], { x: 10, y: 600, width: 50, height: 50, image: { sourceUrl: "https://x/z.png", naturalWidth: 0, naturalHeight: 0 } }),
    ]);
    const use = imagesInOutput(d, "list", exportBounds(d, "list")!);
    expect([...use.assets]).toEqual(["a1"]);
    expect(use.linked).toBe(0);
    expect(use.empty).toBe(0);
    const all = imagesInOutput(d, "pg", exportBounds(d, "pg")!);
    expect(all.linked).toBe(1); // 只有画板上的 far；列表里伸出去的 out 被裁掉
  });

  it("imagesInOutput：蒙版本身是图片时也计入（渲染器用它的 alpha 来裁）", () => {
    const d = doc([
      page(["g"]),
      node("g", "group", "pg", ["m", "t"], { width: 40, height: 40 }),
      node("m", "image", "g", [], { width: 40, height: 40, isMask: true, image: { assetId: "mask1", naturalWidth: 1, naturalHeight: 1 } }),
      node("t", "rect", "g", [], { width: 40, height: 40 }),
    ]);
    expect([...imagesInOutput(d, "g", exportBounds(d, "g")!).assets]).toEqual(["mask1"]);
  });

  it("imagesInOutput：看得见的空图片计入", () => {
    const d = doc([page(["e"]), node("e", "image", "pg", [], { x: 0, y: 0, width: 10, height: 10 })]);
    expect(imagesInOutput(d, "pg", exportBounds(d, "pg")!).empty).toBe(1);
  });
});

describe("效果层精度上限", () => {
  const d = doc([
    page(["card", "plain"]),
    node("card", "frame", "pg", ["t"], { x: 16, y: 100, width: 343, height: 600, style: { effects: [shadow(0, 4, 16)] } }),
    node("t", "text", "card", [], { width: 100, height: 20 }),
    node("plain", "frame", "pg", [], { x: 16, y: 100, width: 343, height: 600 }),
  ]);
  it("带投影的大卡片在高倍导出时超过离屏层上限", () => {
    expect(effectLayerLimited(d, "card", 1)).toBe(false);
    expect(effectLayerLimited(d, "card", 4)).toBe(true);
  });
  it("没有效果的图层不受限；导出画板时检查到子图层", () => {
    expect(effectLayerLimited(d, "plain", 4)).toBe(false);
    expect(effectLayerLimited(d, "pg", 4)).toBe(true);
  });
});

describe("导出尺寸与命名", () => {
  it("超过单边上限时等比缩小，并返回实际倍率", () => {
    const s = exportSize({ width: 750, height: 12000 }, 1.5);
    expect(s.height).toBe(8192);
    expect(s.scale).toBeLessThan(1.5);
    expect(exportSize({ width: 24, height: 24 }, 1.5)).toEqual({ width: 36, height: 36, scale: 1.5 });
  });

  it("iOS 档位文件名：「icon」的 @2x 与「icon@2x」的 @1x 撞名，需要按最终路径去重", () => {
    const t = exportTargets("ios", 1);
    const a = t.map((x) => targetPath(x, safeFileName("icon", "ios"), "png"));
    const b = t.map((x) => targetPath(x, safeFileName("icon@2x", "ios"), "png"));
    expect(a.some((p) => b.includes(p))).toBe(true);
  });

  it("assignBaseNames 按最终路径去重，不区分大小写", () => {
    const ios = exportTargets("ios", 1);
    const bases = assignBaseNames(["icon", "icon@2x", "Icon", "icon"], ios, "ios", "png");
    expect(bases).toEqual(["icon", "icon@2x-2", "Icon-2", "icon-3"]);
    const paths = bases.flatMap((b) => ios.map((t) => targetPath(t, b, "png").toLowerCase()));
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("assignBaseNames：Android 同名放不同目录，重名加 _2", () => {
    const android = exportTargets("android", 1);
    expect(assignBaseNames(["返回", "back", "Back"], android, "android", "png")).toEqual(["image", "back", "back_2"]);
  });
});
