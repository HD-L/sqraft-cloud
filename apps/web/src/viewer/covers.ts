/**
 * 设计稿封面：把设计稿的第一个画板在浏览器里渲染成一张小图（与查看器同一个渲染器），列表和卡片上用。
 * - 结果按「设计稿 @ 版本」缓存成对象 URL，最近用过的留 80 张；
 * - 同时最多画 2 张，其余排队，滚动很快时不会一次发几十个请求；
 * - 画好的封面再存进浏览器的 Cache Storage（版本内容不可变，按「设计稿 @ 版本」存是安全的），刷新页面后直接取，不用重画；
 * - 画不出来（没有版本、页面加载失败）返回 null，调用方显示占位。
 */
import { api } from "../api";
import { renderNode } from "./exportImage";

interface PageRow {
  id: string;
  width: number;
  height: number;
}

/** 封面的目标宽度（CSS 像素 × 2，保证高分屏清晰） */
const COVER_WIDTH = 640;
const MAX_CACHED = 80;
const MAX_RUNNING = 2;

const cache = new Map<string, Promise<string | null>>();
const urls = new Map<string, string>();
const queue: Array<() => void> = [];
let running = 0;

function schedule<T>(job: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      running++;
      job()
        .then(resolve, reject)
        .finally(() => {
          running--;
          queue.shift()?.();
        });
    };
    if (running < MAX_RUNNING) run();
    else queue.push(run);
  });
}

const CACHE_NAME = "sqraft-covers-v1";
const cacheKey = (designId: string, version: number) => `/__covers/${encodeURIComponent(designId)}/${version}.png`;

/** 浏览器缓存里的封面；不支持 Cache Storage（非安全上下文、隐私模式等）时返回 null */
async function fromCache(designId: string, version: number): Promise<Blob | null> {
  try {
    if (typeof caches === "undefined") return null;
    const hit = await (await caches.open(CACHE_NAME)).match(cacheKey(designId, version));
    return hit ? await hit.blob() : null;
  } catch {
    return null;
  }
}
async function toCache(designId: string, version: number, blob: Blob): Promise<void> {
  try {
    if (typeof caches === "undefined") return;
    await (await caches.open(CACHE_NAME)).put(cacheKey(designId, version), new Response(blob, { headers: { "content-type": "image/png" } }));
  } catch {
    // 存不进去（配额满等）只是下次要重画，不影响显示
  }
}

async function render(designId: string, version: number): Promise<string | null> {
  const cached = await fromCache(designId, version);
  if (cached) return URL.createObjectURL(cached);
  const res = await api<{ pages: PageRow[] }>("GET", `/designs/${designId}/versions/${version}/pages`);
  const page = res.pages.find((p) => p.width > 0 && p.height > 0);
  if (!page) return null;
  // 封面只取画板顶部一屏的比例也够用：按宽度定倍率，过长的画板由 <img> 的 object-fit 裁掉下半部分
  const scale = Math.min(2, COVER_WIDTH / page.width);
  const opts = { designId, version, pageId: page.id, nodeId: page.id, scale, format: "png" as const };
  try {
    // 先按严格模式画：图片全部画出来了才存进缓存
    const blob = await renderNode(opts);
    void toCache(designId, version, blob);
    return URL.createObjectURL(blob);
  } catch {
    // 有图片没加载出来（网络抖动、链接图等）：照常显示带占位的封面，但不缓存，下次再画
    const blob = await renderNode({ ...opts, strict: false });
    return URL.createObjectURL(blob);
  }
}

/** 封面图的对象 URL；没有可画的内容时为 null */
export function coverOf(designId: string, version: number | null | undefined): Promise<string | null> {
  if (!version) return Promise.resolve(null);
  const key = `${designId}@${version}`;
  let p = cache.get(key);
  if (p) {
    // 最近用过的挪到末尾
    cache.delete(key);
    cache.set(key, p);
    return p;
  }
  p = schedule(() => render(designId, version))
    .then((url) => {
      if (url) urls.set(key, url);
      return url;
    })
    .catch(() => {
      // 失败不缓存，下次再试
      cache.delete(key);
      return null;
    });
  cache.set(key, p);
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value as string;
    cache.delete(oldest);
    const url = urls.get(oldest);
    if (url) URL.revokeObjectURL(url);
    urls.delete(oldest);
  }
  return p;
}
