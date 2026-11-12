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

type VersionParams = { id: string; v: string };

function sendAsset(reply: FastifyReply, ctx: AppContext, idx: VersionIndex, assetId: string) {
  const asset = idx.assets[assetId];
  if (!asset) throw notFound("切图不存在");
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
    return {
      version: version.number,
      pages: idx.pages.map(({ blob: _b, ...p }) => p),
    };
  });

  app.get<{ Params: VersionParams & { pageId: string } }>("/api/v1/designs/:id/versions/:v/pages/:pageId", async (req) => {
    const { version, idx } = await open(req, req.params);
    if (!idx.pages.some((p) => p.id === req.params.pageId)) throw notFound("页面不存在");
    return { version: version.number, doc: await reader.subtreeDoc(version, idx, req.params.pageId) };
  });

  app.get<{ Params: VersionParams }>("/api/v1/designs/:id/versions/:v/components", async (req) => {
    const { version, idx } = await open(req, req.params);
    return { version: version.number, components: idx.components.map(({ blob: _b, ...c }) => c) };
  });

  app.get<{ Params: VersionParams }>("/api/v1/designs/:id/versions/:v/tokens", async (req) => {
    const { version, idx } = await open(req, req.params);
    return { version: version.number, tokens: idx.tokens };
  });

  app.get<{ Params: VersionParams & { assetId: string } }>("/api/v1/designs/:id/versions/:v/assets/:assetId", async (req, reply) => {
    const { idx } = await open(req, req.params);
    return sendAsset(reply, ctx, idx, req.params.assetId);
  });

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
