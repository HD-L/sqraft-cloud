import { describe, expect, it } from "vitest";
import {
  alphaPercent,
  COLOR_FORMATS,
  colorKey,
  cssColor,
  defaultFormatFor,
  formatColor,
  matchTokens,
  nextFormat,
  parseColor,
  tokenIndex,
  type Color,
  type ColorFormat,
} from "../src/viewer/color";

const rgb = (r: number, g: number, b: number, a = 1): Color => ({ r, g, b, a });

describe("parseColor：hex", () => {
  it("#rgb / #rgba / #rrggbb / #rrggbbaa，大小写与首尾空格", () => {
    expect(parseColor("#2f5cff")).toEqual(rgb(47, 92, 255));
    expect(parseColor("  #2F5CFF ")).toEqual(rgb(47, 92, 255));
    expect(parseColor("#abc")).toEqual(rgb(170, 187, 204));
    expect(parseColor("#abcd")).toEqual(rgb(170, 187, 204, 0xdd / 255));
    expect(parseColor("#2f5cff80")).toEqual(rgb(47, 92, 255, 128 / 255));
    expect(parseColor("#00000000")).toEqual(rgb(0, 0, 0, 0));
  });

  it("不合法的输入返回 null", () => {
    for (const s of [undefined, "", "   ", "#12", "#12345", "#1234567", "#ggg", "2f5cff"]) {
      expect(parseColor(s)).toBeNull();
    }
  });
});

describe("parseColor：rgb() / rgba()", () => {
  it("逗号写法", () => {
    expect(parseColor("rgb(47, 92, 255)")).toEqual(rgb(47, 92, 255));
    expect(parseColor("rgba(47,92,255,0.5)")).toEqual(rgb(47, 92, 255, 0.5));
    expect(parseColor("RGBA(47, 92, 255, .25)")).toEqual(rgb(47, 92, 255, 0.25));
    // rgb() 也可以带第四个分量
    expect(parseColor("rgb(47, 92, 255, 0.5)")).toEqual(rgb(47, 92, 255, 0.5));
  });

  it("空格写法与斜杠 alpha，以及混用", () => {
    expect(parseColor("rgb(47 92 255)")).toEqual(rgb(47, 92, 255));
    expect(parseColor("rgb(47 92 255 / 50%)")).toEqual(rgb(47, 92, 255, 0.5));
    expect(parseColor("rgba(47 92 255/0.5)")).toEqual(rgb(47, 92, 255, 0.5));
    // Token 校验允许的混用写法
    expect(parseColor("rgba(1 2 3, 0.5)")).toEqual(rgb(1, 2, 3, 0.5));
  });

  it("百分比通道四舍五入，alpha 百分比", () => {
    expect(parseColor("rgb(100%, 50%, 0%)")).toEqual(rgb(255, 128, 0));
    expect(parseColor("rgba(47, 92, 255, 50%)")).toEqual(rgb(47, 92, 255, 0.5));
    expect(parseColor("rgb(47.4, 92.5, 254.6)")).toEqual(rgb(47, 93, 255));
  });

  it("越界夹取", () => {
    expect(parseColor("rgb(300, -5, 0)")).toEqual(rgb(255, 0, 0));
    expect(parseColor("rgba(0, 0, 0, 2)")).toEqual(rgb(0, 0, 0, 1));
    expect(parseColor("rgba(0, 0, 0, -1)")).toEqual(rgb(0, 0, 0, 0));
  });

  it("不合法", () => {
    for (const s of ["rgb(1, 2)", "rgb(1, 2, 3, 4, 5)", "rgb(a, b, c)", "rgb(1 2 / 3)", "rgb(1 2 3 / 4 / 5)", "rgb(1, 2, 3", "rgb()"]) {
      expect(parseColor(s)).toBeNull();
    }
  });
});

describe("parseColor：hsl() / hsla()", () => {
  it("逗号写法", () => {
    expect(parseColor("hsl(227, 100%, 59%)")).toEqual(rgb(46, 91, 255));
    expect(parseColor("hsla(0, 0%, 50%, 0.5)")).toEqual(rgb(128, 128, 128, 0.5));
    expect(parseColor("hsl(0, 100%, 50%)")).toEqual(rgb(255, 0, 0));
    expect(parseColor("hsl(0, 0%, 100%)")).toEqual(rgb(255, 255, 255));
  });

  it("空格写法、色相单位、色相归一", () => {
    expect(parseColor("hsl(120deg 100% 50% / 25%)")).toEqual(rgb(0, 255, 0, 0.25));
    expect(parseColor("hsl(0.5turn, 100%, 50%)")).toEqual(rgb(0, 255, 255));
    expect(parseColor(`hsl(${Math.PI}rad 100% 50%)`)).toEqual(rgb(0, 255, 255));
    expect(parseColor("hsl(200grad, 100%, 50%)")).toEqual(rgb(0, 255, 255));
    expect(parseColor("hsl(-120, 100%, 50%)")).toEqual(rgb(0, 0, 255));
    expect(parseColor("hsl(480, 100%, 50%)")).toEqual(rgb(0, 255, 0));
    // 新语法允许裸数字的饱和度 / 亮度
    expect(parseColor("hsl(240 100 50)")).toEqual(rgb(0, 0, 255));
  });

  it("不合法", () => {
    for (const s of ["hsl(1, 2%)", "hsl(1px, 2%, 3%)", "hsl(x, 2%, 3%)"]) {
      expect(parseColor(s)).toBeNull();
    }
  });
});

describe("parseColor：关键字", () => {
  it("transparent 不依赖 DOM", () => {
    expect(parseColor("transparent")).toEqual(rgb(0, 0, 0, 0));
  });
  it("Node 环境下命名色解析不了（浏览器里由 canvas 兜底）", () => {
    expect(parseColor("red")).toBeNull();
    expect(parseColor("not-a-color")).toBeNull();
  });
});

describe("formatColor", () => {
  const half = parseColor("#2f5cff80")!;
  const solid = parseColor("#2f5cff")!;

  it("半透明：每种格式", () => {
    expect(formatColor(half, "hex")).toBe("#2F5CFF");
    expect(formatColor(half, "hex8")).toBe("#2F5CFF80");
    expect(formatColor(half, "argb")).toBe("#802F5CFF");
    expect(formatColor(half, "rgba")).toBe("rgba(47, 92, 255, 0.5)");
    expect(formatColor(half, "hsla")).toBe("hsla(227, 100%, 59%, 0.5)");
    expect(formatColor(half, "uicolor")).toBe("UIColor(red: 0.184, green: 0.361, blue: 1.000, alpha: 0.50)");
  });

  it("不透明：rgba / hsla 退回 rgb / hsl，8 位格式带 FF", () => {
    expect(formatColor(solid, "hex")).toBe("#2F5CFF");
    expect(formatColor(solid, "hex8")).toBe("#2F5CFFFF");
    expect(formatColor(solid, "argb")).toBe("#FF2F5CFF");
    expect(formatColor(solid, "rgba")).toBe("rgb(47, 92, 255)");
    expect(formatColor(solid, "hsla")).toBe("hsl(227, 100%, 59%)");
    expect(formatColor(solid, "uicolor")).toBe("UIColor(red: 0.184, green: 0.361, blue: 1.000, alpha: 1.00)");
  });

  it("HSL 取整边界", () => {
    expect(formatColor(parseColor("#808080")!, "hsla")).toBe("hsl(0, 0%, 50%)");
    expect(formatColor(parseColor("#000")!, "hsla")).toBe("hsl(0, 0%, 0%)");
    expect(formatColor(parseColor("#fff")!, "hsla")).toBe("hsl(0, 0%, 100%)");
    // 359.76° 四舍五入后绕回 0
    expect(formatColor(rgb(255, 0, 1), "hsla")).toBe("hsl(0, 100%, 50%)");
    expect(formatColor(rgb(0, 255, 0), "hsla")).toBe("hsl(120, 100%, 50%)");
    expect(formatColor(rgb(0, 0, 255, 0.25), "hsla")).toBe("hsla(240, 100%, 50%, 0.25)");
  });

  it("通道用 Math.round 而不是截断，越界夹取", () => {
    const c = rgb(127.5, 0.4, 254.6);
    expect(formatColor(c, "hex")).toBe("#8000FF");
    expect(formatColor(c, "rgba")).toBe("rgb(128, 0, 255)");
    expect(formatColor(rgb(300, -4, 15.5), "hex")).toBe("#FF0010");
    // alpha 0.5 → 127.5 → 0x80（截断会得到 7F）
    expect(formatColor(rgb(0, 0, 0, 0.5), "hex8")).toBe("#00000080");
    expect(formatColor(rgb(0, 0, 0, 0.5), "argb")).toBe("#80000000");
  });

  it("UIColor 精度：分量 3 位，alpha 2 位（必要时 3 位）", () => {
    expect(formatColor(rgb(1, 128, 254), "uicolor")).toBe("UIColor(red: 0.004, green: 0.502, blue: 0.996, alpha: 1.00)");
    expect(formatColor(rgb(0, 0, 0, 0), "uicolor")).toBe("UIColor(red: 0.000, green: 0.000, blue: 0.000, alpha: 0.00)");
    expect(formatColor(rgb(0, 0, 0, 0.07), "uicolor")).toBe("UIColor(red: 0.000, green: 0.000, blue: 0.000, alpha: 0.07)");
    expect(formatColor(rgb(0, 0, 0, 1 / 255), "uicolor")).toBe("UIColor(red: 0.000, green: 0.000, blue: 0.000, alpha: 0.004)");
  });

  it("alpha 以 8 位为准：显示值回读后是同一档", () => {
    expect(formatColor(rgb(0, 0, 0, 1 / 255), "rgba")).toBe("rgba(0, 0, 0, 0.004)");
    expect(formatColor(rgb(0, 0, 0, 0x40 / 255), "rgba")).toBe("rgba(0, 0, 0, 0.25)");
    expect(formatColor(rgb(0, 0, 0, 0.123), "rgba")).toBe("rgba(0, 0, 0, 0.12)");
    expect(formatColor(rgb(0, 0, 0, 0.998), "rgba")).toBe("rgba(0, 0, 0, 0.998)");
    // 0.999 已经是 0xFF，按不透明处理
    expect(formatColor(rgb(0, 0, 0, 0.999), "rgba")).toBe("rgb(0, 0, 0)");
    for (let q = 0; q <= 255; q++) {
      const out = formatColor(rgb(10, 20, 30, q / 255), "rgba");
      const back = parseColor(out)!;
      expect(Math.round(back.a * 255)).toBe(q);
    }
  });

  it("无损格式（HEX8 / RGBA）读回后是同一个颜色（8 位精度）", () => {
    const formats: ColorFormat[] = ["hex8", "rgba"];
    for (const f of formats) expect(colorKey(parseColor(formatColor(half, f))!)).toBe(colorKey(half));
    expect(parseColor(formatColor(half, "hex"))).toEqual(solid);
  });
});

describe("cssColor / alphaPercent", () => {
  it("cssColor：不透明 #RRGGBB，半透明 rgba()", () => {
    expect(cssColor(parseColor("#2f5cff")!)).toBe("#2F5CFF");
    expect(cssColor(parseColor("#2f5cff80")!)).toBe("rgba(47, 92, 255, 0.5)");
    expect(cssColor(rgb(0, 0, 0, 0))).toBe("rgba(0, 0, 0, 0)");
  });

  it("alphaPercent 去掉多余的 0", () => {
    expect(alphaPercent(parseColor("#2f5cff80")!)).toBe("50");
    expect(alphaPercent(parseColor("#2f5cff")!)).toBe("100");
    expect(alphaPercent(rgb(0, 0, 0, 0))).toBe("0");
    expect(alphaPercent(rgb(0, 0, 0, 0.07))).toBe("7");
    expect(alphaPercent(rgb(0, 0, 0, 1 / 255))).toBe("0.4");
    expect(alphaPercent(rgb(0, 0, 0, 0.255))).toBe("25.5");
  });
});

describe("格式列表与切换", () => {
  it("COLOR_FORMATS 顺序与标签", () => {
    expect(COLOR_FORMATS).toEqual([
      { id: "hex", label: "HEX" },
      { id: "hex8", label: "HEX8 (#RRGGBBAA)" },
      { id: "argb", label: "ARGB (Android)" },
      { id: "rgba", label: "RGBA" },
      { id: "hsla", label: "HSLA" },
      { id: "uicolor", label: "UIColor (iOS)" },
    ]);
  });

  it("nextFormat 循环一圈回到起点", () => {
    const seen: ColorFormat[] = [];
    let f: ColorFormat = "hex";
    for (let i = 0; i < COLOR_FORMATS.length; i++) {
      seen.push(f);
      f = nextFormat(f);
    }
    expect(seen).toEqual(["hex", "hex8", "argb", "rgba", "hsla", "uicolor"]);
    expect(f).toBe("hex");
    expect(nextFormat("uicolor")).toBe("hex");
  });

  it("defaultFormatFor 跟平台走", () => {
    expect(defaultFormatFor("android")).toBe("argb");
    expect(defaultFormatFor("ios")).toBe("uicolor");
    expect(defaultFormatFor("web")).toBe("hex");
    expect(defaultFormatFor("mp")).toBe("hex");
  });
});

describe("Token 反查", () => {
  it("colorKey：8 位精度下相同的颜色键相同", () => {
    expect(colorKey(parseColor("#2f5cff80")!)).toBe("47,92,255,0.5");
    expect(colorKey(parseColor("rgba(47, 92, 255, 0.5)")!)).toBe("47,92,255,0.5");
    expect(colorKey(parseColor("#2f5cff")!)).toBe("47,92,255,1");
    expect(colorKey(rgb(47.4, 91.6, 255, 0.502))).toBe("47,92,255,0.5");
    expect(colorKey(rgb(0, 0, 0, 1 / 255))).toBe("0,0,0,0.004");
    // 同一档的不同写法键一致
    expect(colorKey(rgb(0, 0, 0, 0.1196))).toBe(colorKey(rgb(0, 0, 0, 30 / 255)));
  });

  const tokens = {
    "color/brand": { type: "color", value: "#2F5CFF" },
    "color/primary": { type: "color", value: "rgb(47, 92, 255)" },
    "color/brand-50": { type: "color", value: "#2f5cff80" },
    "color/overlay": { type: "color", value: "rgba(0, 0, 0, 0.4)" },
    "color/broken": { type: "color", value: "not a color" },
    "space/md": { type: "number", value: 12 },
    "weird/number-as-hex": { type: "number", value: "#2F5CFF" },
  };

  it("tokenIndex 只收颜色 Token，按键分组、路径排序，跳过解析不了的", () => {
    const index = tokenIndex(tokens);
    expect(index.get("47,92,255,1")).toEqual(["color/brand", "color/primary"]);
    expect(index.get("47,92,255,0.5")).toEqual(["color/brand-50"]);
    expect(index.get("0,0,0,0.4")).toEqual(["color/overlay"]);
    expect(index.size).toBe(3);
    expect(tokenIndex({}).size).toBe(0);
  });

  it("matchTokens 区分透明度，没有匹配返回空数组", () => {
    const index = tokenIndex(tokens);
    expect(matchTokens(index, parseColor("#2F5CFF")!)).toEqual(["color/brand", "color/primary"]);
    expect(matchTokens(index, parseColor("rgba(47, 92, 255, 0.5)")!)).toEqual(["color/brand-50"]);
    expect(matchTokens(index, parseColor("#00000066")!)).toEqual(["color/overlay"]);
    expect(matchTokens(index, parseColor("rgba(47, 92, 255, 0.3)")!)).toEqual([]);
    expect(matchTokens(index, parseColor("#2F5CFE")!)).toEqual([]);
    // 返回副本，改了不影响反查表
    matchTokens(index, parseColor("#2F5CFF")!).push("x");
    expect(matchTokens(index, parseColor("#2F5CFF")!)).toEqual(["color/brand", "color/primary"]);
  });
});
