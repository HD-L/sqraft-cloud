/** 进程入口：读配置、建应用、监听端口；每小时清理过期会话与超期审计日志。 */

import { buildApp } from "./app";
import { loadConfig } from "./config";
import { ensureAdmin } from "./bootstrap";
import { pruneAudit } from "./audit";

async function main(): Promise<void> {
  const config = loadConfig();
  const { app, ctx } = await buildApp(config, {
    level: process.env.SQRAFT_LOG_LEVEL ?? "info",
    redact: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
  });

  if ((await ensureAdmin(ctx)) === "missing-env") {
    app.log.warn("还没有任何管理员：请设置 SQRAFT_ADMIN_USER 与 SQRAFT_ADMIN_PASSWORD 后重启");
  }
  if (config.insecureHttp) app.log.warn("已开启内网模式（SQRAFT_INSECURE_HTTP），允许纯 HTTP 访问，凭据可能被窃听");

  const sweep = () => {
    ctx.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
    pruneAudit(ctx.db, config.auditRetentionDays);
  };
  sweep();
  const timer = setInterval(sweep, 60 * 60 * 1000);
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

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
