/**
 * 维护任务（D6、存储回收）：
 * - 回收站：删除超过 `trashDays` 天的设计稿连同全部版本彻底删除；
 * - 孤儿文件回收：文件仓库里没有任何版本引用的 blob（上传校验失败的残留、被彻底删除的设计稿）删掉。
 *   只删「超过宽限期」的文件，避免误删正在收录中的上传；
 * - 临时目录：超过一天的临时文件删掉。
 * 服务每天自动跑一次，也可以在管理后台手动触发或用 `node server.mjs gc`。
 */

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AppContext } from "./app";
import type { VersionIndex } from "./indexer";
import type { AssetRef } from "./sqraft-file";

const DAY = 24 * 60 * 60 * 1000;

export interface MaintenanceReport {
  purgedDesigns: number;
  deletedBlobs: number;
  freedBytes: number;
  keptBlobs: number;
  tmpFiles: number;
}

export function purgeTrash(ctx: AppContext, days = ctx.config.trashDays, now = Date.now()): number {
  return ctx.db.prepare("DELETE FROM designs WHERE deleted_at IS NOT NULL AND deleted_at < ?").run(now - days * DAY).changes;
}

/** 所有版本引用到的 blob：原始文件各条目 + 按页索引里的页面 / 组件 / 搜索文件。 */
export async function referencedBlobs(ctx: AppContext): Promise<Set<string>> {
  const refs = new Set<string>();
  const rows = ctx.db.prepare("SELECT doc_blob, manifest_blob, assets, index_blob FROM versions").all() as Array<{
    doc_blob: string;
    manifest_blob: string | null;
    assets: string;
    index_blob: string | null;
  }>;
  for (const r of rows) {
    refs.add(r.doc_blob);
    if (r.manifest_blob) refs.add(r.manifest_blob);
    for (const a of JSON.parse(r.assets) as AssetRef[]) refs.add(a.blob);
    if (r.index_blob) {
      refs.add(r.index_blob);
      try {
        const idx = await ctx.store.getJson<VersionIndex>(r.index_blob);
        for (const p of idx.pages) refs.add(p.blob);
        for (const c of idx.components) refs.add(c.blob);
        refs.add(idx.searchBlob);
      } catch {
        // 索引文件读不出来：下次读取时会重建，这里不影响回收其它文件
      }
    }
  }
  return refs;
}

export async function collectGarbage(ctx: AppContext, graceMs = DAY, now = Date.now()): Promise<Omit<MaintenanceReport, "purgedDesigns">> {
  const refs = await referencedBlobs(ctx);
  let deletedBlobs = 0;
  let freedBytes = 0;
  let keptBlobs = 0;
  for (const prefix of await readdir(ctx.store.blobsDir).catch(() => [] as string[])) {
    const dir = join(ctx.store.blobsDir, prefix);
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (refs.has(name)) {
        keptBlobs++;
        continue;
      }
      const file = join(dir, name);
      const s = await stat(file).catch(() => null);
      if (!s || now - s.mtimeMs < graceMs) {
        keptBlobs++;
        continue;
      }
      await rm(file, { force: true });
      deletedBlobs++;
      freedBytes += s.size;
    }
  }
  let tmpFiles = 0;
  for (const name of await readdir(ctx.store.tmpDir).catch(() => [] as string[])) {
    const file = join(ctx.store.tmpDir, name);
    const s = await stat(file).catch(() => null);
    if (s && now - s.mtimeMs > DAY) {
      await rm(file, { force: true });
      tmpFiles++;
    }
  }
  return { deletedBlobs, freedBytes, keptBlobs, tmpFiles };
}

export async function runMaintenance(ctx: AppContext, graceMs = DAY): Promise<MaintenanceReport> {
  const purgedDesigns = purgeTrash(ctx);
  return { purgedDesigns, ...(await collectGarbage(ctx, graceMs)) };
}

/** 文件仓库占用（字节）：遍历目录，结果缓存 10 分钟。 */
let storageCache: { at: number; bytes: number; blobs: number } | null = null;
export async function storageUsage(ctx: AppContext): Promise<{ bytes: number; blobs: number }> {
  if (storageCache && Date.now() - storageCache.at < 10 * 60 * 1000) return storageCache;
  let bytes = 0;
  let blobs = 0;
  for (const prefix of await readdir(ctx.store.blobsDir).catch(() => [] as string[])) {
    const dir = join(ctx.store.blobsDir, prefix);
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const s = await stat(join(dir, name)).catch(() => null);
      if (s) {
        bytes += s.size;
        blobs++;
      }
    }
  }
  storageCache = { at: Date.now(), bytes, blobs };
  return storageCache;
}

export function invalidateStorageCache(): void {
  storageCache = null;
}
