/**
 * 组装 Fastify 应用：凭据解析、CSRF、HTTPS 强制、安全响应头、统一错误格式、各路由。
 * `buildApp` 不监听端口，测试直接用 `app.inject`。
 */

import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import cookie from "@fastify/cookie";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config";
import { openDb, type Db } from "./db";
import { BlobStore } from "./storage";
import { checkCsrf, resolvePrincipal } from "./auth";
import { HttpError } from "./errors";
import { ensureAdmin } from "./bootstrap";
import { systemRoutes } from "./routes/system";
import { authRoutes } from "./routes/auth";
import { tokenRoutes } from "./routes/tokens";
import { adminRoutes } from "./routes/admin";
import { projectRoutes } from "./routes/projects";
import { uploadRoutes } from "./routes/uploads";
import { commitRoutes } from "./routes/commits";
import { teamRoutes } from "./routes/team";
import { commentRoutes } from "./routes/comments";
import { readRoutes } from "./routes/read";
import { oauthRoutes } from "./routes/oauth";
import { opsRoutes } from "./routes/ops";
import { mcpRoutes } from "./mcp/server";
import { webRoutes } from "./web";
import { DesignReader } from "./reader";

export interface AppContext {
  db: Db;
  config: Config;
  store: BlobStore;
}

/** 网页只加载同源资源；画布图片来自同源切图接口，样式允许内联（Vue 运行时的 style 绑定）。 */
const CSP =
  "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; " +
  "object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** 不要求 HTTPS 的路径：容器编排的健康检查走的是内部 HTTP。 */
const PLAIN_HTTP_OK = new Set(["/healthz", "/readyz", "/metrics"]);

export async function buildApp(
  config: Config,
  logger: FastifyServerOptions["logger"] = false,
): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  await mkdir(config.dataDir, { recursive: true });
  const store = new BlobStore(config.dataDir);
  await store.init();
  const db = openDb(join(config.dataDir, "sqraft-cloud.db"));
  const ctx: AppContext = { db, config, store };
  await ensureAdmin(ctx);

  const app = Fastify({
    logger,
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
    disableRequestLogging: false,
  });
  await app.register(cookie);
  app.decorateRequest("principal", null);
  // 上传分块：原样交给路由流式写盘，不缓存进内存
  app.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));

  app.addHook("onRequest", async (req) => {
    const path = req.url.split("?")[0];
    if (!config.insecureHttp && req.protocol !== "https" && !PLAIN_HTTP_OK.has(path)) {
      throw new HttpError(403, "https_required", "需要通过 HTTPS 访问（内网部署可设置 SQRAFT_INSECURE_HTTP=1）");
    }
    req.principal = resolvePrincipal(db, req);
    checkCsrf(req);
  });

  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    // 路由自己设过的（切图的长缓存、SVG 的沙箱 CSP、网页静态资源）不覆盖
    if (!reply.hasHeader("Content-Security-Policy")) reply.header("Content-Security-Policy", CSP);
    if (!reply.hasHeader("Cache-Control")) reply.header("Cache-Control", "no-store");
  });

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof HttpError) {
      if (error.status === 429 && error.extra?.retryAfter) reply.header("Retry-After", String(error.extra.retryAfter));
      return reply.status(error.status).send({ error: { code: error.code, message: error.message } });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if ((error as { validation?: unknown }).validation || status === 400) {
      return reply.status(400).send({ error: { code: "bad_request", message: `请求参数不对：${error.message}` } });
    }
    if (status === 413) {
      return reply.status(413).send({ error: { code: "too_large", message: "请求体过大" } });
    }
    if (status === 415) {
      return reply.status(415).send({ error: { code: "unsupported_media_type", message: "不支持的 Content-Type" } });
    }
    req.log.error(error);
    return reply.status(500).send({ error: { code: "internal", message: "服务器内部错误" } });
  });

  let indexHtml: string | null = null;
  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split("?")[0];
    // 网页的前端路由（/designs/xxx 等）回落到 index.html
    // /.well-known/*（MCP 客户端的 OAuth 发现等）必须是真正的 404，回落成网页会让客户端把 HTML 当元数据解析
    if (indexHtml && req.method === "GET" && !path.startsWith("/api/") && path !== "/mcp" && !path.startsWith("/.well-known/")) {
      return reply.type("text/html; charset=utf-8").send(indexHtml);
    }
    reply.status(404).send({ error: { code: "not_found", message: "接口不存在" } });
  });

  systemRoutes(app, ctx);
  authRoutes(app, ctx);
  tokenRoutes(app, ctx);
  adminRoutes(app, ctx);
  const reader = new DesignReader(ctx);
  projectRoutes(app, ctx);
  uploadRoutes(app, ctx, reader);
  commitRoutes(app, ctx, reader);
  teamRoutes(app, ctx);
  commentRoutes(app, ctx);
  oauthRoutes(app, ctx);
  opsRoutes(app, ctx);
  readRoutes(app, ctx, reader);
  mcpRoutes(app, ctx, reader);
  indexHtml = (await webRoutes(app, ctx)).indexHtml;

  app.addHook("onClose", async () => {
    db.close();
  });
  return { app, ctx };
}
