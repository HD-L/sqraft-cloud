/**
 * 设计稿只读接口（网页查看用，W1–W3）：页面列表、单页节点、组件、Token、切图。
 * `:v` 为版本号或 `current`。切图按内容寻址，可长期缓存。
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { createReadStream } from "node:fs";
import type { AppContext } from "../app";
import { requireUser } from "../auth";
import { notFound } from "../errors";
import type { DesignReader } from "../reader";
import type { VersionIndex } from "../indexer";
import { loadDesign, type DesignRow } from "./projects";
import { resolveChangedIn } from "../changes";
import { sectionsOf } from "../sections";

type VersionParams = { id: string; v: string };

function sendSvg(reply: FastifyReply, result: { svg: string; name: string }) {
  reply.header("Content-Type", "image/svg+xml; charset=utf-8");
  // 以附件下载；即使在浏览器里直接打开也不执行任何脚本
  reply.header("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
  reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${result.name}.svg`)}`);
  return reply.send(result.svg);
}

/** 下载用的文件名：调用方给的名字（去掉路径和控制字符，按字符截到 120 个）+ 切图本身的扩展名 */
function downloadName(asset: { name: string }, wanted: string): string {
  const ext = asset.name.includes(".") ? asset.name.slice(asset.name.lastIndexOf(".")) : "";
  const cleaned = wanted.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_").trim();
  // 按码点截断，不能把代理对切成半个（否则 encodeURIComponent 会抛错）
  const base = Array.from(cleaned).slice(0, 120).join("");
  return base ? `${base}${ext}` : asset.name;
}

/** RFC 5987 / 8187 的 ext-value：encodeURIComponent 不转义的 ' ( ) * ! 也要转义，否则浏览器不认 */
function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sendAsset(reply: FastifyReply, ctx: AppContext, idx: VersionIndex, assetId: string, download?: unknown) {
  const asset = idx.assets[assetId];
  if (!asset) throw notFound("切图不存在");
  // ?download=<文件名>：作为附件下载（标注面板的「下载切图」）
  if (typeof download === "string") reply.header("Content-Disposition", `attachment; filename*=UTF-8''${rfc5987(downloadName(asset, download))}`);
  reply.header("Content-Type", asset.mime);
  reply.header("Content-Length", String(asset.size));
  reply.header("Cache-Control", "private, max-age=31536000, immutable");
  // SVG 可能内嵌脚本：作为下载处理，禁止在本站上下文里执行
  if (asset.mime === "image/svg+xml") reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  return reply.send(createReadStream(ctx.store.path(asset.blob)));
}

export function readRoutes(app: FastifyInstance, ctx: AppContext, reader: DesignReader): void {
  const { db } = ctx;

  const open = async (req: Parameters<typeof requireUser>[0], params: VersionParams) => {
    const p = requireUser(req);
    const design = loadDesign(db, p, params.id, "viewer");
    const version = reader.resolveVersion(design, params.v);
    return { design, version, idx: await reader.index(version) };
  };

  app.get<{ Params: VersionParams }>("/api/v1/designs/:id/versions/:v/pages", async (req) => {
    const { version, idx } = await open(req, req.params);
    // 按分组、组内按画布阅读顺序排列；sections 给出分组名与成员（inferred = 按画布推断的）
    const sections = sectionsOf(idx);
    const byId = new Map(idx.pages.map((p) => [p.id, p]));
    const pages = sections.flatMap((s) =>
      s.pageIds.map((id) => {
        const { blob: _b, contentHash: _h, uses: _u, changedIn, ...p } = byId.get(id)!;
        return { ...p, section: s.name, changedIn: resolveChangedIn({ changedIn }, version.number) ?? null };
      }),
    );
    return { version: version.number, sections, pages };
  });

  // 这个版本相对基准版本改了什么（页面 / 组件 / Token / 切图）
  app.get<{ Params: VersionParams }>("/api/v1/designs/:id/versions/:v/changes", async (req) => {
    const { version } = await open(req, req.params);
    return { version: version.number, changes: await reader.changesOf(version) };
  });

  app.get<{ Params: VersionParams & { pageId: string } }>("/api/v1/designs/:id/versions/:v/pages/:pageId", async (req) => {
    const { version, idx } = await open(req, req.params);
    if (!idx.pages.some((p) => p.id === req.params.pageId)) throw notFound("页面不存在");
    return { version: version.number, doc: await reader.subtreeDoc(version, idx, req.params.pageId) };
  });

  // 单页节点的原始数据（{"nodes":{…},"rootIds":[id]}，不含 Token）：文件仓库里本来就是 gzip，直接带
  // Content-Encoding: gzip 发出去，不解压、不重新序列化。内容按哈希寻址，可长期缓存。总览画布批量加载缩略图用。
  app.get<{ Params: VersionParams & { pageId: string } }>("/api/v1/designs/:id/versions/:v/parts/:pageId", async (req, reply) => {
    const { idx } = await open(req, req.params);
    const entry = idx.pages.find((p) => p.id === req.params.pageId) ?? idx.components.find((c) => c.id === req.params.pageId);
    if (!entry) throw notFound("页面不存在");
    // 先确认能读到内容再设缓存头：读失败时的错误响应不能带着长缓存被浏览器存下来
    const head = await ctx.store.head(entry.blob, 2);
    const gzipped = head[0] === 0x1f && head[1] === 0x8b;
    const sendGzip = gzipped && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
    const text = sendGzip ? null : await ctx.store.getText(entry.blob);
    const setCacheHeaders = () => {
      // 具体版本号的地址内容不会变，可长期缓存；`current` 会随发布变化，只能每次用 ETag 校验
      const pinned = /^\d+$/.test(req.params.v);
      reply.header("Cache-Control", pinned ? "private, max-age=31536000, immutable" : "private, no-cache");
      reply.header("ETag", `"${entry.blob}"`);
      reply.header("Vary", "Accept-Encoding");
    };
    if (req.headers["if-none-match"] === `"${entry.blob}"`) {
      setCacheHeaders();
      return reply.status(304).send();
    }
    reply.header("Content-Type", "application/json; charset=utf-8");
    if (text !== null) {
      setCacheHeaders();
      return reply.send(text);
    }
    const stream = createReadStream(ctx.store.path(entry.blob));
    await new Promise<void>((resolve, reject) => stream.once("open", () => resolve()).once("error", reject));
    setCacheHeaders();
    reply.header("Content-Encoding", "gzip");
    return reply.send(stream);
  });

  app.get<{ Params: VersionParams }>("/api/v1/designs/:id/versions/:v/components", async (req) => {
    const { version, idx } = await open(req, req.params);
    return {
      version: version.number,
      components: idx.components.map(({ blob: _b, contentHash: _h, uses: _u, changedIn, ...c }) => ({
        ...c,
        changedIn: resolveChangedIn({ changedIn }, version.number) ?? null,
      })),
    };
  });

  app.get<{ Params: VersionParams }>("/api/v1/designs/:id/versions/:v/tokens", async (req) => {
    const { version, idx } = await open(req, req.params);
    return { version: version.number, tokens: idx.tokens };
  });

  app.get<{ Params: VersionParams & { assetId: string }; Querystring: { download?: unknown } }>(
    "/api/v1/designs/:id/versions/:v/assets/:assetId",
    async (req, reply) => {
      const { idx } = await open(req, req.params);
      return sendAsset(reply, ctx, idx, req.params.assetId, req.query.download);
    },
  );

  app.get<{ Params: VersionParams & { nodeId: string }; Querystring: { root?: string } }>(
    "/api/v1/designs/:id/versions/:v/nodes/:nodeId/svg",
    async (req, reply) => {
      const { version, idx } = await open(req, req.params);
      return sendSvg(reply, await reader.exportSvg(version, idx, req.params.nodeId, req.query.root || undefined));
    },
  );

  // 签名链接（MCP export_svg 给出）：不需要登录，10 分钟有效，设计稿删除后立即失效
  app.get<{ Params: { designId: string; v: string; rootId: string; file: string }; Querystring: { exp?: string; sig?: string } }>(
    "/api/v1/exports/:designId/:v/:rootId/:file",
    async (req, reply) => {
      const { designId, v, rootId, file } = req.params;
      const path = `/api/v1/exports/${designId}/${v}/${encodeURIComponent(rootId)}/${encodeURIComponent(file)}`;
      if (!file.endsWith(".svg") || !reader.verifyAssetPath(path, req.query.exp, req.query.sig)) throw notFound("链接无效或已过期");
      const design = db.prepare("SELECT * FROM designs WHERE id = ?").get(designId) as DesignRow | undefined;
      if (!design || design.deleted_at !== null) throw notFound("链接无效或已过期");
      const version = reader.resolveVersion(design, v);
      return sendSvg(reply, await reader.exportSvg(version, await reader.index(version), file.slice(0, -4), rootId));
    },
  );

  // 签名链接：不需要登录（链接本身就是 10 分钟有效的凭据），设计稿被删除后立即失效
  app.get<{ Params: { designId: string; v: string; assetId: string }; Querystring: { exp?: string; sig?: string } }>(
    "/api/v1/assets/:designId/:v/:assetId",
    async (req, reply) => {
      const { designId, v, assetId } = req.params;
      const path = `/api/v1/assets/${designId}/${v}/${assetId}`;
      if (!reader.verifyAssetPath(path, req.query.exp, req.query.sig)) throw notFound("链接无效或已过期");
      const design = db.prepare("SELECT * FROM designs WHERE id = ?").get(designId) as DesignRow | undefined;
      if (!design || design.deleted_at !== null) throw notFound("链接无效或已过期");
      const version = reader.resolveVersion(design, v);
      return sendAsset(reply, ctx, await reader.index(version), assetId);
    },
  );
}
