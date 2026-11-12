/**
 * 团队与成员（E1–E5）、个人资料、最近浏览（B5）、全局搜索（F2）、上传客户端下载（F3）。
 *
 * 成员由管理员直接建账号（给初始密码，首次登录必须改密码），团队角色：管理员 / 编辑者 / 查看者。
 * 「移除成员」= 停用账号：立刻下线、吊销令牌，评论等历史记录保留；可以恢复。
 */

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";
import { audit } from "../audit";
import { projectRole, publicUser, requireAdmin, requireSession, requireUser, TEAM_ROLES, type Principal, type TeamRole, type UserRow } from "../auth";
import { checkPasswordPolicy, generatePassword, hashPassword, newId } from "../crypto";
import type { Db } from "../db";
import { badRequest, conflict, notFound } from "../errors";
import { nameOf, notify } from "../notify";
import { publicDesign, type DesignRow } from "./projects";

export const USERNAME = /^[A-Za-z0-9._@-]{2,64}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const ROLE_LABEL: Record<TeamRole, string> = { admin: "管理员", editor: "编辑者", viewer: "查看者" };
const DEFAULT_TEAM = { name: "我的团队", description: "" };

function checkDisplayName(v: unknown): string {
  if (typeof v !== "string" || v.length > 50) throw badRequest("姓名最多 50 个字符");
  return v.trim();
}

function checkEmail(v: unknown): string {
  if (typeof v !== "string" || (v.trim() && (!EMAIL.test(v.trim()) || v.length > 200))) throw badRequest("邮箱格式不对");
  return v.trim();
}

function checkRole(v: unknown): TeamRole {
  if (!TEAM_ROLES.includes(v as TeamRole)) throw badRequest("角色只能是 admin（管理员）、editor（编辑者）或 viewer（查看者）");
  return v as TeamRole;
}

const activeAdmins = (db: Db) => (db.prepare("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled_at IS NULL").get() as { n: number }).n;

export function teamInfo(db: Db): { name: string; description: string } {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'team'").get() as { value: string } | undefined;
  return row ? { ...DEFAULT_TEAM, ...(JSON.parse(row.value) as object) } : DEFAULT_TEAM;
}

/** 建成员账号；没给密码就生成一个初始密码返回（只显示一次）。 */
export async function createMember(
  db: Db,
  p: Principal,
  ip: string,
  input: { username?: unknown; password?: unknown; role?: unknown; isAdmin?: unknown; displayName?: unknown; email?: unknown },
): Promise<{ user: UserRow; initialPassword: string | null }> {
  const { username, password } = input;
  if (typeof username !== "string" || !USERNAME.test(username)) throw badRequest("用户名 2–64 位，只能包含字母、数字和 . _ @ -");
  if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) throw conflict("用户名已存在", "username_taken");
  const role = input.role !== undefined ? checkRole(input.role) : input.isAdmin === true ? "admin" : "viewer";
  const displayName = input.displayName === undefined ? "" : checkDisplayName(input.displayName);
  const email = input.email === undefined ? "" : checkEmail(input.email);
  let initial: string | null = null;
  if (password !== undefined) {
    const problem = checkPasswordPolicy(password);
    if (problem) throw badRequest(problem, "weak_password");
  } else {
    initial = generatePassword();
  }
  const user: UserRow = {
    id: newId(),
    username,
    password_hash: await hashPassword((password as string | undefined) ?? (initial as string)),
    is_admin: role === "admin" ? 1 : 0,
    must_change_password: 1,
    disabled_at: null,
    failed_logins: 0,
    locked_until: null,
    created_at: Date.now(),
    role,
    display_name: displayName,
    email,
  };
  db.prepare(
    `INSERT INTO users (id, username, password_hash, is_admin, role, display_name, email, must_change_password, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(user.id, user.username, user.password_hash, user.is_admin, role, displayName, email, user.created_at);
  audit(db, p, ip, { action: "user.create", target: user.id, detail: { username, role } });
  notify(db, user.id, "invited", p.user.id, `${nameOf(p.user)} 邀请你加入「${teamInfo(db).name}」，角色：${ROLE_LABEL[role]}`, "/");
  return { user, initialPassword: initial };
}

/** 改团队角色；保证至少留一个可用的管理员，且不能撤掉自己的管理员身份。 */
export function setRole(db: Db, p: Principal, ip: string, user: UserRow, role: TeamRole): void {
  if (user.role === role && (user.is_admin === 1) === (role === "admin")) return;
  if (user.is_admin === 1 && role !== "admin") {
    if (user.id === p.user.id) throw badRequest("不能取消自己的管理员身份");
    if (activeAdmins(db) <= 1) throw badRequest("至少要保留一个可用的管理员");
  }
  db.prepare("UPDATE users SET role = ?, is_admin = ? WHERE id = ?").run(role, role === "admin" ? 1 : 0, user.id);
  audit(db, p, ip, { action: "user.set_role", target: user.id, detail: { role } });
}

/** 停用 / 恢复账号。停用 = 立刻下线 + 吊销全部令牌。 */
export function setDisabled(db: Db, p: Principal, ip: string, user: UserRow, disabled: boolean): void {
  if (disabled && user.id === p.user.id) throw badRequest("不能移除自己");
  if (disabled && user.is_admin === 1 && user.disabled_at === null && activeAdmins(db) <= 1) throw badRequest("至少要保留一个可用的管理员");
  db.transaction(() => {
    db.prepare("UPDATE users SET disabled_at = ? WHERE id = ?").run(disabled ? Date.now() : null, user.id);
    if (disabled) {
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
      db.prepare("UPDATE tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(Date.now(), user.id);
    }
  })();
  audit(db, p, ip, { action: disabled ? "user.disable" : "user.enable", target: user.id });
}

export async function resetPassword(db: Db, p: Principal, ip: string, user: UserRow): Promise<string> {
  const pw = generatePassword();
  const hash = await hashPassword(pw);
  db.transaction(() => {
    db.prepare("UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL WHERE id = ?").run(hash, user.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
  })();
  audit(db, p, ip, { action: "user.reset_password", target: user.id });
  return pw;
}

export function teamRoutes(app: FastifyInstance, { db, config }: AppContext): void {
  const loadUser = (id: string) => {
    const u = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    if (!u) throw notFound("成员不存在");
    return u;
  };

  // ── 团队信息 ──
  app.get("/api/v1/team", async (req) => {
    requireUser(req);
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    return {
      team: teamInfo(db),
      stats: {
        members: count("SELECT COUNT(*) AS n FROM users WHERE disabled_at IS NULL"),
        admins: count("SELECT COUNT(*) AS n FROM users WHERE disabled_at IS NULL AND is_admin = 1"),
        projects: count("SELECT COUNT(*) AS n FROM projects WHERE archived_at IS NULL"),
        designs: count("SELECT COUNT(*) AS n FROM designs WHERE deleted_at IS NULL"),
      },
    };
  });

  app.patch<{ Body: { name?: unknown; description?: unknown } }>("/api/v1/team", async (req) => {
    const p = requireAdmin(req);
    const team = { ...teamInfo(db) };
    const { name, description } = req.body ?? {};
    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim() || name.length > 50) throw badRequest("团队名称必填，最多 50 个字符");
      team.name = name.trim();
    }
    if (description !== undefined) {
      if (typeof description !== "string" || description.length > 200) throw badRequest("团队简介最多 200 个字符");
      team.description = description.trim();
    }
    db.prepare("INSERT INTO settings (key, value) VALUES ('team', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify(team));
    audit(db, p, req.ip, { action: "team.update", detail: team });
    return { team };
  });

  // ── 成员 ──
  // 所有成员都能看到成员列表（评论里 @ 人要用）；管理员加 ?all=1 还能看到已移除的
  app.get<{ Querystring: { all?: string } }>("/api/v1/team/members", async (req) => {
    const p = requireUser(req);
    const all = req.query.all === "1" && p.user.is_admin === 1;
    const rows = db.prepare(`SELECT * FROM users ${all ? "" : "WHERE disabled_at IS NULL"} ORDER BY created_at`).all() as UserRow[];
    const lastSeen = db.prepare("SELECT MAX(created_at) AS t FROM sessions WHERE user_id = ?");
    return {
      members: rows.map((u) => ({
        ...publicUser(u),
        ...(p.user.is_admin === 1 ? { lastLoginAt: (lastSeen.get(u.id) as { t: number | null }).t } : {}),
      })),
    };
  });

  app.post<{ Body: Record<string, unknown> }>("/api/v1/team/members", async (req) => {
    const p = requireAdmin(req);
    const { user, initialPassword } = await createMember(db, p, req.ip, req.body ?? {});
    return { member: publicUser(user), ...(initialPassword ? { initialPassword } : {}) };
  });

  app.patch<{ Params: { id: string }; Body: { role?: unknown; displayName?: unknown; email?: unknown; resetPassword?: unknown } }>(
    "/api/v1/team/members/:id",
    async (req) => {
      const p = requireAdmin(req);
      const user = loadUser(req.params.id);
      const { role, displayName, email } = req.body ?? {};
      if (displayName !== undefined) db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(checkDisplayName(displayName), user.id);
      if (email !== undefined) db.prepare("UPDATE users SET email = ? WHERE id = ?").run(checkEmail(email), user.id);
      if (role !== undefined) setRole(db, p, req.ip, user, checkRole(role));
      const pw = req.body?.resetPassword === true ? await resetPassword(db, p, req.ip, user) : null;
      return { member: publicUser(loadUser(user.id)), ...(pw ? { initialPassword: pw } : {}) };
    },
  );

  app.delete<{ Params: { id: string } }>("/api/v1/team/members/:id", async (req) => {
    const p = requireAdmin(req);
    setDisabled(db, p, req.ip, loadUser(req.params.id), true);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/v1/team/members/:id/restore", async (req) => {
    const p = requireAdmin(req);
    setDisabled(db, p, req.ip, loadUser(req.params.id), false);
    return { member: publicUser(loadUser(req.params.id)) };
  });

  // ── 个人资料 ──
  app.patch<{ Body: { displayName?: unknown; email?: unknown } }>("/api/v1/me", async (req) => {
    const p = requireSession(req);
    const { displayName, email } = req.body ?? {};
    if (displayName !== undefined) db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(checkDisplayName(displayName), p.user.id);
    if (email !== undefined) db.prepare("UPDATE users SET email = ? WHERE id = ?").run(checkEmail(email), p.user.id);
    return { user: publicUser(loadUser(p.user.id)) };
  });

  // ── 最近浏览 ──
  app.get("/api/v1/me/recent", async (req) => {
    const p = requireUser(req);
    const rows = db
      .prepare(
        `SELECT d.*, r.viewed_at, pr.name AS project_name FROM recent_views r
         JOIN designs d ON d.id = r.design_id JOIN projects pr ON pr.id = d.project_id
         WHERE r.user_id = ? AND d.deleted_at IS NULL ORDER BY r.viewed_at DESC LIMIT 60`,
      )
      .all(p.user.id) as Array<DesignRow & { viewed_at: number; project_name: string }>;
    const designs = rows
      .filter((d) => projectRole(db, p, d.project_id))
      .slice(0, 30)
      .map((d) => ({ ...publicDesign(db, d), projectName: d.project_name, viewedAt: d.viewed_at }));
    return { designs };
  });

  // ── 全局搜索：项目、设计稿、成员（只返回有权限看到的）──
  app.get<{ Querystring: { q?: string } }>("/api/v1/search", async (req) => {
    const p = requireUser(req);
    const q = (req.query.q ?? "").trim();
    if (!q) return { projects: [], designs: [], members: [] };
    if (q.length > 100) throw badRequest("搜索词太长");
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const projects = (
      db.prepare("SELECT * FROM projects WHERE (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\') ORDER BY name").all(like, like) as Array<{
        id: string;
        name: string;
        description: string;
        archived_at: number | null;
      }>
    )
      .filter((r) => projectRole(db, p, r.id))
      .slice(0, 10)
      .map((r) => ({ id: r.id, name: r.name, description: r.description, archived: r.archived_at !== null }));
    const designs = (
      db
        .prepare(
          `SELECT d.*, pr.name AS project_name FROM designs d JOIN projects pr ON pr.id = d.project_id
           WHERE d.deleted_at IS NULL AND d.name LIKE ? ESCAPE '\\' ORDER BY d.updated_at DESC LIMIT 200`,
        )
        .all(like) as Array<DesignRow & { project_name: string }>
    )
      .filter((d) => projectRole(db, p, d.project_id))
      .slice(0, 10)
      .map((d) => ({ ...publicDesign(db, d), projectName: d.project_name }));
    const members = (
      db
        .prepare("SELECT * FROM users WHERE disabled_at IS NULL AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\') LIMIT 10")
        .all(like, like) as UserRow[]
    ).map((u) => ({ id: u.id, username: u.username, displayName: nameOf(u), role: u.role }));
    return { projects, designs, members };
  });

  // ── 上传客户端下载入口 ──
  app.get("/api/v1/client", async (req) => {
    requireUser(req);
    return { downloadUrl: config.uploaderUrl, platform: "macOS（Apple Silicon）" };
  });
}
