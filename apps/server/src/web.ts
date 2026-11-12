/**
 * 托管网页（apps/web 的构建产物）：同一个 Node 服务提供，不需要单独的前端服务。
 * - 带哈希的 /assets/* 长缓存；index.html 不缓存；
 * - 前端路由（非 /api、非 /mcp 的 GET）回落到 index.html。
 */

import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppContext } from "./app";

function findWebDir(configured: string | null): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = configured ? [configured] : [join(here, "web"), join(here, "../../web/dist"), join(here, "../web/dist")];
  return candidates.find((dir) => existsSync(join(dir, "index.html"))) ?? null;
}

export interface WebHandle {
  /** 前端路由回落用的 index.html；网页未构建时为 null */
  indexHtml: string | null;
}

export async function webRoutes(app: FastifyInstance, { config }: AppContext): Promise<WebHandle> {
  const dir = findWebDir(config.webDir);
  if (!dir) {
    app.get("/", async (_req, reply) =>
      reply.type("text/plain; charset=utf-8").send("sqraft-cloud 正在运行，但网页还没有构建：在仓库根目录执行 pnpm build"),
    );
    return { indexHtml: null };
  }
  await app.register(fastifyStatic, {
    root: dir,
    index: false,
    wildcard: false,
    setHeaders(res, path) {
      res.setHeader("Cache-Control", path.includes(`${join(dir, "assets")}`) ? "public, max-age=31536000, immutable" : "no-store");
    },
  });
  const indexHtml = readFileSync(join(dir, "index.html"), "utf8");
  app.get("/", async (_req, reply) => reply.type("text/html; charset=utf-8").send(indexHtml));
  return { indexHtml };
}
