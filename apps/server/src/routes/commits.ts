/**
 * 增量上传：客户端在本地把 .sqraft 拆成页面 / 组件 / 切图，按哈希只传服务端没有的部分。
 *
 * 1. `POST /api/v1/designs/:id/blobs/check` `{ hashes }` → `{ missing }`：服务端缺哪些；
 *    已有的顺带刷新修改时间，提交前不会被孤儿回收删掉
 * 2. `PUT /api/v1/designs/:id/blobs/:hash?kind=part|asset`，body 为 `application/octet-stream`：
 *    - part：页面 / 组件的规范 JSON 经 gzip 压缩，哈希按**解压后**的文本算（见 @sqraft-cloud/shared）；
 *    - asset：切图原始字节，哈希按字节算。
 *    哈希对不上一律拒收
 * 3. `POST /api/v1/designs/:id/commits` `{ note, manifest }`：按清单校验并生成新版本，
 *    响应与整包上传的 complete 相同；还缺文件时返回 409 `missing_blobs` 与缺的哈希
 *
 * 部件的结构与「确实是规范序列化」在提交时校验（同一份内容只会有一个名字）。
 */

import type { FastifyInstance } from "fastify";
import type { Readable } from "node:stream";
import { createReadStream, createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Transform, Writable } from "node:stream";
import { CURRENT_FORMAT_VERSION } from "@sqraft/core";
import { ASSET_NAME_RE, HASH_RE, normalizeSections, versionFingerprint, type CommitManifest } from "@sqraft-cloud/shared";
import type { AppContext } from "../app";
import { audit } from "../audit";
import { requireWriter } from "../auth";
import { badRequest, HttpError } from "../errors";
import { buildIndexFromManifest } from "../indexer";
import type { DesignReader } from "../reader";
import { DEFAULT_LIMITS } from "../sqraft-file";
import { commitVersion } from "../versions";
import { loadDesign, publicDesign, publicVersion } from "./projects";

const MAX_HASHES = DEFAULT_LIMITS.maxEntries + 10_000;
const invalid = (message: string) => new HttpError(422, "invalid_manifest", message);

/** 边收边数：超过上限就丢弃后续字节但把请求读完，再报 413（中途断开请求流客户端会收不到响应）。 */
function meter(limit: number, hash?: ReturnType<typeof createHash>) {
  const state = { bytes: 0, overflow: false };
  const stream = new Transform({
    transform(chunk: Buffer, _enc, done) {
      state.bytes += chunk.length;
      if (state.bytes > limit) state.overflow = true;
      if (state.overflow) return done();
      hash?.update(chunk);
      done(null, chunk);
    },
  });
  return { stream, state };
}

/** 解压一个 gzip 文件并算解压后的哈希；解压后超过上限视为压缩炸弹。 */
async function gunzippedHash(file: string, limit: number): Promise<string> {
  const hash = createHash("sha256");
  let bytes = 0;
  await pipeline(
    createReadStream(file),
    createGunzip(),
    new Writable({
      write(chunk: Buffer, _enc, done) {
        bytes += chunk.length;
        if (bytes > limit) return done(new HttpError(413, "too_large", "页面数据解压后超过大小上限"));
        hash.update(chunk);
        done();
      },
    }),
  );
  return hash.digest("hex");
}

function checkManifest(raw: unknown): CommitManifest {
  if (!raw || typeof raw !== "object") throw invalid("缺少 manifest");
  const m = raw as Record<string, unknown>;
  const formatVersion = m.formatVersion;
  if (typeof formatVersion !== "number" || !Number.isInteger(formatVersion) || formatVersion < 1) throw invalid("formatVersion 需要正整数");
  if (formatVersion > CURRENT_FORMAT_VERSION) {
    throw new HttpError(422, "format_too_new", `设计稿格式版本 ${formatVersion} 高于服务端支持的 ${CURRENT_FORMAT_VERSION}，请升级 sqraft-cloud`);
  }
  const tokens = m.tokens ?? {};
  if (typeof tokens !== "object" || Array.isArray(tokens)) throw invalid("tokens 需要是对象");
  if (!Array.isArray(m.parts) || m.parts.length > DEFAULT_LIMITS.maxEntries) throw invalid("parts 需要是数组");
  if (!Array.isArray(m.assets) || m.assets.length > DEFAULT_LIMITS.maxEntries) throw invalid("assets 需要是数组");
  const roots = new Set<string>();
  const parts = m.parts.map((p: unknown) => {
    const { rootId, hash } = (p ?? {}) as Record<string, unknown>;
    if (typeof rootId !== "string" || !rootId || rootId.length > 512) throw invalid("parts[].rootId 无效");
    if (typeof hash !== "string" || !HASH_RE.test(hash)) throw invalid(`页面 / 组件 ${rootId} 的哈希无效`);
    if (roots.has(rootId)) throw invalid(`页面 / 组件 ${rootId} 重复`);
    roots.add(rootId);
    return { rootId, hash };
  });
  const names = new Set<string>();
  const assets = m.assets.map((a: unknown) => {
    const { name, hash, size } = (a ?? {}) as Record<string, unknown>;
    if (typeof name !== "string" || !ASSET_NAME_RE.test(name)) throw invalid(`切图路径无效：${String(name)}`);
    if (typeof hash !== "string" || !HASH_RE.test(hash)) throw invalid(`切图 ${name} 的哈希无效`);
    if (typeof size !== "number" || !Number.isInteger(size) || size < 0) throw invalid(`切图 ${name} 的大小无效`);
    if (names.has(name)) throw invalid(`切图 ${name} 重复`);
    names.add(name);
    return { name, hash, size };
  });
  // 分组在建索引时整理（不合法的整体忽略），这里只做体积上的限制
  if (m.sections !== undefined && (!Array.isArray(m.sections) || m.sections.length > 10_000)) throw invalid("sections 需要是数组");
  return { formatVersion, tokens: tokens as CommitManifest["tokens"], parts, assets, ...(m.sections ? { sections: m.sections as CommitManifest["sections"] } : {}) };
}

export function commitRoutes(app: FastifyInstance, ctx: AppContext, reader: DesignReader): void {
  const { db, store, config } = ctx;

  app.post<{ Params: { id: string }; Body: { hashes?: unknown } }>(
    "/api/v1/designs/:id/blobs/check",
    { bodyLimit: 64 * 1024 * 1024 },
    async (req) => {
      const p = requireWriter(req);
      loadDesign(db, p, req.params.id, "editor");
      const hashes = req.body?.hashes;
      if (!Array.isArray(hashes) || hashes.length > MAX_HASHES || hashes.some((h) => typeof h !== "string" || !HASH_RE.test(h))) {
        throw badRequest("hashes 需要是 SHA-256 十六进制字符串数组");
      }
      const missing: string[] = [];
      for (const h of new Set(hashes as string[])) {
        if (await store.has(h)) await store.touch(h);
        else missing.push(h);
      }
      return { missing };
    },
  );

  app.put<{ Params: { id: string; hash: string }; Querystring: { kind?: string } }>("/api/v1/designs/:id/blobs/:hash", async (req) => {
    const p = requireWriter(req);
    loadDesign(db, p, req.params.id, "editor");
    const { hash } = req.params;
    const kind = req.query.kind;
    const body = req.body as Readable | undefined;
    const drain = () => body?.resume?.();
    if (!HASH_RE.test(hash)) {
      drain();
      throw badRequest("哈希无效");
    }
    if (kind !== "part" && kind !== "asset") {
      drain();
      throw badRequest("kind 需要是 part 或 asset");
    }
    if (!body || typeof body.pipe !== "function") throw badRequest("需要 Content-Type: application/octet-stream");
    if (await store.has(hash)) {
      drain();
      await store.touch(hash);
      return { hash, stored: false };
    }
    const limit = Math.min(config.maxUploadBytes, DEFAULT_LIMITS.maxEntryBytes);
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      drain();
      throw new HttpError(413, "too_large", "文件超过大小上限");
    }
    const tmp = store.tmpPath();
    const raw = kind === "asset" ? createHash("sha256") : undefined;
    const m = meter(limit, raw);
    try {
      await pipeline(body, m.stream, createWriteStream(tmp));
      if (m.state.overflow) throw new HttpError(413, "too_large", "文件超过大小上限");
      let actual: string;
      try {
        actual = raw ? raw.digest("hex") : await gunzippedHash(tmp, DEFAULT_LIMITS.maxEntryBytes);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw badRequest("页面数据需要 gzip 压缩");
      }
      if (actual !== hash) throw badRequest("内容与哈希对不上（传输损坏或客户端计算有误）", "hash_mismatch");
      await store.adopt(tmp, hash);
      return { hash, stored: true };
    } catch (error) {
      await rm(tmp, { force: true });
      if (error instanceof HttpError) throw error;
      throw badRequest("传输中断，请重试");
    }
  });

  app.post<{ Params: { id: string }; Body: { note?: unknown; manifest?: unknown } }>(
    "/api/v1/designs/:id/commits",
    { bodyLimit: 64 * 1024 * 1024 },
    async (req, reply) => {
      const p = requireWriter(req);
      const design = loadDesign(db, p, req.params.id, "editor");
      const note = req.body?.note;
      if (note !== undefined && (typeof note !== "string" || note.length > 500)) throw badRequest("版本说明最多 500 个字符");
      const fail = (error: HttpError) => {
        audit(db, p, req.ip, { action: "design.upload", target: design.id, result: "failed", detail: { mode: "incremental", reason: error.message } });
        return error;
      };

      let manifest: CommitManifest;
      try {
        manifest = checkManifest(req.body?.manifest);
      } catch (error) {
        throw error instanceof HttpError ? fail(error) : error;
      }
      const missing: string[] = [];
      for (const h of new Set([...manifest.parts.map((x) => x.hash), ...manifest.assets.map((a) => a.hash)])) {
        if (!(await store.has(h))) missing.push(h);
      }
      if (missing.length) {
        return reply.status(409).send({ error: { code: "missing_blobs", message: `还有 ${missing.length} 个文件没有上传` }, missing });
      }
      // 和当前版本内容一样就不用再校验、建索引了。分组按当前版本的页面整理：
      // 内容真的一样时，页面集合就是当前版本的；不一样时部件哈希已经不同，怎么整理都不会误判
      const current = design.current_version ? reader.resolveVersion(design) : undefined;
      if (current?.content_hash) {
        const pageIds = (await reader.index(current)).pages.map((pg) => pg.id);
        const early = versionFingerprint({ ...manifest, sections: normalizeSections(manifest.sections, pageIds) });
        if (current.content_hash === early) {
          return { design: publicDesign(db, design, p), version: publicVersion(db, current, design.current_version), duplicate: true };
        }
      }
      let assetBytes = 0;
      for (const a of manifest.assets) {
        if ((await store.size(a.hash)) !== a.size) throw fail(invalid(`切图 ${a.name} 的大小与清单不一致`));
        assetBytes += a.size;
      }

      let built;
      try {
        built = await buildIndexFromManifest(manifest, store, await reader.currentBase(design), DEFAULT_LIMITS.maxNodes);
      } catch (error) {
        throw fail(error instanceof HttpError ? error : invalid((error as Error).message));
      }
      const contentHash = versionFingerprint({ ...manifest, sections: built.index.sections });
      const outcome = await commitVersion(ctx, reader, p.user.id, design.id, {
        note: (note as string | undefined)?.trim() ?? "",
        fileSha256: contentHash,
        size: built.partBytes + assetBytes,
        formatVersion: manifest.formatVersion,
        docBlob: null,
        manifestBlob: null,
        assets: manifest.assets.map((a) => ({ name: a.name, blob: a.hash, size: a.size })),
        nodeCount: built.nodeCount,
        pageCount: built.pageCount,
        index: built.index,
        contentHash,
      });
      audit(db, p, req.ip, {
        action: "design.upload",
        target: design.id,
        detail: { mode: "incremental", version: outcome.version.number, size: built.partBytes + assetBytes, duplicate: outcome.duplicate },
      });
      return {
        design: publicDesign(db, outcome.design, p),
        version: publicVersion(db, outcome.version, outcome.design.current_version),
        duplicate: outcome.duplicate,
      };
    },
  );
}
