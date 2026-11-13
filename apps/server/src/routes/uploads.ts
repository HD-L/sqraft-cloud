/**
 * 分块、可续传的设计稿上传（D1–D3）。
 *
 * 1. `POST /api/v1/designs/:id/uploads` `{ size, note }` → `{ uploadId, chunkSize, received }`
 * 2. `PUT /api/v1/uploads/:id`，头 `Upload-Offset: <已传字节>`，body 为 `application/octet-stream` 分块；
 *    偏移对不上返回 409 与服务端实际偏移，客户端据此续传
 * 3. `GET /api/v1/uploads/:id` 查询进度（断线后续传用）
 * 4. `POST /api/v1/uploads/:id/complete` → 校验 .sqraft、收录资源、生成新版本；
 *    与当前版本内容完全相同则不生成新版本（`duplicate: true`）
 *
 * 只传改动部分的增量上传见 commits.ts；两条路生成的版本完全一样（都记录页面级变更）。
 * 5. `DELETE /api/v1/uploads/:id` 取消
 */

import type { FastifyInstance } from "fastify";
import type { Readable } from "node:stream";
import { createWriteStream } from "node:fs";
import { rm, stat, truncate } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { AppContext } from "../app";
import { audit } from "../audit";
import { requireWriter, type Principal } from "../auth";
import { newId } from "../crypto";
import { badRequest, conflict, HttpError, notFound } from "../errors";
import { ingestSqraft } from "../sqraft-file";
import type { DesignReader } from "../reader";
import { commitVersion } from "../versions";
import { loadDesign, publicDesign, publicVersion, type DesignRow } from "./projects";

export const CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_CHUNK = 64 * 1024 * 1024;
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

interface UploadRow {
  id: string;
  user_id: string;
  design_id: string;
  note: string;
  size: number;
  received: number;
  created_at: number;
  expires_at: number;
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

export function uploadRoutes(app: FastifyInstance, ctx: AppContext, reader: DesignReader): void {
  const { db, store, config } = ctx;

  const loadUpload = (p: Principal, id: string): UploadRow => {
    const u = db.prepare("SELECT * FROM uploads WHERE id = ?").get(id) as UploadRow | undefined;
    if (!u || u.user_id !== p.user.id || u.expires_at <= Date.now()) throw notFound("上传不存在或已过期");
    loadDesign(db, p, u.design_id, "editor");
    return u;
  };

  const purgeExpired = async () => {
    const expired = db.prepare("SELECT id FROM uploads WHERE expires_at <= ?").all(Date.now()) as Array<{ id: string }>;
    for (const { id } of expired) {
      await rm(store.uploadPath(id), { force: true });
      db.prepare("DELETE FROM uploads WHERE id = ?").run(id);
    }
  };

  app.post<{ Params: { id: string }; Body: { size?: unknown; note?: unknown } }>("/api/v1/designs/:id/uploads", async (req) => {
    const p = requireWriter(req);
    const d = loadDesign(db, p, req.params.id, "editor");
    const { size, note } = req.body ?? {};
    if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) throw badRequest("size 需要正整数（文件字节数）");
    if (size > config.maxUploadBytes) {
      throw new HttpError(413, "too_large", `文件超过上限 ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB`);
    }
    if (note !== undefined && (typeof note !== "string" || note.length > 500)) throw badRequest("版本说明最多 500 个字符");
    await purgeExpired();
    const now = Date.now();
    const row: UploadRow = {
      id: newId(),
      user_id: p.user.id,
      design_id: d.id,
      note: (note as string | undefined)?.trim() ?? "",
      size,
      received: 0,
      created_at: now,
      expires_at: now + UPLOAD_TTL_MS,
    };
    db.prepare(
      "INSERT INTO uploads (id, user_id, design_id, note, size, received, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
    ).run(row.id, row.user_id, row.design_id, row.note, row.size, now, row.expires_at);
    return { uploadId: row.id, chunkSize: CHUNK_SIZE, received: 0, size };
  });

  app.get<{ Params: { id: string } }>("/api/v1/uploads/:id", async (req) => {
    const p = requireWriter(req);
    const u = loadUpload(p, req.params.id);
    return { uploadId: u.id, received: await fileSize(store.uploadPath(u.id)), size: u.size };
  });

  app.put<{ Params: { id: string } }>("/api/v1/uploads/:id", async (req, reply) => {
    const p = requireWriter(req);
    const u = loadUpload(p, req.params.id);
    const path = store.uploadPath(u.id);
    const onDisk = await fileSize(path);
    const offset = Number(req.headers["upload-offset"]);
    if (!Number.isInteger(offset) || offset !== onDisk) {
      (req.body as Readable | undefined)?.resume();
      return reply.status(409).send({ error: { code: "offset_mismatch", message: "偏移不一致，请从服务端偏移续传" }, received: onDisk });
    }
    const body = req.body as Readable | undefined;
    if (!body || typeof body.pipe !== "function") throw badRequest("需要 Content-Type: application/octet-stream 的分块");
    const limit = Math.min(MAX_CHUNK, u.size - onDisk);
    const tooLarge = () => new HttpError(413, "too_large", "分块超出声明的文件大小或单块上限");
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      body.resume();
      throw tooLarge();
    }
    // 没有 Content-Length（分块编码）时边收边数：超出部分丢弃但把请求读完，再回 413，
    // 中途断开请求流会让客户端收不到任何响应
    let written = 0;
    let overflow = false;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        written += chunk.length;
        if (written > limit) overflow = true;
        done(null, overflow ? undefined : chunk);
      },
    });
    try {
      await pipeline(body, meter, createWriteStream(path, { flags: "a" }));
    } catch {
      // 写坏的尾巴截掉，客户端按服务端偏移重传
      await truncate(path, onDisk).catch(() => undefined);
      throw badRequest("分块传输中断，请重试");
    }
    if (overflow) {
      await truncate(path, onDisk).catch(() => undefined);
      throw tooLarge();
    }
    const received = onDisk + written;
    db.prepare("UPDATE uploads SET received = ? WHERE id = ?").run(received, u.id);
    return { received, size: u.size };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/uploads/:id", async (req) => {
    const p = requireWriter(req);
    const u = loadUpload(p, req.params.id);
    await rm(store.uploadPath(u.id), { force: true });
    db.prepare("DELETE FROM uploads WHERE id = ?").run(u.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/v1/uploads/:id/complete", async (req) => {
    const p = requireWriter(req);
    const u = loadUpload(p, req.params.id);
    const path = store.uploadPath(u.id);
    const received = await fileSize(path);
    if (received !== u.size) throw conflict(`还没传完：${received} / ${u.size} 字节`, "incomplete");

    let result;
    try {
      const design = db.prepare("SELECT * FROM designs WHERE id = ?").get(u.design_id) as DesignRow;
      result = await ingestSqraft(path, store, undefined, await reader.currentBase(design));
    } catch (error) {
      if (error instanceof HttpError) {
        audit(db, p, req.ip, { action: "design.upload", target: u.design_id, result: "failed", detail: { reason: error.message } });
      }
      throw error;
    } finally {
      await rm(path, { force: true });
      db.prepare("DELETE FROM uploads WHERE id = ?").run(u.id);
    }

    const outcome = await commitVersion(ctx, reader, p.user.id, u.design_id, {
      note: u.note,
      fileSha256: result.fileSha256,
      size: result.size,
      formatVersion: result.formatVersion,
      docBlob: result.docBlob,
      manifestBlob: result.manifestBlob,
      assets: result.assets,
      nodeCount: result.nodeCount,
      pageCount: result.pageCount,
      index: result.index,
      contentHash: result.contentHash,
    });

    audit(db, p, req.ip, {
      action: "design.upload",
      target: u.design_id,
      detail: { version: outcome.version.number, size: result.size, duplicate: outcome.duplicate },
    });
    return {
      design: publicDesign(db, outcome.design, p),
      version: publicVersion(db, outcome.version, outcome.design.current_version),
      duplicate: outcome.duplicate,
    };
  });
}
