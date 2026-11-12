/**
 * 切图位图导出：把选中的图层按倍率画到离屏画布，导出 PNG / JPG / WEBP；多个文件交给 zip.ts 打包。
 *
 * - 绘制方式与总览缩略图（thumbs.ts）相同：Canvas2DBackend + drawDocument，只画选中的子树（onlyRootIds），
 *   beginFrame 会把画布清成透明，所以 PNG / WEBP 天然带透明背景；JPG 没有透明通道，最后垫一层白底；
 * - 图片先画一遍、收集还在加载的切图，等它们到齐再重画，保证导出的是完整画面；
 * - 倍率 = 目标密度 / 设计稿倍率（750 宽的 @2x 稿导出 iOS @3x：3 / 2 = 1.5 倍设计稿像素）；
 * - 文件命名规则参考 sketch-measure 的 getExportable（iOS 加 @2x/@3x 后缀、Android 分 drawable-* 目录同名）
 *   与 mastergo-offline-note 的 getFileName（空格换成 "-"）。
 *
 * 只在浏览器里用（document / canvas），不做单测；纯计算的部分（命名、尺寸）不碰 DOM。
 */
import type { DocNode, DocState, NodeStyle, Rect } from "@sqraft/core";
import { BLUR_EXTENT, EFFECT_LAYER_MAX_SIDE, effectPadding, hasVisibleEffects, maskPlan, resolveNumericStyle, resolvePaint, subtreeWorldBounds, worldQuad } from "@sqraft/core";
import { Canvas2DBackend, drawDocument, type ResolvedImage, type Viewport } from "@sqraft/render";
import { imageStore } from "./images";
import { getPageDoc } from "./pageDocs";
import type { ZipEntry } from "./zip";

export type ExportFormat = "png" | "jpeg" | "webp";
export type ExportPlatform = "web" | "ios" | "android" | "mp";

export interface ExportTarget {
  /** 界面上显示的名字：@1x / @2x / @3x、mdpi … xxxhdpi、1x / 2x */
  label: string;
  /** 相对设计稿像素的倍率（已经除过设计稿倍率） */
  scale: number;
  /** 由清洗过的基础名与扩展名拼出文件名（不含目录） */
  fileName: (base: string, ext: string) => string;
  /** 打包时放进的目录（Android 的 "drawable-xhdpi"），不带斜杠 */
  folder?: string;
}

/** 单边像素上限：再大浏览器可能建不出画布，或吃光内存 */
export const MAX_EXPORT_SIDE = 8192;

/** 文件扩展名：jpeg 用更常见的 .jpg */
export function extFor(format: ExportFormat): string {
  return format === "jpeg" ? "jpg" : format;
}

const mimeOf = (format: ExportFormat) => `image/${format}`;

const ANDROID_DENSITIES: ReadonlyArray<readonly [string, number]> = [
  ["mdpi", 1],
  ["hdpi", 1.5],
  ["xhdpi", 2],
  ["xxhdpi", 3],
  ["xxxhdpi", 4],
];

/**
 * 各平台的导出档位。designScale 是设计稿倍率（750 宽的稿子为 2），非法值按 1 处理。
 * - iOS：name.png / name@2x.png / name@3x.png；
 * - Android：drawable-mdpi … drawable-xxxhdpi 五个目录，文件同名；
 * - Web / 小程序：name.png（1x）与 name@2x.png（2x）。
 */
export function exportTargets(platform: ExportPlatform, designScale: number): ExportTarget[] {
  const ds = Number.isFinite(designScale) && designScale > 0 ? designScale : 1;
  const suffixed = (n: number, label: string): ExportTarget => ({
    label,
    scale: n / ds,
    fileName: (base, ext) => `${base}${n === 1 ? "" : `@${n}x`}.${ext}`,
  });
  switch (platform) {
    case "ios":
      return [1, 2, 3].map((n) => suffixed(n, `@${n}x`));
    case "android":
      return ANDROID_DENSITIES.map(([name, density]) => ({
        label: name,
        scale: density / ds,
        folder: `drawable-${name}`,
        fileName: (base, ext) => `${base}.${ext}`,
      }));
    default:
      return [1, 2].map((n) => suffixed(n, `${n}x`));
  }
}

/** 档位在包内的完整路径：有目录时为 "drawable-xhdpi/name.png" */
export function targetPath(target: ExportTarget, base: string, ext: string): string {
  const file = target.fileName(base, ext);
  return target.folder ? `${target.folder}/${file}` : file;
}

/** Windows 保留设备名：带不带扩展名都不能用作文件名 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** Java 关键字：Android 资源名会变成 R.drawable.xxx 字段，撞上关键字编译不过 */
const JAVA_KEYWORDS = new Set(
  (
    "abstract assert boolean break byte case catch char class const continue default do double else enum extends false final " +
    "finally float for goto if implements import instanceof int interface long native new null package private protected public " +
    "return short static strictfp super switch synchronized this throw throws transient true try void volatile while"
  ).split(" "),
);
/** 基础名最多保留的字符数：留出 "@3x.webp" 的位置，也不超过常见文件系统 255 字节的限制 */
const MAX_NAME_CHARS = 60;
const FALLBACK_NAME = "image";

/**
 * 图层名 → 安全的文件基础名（不含扩展名）。
 * - 空白、"/"、"\" 换成 "-"（"图标/返回" → "图标-返回"），去掉文件名里不允许的字符与控制字符，
 *   去掉首尾的 "-" 与 "."（避免隐藏文件和 Windows 末尾点），连续的 "-" 合并；
 * - Android：转小写，只保留 [a-z0-9_]，其他字符换成 "_"；不能以数字开头（补 "img_"），不能是 Java 关键字；
 * - 清洗后为空（例如 Android 下的纯中文名）时用 "image"，重名由调用方去重。
 */
export function safeFileName(name: string, platform: ExportPlatform): string {
  let s = name
    .normalize("NFC")
    .replace(/[\s/\\]+/g, "-")
    .replace(/[:*?"<>|\u0000-\u001f\u007f]/g, "")
    .replace(/-{2,}/g, "-");
  if (platform === "android") {
    s = s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "") // 去掉重音符号：Café → cafe
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .replace(/_{2,}/g, "_");
  }
  s = Array.from(s).slice(0, MAX_NAME_CHARS).join("");
  s = s.replace(/^[-._]+|[-._]+$/g, "");
  if (!s) s = FALLBACK_NAME;
  if (platform === "android") {
    if (/^[0-9]/.test(s)) s = `img_${s}`;
    if (JAVA_KEYWORDS.has(s)) s = `${s}_img`;
  }
  if (WINDOWS_RESERVED.test(s)) s = `${s}_`;
  return s;
}

/** 描边居中：外扩半个线宽。直线没有描边时渲染器按黑色 1px 画；图片节点渲染器不画描边。 */
function strokeOutset(doc: DocState, type: DocNode["type"], style: NodeStyle): number {
  if (type === "image") return 0;
  if (type === "line") return (style.strokeWidth ?? 1) / 2;
  return resolvePaint(doc, style.stroke) ? Math.max(0, style.strokeWidth ?? 1) / 2 : 0;
}

/** 世界坐标里的外接框（min / max 形式，便于求并与求交） */
interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
function unionBox(a: Box | null, b: Box | null): Box | null {
  if (!a) return b;
  if (!b) return a;
  return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
}
function intersectBox(a: Box | null, b: Box | null): Box | null {
  if (!a || !b) return null;
  const r = { minX: Math.max(a.minX, b.minX), minY: Math.max(a.minY, b.minY), maxX: Math.min(a.maxX, b.maxX), maxY: Math.min(a.maxY, b.maxY) };
  return r.minX < r.maxX && r.minY < r.maxY ? r : null;
}
function quadBox(quad: ReadonlyArray<{ x: number; y: number }>, pad: number): Box {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  return { minX: Math.min(...xs) - pad, minY: Math.min(...ys) - pad, maxX: Math.max(...xs) + pad, maxY: Math.max(...ys) + pad };
}

/**
 * 效果作用后的范围，与渲染器（canvas2d 的 composeEffects）一致：效果按顺序施加，后一条作用在前一条的结果上——
 * - 投影：取当前结果的轮廓，按偏移往一侧挪（屏幕坐标轴，与旋转无关），再按模糊与扩展外扩，和当前结果求并。
 *   多层投影因此逐层累加（第二层投的是「内容 + 第一层投影」）；
 * - 图层模糊：模糊后被节点自身形状裁住（连同排在它前面的投影），所以范围 = 外扩模糊半径后与形状求交；
 * - 内阴影、背景模糊只作用在形状内部，不改变范围。
 * 模糊外扩取渲染器离屏层用的 BLUR_EXTENT 倍半径，保证导出不截掉渲染出来的阴影。
 */
function applyEffects(box: Box, effects: ReturnType<typeof resolveNumericStyle>["effects"], shape: Box | null): Box {
  let out = box;
  for (const e of effects ?? []) {
    if (!e.visible) continue;
    if (e.type === "drop-shadow") {
      const grow = Math.max(0, e.blur ?? 0) * BLUR_EXTENT + (e.spread ?? 0);
      const dx = e.x ?? 0;
      const dy = e.y ?? 0;
      const shadow = { minX: out.minX + dx - grow, minY: out.minY + dy - grow, maxX: out.maxX + dx + grow, maxY: out.maxY + dy + grow };
      if (shadow.minX < shadow.maxX && shadow.minY < shadow.maxY) out = unionBox(out, shadow)!;
    } else if (e.type === "layer-blur" && shape) {
      const r = Math.max(0, e.radius ?? 0) * BLUR_EXTENT;
      out = intersectBox({ minX: out.minX - r, minY: out.minY - r, maxX: out.maxX + r, maxY: out.maxY + r }, shape) ?? out;
    }
  }
  return out;
}

/**
 * 导出范围（世界坐标）：图层看得见的部分，含效果与半个描边宽。
 * - 画板（page）就是画板自身的矩形，溢出画板的内容不导出（与 Sketch 导出画板一致）；
 * - 自下而上算：自身形状（编组本身不画东西）∪ 子图层范围，再施加自身的效果（效果作用在整棵子树合成后的结果上）；
 * - 跳过隐藏的子图层；裁切容器的子图层与容器形状求交；
 * - 蒙版按渲染器的配对规则（maskPlan）：蒙版裁掉紧随其后的一个兄弟，被遮的部分只算与蒙版形状相交的区域，
 *   蒙版本身不画；蒙版或目标隐藏时整对不画；
 * - 什么都没算到（全部隐藏等）时退回 subtreeWorldBounds。
 */
export function exportBounds(doc: DocState, nodeId: string): Rect | null {
  const root = doc.nodes[nodeId];
  if (!root) return null;
  if (root.type === "page") return { x: root.x, y: root.y, width: Math.max(1, root.width), height: Math.max(1, root.height) };

  const shapeBox = (n: DocNode, style: NodeStyle): Box | null => {
    const quad = worldQuad(doc, n.id);
    return quad ? quadBox(quad, strokeOutset(doc, n.type, style)) : null;
  };
  const visit = (id: string, isRoot: boolean): Box | null => {
    const n = doc.nodes[id];
    if (!n || (!isRoot && !n.visible)) return null;
    const style = resolveNumericStyle(doc, n.style);
    let box = n.type === "group" ? null : shapeBox(n, style);
    let kids: Box | null = null;
    for (const entry of maskPlan(n.children, (cid) => doc.nodes[cid]?.isMask === true)) {
      if (entry.kind === "plain") {
        kids = unionBox(kids, visit(entry.id, false));
        continue;
      }
      const mask = doc.nodes[entry.maskId];
      const target = doc.nodes[entry.targetId];
      if (!mask?.visible || !target?.visible) continue;
      const maskQuad = worldQuad(doc, mask.id);
      kids = unionBox(kids, intersectBox(visit(target.id, false), maskQuad ? quadBox(maskQuad, 0) : null));
    }
    const ownQuad = worldQuad(doc, n.id);
    const ownShape = ownQuad ? quadBox(ownQuad, 0) : null;
    const clips = n.clip && (n.type === "frame" || n.type === "component" || n.type === "instance");
    if (clips) kids = intersectBox(kids, ownShape);
    box = unionBox(box, kids);
    return box ? applyEffects(box, style.effects, ownShape) : null;
  };
  const box = visit(nodeId, true);
  if (!box) return subtreeWorldBounds(doc, nodeId);
  return { x: box.minX, y: box.minY, width: Math.max(1, box.maxX - box.minX), height: Math.max(1, box.maxY - box.minY) };
}

/**
 * 带效果（投影 / 模糊）的图层，渲染器会把它连同子树（其中的文字、图片）画进一个离屏层，离屏层长边超过
 * EFFECT_LAYER_MAX_SIDE 设备像素时降采样后再放大贴回——导出的高倍图里整个图层都会发糊。
 * 按实际倍率 scale 检查导出范围内有没有这样的图层。
 */
export function effectLayerLimited(doc: DocState, nodeId: string, scale: number, bounds?: Rect | null): boolean {
  const area = bounds ?? exportBounds(doc, nodeId);
  if (!area) return false;
  // 与绘制时一致：视口是导出范围外扩 effectMargin
  const m = effectMargin(doc, nodeId);
  const clip: Box = { minX: area.x - m, minY: area.y - m, maxX: area.x + area.width + m, maxY: area.y + area.height + m };
  const visit = (id: string, isRoot: boolean): boolean => {
    const n = doc.nodes[id];
    if (!n || (!isRoot && !n.visible)) return false;
    const effects = resolveNumericStyle(doc, n.style).effects;
    if (hasVisibleEffects(effects)) {
      const quad = worldQuad(doc, n.id);
      const layer = quad ? intersectBox(quadBox(quad, effectPadding(effects)), clip) : null;
      if (layer && Math.max(layer.maxX - layer.minX, layer.maxY - layer.minY) * scale > EFFECT_LAYER_MAX_SIDE) return true;
    }
    return n.children.some((c) => visit(c, false));
  };
  return visit(nodeId, true);
}

/**
 * 导出画布的像素尺寸：范围 × 倍率向上取整（扣掉浮点误差，24 × 1.5 不会变成 37）；
 * 最长边超过 MAX_EXPORT_SIDE 时等比缩小倍率。返回实际使用的倍率。
 */
export function exportSize(bounds: Pick<Rect, "width" | "height">, scale: number): { width: number; height: number; scale: number } {
  const long = Math.max(bounds.width, bounds.height);
  const s = long * scale > MAX_EXPORT_SIDE ? MAX_EXPORT_SIDE / long : scale;
  const px = (v: number) => Math.min(MAX_EXPORT_SIDE, Math.max(1, Math.ceil(v * s - 1e-6)));
  return { width: px(bounds.width), height: px(bounds.height), scale: s };
}

const formatSupport = new Map<ExportFormat, boolean>();

/** 浏览器能否编码这种格式（Safari 的 canvas 不能编码 WEBP，会悄悄退回 PNG） */
export function canExport(format: ExportFormat): boolean {
  if (format === "png") return true;
  let ok = formatSupport.get(format);
  if (ok === undefined) {
    const c = document.createElement("canvas");
    c.width = 1;
    c.height = 1;
    ok = c.toDataURL(mimeOf(format)).startsWith(`data:${mimeOf(format)}`);
    formatSupport.set(format, ok);
  }
  return ok;
}

export interface RenderNodeOptions {
  designId: string;
  version: number;
  /** 图层所在的画板（getPageDoc 只取这一页） */
  pageId: string;
  nodeId: string;
  /** 相对设计稿像素的倍率，通常取 ExportTarget.scale */
  scale: number;
  format: ExportFormat;
  /** JPG / WEBP 质量 0–1，缺省用浏览器默认值 */
  quality?: number;
  /** 取消：等图片或编码时被取消就抛出取消原因 */
  signal?: AbortSignal;
  /** false：有图片没画出来也照常出图（预览用）；缺省 true，导出时报错 */
  strict?: boolean;
}

/**
 * 绘制时导出范围四周要多画的边距（世界单位）。渲染器的效果层只在视口内取内容：视口若正好等于导出范围，
 * 范围外（出血的背景、伸出去的卡片、居中描边的外半圈）就不参与模糊和投影，导出图边缘会发虚变浅，与画布不一致。
 * 效果层能把多远的内容带进来 = 它的 effectPadding；嵌套的效果层逐层累加，取子树里各条祖先链的最大和。
 */
export function effectMargin(doc: DocState, nodeId: string): number {
  const visit = (id: string, isRoot: boolean): number => {
    const n = doc.nodes[id];
    if (!n || (!isRoot && !n.visible)) return 0;
    let kids = 0;
    for (const c of n.children) kids = Math.max(kids, visit(c, false));
    return effectPadding(resolveNumericStyle(doc, n.style).effects) + kids;
  };
  return visit(nodeId, true);
}

/** 落进导出图里的图片：用到的切图 id、链接图（只有 sourceUrl）与没有图片数据的图片图层数 */
export interface ImageUse {
  assets: Set<string>;
  linked: number;
  empty: number;
}

/**
 * 统计实际会出现在导出图里的图片：按渲染器的规则剔除隐藏图层、被裁切容器裁掉的、被蒙版遮掉的，
 * 以及完全在导出范围外的。链接图和空图片在渲染器里画成灰色占位，只有看得见的才算问题。
 */
export function imagesInOutput(doc: DocState, nodeId: string, out: Rect): ImageUse {
  const use: ImageUse = { assets: new Set(), linked: 0, empty: 0 };
  const visit = (id: string, isRoot: boolean, clip: Box) => {
    const n = doc.nodes[id];
    if (!n || (!isRoot && !n.visible)) return;
    const quad = worldQuad(doc, id);
    const shape = quad ? quadBox(quad, 0) : null;
    if (n.type === "image" && intersectBox(shape, clip)) {
      const ref = n.image;
      if (ref?.assetId) use.assets.add(ref.assetId);
      else if (ref?.sourceUrl) use.linked++;
      else use.empty++;
    }
    const clips = n.clip && (n.type === "frame" || n.type === "component" || n.type === "instance");
    const inner = clips ? intersectBox(clip, shape) : clip;
    if (!inner) return;
    for (const entry of maskPlan(n.children, (cid) => doc.nodes[cid]?.isMask === true)) {
      if (entry.kind === "plain") {
        visit(entry.id, false, inner);
        continue;
      }
      const mask = doc.nodes[entry.maskId];
      const target = doc.nodes[entry.targetId];
      if (!mask?.visible || !target?.visible) continue;
      const maskQuad = worldQuad(doc, mask.id);
      const masked = intersectBox(inner, maskQuad ? quadBox(maskQuad, 0) : null);
      if (!masked) continue;
      // 蒙版本身是图片时，渲染器取它的 alpha 来裁：图没画出来，被遮的内容几乎全被裁掉
      if (mask.type === "image") {
        if (mask.image?.assetId) use.assets.add(mask.image.assetId);
        else if (mask.image?.sourceUrl) use.linked++;
        else use.empty++;
      }
      visit(target.id, false, masked);
    }
  };
  visit(nodeId, true, { minX: out.x, minY: out.y, maxX: out.x + out.width, maxY: out.y + out.height });
  const root = doc.nodes[nodeId];
  if (root?.type === "page" && root.backgroundImage?.assetId) use.assets.add(root.backgroundImage.assetId);
  return use;
}

/** 等 promise 结束，期间被取消就立即抛出取消原因 */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** 浏览器能否真的分配这么大的画布：写一个像素再读回来（分配失败的画布读回全 0） */
function canAllocate(width: number, height: number): boolean {
  const c = document.createElement("canvas");
  try {
    c.width = width;
    c.height = height;
    const g = c.getContext("2d");
    if (!g) return false;
    g.fillRect(0, 0, 1, 1);
    return g.getImageData(0, 0, 1, 1).data[3] === 255;
  } catch {
    return false;
  } finally {
    c.width = 0;
    c.height = 0;
  }
}

/** 绘制用画布（含四周边距）的单边上限：主流浏览器能建的画布都不小于这个尺寸 */
const WORK_MAX_SIDE = 16384;

/** 已加载的页面文档上绘制并编码一个图层（renderNode 的内部实现，导出给测试用） */
export async function renderFromDoc(doc: DocState, opts: RenderNodeOptions): Promise<Blob> {
  const node = doc.nodes[opts.nodeId];
  if (!node) throw new Error("图层不存在或不在这个画板里");
  if (!(opts.scale > 0) || !Number.isFinite(opts.scale)) throw new Error("导出倍率无效");
  const bounds = exportBounds(doc, opts.nodeId);
  if (!bounds) throw new Error("图层没有可导出的内容");
  const size = exportSize(bounds, opts.scale);
  // 四周多画一圈（像素），画完再把中间的导出范围裁出来；边距受画布上限约束
  let marginPx = Math.max(0, Math.min(Math.ceil(effectMargin(doc, opts.nodeId) * size.scale), Math.floor((WORK_MAX_SIDE - Math.max(size.width, size.height)) / 2)));
  // 加了边距的画布浏览器建不出来（iOS Safari 按面积限制、内存不足）时退回不加边距：
  // 否则空画布会被当成正常内容裁出来，悄悄导出一张透明图
  if (marginPx > 0 && !canAllocate(size.width + marginPx * 2, size.height + marginPx * 2)) marginPx = 0;

  const work = document.createElement("canvas");
  const output = marginPx > 0 ? document.createElement("canvas") : work;
  try {
    const ctx = work.getContext("2d");
    if (!ctx) throw new Error("浏览器无法创建画布");
    const backend = new Canvas2DBackend(ctx);
    const images = imageStore(opts.designId, opts.version);
    // dpr = 1：视口的 CSS 像素就是画布像素；zoom 把世界坐标映射到像素，导出范围的左上角落在 (marginPx, marginPx)
    const vp: Viewport = {
      x: bounds.x - marginPx / size.scale,
      y: bounds.y - marginPx / size.scale,
      zoom: size.scale,
      width: size.width + marginPx * 2,
      height: size.height + marginPx * 2,
      dpr: 1,
    };

    // 之前失败过的图（网络抖动、登录过期等）重新请求一次，不把灰色占位画进切图
    images.retryFailed();
    const missing = new Set<string>();
    const draw = (pending: Promise<void>[]) => {
      missing.clear();
      const resolveImage = (assetId: string): ResolvedImage | null => {
        const img = images.resolve(assetId, pending);
        if (!img) missing.add(assetId);
        return img;
      };
      backend.beginFrame(vp);
      // 画板本身不画底色（底色由 drawDocument 的页面分支负责，onlyRootIds 走不到）：这里补上背景色与背景图
      if (node.type === "page") {
        ctx.fillStyle = resolvePaint(doc, node.style.fill) ?? "#ffffff";
        ctx.fillRect(node.x, node.y, node.width, node.height);
        const bg = node.backgroundImage;
        const img = bg ? resolveImage(bg.assetId) : null;
        if (bg && img) backend.drawImageInRect(img, { x: node.x, y: node.y, width: node.width, height: node.height }, bg.fit);
      }
      drawDocument(backend, doc, { onlyRootIds: [opts.nodeId], resolveImage });
      backend.endFrame();
    };

    // 先画一遍收集还在加载的切图，到齐后重画（渲染途中可能才发现新的图，所以多轮）
    let pending: Promise<void>[] = [];
    draw(pending);
    for (let pass = 0; pending.length > 0 && pass < 5; pass++) {
      await untilAborted(Promise.all(pending), opts.signal);
      pending = [];
      draw(pending);
    }
    // 导出图里看得见的图片有没画出来的（加载失败、一直没到、链接图、没有图片数据）就报错，不交出带占位图的切图；
    // 预览（strict: false）照常出图
    if (opts.strict !== false) {
      const use = imagesInOutput(doc, opts.nodeId, bounds);
      const absent = [...missing].filter((id) => use.assets.has(id));
      const failed = absent.filter((id) => images.isFailed(id)).length;
      const reasons = [
        failed ? `${failed} 张图片加载失败，请检查网络后重试` : "",
        absent.length > failed ? `${absent.length - failed} 张图片还没加载完，请稍后重试` : "",
        use.linked ? `${use.linked} 张链接图片没有随设计稿上传` : "",
        use.empty ? `${use.empty} 个图片图层没有图片数据` : "",
      ].filter(Boolean);
      if (reasons.length) throw new Error(reasons.join("；"));
    }

    let octx = ctx;
    if (output !== work) {
      output.width = size.width;
      output.height = size.height;
      const c = output.getContext("2d");
      if (!c) throw new Error("浏览器无法创建画布");
      c.drawImage(work, marginPx, marginPx, size.width, size.height, 0, 0, size.width, size.height);
      work.width = 0;
      work.height = 0;
      octx = c;
    }
    if (opts.format === "jpeg") {
      // beginFrame 会清空画布，所以白底放到最后、垫在已有内容下面
      octx.save();
      octx.setTransform(1, 0, 0, 1, 0, 0);
      octx.globalAlpha = 1;
      octx.globalCompositeOperation = "destination-over";
      octx.fillStyle = "#ffffff";
      octx.fillRect(0, 0, output.width, output.height);
      octx.restore();
    }

    const mime = mimeOf(opts.format);
    const blob = await untilAborted(new Promise<Blob | null>((resolve) => output.toBlob(resolve, mime, opts.quality)), opts.signal);
    if (!blob) throw new Error("导出失败：图片太大或浏览器内存不足");
    if (blob.type !== mime) throw new Error(`当前浏览器不支持导出 ${opts.format.toUpperCase()}`);
    return blob;
  } finally {
    // 尽快释放位图内存（批量导出时一张接一张画）
    for (const c of [work, output]) {
      c.width = 0;
      c.height = 0;
    }
  }
}

/** 把一个图层渲染成图片：尺寸 = 导出范围 × scale（向上取整，单边不超过 MAX_EXPORT_SIDE） */
export async function renderNode(opts: RenderNodeOptions): Promise<Blob> {
  const doc = await getPageDoc(opts.designId, opts.version, opts.pageId);
  return renderFromDoc(doc, opts);
}

/** 触发浏览器下载：对象 URL + <a download>，浏览器接手后再撤销 URL */
export async function downloadBlob(blob: Blob, fileName: string): Promise<void> {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // 点击后立刻撤销，Firefox / Safari 可能还没开始读，下载会失败
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

/**
 * 给一批图层名分配文件基础名：按平台清洗，再按最终路径去重（不区分大小写，macOS / Windows 文件系统都不区分）。
 * 任一档位的文件名撞上已分配的文件时，基础名依次加 "-2"、"-3"（Android 用 "_2"）——
 * 例如 iOS 下图层「icon」的 @2x 与「icon@2x」的 @1x 都叫 icon@2x.png，后者会改成 icon@2x-2。
 */
export function assignBaseNames(names: readonly string[], targets: readonly ExportTarget[], platform: ExportPlatform, ext: string): string[] {
  const sep = platform === "android" ? "_" : "-";
  const used = new Set<string>();
  const pathsOf = (base: string) => targets.map((t) => targetPath(t, base, ext).toLowerCase());
  return names.map((name) => {
    const safe = safeFileName(name, platform);
    let base = safe;
    for (let i = 2; pathsOf(base).some((p) => used.has(p)); i++) base = `${safe}${sep}${i}`;
    for (const p of pathsOf(base)) used.add(p);
    return base;
  });
}

export interface ExportManyOptions {
  designId: string;
  version: number;
  pageId: string;
  platform: ExportPlatform;
  designScale: number;
  format: ExportFormat;
  /** 要导出的档位，缺省为 exportTargets(platform, designScale) 全部 */
  targets?: ExportTarget[];
  quality?: number;
  /** 每完成一个文件回调一次（done 从 1 数到 total = 图层数 × 档位数） */
  onProgress?: (done: number, total: number) => void;
  /** 中途取消：抛出 signal 的取消原因 */
  signal?: AbortSignal;
}

export interface ExportManyResult {
  /** 可直接交给 zipStore 的文件（路径含 Android 目录） */
  files: ZipEntry[];
  /** 画不出来的图层（不存在、图片加载失败、浏览器建不出画布等），其余图层照常导出 */
  failed: Array<{ nodeId: string; name: string; error: string }>;
  /**
   * 精度打了折扣的文件：size = 超过单边上限、被等比缩小；effects = 带投影 / 模糊的图层超过渲染器离屏层上限，
   * 该图层连同其中的文字、图片都降采样发糊
   */
  downscaled: Array<{ nodeId: string; name: string; label: string; reason: "size" | "effects" }>;
}

/**
 * 批量导出：每个图层 × 每个档位一张图，逐张绘制（控制内存），文件名见 assignBaseNames。
 * 被取消时抛出取消原因，不返回半成品。
 */
export async function exportMany(items: ReadonlyArray<{ nodeId: string; name: string }>, opts: ExportManyOptions): Promise<ExportManyResult> {
  if (!canExport(opts.format)) throw new Error(`当前浏览器不支持导出 ${opts.format.toUpperCase()}`);
  const targets = opts.targets ?? exportTargets(opts.platform, opts.designScale);
  const ext = extFor(opts.format);
  const doc = await getPageDoc(opts.designId, opts.version, opts.pageId);

  const seenNodes = new Set<string>();
  const unique = items.filter((it) => !seenNodes.has(it.nodeId) && seenNodes.add(it.nodeId));
  const bases = assignBaseNames(
    unique.map((it) => it.name),
    targets,
    opts.platform,
    ext,
  );
  const total = unique.length * targets.length;
  const files: ZipEntry[] = [];
  const failed: ExportManyResult["failed"] = [];
  const downscaled: ExportManyResult["downscaled"] = [];
  let done = 0;

  for (const [index, item] of unique.entries()) {
    const base = bases[index];
    const bounds = exportBounds(doc, item.nodeId);
    const doneBefore = done;
    const filesBefore = files.length;
    try {
      for (const target of targets) {
        opts.signal?.throwIfAborted();
        const blob = await renderFromDoc(doc, {
          designId: opts.designId,
          version: opts.version,
          pageId: opts.pageId,
          nodeId: item.nodeId,
          scale: target.scale,
          format: opts.format,
          quality: opts.quality,
          signal: opts.signal,
        });
        files.push({ name: targetPath(target, base, ext), data: new Uint8Array(await blob.arrayBuffer()) });
        if (bounds) {
          const actual = exportSize(bounds, target.scale).scale;
          if (actual < target.scale - 1e-9) downscaled.push({ nodeId: item.nodeId, name: item.name, label: target.label, reason: "size" });
          else if (effectLayerLimited(doc, item.nodeId, actual, bounds)) downscaled.push({ nodeId: item.nodeId, name: item.name, label: target.label, reason: "effects" });
        }
        opts.onProgress?.(++done, total);
      }
    } catch (e) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? e;
      failed.push({ nodeId: item.nodeId, name: item.name, error: e instanceof Error ? e.message : String(e) });
      // 一个图层要么全部档位都有、要么一个都没有：丢掉已画好的几张，剩下的档位不画了，进度照样往前走
      files.length = filesBefore;
      for (let i = downscaled.length - 1; i >= 0; i--) if (downscaled[i].nodeId === item.nodeId) downscaled.splice(i, 1);
      done = doneBefore + targets.length;
      opts.onProgress?.(done, total);
    }
  }
  opts.signal?.throwIfAborted();
  return { files, failed, downscaled };
}
