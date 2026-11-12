/**
 * 颜色：解析、多格式输出、Token 反查。纯函数，除命名色兜底外不依赖 DOM。
 *
 * 精度约定：设计稿里的颜色最终都是 8 位通道，所以这里一律以 8 位为准——
 * r/g/b 解析时就取整到 0–255；alpha 显示时挑最短的、回读后仍落在同一个 0–255 档的小数
 * （优先 2 位，不够再 3 位）。这样 #2F5CFF80 显示为 0.5 / 50%，而不是 0.502 / 50.2%，
 * 同时任何显示出来的值复制回去都还是同一个颜色。Token 反查的键也按 8 位档比较。
 */

export type ColorFormat = "hex" | "hex8" | "argb" | "rgba" | "hsla" | "uicolor";

/** r/g/b 为 0–255，a 为 0–1 */
export interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** 点色块时按这个顺序循环 */
export const COLOR_FORMATS: Array<{ id: ColorFormat; label: string }> = [
  { id: "hex", label: "HEX" },
  { id: "hex8", label: "HEX8 (#RRGGBBAA)" },
  { id: "argb", label: "ARGB (Android)" },
  { id: "rgba", label: "RGBA" },
  { id: "hsla", label: "HSLA" },
  { id: "uicolor", label: "UIColor (iOS)" },
];

// ── 解析 ──

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** CSS <number>，可带 %；不合法返回 null */
const NUM = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%?)$/i;

/** 通道值：数字按 0–255，百分比按 0–100% 映射到 0–255 */
function channel(s: string): number | null {
  if (s.toLowerCase() === "none") return 0;
  const m = NUM.exec(s);
  if (!m) return null;
  const v = Number(m[1]);
  return Math.round(clamp(m[2] ? (v / 100) * 255 : v, 0, 255));
}

/** 透明度：数字按 0–1，百分比按 0–100% */
function alphaOf(s: string | undefined): number | null {
  if (s === undefined) return 1;
  if (s.toLowerCase() === "none") return 0;
  const m = NUM.exec(s);
  if (!m) return null;
  const v = Number(m[1]);
  return clamp(m[2] ? v / 100 : v, 0, 1);
}

/** 色相：默认 deg，支持 deg / rad / grad / turn，归一到 [0, 360) */
function hueOf(s: string): number | null {
  if (s.toLowerCase() === "none") return 0;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|rad|grad|turn)?$/i.exec(s);
  if (!m) return null;
  const v = Number(m[1]);
  const unit = (m[2] ?? "deg").toLowerCase();
  const deg = unit === "rad" ? (v * 180) / Math.PI : unit === "grad" ? v * 0.9 : unit === "turn" ? v * 360 : v;
  return ((deg % 360) + 360) % 360;
}

/** 饱和度 / 亮度：百分比或裸数字（CSS Color 4 新语法允许裸数字，含义同 %），返回 0–1 */
function percentOf(s: string): number | null {
  if (s.toLowerCase() === "none") return 0;
  const m = NUM.exec(s);
  if (!m) return null;
  return clamp(Number(m[1]) / 100, 0, 1);
}

/**
 * 函数式颜色的参数：兼容逗号写法 `47, 92, 255, 0.5` 与空格写法 `47 92 255 / 50%`，
 * 也容忍两者混用（Token 校验允许 `rgba(1 2 3, 0.5)` 这种）。返回 [三个分量, alpha?]。
 */
function splitArgs(body: string): [string[], string | undefined] | null {
  const slash = body.split("/");
  if (slash.length > 2) return null;
  const main = slash[0].split(/[\s,]+/).filter(Boolean);
  if (slash.length === 2) {
    const alpha = slash[1].replace(/,/g, " ").trim();
    if (main.length !== 3 || !alpha || /\s/.test(alpha)) return null;
    return [main, alpha];
  }
  if (main.length === 3) return [main, undefined];
  if (main.length === 4) return [main.slice(0, 3), main[3]];
  return null;
}

/** HSL（h 为度，s/l 为 0–1）→ 0–255 的 rgb（未取整） */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** 不碰 DOM 的解析：#hex、rgb()/rgba()、hsl()/hsla()、transparent */
function parsePure(input: string): Color | null {
  const s = input.trim();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  if (s.toLowerCase() === "transparent") return { r: 0, g: 0, b: 0, a: 0 };

  const fn = /^(rgba?|hsla?)\(([^()]*)\)$/i.exec(s);
  if (!fn) return null;
  const args = splitArgs(fn[2]);
  if (!args) return null;
  const [[x, y, z], alphaStr] = args;
  const a = alphaOf(alphaStr);
  if (a === null) return null;

  if (fn[1].toLowerCase().startsWith("rgb")) {
    const r = channel(x);
    const g = channel(y);
    const b = channel(z);
    if (r === null || g === null || b === null) return null;
    return { r, g, b, a };
  }
  const h = hueOf(x);
  const sat = percentOf(y);
  const light = percentOf(z);
  if (h === null || sat === null || light === null) return null;
  const [r, g, b] = hslToRgb(h, sat, light);
  return { r: Math.round(r), g: Math.round(g), b: Math.round(b), a };
}

let colorCtx: CanvasRenderingContext2D | null | undefined;

/**
 * 浏览器兜底：命名色、hwb() 等交给 canvas 规范化成 #rrggbb / rgba() 再解析。
 * 用两个不同的哨兵色判断是否被接受（不合法的值不会改写 fillStyle）。Node / 测试环境直接返回 null。
 */
function parseViaCanvas(input: string): Color | null {
  if (typeof document === "undefined") return null;
  try {
    if (colorCtx === undefined) colorCtx = document.createElement("canvas").getContext("2d");
    if (!colorCtx) return null;
    colorCtx.fillStyle = "#000000";
    colorCtx.fillStyle = input;
    const a = String(colorCtx.fillStyle);
    colorCtx.fillStyle = "#ffffff";
    colorCtx.fillStyle = input;
    const b = String(colorCtx.fillStyle);
    if (a !== b) return null;
    return parsePure(a);
  } catch {
    return null;
  }
}

/**
 * 解析 CSS 颜色：#rgb / #rgba / #rrggbb / #rrggbbaa、rgb()/rgba()（含百分比与空格写法）、
 * hsl()/hsla()；浏览器里再兜底命名色等。解析不了返回 null。r/g/b 取整到 0–255。
 */
/** 只用纯解析（hex / rgb() / hsl() 等），不借助 DOM；解析不了返回 null */
export function parsePureColor(input: string): Color | null {
  return parsePure(input.trim());
}

export function parseColor(input: string | undefined): Color | null {
  if (!input || !input.trim()) return null;
  return parsePure(input) ?? parseViaCanvas(input.trim());
}

// ── 输出 ──

/** 通道取整夹到 0–255 */
const byte = (n: number) => Math.round(clamp(n, 0, 255));
const alphaByte = (a: number) => Math.round(clamp(a, 0, 1) * 255);
const hex2 = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
/** 去掉末尾多余的 0（顺带把 -0 变成 0） */
const trim = (n: number, digits: number) => String(Number(n.toFixed(digits)));

/**
 * 8 位精度下的 alpha 显示值：优先取 2 位小数，回读会落到别的 0–255 档时用 3 位，
 * 还不行（原值恰在两档交界附近）就用该档中心值的 3 位小数——3 位总能回到同一档。
 */
function alphaValue(a: number): number {
  const q = alphaByte(a);
  for (const k of [100, 1000]) {
    const v = Math.round(clamp(a, 0, 1) * k) / k;
    if (alphaByte(v) === q) return v;
  }
  return Math.round((q / 255) * 1000) / 1000;
}

const isOpaque = (c: Color) => alphaByte(c.a) === 255;

function rgbHex(c: Color): string {
  return `${hex2(byte(c.r))}${hex2(byte(c.g))}${hex2(byte(c.b))}`;
}

/** 取整后的 rgb → HSL（h 0–359 度，s/l 0–100 整数百分比） */
function toHsl(c: Color): [number, number, number] {
  const r = byte(c.r) / 255;
  const g = byte(c.g) / 255;
  const b = byte(c.b) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  // 359.6° 这类四舍五入到 360 的要绕回 0
  return [Math.round(h) % 360, Math.round(s * 100), Math.round(l * 100)];
}

/**
 * 按格式输出颜色文本。
 * - hex：`#2F5CFF`（透明度由调用方另行显示，见 alphaPercent）
 * - hex8：`#2F5CFF80`；argb：`#802F5CFF`（Android，alpha 在前）
 * - rgba / hsla：不透明时输出 rgb() / hsl()
 * - uicolor：Swift 写法，分量 3 位小数、alpha 2 位小数
 */
export function formatColor(c: Color, f: ColorFormat): string {
  const r = byte(c.r);
  const g = byte(c.g);
  const b = byte(c.b);
  const a = alphaValue(c.a);
  switch (f) {
    case "hex8":
      return `#${rgbHex(c)}${hex2(alphaByte(c.a))}`;
    case "argb":
      return `#${hex2(alphaByte(c.a))}${rgbHex(c)}`;
    case "rgba":
      return isOpaque(c) ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${trim(a, 3)})`;
    case "hsla": {
      const [h, s, l] = toHsl(c);
      const body = `${h}, ${s}%, ${l}%`;
      return isOpaque(c) ? `hsl(${body})` : `hsla(${body}, ${trim(a, 3)})`;
    }
    case "uicolor": {
      const ch = (n: number) => (n / 255).toFixed(3);
      // alpha 默认 2 位；只有 3 位才能表达的档（如 1/255）保留 3 位
      const al = Math.abs(a * 100 - Math.round(a * 100)) < 1e-9 ? a.toFixed(2) : a.toFixed(3);
      return `UIColor(red: ${ch(r)}, green: ${ch(g)}, blue: ${ch(b)}, alpha: ${al})`;
    }
    case "hex":
    default:
      return `#${rgbHex(c)}`;
  }
}

/** CSS 里用的颜色：不透明用 #RRGGBB，半透明用 rgba() */
export function cssColor(c: Color): string {
  return formatColor(c, isOpaque(c) ? "hex" : "rgba");
}

/** 透明度百分比（不带 %），去掉多余的 0：#2F5CFF80 → "50"，1/255 → "0.4" */
export function alphaPercent(c: Color): string {
  return trim(alphaValue(c.a) * 100, 1);
}

/** 下一个格式（点色块循环切换用） */
export function nextFormat(f: ColorFormat): ColorFormat {
  const i = COLOR_FORMATS.findIndex((x) => x.id === f);
  return COLOR_FORMATS[(i + 1) % COLOR_FORMATS.length].id;
}

/** 平台默认颜色格式：Android → ARGB，iOS → UIColor，其余 HEX */
export function defaultFormatFor(platform: "web" | "ios" | "android" | "mp"): ColorFormat {
  if (platform === "android") return "argb";
  if (platform === "ios") return "uicolor";
  return "hex";
}

// ── Token 反查 ──

/**
 * 颜色的规范键：8 位精度下相同的颜色键相同，如 `47,92,255,0.5`。
 * alpha 先量化到 0–255 一档再取显示值（≤3 位小数），键只取决于那一档，
 * 所以 #2F5CFF80 与 rgba(47,92,255,0.5) 能对上。
 */
export function colorKey(c: Color): string {
  return `${byte(c.r)},${byte(c.g)},${byte(c.b)},${trim(alphaValue(alphaByte(c.a) / 255), 3)}`;
}

/** 建反查表：颜色键 → 取值等于它的颜色 Token 路径（只收 color 类型，路径排序）。解析不了的值跳过。 */
export function tokenIndex(tokens: Record<string, { type: string; value: string | number }>): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const [path, entry] of Object.entries(tokens)) {
    if (entry.type !== "color") continue;
    const c = parseColor(String(entry.value));
    if (!c) continue;
    const key = colorKey(c);
    const list = index.get(key);
    if (list) list.push(path);
    else index.set(key, [path]);
  }
  for (const list of index.values()) list.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return index;
}

/** 与颜色相等（含透明度）的 Token 路径；没有返回空数组 */
export function matchTokens(index: Map<string, string[]>, c: Color): string[] {
  return [...(index.get(colorKey(c)) ?? [])];
}
