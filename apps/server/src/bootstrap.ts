/** 首次启动：没有任何管理员时，用 SQRAFT_ADMIN_USER / SQRAFT_ADMIN_PASSWORD 创建一个。 */

import type { AppContext } from "./app";
import { checkPasswordPolicy, hashPassword, newId } from "./crypto";

export type BootstrapResult = "exists" | "created" | "missing-env";

export async function ensureAdmin({ db, config }: AppContext): Promise<BootstrapResult> {
  const admins = (db.prepare("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled_at IS NULL").get() as { n: number }).n;
  if (admins > 0) return "exists";
  if (!config.adminUser || !config.adminPassword) return "missing-env";
  const problem = checkPasswordPolicy(config.adminPassword);
  if (problem) throw new Error(`SQRAFT_ADMIN_PASSWORD 不符合要求：${problem}`);
  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(config.adminUser) as { id: string } | undefined;
  const hash = await hashPassword(config.adminPassword);
  if (existing) {
    db.prepare("UPDATE users SET is_admin = 1, disabled_at = NULL, password_hash = ? WHERE id = ?").run(hash, existing.id);
  } else {
    db.prepare(
      "INSERT INTO users (id, username, password_hash, is_admin, must_change_password, created_at) VALUES (?, ?, ?, 1, 0, ?)",
    ).run(newId(), config.adminUser, hash, Date.now());
  }
  return "created";
}
