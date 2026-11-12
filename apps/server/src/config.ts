/**
 * 运行配置：全部来自环境变量（Docker 部署的惯例），缺省值面向单机部署。
 */

import { resolve } from "node:path";

export interface Config {
  /** 数据卷根目录：SQLite 文件、设计稿文件仓库、上传临时文件都在这里 */
  dataDir: string;
  host: string;
  port: number;
  /** 对外访问地址（如 https://design.example.com），用于生成链接；可空 */
  publicUrl: string | null;
  /** 内网模式：允许纯 HTTP。默认关闭——生产环境必须 HTTPS（或在反向代理后由代理终止 TLS） */
  insecureHttp: boolean;
  /** 信任反向代理的 X-Forwarded-* 头（判断 HTTPS、取客户端 IP） */
  trustProxy: boolean;
  /** 首次启动创建的管理员；已有管理员时忽略 */
  adminUser: string | null;
  adminPassword: string | null;
  /** 单个设计稿文件上限（字节） */
  maxUploadBytes: number;
  /** 网页会话有效期（毫秒） */
  sessionTtlMs: number;
  /** 令牌最长有效期（天）；null = 允许不过期 */
  tokenMaxDays: number | null;
  /** 审计日志保留天数 */
  auditRetentionDays: number;
}

const DAY = 24 * 60 * 60 * 1000;

function flag(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes";
}

function int(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`环境变量 ${name} 需要非负整数，收到 "${value}"`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const tokenMaxDays = int(env.SQRAFT_TOKEN_MAX_DAYS, 0, "SQRAFT_TOKEN_MAX_DAYS");
  return {
    dataDir: resolve(env.SQRAFT_DATA_DIR ?? "./data"),
    host: env.SQRAFT_HOST ?? "0.0.0.0",
    port: int(env.SQRAFT_PORT, 8080, "SQRAFT_PORT"),
    publicUrl: env.SQRAFT_PUBLIC_URL?.replace(/\/+$/, "") || null,
    insecureHttp: flag(env.SQRAFT_INSECURE_HTTP),
    trustProxy: flag(env.SQRAFT_TRUST_PROXY),
    adminUser: env.SQRAFT_ADMIN_USER || null,
    adminPassword: env.SQRAFT_ADMIN_PASSWORD || null,
    maxUploadBytes: int(env.SQRAFT_MAX_UPLOAD_MB, 2048, "SQRAFT_MAX_UPLOAD_MB") * 1024 * 1024,
    sessionTtlMs: int(env.SQRAFT_SESSION_DAYS, 7, "SQRAFT_SESSION_DAYS") * DAY,
    tokenMaxDays: tokenMaxDays === 0 ? null : tokenMaxDays,
    auditRetentionDays: int(env.SQRAFT_AUDIT_DAYS, 180, "SQRAFT_AUDIT_DAYS"),
  };
}
