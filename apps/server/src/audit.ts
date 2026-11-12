/**
 * 审计日志：只追加。记录谁（用户 / 令牌名）、何时、从哪个 IP、做了什么、对象、结果。
 * 密码、令牌、Cookie 永远不进 detail。
 */

import type { Db } from "./db";
import type { Principal } from "./auth";

export interface AuditEntry {
  action: string;
  target?: string | null;
  result?: "ok" | "denied" | "failed";
  detail?: Record<string, unknown> | null;
  /** 未登录场景（登录失败）手动给出用户名 */
  username?: string | null;
}

export interface AuditRow {
  id: number;
  at: number;
  user_id: string | null;
  username: string | null;
  token_name: string | null;
  ip: string | null;
  action: string;
  target: string | null;
  result: string;
  detail: string | null;
}

export function audit(db: Db, principal: Principal | null, ip: string | null, entry: AuditEntry): void {
  db.prepare(
    `INSERT INTO audit (at, user_id, username, token_name, ip, action, target, result, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    Date.now(),
    principal?.user.id ?? null,
    principal?.user.username ?? entry.username ?? null,
    principal?.token?.name ?? null,
    ip,
    entry.action,
    entry.target ?? null,
    entry.result ?? "ok",
    entry.detail ? JSON.stringify(entry.detail) : null,
  );
}

export function pruneAudit(db: Db, retentionDays: number): number {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  return db.prepare("DELETE FROM audit WHERE at < ?").run(cutoff).changes;
}
