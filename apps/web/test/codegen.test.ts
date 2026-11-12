import { describe, expect, it } from "vitest";
import type { DocState } from "@sqraft/core";
import { buildSpec, normalizeCssColor } from "../src/viewer/codegen/spec";
import { cssFor, cssVarName, type CssOptions } from "../src/viewer/codegen/css";
import { escapeHtml, highlightCss } from "../src/viewer/codegen/highlight";

const n = (id: string, type: string, parentId: string | null, children: string[], extra: Record<string, unknown> = {}) => ({
  id, type, name: id, parentId, children, x: 0, y: 0, width: 100, height: 100, rotation: 0, opacity: 1, visible: true, locked: false, clip: false, style: {}, ...extra,
});

function doc(nodes: ReturnType<typeof n>[], tokens: Record<string, { type: "color" | "number"; value: string | number }> = {}): DocState {
  return { version: 1, rootIds: [nodes[0].id], nodes: Object.fromEntries(nodes.map((x) => [x.id, x])), tokens } as unknown as DocState;
}

const px = (v: number) => {
  const r = Math.round(v * 100) / 100;
  return `${Object.is(r, -0) ? 0 : r}px`;
};
const OPTS: CssOptions = { len: px, tokenVars: true };
const PLAIN: CssOptions = { len: px, tokenVars: false };

function css(d: DocState, id: string, opts: CssOptions = OPTS) {
  const spec = buildSpec(d, id);
  if (!spec) throw new Error(`no node ${id}`);
  return cssFor(spec, opts);
}
const lines = (d: DocState, id: string, opts: CssOptions = OPTS) => css(d, id, opts).sections.flatMap((s) => s.lines);

const PAD0 = { top: 0, right: 0, bottom: 0, left: 0 };
const layout = (extra: Record<string, unknown> = {}) => ({
  direction: "horizontal", gap: 0, crossGap: 0, wrap: false, padding: PAD0, mainAlign: "start", crossAlign: "start", alignContent: "start", ...extra,
});

describe("spec", () => {
  it("节点不存在返回 null；根节点按 flow；颜色规范成 #RRGGBB / rgba()", () => {
    const d = doc([n("pg", "page", null, [], { x: 500, y: 300, style: { fill: { value: "#ffffff" } } })]);
    expect(buildSpec(d, "nope")).toBeNull();
    const s = buildSpec(d, "pg")!;
    expect(s.position).toEqual({ mode: "flow", x: 0, y: 0 });
    expect(s.parentLayout).toBeNull();
    expect(s.fill).toEqual({ color: "#FFFFFF" });
    expect(normalizeCssColor("#2f5cff80")).toBe("rgba(47, 92, 255, 0.5)");
    expect(normalizeCssColor("#abc")).toBe("#AABBCC");
    expect(normalizeCssColor("rgba(0, 0, 0, 0.25)")).toBe("rgba(0, 0, 0, 0.25)");
    expect(normalizeCssColor("rgb(255 0 0 / 50%)")).toBe("rgba(255, 0, 0, 0.5)");
    expect(normalizeCssColor("rebeccapurple")).toBe("rebeccapurple");
    // 透明度保留 8 位精度：0x7F 不会变成 0.5（0x80），0x01 不会变成全透明，0xFE 不会变成不透明
    expect(normalizeCssColor("#2F5CFF7F")).toBe("rgba(47, 92, 255, 0.498)");
    expect(normalizeCssColor("#00000001")).toBe("rgba(0, 0, 0, 0.004)");
    expect(normalizeCssColor("#000000FE")).toBe("rgba(0, 0, 0, 0.996)");
  });

  it("旋转：rotation 按祖先累计，CSS 只写自身角度；缺失的数值 Token 不报告", () => {
    const d = doc(
      [
        n("pg", "page", null, ["g"]),
        n("g", "group", "pg", ["r"], { rotation: 30, style: { fill: { value: "#000" } } }),
        n("r", "rect", "g", [], { rotation: 15, style: { cornerRadius: { topLeft: 4, topRight: 4, bottomRight: 4, bottomLeft: 4 }, cornerRadiusTokens: { topLeft: "radius/missing" } } }),
      ],
    );
    const s = buildSpec(d, "r")!;
    expect(s.rotation).toBe(45);
    expect(s.ownRotation).toBe(15);
    expect(s.radius).toEqual({ uniform: 4, corners: { topLeft: 4, topRight: 4, bottomRight: 4, bottomLeft: 4 }, tokens: {} });
    expect(buildSpec(d, "g")!.fill).toBeNull(); // 编组不画填充
    expect(lines(d, "r")).toContain("transform: rotate(15deg);");
    expect(lines(d, "g")).toContain("transform: rotate(30deg);");
  });

  it("直线没设描边色时按渲染器的缺省（黑色 1px）报告描边", () => {
    const d = doc([n("pg", "page", null, ["l", "l2"]), n("l", "line", "pg", [], { width: 100, height: 0 }), n("l2", "line", "pg", [], { style: { stroke: { value: "#ff0000" }, strokeWidth: 3 } })]);
    expect(buildSpec(d, "l")!.stroke).toEqual({ width: 1, color: "#000000" });
    expect(buildSpec(d, "l2")!.stroke).toEqual({ width: 3, color: "#FF0000" });
  });

  it("与渲染器一致：蒙版不报描边与效果；编组的投影用 filter: drop-shadow", () => {
    const fx = [{ type: "drop-shadow", visible: true, x: 0, y: 2, blur: 4, spread: 0, color: { value: "#000000" } }];
    const d = doc([
      n("pg", "page", null, ["m", "g", "r"]),
      n("m", "rect", "pg", [], { isMask: true, style: { fill: { value: "#d8d8d8" }, stroke: { value: "#979797" }, strokeWidth: 1, effects: fx } }),
      n("g", "group", "pg", [], { style: { effects: fx } }),
      n("r", "rect", "pg", [], { style: { fill: { value: "#ffffff" }, effects: fx } }),
    ]);
    expect(buildSpec(d, "m")!.stroke).toBeNull();
    expect(buildSpec(d, "m")!.shadows).toEqual([]);
    expect(lines(d, "g")).toContain("filter: drop-shadow(0px 2px 4px #000000);");
    expect(lines(d, "g").some((l) => l.startsWith("box-shadow"))).toBe(false);
    expect(lines(d, "r").some((l) => l.startsWith("box-shadow"))).toBe(true);
  });

  it("与渲染器一致：图片不报描边，直线不报填充", () => {
    const d = doc([
      n("pg", "page", null, ["img", "l"]),
      n("img", "image", "pg", [], { style: { stroke: { value: "#ff0000" }, strokeWidth: 2 } }),
      n("l", "line", "pg", [], { style: { fill: { value: "#00ff00" } } }),
    ]);
    expect(buildSpec(d, "img")!.stroke).toBeNull();
    expect(lines(d, "img").some((l) => l.startsWith("outline"))).toBe(false);
    expect(buildSpec(d, "l")!.fill).toBeNull();
  });
});

describe("CSS：尺寸与排布", () => {
  const d = doc([
    n("pg", "page", null, ["row", "col"], { width: 375, height: 812 }),
    n("row", "frame", "pg", ["fillW", "fillH", "hugBox", "fixed", "abs"], { x: 10, y: 20, width: 300, height: 80, layout: layout({ padding: { top: 8, right: 16, bottom: 8, left: 16 } }) }),
    n("fillW", "rect", "row", [], { width: 120, height: 40, layoutSizingW: "fill", layoutMinW: 40, layoutMaxW: 200 }),
    n("fillH", "rect", "row", [], { width: 40, height: 64, layoutSizingH: "fill" }),
    n("hugBox", "frame", "row", [], { width: 60, height: 30, layoutSizingW: "hug", layoutSizingH: "hug", layout: layout() }),
    n("fixed", "rect", "row", [], { width: 24, height: 24 }),
    n("abs", "rect", "row", [], { x: 250, y: 4, width: 10, height: 10, layoutAbsolute: true }),
    n("col", "frame", "pg", ["hugText"], { width: 200, height: 300, layout: layout({ direction: "vertical", crossAlign: "stretch" }) }),
    n("hugText", "text", "col", [], { width: 80, height: 22, textAutoResize: "auto-width", style: { fontSize: 16 } }),
  ]);

  it("flex 主轴 fill → flex: 1 1 0，不写宽；min / max 照写", () => {
    const l = lines(d, "fillW");
    expect(l).toContain("flex: 1 1 0;");
    expect(l.some((x) => x.startsWith("width:"))).toBe(false);
    expect(l).toContain("height: 40px;");
    expect(l).toEqual(expect.arrayContaining(["min-width: 40px;", "max-width: 200px;"]));
  });

  it("交叉轴 fill → align-self: stretch，不写高；固定子项不收缩", () => {
    const l = lines(d, "fillH");
    expect(l).toEqual(expect.arrayContaining(["flex-shrink: 0;", "align-self: stretch;", "width: 40px;"]));
    expect(l.some((x) => x.startsWith("height:"))).toBe(false);
    expect(lines(d, "fixed")).toEqual(expect.arrayContaining(["flex-shrink: 0;", "width: 24px;", "height: 24px;"]));
  });

  it("hug 容器不写宽高", () => {
    const l = lines(d, "hugBox");
    expect(l.some((x) => /^(width|height):/.test(x))).toBe(false);
    expect(l).toContain("display: flex;");
  });

  it("父级 stretch 时 hug 的文本贴起点，不被 CSS 拉伸", () => {
    const l = lines(d, "hugText");
    expect(l).toContain("align-self: flex-start;");
    expect(l.some((x) => /^(width|height):/.test(x))).toBe(false);
  });

  it("绝对定位：layoutAbsolute 或父级无布局 → absolute + left / top；父级 position: relative", () => {
    const abs = lines(d, "abs");
    expect(abs.find((x) => x.startsWith("position:"))).toMatch(/^position: absolute; \/\*.*position: relative/);
    expect(abs).toEqual(expect.arrayContaining(["left: 250px;", "top: 4px;", "width: 10px;"]));
    expect(abs.some((x) => x.startsWith("flex"))).toBe(false);
    // row 本身在画板（无布局）里：绝对定位；它有绝对定位的子项，但自己已是 absolute，不再写 relative
    const row = lines(d, "row");
    expect(row).toEqual(expect.arrayContaining(["left: 10px;", "top: 20px;"]));
    expect(row).not.toContain("position: relative;");
    // 画板：子项都按绝对定位摆放 → relative
    expect(lines(d, "pg")).toContain("position: relative;");
  });

  it("有内边距的容器写 box-sizing；自动布局写 padding / align-items", () => {
    const row = lines(d, "row");
    expect(row).toEqual(expect.arrayContaining(["box-sizing: border-box;", "padding: 8px 16px;", "align-items: flex-start;", "flex-direction: row;"]));
    expect(row.some((x) => x.startsWith("justify-content"))).toBe(false);
    expect(css(d, "row").sections.map((s) => s.key)).toEqual(["size", "position", "autolayout"]);
  });
});

describe("CSS：文本", () => {
  const d = doc([
    n("pg", "page", null, ["aw", "ah", "fx", "st"]),
    n("aw", "text", "pg", [], { width: 80, height: 22, textAutoResize: "auto-width", style: { fontSize: 16, fontFamily: "PingFang SC", fill: { value: "#333333" } } }),
    n("ah", "text", "pg", [], { width: 200, height: 44, textAutoResize: "auto-height", style: { fontSize: 16, fontWeight: 600, textAlign: "center" } }),
    n("fx", "text", "pg", [], { width: 200, height: 44, textAutoResize: "fixed", truncate: true, style: { fontSize: 16, lineHeight: 22, lineHeightUnit: "px", textVerticalAlign: "middle" } }),
    n("st", "text", "pg", [], {
      style: {
        fontSize: 16,
        stroke: { value: "#ff0000" },
        strokeWidth: 1,
        effects: [
          { type: "drop-shadow", visible: true, x: 0, y: 2, blur: 4, spread: 3, color: { value: "#00000040" } },
          { type: "inner-shadow", visible: true, x: 0, y: 1, blur: 2, spread: 0, color: { value: "#000000" } },
        ],
      },
    }),
  ]);

  it("auto-width 不写宽高；auto-height 只写宽；行高始终写 px", () => {
    const aw = lines(d, "aw");
    expect(aw.some((x) => /^(width|height):/.test(x))).toBe(false);
    expect(aw).toEqual(expect.arrayContaining(['font-family: "PingFang SC";', "font-size: 16px;", "line-height: 22.4px;", "color: #333333;", "white-space: nowrap;"]));
    expect(aw.some((x) => x.startsWith("font-weight") || x.startsWith("background"))).toBe(false);
    const ah = lines(d, "ah");
    expect(ah).toContain("width: 200px;");
    expect(ah.some((x) => x.startsWith("height:"))).toBe(false);
    expect(ah).toEqual(expect.arrayContaining(["font-weight: 600;", "text-align: center;"]));
  });

  it("固定尺寸 + 截断：按能放下的行数 line-clamp；垂直居中给注释", () => {
    const fx = lines(d, "fx");
    expect(fx).toEqual(expect.arrayContaining(["width: 200px;", "height: 44px;", "line-height: 22px;", "-webkit-line-clamp: 2;", "overflow: hidden;"]));
    expect(fx.some((x) => x.startsWith("/* 垂直居中"))).toBe(true);
  });

  it("文字描边用 -webkit-text-stroke；text-shadow 无扩展、无内阴影", () => {
    const st = lines(d, "st");
    expect(st).toContain("-webkit-text-stroke: 1px #FF0000;");
    expect(st).toContain("color: #000000;"); // 没设填充：与渲染器一致按黑色
    expect(st).toContain("text-shadow: 0px 2px 4px rgba(0, 0, 0, 0.25);");
    expect(st.some((x) => /outline|box-shadow|inset/.test(x))).toBe(false);
  });
});

describe("CSS：外观、Token、布局", () => {
  const tokens = {
    "color/brand/primary": { type: "color" as const, value: "#2f5cff" },
    "radius/md": { type: "number" as const, value: 8 },
    "space/md": { type: "number" as const, value: 12 },
    "space/sm": { type: "number" as const, value: 4 },
    "border/thin": { type: "number" as const, value: 2 },
    "font/size/Body L": { type: "number" as const, value: 18 },
  };
  const d = doc(
    [
      n("pg", "page", null, ["card", "hwrap", "vwrap", "same", "tri", "pic", "ov"]),
      n("card", "frame", "pg", [], {
        clip: true,
        opacity: 0.8,
        style: {
          fill: { token: "color/brand/primary" },
          stroke: { value: "#000000" },
          strokeWidth: 1,
          strokeWidthToken: "border/thin",
          cornerRadius: { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 },
          cornerRadiusTokens: { topLeft: "radius/md", topRight: "radius/md", bottomRight: "radius/md", bottomLeft: "radius/md" },
          effects: [
            { type: "inner-shadow", visible: true, x: 0, y: 1, blur: 2, spread: 0, color: { value: "#0000001a" } },
            { type: "layer-blur", visible: true, radius: 4 },
            { type: "backdrop-blur", visible: true, radius: 10 },
            { type: "drop-shadow", visible: false, x: 0, y: 9, blur: 9, spread: 0, color: { value: "#000" } },
          ],
        },
        layout: layout({ direction: "vertical", gap: 0, gapToken: "space/md", padding: { top: 0, right: 0, bottom: 0, left: 0 }, paddingTokens: { top: "space/sm", bottom: "space/sm" } }),
      }),
      n("hwrap", "frame", "pg", [], { layout: layout({ wrap: true, gap: 16, crossGap: 8, mainAlign: "space-between" }) }),
      n("vwrap", "frame", "pg", [], { layout: layout({ direction: "vertical", wrap: true, gap: 16, crossGap: 8 }) }),
      n("same", "frame", "pg", [], { layout: layout({ wrap: true, gap: 8, crossGap: 8 }) }),
      n("tri", "polygon", "pg", [], { width: 30, height: 20, style: { fill: { value: "#ff0000" }, stroke: { value: "#000" }, strokeWidth: 2 } }),
      n("pic", "image", "pg", [], { style: { fill: { value: "#eeeeee" } } }),
      n("ov", "ellipse", "pg", [], { style: { fill: { value: "rgba(255, 0, 0, 0.5)" } } }),
    ],
    tokens,
  );

  it("Token 变量：颜色 / 圆角 / 描边宽 / 间距 / 内边距写 var(--name, 字面量)", () => {
    const l = lines(d, "card");
    expect(l).toEqual(
      expect.arrayContaining([
        "background: var(--color-brand-primary, #2F5CFF);",
        "border-radius: var(--radius-md, 8px);",
        "outline: var(--border-thin, 2px) solid #000000;",
        "outline-offset: calc(var(--border-thin, 2px) / -2); /* 居中描边 */",
        "gap: var(--space-md, 12px);",
        "padding: var(--space-sm, 4px) 0px;",
        "opacity: 0.8;",
        "overflow: hidden;",
      ]),
    );
  });

  it("关掉 Token 变量只写字面量；居中描边 outline-offset = -W/2", () => {
    const l = lines(d, "card", PLAIN);
    expect(l).toEqual(expect.arrayContaining(["background: #2F5CFF;", "border-radius: 8px;", "outline: 2px solid #000000;", "outline-offset: -1px; /* 居中描边 */", "gap: 12px;", "padding: 4px 0px;"]));
    expect(l.join("\n")).not.toContain("var(");
  });

  it("内阴影 inset；隐藏的效果不输出；图层模糊 → filter，背景模糊 → backdrop-filter", () => {
    const l = lines(d, "card");
    expect(l).toEqual(expect.arrayContaining(["box-shadow: inset 0px 1px 2px 0px rgba(0, 0, 0, 0.1);", "filter: blur(4px);", "backdrop-filter: blur(10px);"]));
    expect(l.join("\n")).not.toContain("9px");
  });

  it("换行布局的 gap 顺序：横向 = 换行间距 主轴间距，纵向反过来；相同时写一个", () => {
    const h = lines(d, "hwrap");
    expect(h).toEqual(expect.arrayContaining(["flex-wrap: wrap;", "gap: 8px 16px;", "justify-content: space-between;", "align-content: flex-start;"]));
    expect(lines(d, "vwrap")).toContain("gap: 16px 8px;");
    expect(lines(d, "same")).toContain("gap: 8px;");
  });

  it("矢量只给尺寸与定位，并建议导出 SVG", () => {
    const l = lines(d, "tri");
    expect(l).toEqual(expect.arrayContaining(["width: 30px;", "height: 20px;"]));
    expect(l.some((x) => x.includes("SVG"))).toBe(true);
    expect(l.join("\n")).not.toMatch(/background|outline|border/);
  });

  it("图片不写背景、给 object-fit 提示；椭圆 50%；半透明色 rgba()", () => {
    const pic = lines(d, "pic");
    expect(pic.some((x) => x.startsWith("background"))).toBe(false);
    expect(pic.some((x) => x.includes("object-fit"))).toBe(true);
    expect(lines(d, "ov")).toEqual(expect.arrayContaining(["background: rgba(255, 0, 0, 0.5);", "border-radius: 50%;"]));
  });

  it("CSS 变量名：/ 与非法字符换成 -，转小写", () => {
    expect(cssVarName("color/brand/primary")).toBe("--color-brand-primary");
    expect(cssVarName("font/size/Body L")).toBe("--font-size-body-l");
    expect(cssVarName("a.b_c-d")).toBe("--a-b_c-d");
    expect(cssVarName("color/规范色/中性色/#000000")).toBe("--color-规范色-中性色-000000");
    expect(cssVarName("//")).toBe("--token");
    expect(cssVarName("space/-4")).toBe("--space--4");
    expect(cssVarName("space/-4")).not.toBe(cssVarName("space/4"));
    expect(cssVarName("สี/หลัก")).toBe("--สี-หลัก");
  });

  it("text 以图层名注释开头，注释里的 */ 与换行被处理掉", () => {
    const d2 = doc([n("pg", "page", null, ["x"]), n("x", "rect", "pg", [], { name: "a */ b\nc" })]);
    const out = css(d2, "x");
    expect(out.text.split("\n")[0]).toBe("/* a * / b c */");
    expect(out.text).toBe(`/* a * / b c */\n${out.sections.flatMap((s) => s.lines).join("\n")}`);
  });

  it("单位由调用方决定（rem 示例）", () => {
    const rem: CssOptions = { len: (v, o) => (o?.text ? `${v / 16}rem` : `${v}px`), tokenVars: false };
    const d2 = doc([n("pg", "page", null, ["t"]), n("t", "text", "pg", [], { style: { fontSize: 32 } })]);
    expect(lines(d2, "t", rem)).toEqual(expect.arrayContaining(["font-size: 2rem;", "line-height: 2.8rem;"]));
  });
});

describe("高亮", () => {
  it("用户内容（注释里的 <script>）被转义", () => {
    const html = highlightCss('/* <script>alert("x")</script> */\nwidth: 10px;');
    expect(html).not.toContain("<script>");
    expect(html).toContain('<span class="c-comment">/* &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; */</span>');
  });

  it("属性、数字、函数、关键字、标点分别着色；去掉标签后与原文一致", () => {
    const code = 'background: var(--color-brand, #2F5CFF);\noutline-offset: -1px; /* 居中描边 */\nfont-family: "PingFang SC";\nwidth: 10px & <b>';
    const html = highlightCss(code);
    expect(html).toContain('<span class="c-prop">background</span><span class="c-punct">:</span>');
    expect(html).toContain('<span class="c-func">var</span>');
    expect(html).toContain('<span class="c-num">#2F5CFF</span>');
    expect(html).toContain('<span class="c-num">-1px</span>');
    expect(html).toContain('<span class="c-value">--color-brand</span>');
    expect(html).toContain('<span class="c-value">&quot;PingFang SC&quot;</span>');
    expect(html).toContain('<span class="c-comment">/* 居中描边 */</span>');
    const unescape = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    expect(unescape(html)).toBe(code);
    expect(html).not.toMatch(/<b>/);
  });

  it("escapeHtml 覆盖 & < > \" '", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});
