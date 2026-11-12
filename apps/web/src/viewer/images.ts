/**
 * 切图缓存（按设计稿与版本）：渲染器请求某张图时开始加载，加载好之前返回 null；
 * 调用方可以收集「还在加载的」Promise，等它们结束再重画。
 *
 * - 加载失败的图记为失败，之后直接返回 null、不再让调用方等待（否则每帧都会因为「有图在等」而重画）；
 *   导出切图前用 retryFailed() 清掉失败记录重新请求，绘制后用 isFailed() 检查有没有图缺失；
 * - 每个版本最多留 MAX_ENTRIES 张，最近用过的优先保留；离开设计稿页时整体清空（clearImages）。
 *   被淘汰的图再用到时会重新请求，切图地址带长缓存，通常直接命中浏览器缓存。
 */
import type { ResolvedImage } from "@sqraft/render";

interface Entry {
  img: HTMLImageElement;
  state: "loading" | "ready" | "failed";
  done: Promise<void>;
}

// 要大于单个页面可能用到的切图数，否则单页每帧都在淘汰、重新加载同一批图
const MAX_ENTRIES = 1500;

export class ImageStore {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly designId: string,
    private readonly version: number,
  ) {}

  /** 渲染器的 resolveImage；还在加载时返回 null，并把加载中的 Promise 记进 pending（可选） */
  resolve(assetId: string, pending?: Promise<void>[]): ResolvedImage | null {
    let e = this.entries.get(assetId);
    if (e) {
      // 最近使用的挪到末尾，淘汰从头开始
      this.entries.delete(assetId);
      this.entries.set(assetId, e);
    } else {
      const img = new Image();
      img.decoding = "async";
      const entry: Entry = { img, state: "loading", done: Promise.resolve() };
      entry.done = new Promise<void>((resolve) => {
        img.onload = () => {
          entry.state = "ready";
          resolve();
        };
        img.onerror = () => {
          entry.state = "failed";
          resolve();
        };
      });
      e = entry;
      this.entries.set(assetId, e);
      img.src = `/api/v1/designs/${this.designId}/versions/${this.version}/assets/${encodeURIComponent(assetId)}`;
      while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value as string);
    }
    if (e.state === "ready") return { source: e.img, width: e.img.naturalWidth, height: e.img.naturalHeight };
    if (e.state === "loading") pending?.push(e.done);
    return null;
  }

  /** 这张图是否加载失败过（还没重试） */
  isFailed(assetId: string): boolean {
    return this.entries.get(assetId)?.state === "failed";
  }

  /** 清掉失败记录：下次 resolve 时重新请求（网络抖动、登录过期后恢复） */
  retryFailed(): void {
    for (const [id, e] of this.entries) if (e.state === "failed") this.entries.delete(id);
  }
}

const stores = new Map<string, ImageStore>();
export function imageStore(designId: string, version: number): ImageStore {
  const key = `${designId}@${version}`;
  let s = stores.get(key);
  if (!s) {
    s = new ImageStore(designId, version);
    stores.set(key, s);
    while (stores.size > 2) stores.delete(stores.keys().next().value as string);
  }
  return s;
}

/** 离开设计稿页时调用：释放所有图片对象 */
export function clearImages(): void {
  stores.clear();
}
