/**
 * 进程入口。
 *
 *   node server.mjs                         启动服务
 *   node server.mjs backup [--out <file>]   备份到 .tar.gz（服务运行中也能执行），默认 <数据目录>/backups/
 *   node server.mjs restore <file> [--force] 从备份恢复到数据目录（需先停服务）
 *   node server.mjs gc                      立即执行维护：清理回收站、回收孤儿文件
 *
 * 服务每小时清理过期会话与超期审计日志，每天执行一次维护任务。
 */

import { join } from "node:path";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import { ensureAdmin } from "./bootstrap";
import { pruneAudit } from "./audit";
import { createBackup, defaultBackupName, restoreBackup } from "./backup";
import { runMaintenance } from "./maintenance";

const HOUR = 60 * 60 * 1000;

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function size(n: number): string {
  return n < 1024 ** 3 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;
}

async function serve(): Promise<void> {
  const config = loadConfig();
  const { app, ctx } = await buildApp(config, {
    level: process.env.SQRAFT_LOG_LEVEL ?? "info",
    redact: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
  });

  if ((await ensureAdmin(ctx)) === "missing-env") {
    app.log.warn("还没有任何管理员：请设置 SQRAFT_ADMIN_USER 与 SQRAFT_ADMIN_PASSWORD 后重启");
  }
  if (config.insecureHttp) app.log.warn("已开启内网模式（SQRAFT_INSECURE_HTTP），允许纯 HTTP 访问，凭据可能被窃听");

  let lastMaintenance = 0;
  const sweep = async () => {
    ctx.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
    pruneAudit(ctx.db, config.auditRetentionDays);
    if (Date.now() - lastMaintenance >= 24 * HOUR) {
      lastMaintenance = Date.now();
      try {
        const r = await runMaintenance(ctx);
        app.log.info({ maintenance: r }, `维护完成：清理回收站 ${r.purgedDesigns} 个设计稿，回收 ${r.deletedBlobs} 个文件（${size(r.freedBytes)}）`);
      } catch (error) {
        app.log.error(error, "维护任务失败");
      }
    }
  };
  void sweep();
  const timer = setInterval(() => void sweep(), HOUR);
  timer.unref();

  const shutdown = async () => {
    clearInterval(timer);
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await app.listen({ host: config.host, port: config.port });
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const config = loadConfig();
  switch (command) {
    case undefined:
    case "serve":
      return serve();
    case "backup": {
      const out = flagValue(args, "--out") ?? defaultBackupName(join(config.dataDir, "backups"));
      const started = Date.now();
      const r = await createBackup(config.dataDir, out);
      console.log(`✔ 已备份到 ${r.file}（数据库版本 ${r.schemaVersion}，${r.blobs} 个文件，用时 ${((Date.now() - started) / 1000).toFixed(1)}s）`);
      return;
    }
    case "restore": {
      const file = args.find((a) => !a.startsWith("--"));
      if (!file) throw new Error("用法：node server.mjs restore <备份文件> [--force]");
      const m = await restoreBackup(file, config.dataDir, args.includes("--force"));
      console.log(`✔ 已恢复 ${m.createdAt} 的备份（来自 ${m.version}，${m.blobs} 个文件）到 ${config.dataDir}。启动服务即可。`);
      return;
    }
    case "gc": {
      const { ctx, app } = await buildApp(config);
      try {
        const r = await runMaintenance(ctx);
        console.log(`✔ 清理回收站 ${r.purgedDesigns} 个设计稿；回收 ${r.deletedBlobs} 个孤儿文件（${size(r.freedBytes)}），保留 ${r.keptBlobs} 个；清理临时文件 ${r.tmpFiles} 个`);
      } finally {
        await app.close();
      }
      return;
    }
    default:
      throw new Error(`未知命令：${command}（可用：serve / backup / restore / gc）`);
  }
}

main().catch((error: unknown) => {
  console.error(`✘ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
