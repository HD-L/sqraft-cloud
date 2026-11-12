import { describe, expect, it } from "vitest";
import type { DocState } from "@sqraft/core";
import { effectiveOpacity, maskInfo, owningInstance, PageGeometry, parentLocal, textInfo } from "../src/viewer/inspect";

const n = (id: string, type: string, parentId: string | null, children: string[], extra: Record<string, unknown> = {}) => ({
  id, type, name: id, parentId, children, x: 0, y: 0, width: 100, height: 100, rotation: 0, opacity: 1, visible: true, locked: false, style: {}, ...extra,
});
const PREFS = { unit: "px", scale: 1, color: "hex" } as const;

function doc(nodes: ReturnType<typeof n>[], tokens = {}): DocState {
  return { version: 1, rootIds: [nodes[0].id], nodes: Object.fromEntries(nodes.map((x) => [x.id, x])), tokens } as unknown as DocState;
}

describe("图层命中", () => {
  const d = doc([
    n("pg", "page", null, ["green", "g", "rot", "clipbox", "zero", "hidden"], { x: 1000, y: 500, width: 375, height: 812 }),
    n("green", "rect", "pg", [], { x: 0, y: 0, width: 300, height: 300 }),
    n("g", "group", "pg", ["mask", "photo"], { x: 0, y: 0, width: 200, height: 200 }),
    n("mask", "ellipse", "g", [], { x: 0, y: 0, width: 40, height: 40, isMask: true }),
    n("photo", "image", "g", [], { x: 0, y: 0, width: 200, height: 200 }),
    n("rot", "rect", "pg", [], { x: 100, y: 400, width: 100, height: 20, rotation: 90 }),
    n("clipbox", "frame", "pg", ["out"], { x: 0, y: 600, width: 50, height: 50, clip: true }),
    n("out", "rect", "clipbox", [], { x: 60, y: 0, width: 40, height: 40 }),
    n("zero", "rect", "pg", [], { x: 300, y: 300, width: 0, height: 0 }),
    n("hidden", "rect", "pg", [], { x: 0, y: 0, width: 375, height: 812, visible: false }),
  ]);
  const g = new PageGeometry(d, "pg");
  const at = (x: number, y: number) => g.hit(1000 + x, 500 + y);

  it("被蒙版遮住的图层只在蒙版形状内能点中，形状外点到下面的图层", () => {
    expect(at(20, 20)).toBe("photo");
    expect(at(180, 180)).toBe("green");
    expect(at(2, 2)).toBe("green"); // 椭圆蒙版的角上不算
  });
  it("旋转按实际形状命中；容器裁剪范围外点不中子节点；隐藏、零面积的不参与；空白处是画板", () => {
    expect(at(150, 360)).toBe("rot");
    expect(at(70, 610)).toBe("pg");
    expect(at(350, 700)).toBe("pg");
    expect(g.hit(0, 0)).toBeNull();
  });
  it("尺寸用图层自身宽高与累计旋转，X/Y 用包围盒", () => {
    expect(g.frame("rot")).toEqual({ width: 100, height: 20, rotation: 90 });
    expect(g.local("rot")).toEqual({ x: 140, y: 360, width: 20, height: 100 });
  });
});

describe("图层信息", () => {
  const d = doc([
    n("pg", "page", null, ["card", "g"], { x: 1000, y: 500, width: 375, height: 812 }),
    n("card", "instance", "pg", ["btn"], { x: 16, y: 100, width: 343, height: 200, opacity: 0.8, componentId: "c1" }),
    n("btn", "rect", "card", [], { x: 20, y: 150, width: 100, height: 30, opacity: 0.5 }),
    n("g", "group", "pg", ["m", "img"], { x: 0, y: 400 }),
    n("m", "ellipse", "g", [], { isMask: true }),
    n("img", "image", "g", []),
  ]);
  const g = new PageGeometry(d, "pg");
  it("相对父级与相对画板的位置", () => {
    expect(parentLocal(g, "btn")).toEqual({ x: 20, y: 150, width: 100, height: 30 });
    expect(g.local("btn")).toEqual({ x: 36, y: 250, width: 100, height: 30 });
    expect(parentLocal(g, "card")).toEqual({ x: 16, y: 100, width: 343, height: 200 });
  });
  it("实际不透明度、蒙版、所属组件", () => {
    expect(effectiveOpacity(g, "btn")).toBeCloseTo(0.4);
    expect(maskInfo(g, "img").maskedBy?.id).toBe("m");
    expect(maskInfo(g, "m").isMask).toBe(true);
    expect(owningInstance(g, "btn")?.id).toBe("card");
    expect(owningInstance(g, "img")).toBeNull();
  });
});

describe("文字", () => {
  it("缺省值与渲染器一致：字号 20、自动行高 1.4 倍；没单位的行高按自动", () => {
    expect(textInfo({})).toMatchObject({ size: 20, lineHeight: 28, lineHeightAuto: true, weight: 400 });
    expect(textInfo({ fontSize: 16, lineHeight: 24 })).toMatchObject({ lineHeight: 16 * 1.4, lineHeightAuto: true });
    expect(textInfo({ fontSize: 16, lineHeight: 24, lineHeightUnit: "px", letterSpacing: -0.5, letterSpacingUnit: "percent" })).toMatchObject({ lineHeight: 24, letterSpacing: -0.08 });
  });
});
