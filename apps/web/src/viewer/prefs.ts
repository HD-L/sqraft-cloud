/**
 * 标注设置 v2（平台单位、精度、颜色格式、各设计稿倍率、面板折叠等）：每人记在自己浏览器里。
 *
 * 读写 localStorage 的地方都包在 try/catch 里：隐私模式、配额满、Node 测试环境下读不到就用默认值，存不了就算了。
 * 解析 / 校验 / v1 迁移都是纯函数（normalizePrefs、migratePrefs、resolvePrefs），测试不依赖 localStorage。
 */
import { reactive, watch } from "vue";
import type { ColorFormat } from "./color";
import type { Platform } from "./units";

export type WebUnit = "px" | "rem";
export type Precision = 0 | 1 | 2;
export type PositionBase = "parent" | "artboard";
export type ExportFormat = "png" | "jpeg" | "webp" | "svg";

export interface InspectPrefs {
  platform: Platform;
  /** 只对 Web 生效 */
  webUnit: WebUnit;
  /** rem 基准（px），默认 16 */
  remBase: number;
  /** 小数位：2 位、1 位、取整 */
  precision: Precision;
  color: ColorFormat;
  /** 设计稿倍率，按设计稿 id 分别记；没有记录即 "auto"（按画板宽判断，见 units.autoDesignScale） */
  designScale: Record<string, number | "auto">;
  /** 面板里 X / Y 相对父级还是画板 */
  positionBase: PositionBase;
  /** 代码里绑定了 Token 的值是否写成 var(--token, 回退值) */
  tokenVars: boolean;
  /** 面板里折叠起来的分区 key */
  collapsed: string[];
  /** 切图导出默认格式 */
  exportFormat: ExportFormat;
}

/** v1 存储结构（键 "sqraft-inspect-prefs"） */
export interface InspectPrefsV1 {
  unit: "px" | "pt" | "dp";
  scale: 1 | 2 | 3;
  color: "hex" | "rgba" | "hsla";
}

export const PREFS_KEY = "sqraft-inspect-prefs-v2";
export const PREFS_KEY_V1 = "sqraft-inspect-prefs";

const PLATFORMS: readonly Platform[] = ["web", "ios", "android", "mp"];
const COLOR_FORMATS: readonly ColorFormat[] = ["hex", "hex8", "argb", "rgba", "hsla", "uicolor"];
const EXPORT_FORMATS: readonly ExportFormat[] = ["png", "jpeg", "webp", "svg"];

/** 默认设置；每次返回新对象（designScale / collapsed 不共享） */
export function defaultPrefs(): InspectPrefs {
  return {
    platform: "web",
    webUnit: "px",
    remBase: 16,
    precision: 2,
    color: "hex",
    designScale: {},
    positionBase: "artboard",
    tokenVars: true,
    collapsed: [],
    exportFormat: "png",
  };
}

function oneOf<T>(list: readonly T[], v: unknown, fallback: T): T {
  return list.includes(v as T) ? (v as T) : fallback;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function positive(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/** 把任意已解析的 v2 数据校验成完整的设置：不认识或不合法的字段取默认值 */
export function normalizePrefs(raw: unknown): InspectPrefs {
  const d = defaultPrefs();
  if (!isRecord(raw)) return d;
  const designScale: Record<string, number | "auto"> = {};
  if (isRecord(raw.designScale)) {
    for (const [id, v] of Object.entries(raw.designScale)) {
      // "auto" 与不记录等价，不存；只留有限正数
      if (positive(v)) designScale[id] = v;
    }
  }
  const collapsed = Array.isArray(raw.collapsed) ? [...new Set(raw.collapsed.filter((k): k is string => typeof k === "string"))] : [];
  return {
    platform: oneOf(PLATFORMS, raw.platform, d.platform),
    webUnit: raw.webUnit === "rem" ? "rem" : "px",
    remBase: positive(raw.remBase) ? raw.remBase : d.remBase,
    precision: raw.precision === 0 || raw.precision === 1 ? raw.precision : 2,
    color: oneOf(COLOR_FORMATS, raw.color, d.color),
    designScale,
    positionBase: raw.positionBase === "parent" ? "parent" : "artboard",
    tokenVars: typeof raw.tokenVars === "boolean" ? raw.tokenVars : d.tokenVars,
    collapsed,
    exportFormat: oneOf(EXPORT_FORMATS, raw.exportFormat, d.exportFormat),
  };
}

/**
 * v1 → v2：px → Web、pt → iOS、dp → Android；颜色格式照搬；
 * 旧的 scale（px @2x 乘法，本意是切图像素）丢弃——v2 的倍率是"设计稿倍率"，含义不同，切图倍率归导出管。
 */
export function migratePrefs(raw: unknown): InspectPrefs {
  const d = defaultPrefs();
  if (!isRecord(raw)) return d;
  const platform: Platform = raw.unit === "pt" ? "ios" : raw.unit === "dp" ? "android" : "web";
  const color: ColorFormat = raw.color === "rgba" || raw.color === "hsla" ? raw.color : "hex";
  return { ...d, platform, color };
}

function parse(json: string | null): unknown {
  if (json == null) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

/**
 * 由两个键里存的原始 JSON 得出设置：v2 有就用 v2；否则有 v1 就迁移；都没有（或解析失败）用默认值。
 * migrated 表示结果来自 v1，调用方可据此立即写回 v2。
 */
export function resolvePrefs(v2Json: string | null, v1Json: string | null): { prefs: InspectPrefs; migrated: boolean } {
  const v2 = parse(v2Json);
  if (isRecord(v2)) return { prefs: normalizePrefs(v2), migrated: false };
  const v1 = parse(v1Json);
  if (isRecord(v1)) return { prefs: migratePrefs(v1), migrated: true };
  return { prefs: defaultPrefs(), migrated: false };
}

function save(p: InspectPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // 隐私模式、配额满、非浏览器环境：存不了就算了
  }
}

function load(): InspectPrefs {
  try {
    const { prefs: p, migrated } = resolvePrefs(localStorage.getItem(PREFS_KEY), localStorage.getItem(PREFS_KEY_V1));
    // 迁移结果马上写成 v2；v1 键留着不删，回退到旧版前端时还能用
    if (migrated) save(p);
    return p;
  } catch {
    return defaultPrefs();
  }
}

export const prefs = reactive<InspectPrefs>(load());

watch(prefs, () => save(prefs), { deep: true });

/** 设某个设计稿的倍率；"auto" 即删掉记录，回到按画板宽自动判断。不合法的数字按 "auto" 处理 */
export function setDesignScale(designId: string, v: number | "auto"): void {
  if (positive(v)) prefs.designScale[designId] = v;
  else delete prefs.designScale[designId];
}

/** 折叠 / 展开面板里的某个分区 */
export function toggleCollapsed(key: string): void {
  const i = prefs.collapsed.indexOf(key);
  if (i >= 0) prefs.collapsed.splice(i, 1);
  else prefs.collapsed.push(key);
}
