import { describe, expect, it } from "vitest";
import type { DocNode, DocState } from "@sqraft/core";
import { exportNodeSvg, paintAttrs, vectorPathData } from "../src/svg";

function n(id: string, type: string, parentId: string | null, children: string[] = [], extra: Partial<DocNode> = {}): DocNode {
  return { id, type, name: id, parentId, children, x: 0, y: 0, width: 24, height: 24, rotation: 0, opacity: 1, visible: true, locked: false, style: {}, ...extra } as DocNode;
}

function doc(nodes: DocNode[], tokens: DocState["tokens"] = {}): DocState {
  return { version: 1, formatVersion: 7, rootIds: [nodes[0].id], nodes: Object.fromEntries(nodes.map((x) => [x.id, x])), tokens } as DocState;
}

const noAssets = { asset: () => null };

describe("SVG 导出", () => {
  it("颜色：8 位 hex 拆成颜色 + 不透明度，rgba 同理", () => {
    expect(paintAttrs("#1677ffcc", "fill")).toBe(' fill="#1677ff" fill-opacity="0.8"');
    expect(paintAttrs("#fff", "stroke")).toBe(' stroke="#ffffff"');
    expect(paintAttrs("rgba(0, 0, 0, 0.5)", "fill")).toBe(' fill="rgb(0,0,0)" fill-opacity="0.5"');
    expect(paintAttrs(undefined, "fill")).toBe(' fill="none"');
  });

  it("矢量路径：直线段用 L，带手柄的用三次贝塞尔，闭合加 Z", () => {
    const d = vectorPathData({
      closed: true,
      anchors: [
        { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
        { x: 10, y: 0, inX: 0, inY: 0, outX: 0, outY: 5 },
        { x: 10, y: 10, inX: 0, inY: -5, outX: 0, outY: 0 },
      ],
    });
    expect(d).toBe("M0 0L10 0C10 5 10 5 10 10L0 0Z");
  });

  it("图标：容器坐标、圆角矩形、椭圆、路径描边，Token 解析成颜色", () => {
    const icon = n("icon", "frame", null, ["bg", "dot", "line"], { x: 300, y: 500, width: 24, height: 24 });
    const bg = n("bg", "rect", "icon", [], { width: 24, height: 24, style: { fill: { token: "color/brand" }, cornerRadius: { topLeft: 6, topRight: 6, bottomRight: 6, bottomLeft: 6 } } });
    const dot = n("dot", "ellipse", "icon", [], { x: 8, y: 8, width: 8, height: 8, style: { fill: { value: "#ffffff" } } });
    const line = n("line", "path", "icon", [], {
      x: 4,
      y: 20,
      width: 16,
      height: 0,
      style: { stroke: { value: "#000000" }, strokeWidth: 2 },
      vector: { closed: false, anchors: [{ x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 }, { x: 16, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 }] },
    });
    const r = exportNodeSvg(doc([icon, bg, dot, line], { "color/brand": { type: "color", value: "#1677ff" } }), "icon", noAssets);
    expect(r).toMatchObject({ width: 24, height: 24, warnings: [] });
    // 根节点放在原点（画布位置 300,500 不带进来）
    expect(r.svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="24" height="24" viewBox="0 0 24 24">/);
    expect(r.svg).not.toContain("translate(300");
    expect(r.svg).toContain('<path d="M6 0H18A6 6 0 0 1 24 6V18A6 6 0 0 1 18 24H6A6 6 0 0 1 0 18V6A6 6 0 0 1 6 0Z" fill="#1677ff"/>');
    expect(r.svg).toContain('<g transform="translate(8 8)" data-name="dot"><ellipse cx="4" cy="4" rx="4" ry="4" fill="#ffffff"/>');
    expect(r.svg).toContain('d="M0 0L16 0" fill="none" stroke="#000000" stroke-width="2" stroke-linecap="round"');
  });

  it("隐藏节点不导出；旋转绕中心；clip 的画板裁剪子内容", () => {
    const f = n("f", "frame", null, ["a", "b"], { clip: true, width: 20, height: 20, style: { cornerRadius: { topLeft: 4, topRight: 4, bottomRight: 4, bottomLeft: 4 } } });
    const a = n("a", "rect", "f", [], { width: 40, height: 10, rotation: 45, style: { fill: { value: "#ff0000" } } });
    const b = n("b", "rect", "f", [], { visible: false, style: { fill: { value: "#00ff00" } } });
    const r = exportNodeSvg(doc([f, a, b]), "f", noAssets);
    expect(r.svg).toContain('transform="rotate(45 20 5)"');
    expect(r.svg).not.toContain("#00ff00");
    expect(r.svg).toMatch(/<clipPath id="k\d+"><path d="M4 0H16A4 4/);
    expect(r.svg).toMatch(/<g clip-path="url\(#k\d+\)">/);
  });

  it("蒙版裁掉紧挨着的上一个兄弟，蒙版本身不画", () => {
    const g = n("g", "group", null, ["mask", "pic", "after"], { width: 40, height: 40 });
    const mask = n("mask", "ellipse", "g", [], { width: 40, height: 40, isMask: true, style: { fill: { value: "#123456" } } } as Partial<DocNode>);
    const pic = n("pic", "rect", "g", [], { width: 40, height: 40, style: { fill: { value: "#ff8800" } } });
    const after = n("after", "rect", "g", [], { x: 30, width: 10, height: 10, style: { fill: { value: "#000000" } } });
    const r = exportNodeSvg(doc([g, mask, pic, after]), "g", noAssets);
    // clipPath 里直接放形状（不能包 <g>）
    expect(r.svg).toMatch(/<clipPath id="m\d+"><ellipse cx="20" cy="20" rx="20" ry="20"\/><\/clipPath>/);
    expect(r.svg).not.toMatch(/<clipPath[^>]*><g/);
    expect(r.svg).toMatch(/<g clip-path="url\(#m\d+\)"><g data-name="pic">/);
    expect(r.svg).not.toContain("#123456");
    // 蒙版之后的兄弟不受影响
    expect(r.svg).toMatch(/<\/g><\/g><g transform="translate\(30 0\)" data-name="after">/);
  });

  it("带位移 / 旋转的蒙版：变换写在 clipPath 内的形状上", () => {
    const g = n("g", "group", null, ["mask", "pic"], { width: 40, height: 40 });
    const mask = n("mask", "rect", "g", [], { x: 5, y: 6, width: 10, height: 10, rotation: 30, isMask: true } as Partial<DocNode>);
    const pic = n("pic", "rect", "g", [], { width: 40, height: 40, style: { fill: { value: "#ff8800" } } });
    const r = exportNodeSvg(doc([g, mask, pic]), "g", noAssets);
    expect(r.svg).toMatch(/<clipPath id="m\d+"><path d="M0 0H10V10H0Z" transform="translate\(5 6\) rotate\(30 5 5\)"\/><\/clipPath>/);
  });

  it("位图以 data URI 内嵌并按裁切显示；缺资源画占位并提示", () => {
    const img = n("img", "image", null, [], {
      width: 50,
      height: 50,
      image: { assetId: "aa", naturalWidth: 100, naturalHeight: 200, crop: { x: 0, y: 50, width: 100, height: 100 } },
    });
    const r = exportNodeSvg(doc([img]), "img", { asset: () => ({ mime: "image/png", bytes: Buffer.from("PNGDATA") }) });
    expect(r.svg).toContain('viewBox="0 50 100 100"');
    expect(r.svg).toContain(`href="data:image/png;base64,${Buffer.from("PNGDATA").toString("base64")}"`);
    const missing = exportNodeSvg(doc([img]), "img", noAssets);
    expect(missing.svg).toContain('fill="#e5e7eb"');
    expect(missing.warnings[0]).toContain("占位");
  });

  it("投影用滤镜并给画布留边；内阴影提示不支持", () => {
    const card = n("card", "rect", null, [], {
      width: 100,
      height: 50,
      style: {
        fill: { value: "#ffffff" },
        effects: [
          { type: "drop-shadow", visible: true, x: 0, y: 2, blur: 6, spread: 0, color: { value: "#3a415a69" } },
          { type: "inner-shadow", visible: true, x: 0, y: 1, blur: 2, spread: 0, color: { value: "#00000033" } },
        ],
      },
    });
    const r = exportNodeSvg(doc([card]), "card", noAssets);
    expect(r).toMatchObject({ width: 116, height: 66 });
    expect(r.svg).toContain('viewBox="-8 -8 116 66"');
    expect(r.svg).toContain('<feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#3a415a" flood-opacity="0.41"/>');
    expect(r.warnings.join()).toContain("内阴影");
  });

  it("文本：字体、字号、颜色、居中对齐与基线", () => {
    const t = n("t", "text", null, [], {
      width: 100,
      height: 20,
      text: "照片修复",
      textAutoResize: "fixed",
      style: { fontSize: 14, fontWeight: 500, fontFamily: "PingFang SC", textAlign: "center", fill: { value: "#333333" }, lineHeight: 20, lineHeightUnit: "px" },
    } as Partial<DocNode>);
    const r = exportNodeSvg(doc([t]), "t", noAssets);
    expect(r.svg).toContain('font-family="PingFang SC" font-size="14" font-weight="500" text-anchor="middle"');
    expect(r.svg).toContain('fill="#333333"');
    // 基线 = (20 − 14) / 2 + 14 × 0.8 = 14.2；居中锚点在宽度一半
    expect(r.svg).toContain('<tspan x="50" y="14.2">照片修复</tspan>');
  });
});
