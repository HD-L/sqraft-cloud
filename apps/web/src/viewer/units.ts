/**
 * 标注单位体系：设计稿倍率 + 目标平台单位 + 精度。纯函数，无 DOM 依赖。
 *
 * 换算分两步：
 * 1. 设计稿像素 → 逻辑尺寸：logical = v / 设计稿倍率（750 宽的 @2x 稿，20 → 10）；
 * 2. 逻辑尺寸 → 平台单位：Web px、iOS pt、Android dp / sp 都直接取 logical；rem = logical / 基准；
 *    小程序 rpx 按画板宽换算：rpx = v × 750 / 画板宽，和设计稿倍率无关（750 稿 1:1，375 稿 ×2）。
 *
 * 设计稿倍率按设计稿分别记在 prefs.designScale 里，默认"自动"：按画板宽猜（见 autoDesignScale）。
 */
import type { InspectPrefs } from "./prefs";

/** 目标平台；mp = 微信小程序 */
export type Platform = "web" | "ios" | "android" | "mp";

export const PLATFORM_LABEL: Record<Platform, string> = {
  web: "Web",
  ios: "iOS",
  android: "Android",
  mp: "小程序",
};

/** 一次换算所需的全部上下文：由 unitCtx 从设置 + 当前设计稿 / 画板算出，画布和面板共用 */
export interface UnitCtx {
  platform: Platform;
  /** 解析后的设计稿倍率，例如 750 宽的画板为 2 */
  scale: number;
  /** 倍率是不是按画板宽自动判断的（摘要里会注明） */
  autoScale: boolean;
  /** 当前画板宽（设计稿像素），rpx 换算和自动倍率都用它 */
  pageWidth: number;
  webUnit: "px" | "rem";
  remBase: number;
  precision: 0 | 1 | 2;
}

/** unitCtx 实际用到的设置字段；传完整的 InspectPrefs 即可 */
export type UnitPrefsInput = Pick<InspectPrefs, "platform" | "webUnit" | "remBase" | "precision" | "designScale">;

const DEFAULT_REM_BASE = 16;

/**
 * 按画板宽猜设计稿倍率：
 * - ≤ 480 → @1x（375 / 390 / 414 等 iPhone 逻辑宽、360 等 Android 宽）；
 * - 640–828 → @2x（640、750、828）；
 * - 1080–1284 → @3x（1080、1125、1170、1242、1284）；
 * - 其他（平板、桌面稿）→ @1x。
 */
export function autoDesignScale(pageWidth: number): number {
  if (!Number.isFinite(pageWidth) || pageWidth <= 480) return 1;
  if (pageWidth >= 640 && pageWidth <= 828) return 2;
  if (pageWidth >= 1080 && pageWidth <= 1284) return 3;
  return 1;
}

/** 用户设的倍率是否可用：有限正数 */
function validScale(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * 从设置算出某个设计稿、某个画板下的换算上下文。
 * designScale[designId] 是数字就用它；没有、为 "auto" 或不合法时按画板宽自动判断。
 */
export function unitCtx(p: UnitPrefsInput, designId: string, pageWidth: number): UnitCtx {
  const pref = p.designScale[designId];
  const manual = validScale(pref);
  const width = Number.isFinite(pageWidth) && pageWidth > 0 ? pageWidth : 0;
  return {
    platform: p.platform,
    scale: manual ? pref : autoDesignScale(width),
    autoScale: !manual,
    pageWidth: width,
    webUnit: p.webUnit,
    remBase: validScale(p.remBase) ? p.remBase : DEFAULT_REM_BASE,
    precision: p.precision,
  };
}

/**
 * 设计稿像素 → 平台单位下的数值（未取整）。
 * opts.text：字号、行高、字距这类文字尺寸。目前只影响 Android 的单位名（dp → sp），数值相同；
 * 参数保留下来，调用方统一传，以后要区分（比如按系统字号缩放）时不用改调用处。
 */
export function lenValue(v: number, ctx: UnitCtx, opts?: { text?: boolean }): number {
  if (ctx.platform === "mp") {
    // 画板宽未知时退回"逻辑宽 375 = 750rpx"，即逻辑尺寸 × 2
    return ctx.pageWidth > 0 ? (v * 750) / ctx.pageWidth : (v / ctx.scale) * 2;
  }
  const logical = v / ctx.scale;
  if (ctx.platform === "web" && ctx.webUnit === "rem") return logical / ctx.remBase;
  return logical;
}

/** 当前上下文下的单位名：px | rem | pt | dp | sp | rpx */
export function lenUnit(ctx: UnitCtx, opts?: { text?: boolean }): string {
  switch (ctx.platform) {
    case "web":
      return ctx.webUnit;
    case "ios":
      return "pt";
    case "android":
      return opts?.text ? "sp" : "dp";
    case "mp":
      return "rpx";
  }
}

/**
 * 数字 → 字符串：四舍五入到 precision 位小数，去掉末尾的 0，不会出现 "-0"。
 * 负数按绝对值四舍五入（-2.5 → "-3"，与正数对称）；非有限值输出 "0"。
 */
export function fmtNum(n: number, precision: number): string {
  if (!Number.isFinite(n)) return "0";
  const f = 10 ** precision;
  const x = Math.abs(n) * f;
  // 补一点相对误差，免得 1.005 × 100 = 100.49999… 这种二进制误差把 .5 舍掉
  const r = Math.round(x + x * 4 * Number.EPSILON);
  if (r === 0) return "0";
  return (n < 0 ? "-" : "") + String(r / f);
}

/** rem 最多保留的小数位：1px / 16 = 0.0625 需要 4 位 */
const REM_DIGITS = 4;

/**
 * 设计稿像素 → 显示文本；默认不带单位，withUnit 时拼上 lenUnit（"10pt"）。
 * rem 时精度设置作用在换算前的逻辑像素上（取整模式下 14.4px → 14px → 0.875rem），
 * 再除以基准、最多保留 4 位小数——否则 13px 在 2 位精度下会变成 0.81rem（12.96px）。
 */
export function fmtLen(v: number, ctx: UnitCtx, opts?: { text?: boolean; withUnit?: boolean }): string {
  const s =
    ctx.platform === "web" && ctx.webUnit === "rem"
      ? fmtNum(Number(fmtNum(v / ctx.scale, ctx.precision)) / ctx.remBase, REM_DIGITS)
      : fmtNum(lenValue(v, ctx, opts), ctx.precision);
  return opts?.withUnit ? s + lenUnit(ctx, opts) : s;
}

/**
 * 设置摘要一行，面板顶部显示，例如：
 * - "iOS · pt · 设计稿 @2x（自动：画板宽 750）"
 * - "Web · rem(16) · 设计稿 @1x"
 * - "小程序 · rpx · 按画板宽 750 换算"
 */
export function summary(ctx: UnitCtx): string {
  const head = PLATFORM_LABEL[ctx.platform];
  if (ctx.platform === "mp") {
    const basis = ctx.pageWidth > 0 ? `按画板宽 ${fmtNum(ctx.pageWidth, 2)} 换算` : `按设计稿 @${fmtNum(ctx.scale, 2)}x 换算`;
    return `${head} · rpx · ${basis}`;
  }
  const unit =
    ctx.platform === "web" ? (ctx.webUnit === "rem" ? `rem(${fmtNum(ctx.remBase, 2)})` : "px") : ctx.platform === "ios" ? "pt" : "dp/sp";
  const scale = `设计稿 @${fmtNum(ctx.scale, 2)}x`;
  const auto = ctx.autoScale ? (ctx.pageWidth > 0 ? `（自动：画板宽 ${fmtNum(ctx.pageWidth, 2)}）` : "（自动）") : "";
  return `${head} · ${unit} · ${scale}${auto}`;
}
