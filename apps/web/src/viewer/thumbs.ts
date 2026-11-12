/**
 * 总览画布的画板缩略图：用 Sqraft 的渲染器把单个页面画到离屏画布上，按 2 的幂次分档缓存
 * （缩放变化不大时不用重画），超过像素预算时淘汰最久没用的。
 *
 * - 只渲染屏幕上看得见、且显示尺寸够大的画板；排队时离视口中心近的先画，已经看不见的直接丢掉；
 * - 图片没加载完先画一遍（占位），加载完再补画一遍；
 * - 同时最多 CONCURRENCY 个页面在加载 / 绘制。
 */
import { Canvas2DBackend, drawDocument } from "@sqraft/render";
import { getPageDoc } from "./pageDocs";
import { imageStore } from "./images";

export interface Board {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Thumb {
  canvas: HTMLCanvasElement;
  level: number;
  pixels: number;
  used: number;
}

const CONCURRENCY = 3;
/** 缩略图总像素上限（约 4 字节 / 像素） */
const PIXEL_BUDGET = 48_000_000;
/** 单张缩略图最长边 */
const MAX_SIDE = 2048;
const RETRY_MS = 15_000;

/** 显示比例（世界单位 → 设备像素）对应的缓存档位：向上取 2 的幂，限制单张最长边 */
export function levelFor(board: Board, scale: number): number {
  let level = 2 ** Math.ceil(Math.log2(Math.max(scale, 1 / 128)));
  level = Math.min(level, 2);
  while (level > 1 / 128 && Math.max(board.width, board.height) * level > MAX_SIDE) level /= 2;
  return level;
}

export class ThumbStore {
  /** pageId → 各档位的缩略图 */
  private readonly thumbs = new Map<string, Map<number, Thumb>>();
  /** 画失败的「页面@档位」→ 失败时间；过了 RETRY_MS 再试（网络抖动、刚登录时的 401 等） */
  private readonly failed = new Map<string, number>();
  private pixels = 0;
  private tick = 0;
  private running = 0;
  private wanted = new Map<string, { board: Board; level: number; priority: number }>();
  private readonly busy = new Set<string>();
  private disposed = false;

  constructor(
    private readonly designId: string,
    private readonly version: number,
    private readonly onReady: () => void,
  ) {}

  /** 最合适的现成缩略图：优先恰好的档位，否则取最清晰的 */
  best(id: string, level: number): HTMLCanvasElement | null {
    const levels = this.thumbs.get(id);
    if (!levels?.size) return null;
    const exact = levels.get(level);
    const pick = exact ?? [...levels.values()].sort((a, b) => b.level - a.level)[0];
    pick.used = ++this.tick;
    return pick.canvas;
  }

  has(id: string, level: number): boolean {
    if (this.thumbs.get(id)?.has(level)) return true;
    const at = this.failed.get(`${id}@${level}`);
    return at !== undefined && Date.now() - at < RETRY_MS;
  }

  /** 每帧调用：这一帧想要的缩略图（priority 越小越先画）。没在列表里的排队项会被丢掉。 */
  want(list: Array<{ board: Board; level: number; priority: number }>): void {
    if (this.disposed) return;
    this.wanted = new Map(list.filter((w) => !this.has(w.board.id, w.level)).map((w) => [`${w.board.id}@${w.level}`, w]));
    this.pump();
  }

  /** 不再需要（总览卸载、切换版本）：清空队列，正在画的画完即丢，释放所有缩略图 */
  dispose(): void {
    this.disposed = true;
    this.wanted.clear();
    for (const levels of this.thumbs.values()) {
      for (const t of levels.values()) {
        t.canvas.width = 0;
        t.canvas.height = 0;
      }
    }
    this.thumbs.clear();
    this.pixels = 0;
  }

  private pump(): void {
    while (!this.disposed && this.running < CONCURRENCY) {
      const next = [...this.wanted.entries()].filter(([k]) => !this.busy.has(k)).sort((a, b) => a[1].priority - b[1].priority)[0];
      if (!next) return;
      const [key, w] = next;
      this.wanted.delete(key);
      this.busy.add(key);
      this.running++;
      void this.render(w.board, w.level)
        .catch(() => this.failed.set(key, Date.now()))
        .finally(() => {
          this.busy.delete(key);
          this.running--;
          if (this.disposed) return;
          this.onReady();
          this.pump();
        });
    }
  }

  private async render(board: Board, level: number): Promise<void> {
    const doc = await getPageDoc(this.designId, this.version, board.id);
    if (this.disposed) return;
    const images = imageStore(this.designId, this.version);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    const backend = new Canvas2DBackend(ctx);
    const vp = { x: board.x, y: board.y, zoom: level, width: Math.max(1, Math.round(board.width * level)), height: Math.max(1, Math.round(board.height * level)), dpr: 1 };
    const draw = (pending?: Promise<void>[]) => {
      backend.beginFrame(vp);
      drawDocument(backend, doc, { resolveImage: (assetId) => images.resolve(assetId, pending) });
      backend.endFrame();
    };
    const pending: Promise<void>[] = [];
    draw(pending);
    this.store(board.id, level, canvas);
    if (pending.length) {
      // 先放出没图片的版本，图片到齐（或失败）后补画
      this.onReady();
      await Promise.all(pending);
      if (this.disposed || !this.thumbs.get(board.id)?.has(level)) return;
      draw();
    }
  }

  private store(id: string, level: number, canvas: HTMLCanvasElement): void {
    let levels = this.thumbs.get(id);
    if (!levels) this.thumbs.set(id, (levels = new Map()));
    const old = levels.get(level);
    if (old) this.pixels -= old.pixels;
    const pixels = canvas.width * canvas.height;
    levels.set(level, { canvas, level, pixels, used: ++this.tick });
    this.pixels += pixels;
    this.evict();
  }

  private evict(): void {
    if (this.pixels <= PIXEL_BUDGET) return;
    const all: Array<{ id: string; t: Thumb }> = [];
    for (const [id, levels] of this.thumbs) for (const t of levels.values()) all.push({ id, t });
    all.sort((a, b) => a.t.used - b.t.used);
    for (const { id, t } of all) {
      if (this.pixels <= PIXEL_BUDGET * 0.8) break;
      const levels = this.thumbs.get(id)!;
      levels.delete(t.level);
      if (!levels.size) this.thumbs.delete(id);
      this.pixels -= t.pixels;
      t.canvas.width = 0;
      t.canvas.height = 0;
    }
  }
}
