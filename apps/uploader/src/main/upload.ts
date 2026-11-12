/**
 * 上传设计稿：服务端支持就走增量（本地拆页、只传服务端没有的页面与切图），否则整包分块上传。
 * 不依赖 Electron，可以在 Node 里直接跑。
 */

import { open, stat } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import type { CommitManifest } from "@sqraft-cloud/shared";
import { readLocalDesign } from "./sqraft";
import { CloudError, request } from "./http";
import type { ChangeSummary, UploadProgress, UploadStats } from "../shared/types";

export async function features(server: string): Promise<string[]> {
  const info = await request<{ features?: unknown }>(server, null, "GET", "/api/v1/info");
  return Array.isArray(info.features) ? info.features.filter((f): f is string => typeof f === "string") : [];
}

export interface UploadOutcome {
  duplicate: boolean;
  version: number;
  changes: ChangeSummary | null;
  stats: UploadStats;
}

/** 上传一个 .sqraft：服务端支持就走增量，否则整包上传。 */
export async function uploadFile(
  server: string,
  token: string,
  designId: string,
  path: string,
  note: string,
  onProgress: (p: UploadProgress) => void,
  signal: AbortSignal,
): Promise<UploadOutcome> {
  if ((await features(server)).includes("incremental-upload")) return uploadIncremental(server, token, designId, path, note, onProgress, signal);
  const res = await uploadWhole(server, token, designId, path, note, onProgress, signal);
  const { size } = await stat(path);
  return { ...res, stats: { mode: "whole", sentBytes: size, totalBytes: size, sentParts: 0, totalParts: 0, sentAssets: 0, totalAssets: 0 } };
}

const CONCURRENCY = 4;

/** 并发跑一批任务（最多 CONCURRENCY 个同时进行），任何一个失败就整体失败。 */
async function pool<T>(items: T[], run: (item: T) => Promise<void>, signal: AbortSignal): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      if (signal.aborted) throw new CloudError(0, "aborted", "已取消上传");
      await run(items[next++]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
}

/**
 * 增量上传：本地拆页 → 问服务端缺哪些 → 只传缺的（页面 gzip 压缩）→ 提交清单。
 * 提交时服务端说还缺（比如期间被回收了），补传后再提交一次。
 */
export async function uploadIncremental(
  server: string,
  token: string,
  designId: string,
  path: string,
  note: string,
  onProgress: (p: UploadProgress) => void,
  signal: AbortSignal,
): Promise<UploadOutcome> {
  onProgress({ sent: 0, total: 1, phase: "analyzing" });
  const local = await readLocalDesign(path);
  try {
    const base = `/api/v1/designs/${encodeURIComponent(designId)}`;
    const items = [
      ...local.parts.map((p) => ({ hash: p.hash, size: Buffer.byteLength(p.json), kind: "part" as const, body: async () => gzipSync(p.json) })),
      ...local.assets.map((a) => ({ hash: a.hash, size: a.size, kind: "asset" as const, body: () => a.read() })),
    ];
    const totalBytes = items.reduce((n, i) => n + i.size, 0);
    const stats: UploadStats = {
      mode: "incremental",
      sentBytes: 0,
      totalBytes,
      sentParts: 0,
      totalParts: local.parts.length,
      sentAssets: 0,
      totalAssets: local.assets.length,
    };

    const send = async (hashes: Set<string>) => {
      const seen = new Set<string>();
      const todo = items.filter((i) => hashes.has(i.hash) && !seen.has(i.hash) && seen.add(i.hash));
      const total = todo.reduce((n, i) => n + i.size, 0);
      let sent = 0;
      onProgress({ sent, total: Math.max(total, 1), phase: "uploading" });
      await pool(
        todo,
        async (i) => {
          await request(server, token, "PUT", `${base}/blobs/${i.hash}?kind=${i.kind}`, new Uint8Array(await i.body()));
          sent += i.size;
          stats.sentBytes += i.size;
          if (i.kind === "part") stats.sentParts++;
          else stats.sentAssets++;
          onProgress({ sent, total: Math.max(total, 1), phase: "uploading" });
        },
        signal,
      );
    };

    const { missing } = await request<{ missing: string[] }>(server, token, "POST", `${base}/blobs/check`, { hashes: [...new Set(items.map((i) => i.hash))] });
    await send(new Set(missing));

    const manifest: CommitManifest = {
      formatVersion: local.formatVersion,
      tokens: local.tokens,
      parts: local.parts.map((p) => ({ rootId: p.rootId, hash: p.hash })),
      assets: local.assets.map((a) => ({ name: a.name, hash: a.hash, size: a.size })),
      ...(local.sections ? { sections: local.sections as CommitManifest["sections"] } : {}),
    };
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw new CloudError(0, "aborted", "已取消上传");
      onProgress({ sent: 1, total: 1, phase: "verifying" });
      try {
        const done = await request<{ duplicate: boolean; version: { number: number; changes?: ChangeSummary | null } }>(server, token, "POST", `${base}/commits`, {
          note,
          manifest,
        });
        return { duplicate: done.duplicate, version: done.version.number, changes: done.version.changes ?? null, stats };
      } catch (error) {
        const again = (error as CloudError).data?.missing;
        if (attempt > 0 || !(error instanceof CloudError) || error.code !== "missing_blobs" || !Array.isArray(again)) throw error;
        await send(new Set(again as string[]));
      }
    }
  } finally {
    local.close();
  }
}

/** 整包分块上传（U5、U6）：8 MB 一块，偏移不一致时按服务端偏移续传，可取消。老服务端走这条。 */
export async function uploadWhole(
  server: string,
  token: string,
  designId: string,
  path: string,
  note: string,
  onProgress: (p: UploadProgress) => void,
  signal: AbortSignal,
): Promise<{ duplicate: boolean; version: number; changes: ChangeSummary | null }> {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    const start = await request<{ uploadId: string; chunkSize: number }>(server, token, "POST", `/api/v1/designs/${encodeURIComponent(designId)}/uploads`, {
      size,
      note,
    });
    const id = start.uploadId;
    let offset = 0;
    while (offset < size) {
      if (signal.aborted) {
        await request(server, token, "DELETE", `/api/v1/uploads/${id}`).catch(() => undefined);
        throw new CloudError(0, "aborted", "已取消上传");
      }
      const length = Math.min(start.chunkSize, size - offset);
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, offset);
      try {
        const res = await request<{ received: number }>(server, token, "PUT", `/api/v1/uploads/${id}`, buf, { "upload-offset": String(offset) });
        offset = res.received;
      } catch (error) {
        const received = (error as CloudError).data?.received;
        if (error instanceof CloudError && error.code === "offset_mismatch" && typeof received === "number") offset = received;
        else throw error;
      }
      onProgress({ sent: offset, total: size, phase: offset < size ? "uploading" : "verifying" });
    }
    const done = await request<{ duplicate: boolean; version: { number: number; changes?: ChangeSummary | null } }>(server, token, "POST", `/api/v1/uploads/${id}/complete`, {});
    return { duplicate: done.duplicate, version: done.version.number, changes: done.version.changes ?? null };
  } finally {
    await fh.close();
  }
}
