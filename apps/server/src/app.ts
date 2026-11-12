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

export interface AppContext {
  db: Db;
  config: Config;
  store: BlobStore;
}

/** 不要求 HTTPS 的路径：容器编排的健康检查走的是内部 HTTP。 */
const PLAIN_HTTP_OK = new Set(["/healthz", "/readyz"]);

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
    reply.header("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    reply.header("Cache-Control", "no-store");
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

  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send({ error: { code: "not_found", message: "接口不存在" } });
  });

  systemRoutes(app, ctx);
  authRoutes(app, ctx);
  tokenRoutes(app, ctx);
  adminRoutes(app, ctx);
  projectRoutes(app, ctx);
  uploadRoutes(app, ctx);

  app.addHook("onClose", async () => {
    db.close();
  });
  return { app, ctx };
}
