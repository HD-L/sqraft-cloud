/** 健康检查与服务信息（上传客户端连接前先调 /api/v1/info 校验）。 */

import type { FastifyInstance } from "fastify";
import { CURRENT_FORMAT_VERSION } from "@sqraft/core";
import type { AppContext } from "../app";

export const API_VERSION = 1;
export const APP_VERSION = "0.1.0";

export function systemRoutes(app: FastifyInstance, { db }: AppContext): void {
  app.get("/healthz", async () => ({ ok: true }));

  app.get("/readyz", async (_req, reply) => {
    try {
      db.prepare("SELECT 1").get();
      return { ok: true };
    } catch {
      return reply.status(503).send({ ok: false });
    }
  });

  app.get("/api/v1/info", async () => ({
    app: "sqraft-cloud",
    version: APP_VERSION,
    apiVersion: API_VERSION,
    formatVersion: { min: 1, max: CURRENT_FORMAT_VERSION },
  }));
}
