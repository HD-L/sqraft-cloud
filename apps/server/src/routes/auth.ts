/**
 * 登录 / 登出 / 当前用户 / 改密码。
 * - 连续 5 次密码错误锁定该账号 15 分钟（A4）；同一 IP 5 分钟内最多 30 次登录尝试；
 * - 会话 ID 只在 Cookie 里，服务端存哈希；改密码会让该用户的其它会话全部失效。
 */

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";
import { audit } from "../audit";
import { clearSessionCookie, publicUser, requireUser, SESSION_COOKIE, type UserRow } from "../auth";
import { checkPasswordPolicy, generateSecret, hashPassword, sha256, verifyPassword } from "../crypto";
import { badRequest, forbidden, tooMany, unauthorized } from "../errors";

const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;
const IP_WINDOW_MS = 5 * 60 * 1000;
const IP_MAX_ATTEMPTS = 30;

export function authRoutes(app: FastifyInstance, { db, config }: AppContext): void {
  const attempts = new Map<string, number[]>();

  const limitIp = (ip: string) => {
    const now = Date.now();
    const recent = (attempts.get(ip) ?? []).filter((t) => now - t < IP_WINDOW_MS);
    if (recent.length >= IP_MAX_ATTEMPTS) {
      throw tooMany("登录尝试过于频繁，请稍后再试", Math.ceil((IP_WINDOW_MS - (now - recent[0])) / 1000));
    }
    recent.push(now);
    attempts.set(ip, recent);
  };

  app.post<{ Body: { username?: unknown; password?: unknown } }>("/api/v1/auth/login", async (req, reply) => {
    limitIp(req.ip);
    const { username, password } = req.body ?? {};
    if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
      throw badRequest("请输入用户名和密码");
    }
    const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as UserRow | undefined;
    const now = Date.now();
    if (user?.locked_until && user.locked_until > now) {
      audit(db, null, req.ip, { action: "auth.login", target: username, result: "denied", username, detail: { reason: "locked" } });
      throw forbidden(`密码错误次数过多，账号已锁定，请 ${Math.ceil((user.locked_until - now) / 60000)} 分钟后再试`, "account_locked");
    }
    const ok = await verifyPassword(password, user?.password_hash ?? null);
    if (!user || !ok || user.disabled_at !== null) {
      if (user && !ok) {
        const failed = user.failed_logins + 1;
        db.prepare("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?").run(
          failed >= MAX_FAILED ? 0 : failed,
          failed >= MAX_FAILED ? now + LOCK_MS : null,
          user.id,
        );
      }
      audit(db, null, req.ip, { action: "auth.login", target: username, result: "failed", username });
      throw unauthorized("用户名或密码错误");
    }
    db.prepare("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?").run(user.id);

    const sessionId = generateSecret();
    const csrf = generateSecret();
    db.prepare("INSERT INTO sessions (id_hash, user_id, csrf, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").run(
      sha256(sessionId),
      user.id,
      csrf,
      now + config.sessionTtlMs,
      now,
    );
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    reply.setCookie(SESSION_COOKIE, sessionId, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: !config.insecureHttp,
      maxAge: Math.floor(config.sessionTtlMs / 1000),
    });
    audit(db, { user, via: "session" }, req.ip, { action: "auth.login" });
    return { user: publicUser(user), csrfToken: csrf };
  });

  app.post("/api/v1/auth/logout", async (req, reply) => {
    const p = req.principal;
    if (p?.via === "session" && p.sessionHash) {
      db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(p.sessionHash);
      audit(db, p, req.ip, { action: "auth.logout" });
    }
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get("/api/v1/me", async (req) => {
    const p = requireUser(req);
    return {
      user: publicUser(p.user),
      via: p.via,
      ...(p.csrf ? { csrfToken: p.csrf } : {}),
      ...(p.token ? { token: { name: p.token.name, purpose: p.token.purpose, projectIds: p.token.projectIds } } : {}),
    };
  });

  app.post<{ Body: { currentPassword?: unknown; newPassword?: unknown } }>("/api/v1/me/password", async (req) => {
    const p = requireUser(req);
    if (p.via !== "session") throw forbidden("只能在网页上修改密码", "session_required");
    const { currentPassword, newPassword } = req.body ?? {};
    if (typeof currentPassword !== "string" || !(await verifyPassword(currentPassword, p.user.password_hash))) {
      throw badRequest("当前密码不正确", "wrong_password");
    }
    const problem = checkPasswordPolicy(newPassword);
    if (problem) throw badRequest(problem, "weak_password");
    if (newPassword === currentPassword) throw badRequest("新密码不能与当前密码相同", "weak_password");
    const hash = await hashPassword(newPassword as string);
    db.transaction(() => {
      db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?").run(hash, p.user.id);
      db.prepare("DELETE FROM sessions WHERE user_id = ? AND id_hash != ?").run(p.user.id, p.sessionHash);
    })();
    audit(db, p, req.ip, { action: "user.password_change", target: p.user.id });
    return { ok: true };
  });
}
