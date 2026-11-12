/**
 * 运维接口：
 * - 系统概览（G4）：用户 / 项目 / 设计稿 / 版本数、存储占用、近 7 天上传与 MCP 调用量；
 * - 回收站（D6）：查看、恢复、立即彻底删除；手动触发维护；
 * - Prometheus `/metrics`：设置 SQRAFT_METRICS_TOKEN 后开放，用 Bearer 令牌访问。
 */

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";
import { audit } from "../audit";
import { requireAdmin } from "../auth";
import { safeEqual } from "../crypto";
import { notFound } from "../errors";
import { invalidateStorageCache, runMaintenance, storageUsage } from "../maintenance";
import { APP_VERSION } from "./system";

const DAY = 24 * 60 * 60 * 1000;
const startedAt = Date.now();

export function opsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config } = ctx;
  const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;

  // ── 请求计数（给 /metrics 用）──
  const httpCounts = new Map<string, number>();
  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions.url ?? "unmatched";
    const key = `${req.method}|${route}|${reply.statusCode}`;
    httpCounts.set(key, (httpCounts.get(key) ?? 0) + 1);
  });

  app.get("/api/v1/admin/overview", async (req) => {
    requireAdmin(req);
    const since = Date.now() - 7 * DAY;
    const storage = await storageUsage(ctx);
    return {
      version: APP_VERSION,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      users: count("SELECT COUNT(*) AS n FROM users WHERE disabled_at IS NULL"),
      projects: count("SELECT COUNT(*) AS n FROM projects WHERE archived_at IS NULL"),
      designs: count("SELECT COUNT(*) AS n FROM designs WHERE deleted_at IS NULL"),
      versions: count("SELECT COUNT(*) AS n FROM versions"),
      trash: count("SELECT COUNT(*) AS n FROM designs WHERE deleted_at IS NOT NULL"),
      activeTokens: count("SELECT COUNT(*) AS n FROM tokens WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)", Date.now()),
      storageBytes: storage.bytes,
      blobCount: storage.blobs,
      uploads7d: count("SELECT COUNT(*) AS n FROM audit WHERE action = 'design.upload' AND result = 'ok' AND at >= ?", since),
      mcpCalls7d: count("SELECT COUNT(*) AS n FROM audit WHERE action = 'mcp.call' AND at >= ?", since),
      mcpUsers7d: count("SELECT COUNT(DISTINCT user_id) AS n FROM audit WHERE action = 'mcp.call' AND at >= ?", since),
      trashDays: config.trashDays,
    };
  });

  app.get("/api/v1/admin/trash", async (req) => {
    requireAdmin(req);
    const rows = db
      .prepare(
        `SELECT d.id, d.name, d.deleted_at, p.name AS project_name,
                (SELECT COUNT(*) FROM versions v WHERE v.design_id = d.id) AS version_count
         FROM designs d JOIN projects p ON p.id = d.project_id
         WHERE d.deleted_at IS NOT NULL ORDER BY d.deleted_at DESC`,
      )
      .all() as Array<{ id: string; name: string; deleted_at: number; project_name: string; version_count: number }>;
    return {
      designs: rows.map((r) => ({
        id: r.id,
        name: r.name,
        projectName: r.project_name,
        versionCount: r.version_count,
        deletedAt: r.deleted_at,
        purgeAt: r.deleted_at + config.trashDays * DAY,
      })),
    };
  });

  app.post<{ Params: { id: string } }>("/api/v1/admin/trash/:id/restore", async (req) => {
    const p = requireAdmin(req);
    const res = db.prepare("UPDATE designs SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL").run(Date.now(), req.params.id);
    if (!res.changes) throw notFound("回收站里没有这个设计稿");
    audit(db, p, req.ip, { action: "design.restore", target: req.params.id });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/admin/trash/:id", async (req) => {
    const p = requireAdmin(req);
    const row = db.prepare("SELECT name FROM designs WHERE id = ? AND deleted_at IS NOT NULL").get(req.params.id) as { name: string } | undefined;
    if (!row) throw notFound("回收站里没有这个设计稿");
    db.prepare("DELETE FROM designs WHERE id = ?").run(req.params.id);
    audit(db, p, req.ip, { action: "design.purge", target: req.params.id, detail: { name: row.name } });
    return { ok: true };
  });

  app.post("/api/v1/admin/maintenance", async (req) => {
    const p = requireAdmin(req);
    const report = await runMaintenance(ctx);
    invalidateStorageCache();
    audit(db, p, req.ip, { action: "system.maintenance", detail: { ...report } });
    return report;
  });

  // ── Prometheus ──
  app.get("/metrics", async (req, reply) => {
    const sent = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
    if (!config.metricsToken || !safeEqual(sent, config.metricsToken)) return reply.status(404).send();
    const storage = await storageUsage(ctx);
    const lines: string[] = [];
    const gauge = (name: string, help: string, value: number) => lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value}`);
    gauge("sqraft_users", "启用中的用户数", count("SELECT COUNT(*) AS n FROM users WHERE disabled_at IS NULL"));
    gauge("sqraft_projects", "进行中的项目数", count("SELECT COUNT(*) AS n FROM projects WHERE archived_at IS NULL"));
    gauge("sqraft_designs", "设计稿数（不含回收站）", count("SELECT COUNT(*) AS n FROM designs WHERE deleted_at IS NULL"));
    gauge("sqraft_versions", "设计稿版本数", count("SELECT COUNT(*) AS n FROM versions"));
    gauge("sqraft_storage_bytes", "文件仓库占用字节数", storage.bytes);
    gauge("sqraft_uptime_seconds", "进程运行时长", Math.round((Date.now() - startedAt) / 1000));
    gauge("process_resident_memory_bytes", "进程常驻内存", process.memoryUsage().rss);
    lines.push("# HELP sqraft_http_requests_total HTTP 请求数", "# TYPE sqraft_http_requests_total counter");
    for (const [key, n] of httpCounts) {
      const [method, route, status] = key.split("|");
      lines.push(`sqraft_http_requests_total{method="${method}",route="${route.replace(/"/g, "")}",status="${status}"} ${n}`);
    }
    lines.push("# HELP sqraft_mcp_calls_total MCP 工具调用数（来自审计日志）", "# TYPE sqraft_mcp_calls_total counter");
    const mcp = db
      .prepare("SELECT json_extract(detail, '$.tool') AS tool, result, COUNT(*) AS n FROM audit WHERE action = 'mcp.call' GROUP BY tool, result")
      .all() as Array<{ tool: string | null; result: string; n: number }>;
    for (const r of mcp) lines.push(`sqraft_mcp_calls_total{tool="${(r.tool ?? "").replace(/[^a-z_]/g, "")}",result="${r.result}"} ${r.n}`);
    return reply.type("text/plain; version=0.0.4; charset=utf-8").send(`${lines.join("\n")}\n`);
  });
}
