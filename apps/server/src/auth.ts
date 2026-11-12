/**
 * 身份与权限。
 *
 * 两种凭据：
 * - 网页会话：HttpOnly Cookie，写请求必须带 `X-CSRF-Token`；
 * - 令牌：`Authorization: Bearer sqr_…`，用途分 `mcp`（只读）和 `uploader`（可上传），可限定项目。
 *
 * 权限：每个人有团队角色（管理员 / 编辑者 / 查看者）和项目可见范围：
 * - 可见范围 all：团队角色默认对所有项目生效；assigned：只能看到单独分配了的项目（新项目默认看不到）；
 * - 项目里可以单独覆盖成编辑者、查看者或「看不到」（members 表）。
 * 管理员对所有项目都是编辑者。
 *
 * 权限检查一律在服务端做；看不到的资源返回 404。
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "./db";
import { safeEqual, sha256, TOKEN_PREFIX } from "./crypto";
import { forbidden, notFound, unauthorized } from "./errors";

export const SESSION_COOKIE = "sqraft_session";

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  is_admin: number;
  must_change_password: number;
  disabled_at: number | null;
  failed_logins: number;
  locked_until: number | null;
  created_at: number;
  role: TeamRole;
  display_name: string;
  email: string;
  project_scope: ProjectScope;
}

export type ProjectScope = "all" | "assigned";

export type TeamRole = "admin" | "editor" | "viewer";
export const TEAM_ROLES: TeamRole[] = ["admin", "editor", "viewer"];
/** 项目里的覆盖：none = 这个项目对他不可见 */
export type ProjectOverride = "editor" | "viewer" | "none";

export interface Principal {
  user: UserRow;
  via: "session" | "token";
  /** 会话的 CSRF 令牌（仅 via=session） */
  csrf?: string;
  sessionHash?: string;
  token?: { id: string; name: string; purpose: "mcp" | "uploader"; projectIds: string[] | null };
}

export type Role = "viewer" | "editor";

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export function publicUser(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name || u.username,
    email: u.email,
    role: u.role,
    projectScope: u.project_scope,
    isAdmin: u.is_admin === 1,
    mustChangePassword: u.must_change_password === 1,
    disabled: u.disabled_at !== null,
    createdAt: u.created_at,
  };
}

/** 解析请求上的凭据；无效凭据视为未登录（不报错，由路由决定是否要求登录）。 */
export function resolvePrincipal(db: Db, req: FastifyRequest): Principal | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    const raw = header.slice(7).trim();
    if (!raw.startsWith(TOKEN_PREFIX)) return null;
    const row = db
      .prepare(
        `SELECT t.id AS tid, t.name AS tname, t.purpose, t.project_ids, t.expires_at, t.revoked_at, u.*
         FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
      )
      .get(sha256(raw)) as
      | (UserRow & { tid: string; tname: string; purpose: "mcp" | "uploader"; project_ids: string | null; expires_at: number | null; revoked_at: number | null })
      | undefined;
    const now = Date.now();
    if (!row || row.revoked_at !== null || row.disabled_at !== null) return null;
    if (row.expires_at !== null && row.expires_at <= now) return null;
    db.prepare("UPDATE tokens SET last_used_at = ?, last_used_ip = ? WHERE id = ?").run(now, req.ip, row.tid);
    const { tid, tname, purpose, project_ids, expires_at: _e, revoked_at: _r, ...user } = row;
    return {
      user: user as UserRow,
      via: "token",
      token: { id: tid, name: tname, purpose, projectIds: project_ids ? (JSON.parse(project_ids) as string[]) : null },
    };
  }

  const cookie = req.cookies?.[SESSION_COOKIE];
  if (!cookie) return null;
  const idHash = sha256(cookie);
  const row = db
    .prepare(
      `SELECT s.csrf, s.expires_at AS sexp, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`,
    )
    .get(idHash) as (UserRow & { csrf: string; sexp: number }) | undefined;
  if (!row || row.sexp <= Date.now() || row.disabled_at !== null) return null;
  const { csrf, sexp: _s, ...user } = row;
  return { user: user as UserRow, via: "session", csrf, sessionHash: idHash };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** 会话的写请求必须带对 CSRF 令牌；令牌请求不受浏览器自动带 Cookie 的影响，不需要。 */
export function checkCsrf(req: FastifyRequest): void {
  const p = req.principal;
  if (!p || p.via !== "session" || SAFE_METHODS.has(req.method)) return;
  const sent = req.headers["x-csrf-token"];
  if (typeof sent !== "string" || !p.csrf || !safeEqual(sent, p.csrf)) {
    throw forbidden("CSRF 校验失败，请刷新页面后重试", "csrf_failed");
  }
}

/** 首次登录必须改密码：除这些接口外一律拦下。 */
const ALLOWED_BEFORE_PASSWORD_CHANGE = new Set(["/api/v1/me", "/api/v1/me/password", "/api/v1/auth/logout"]);

export function requireUser(req: FastifyRequest): Principal {
  const p = req.principal;
  if (!p) throw unauthorized();
  const path = req.routeOptions.url ?? "";
  if (p.user.must_change_password === 1 && !ALLOWED_BEFORE_PASSWORD_CHANGE.has(path)) {
    throw forbidden("首次登录请先修改密码", "password_change_required");
  }
  return p;
}

export function requireSession(req: FastifyRequest): Principal {
  const p = requireUser(req);
  if (p.via !== "session") throw forbidden("这个操作只能在网页上登录后进行", "session_required");
  return p;
}

export function requireAdmin(req: FastifyRequest): Principal {
  const p = requireSession(req);
  if (p.user.is_admin !== 1) throw forbidden("需要系统管理员");
  return p;
}

/** 写操作的凭据：网页会话，或用途为 uploader 的令牌。MCP 令牌只读。 */
export function requireWriter(req: FastifyRequest): Principal {
  const p = requireUser(req);
  if (p.via === "token" && p.token?.purpose !== "uploader") throw forbidden("这个令牌只读，不能写入", "read_only_token");
  return p;
}

/** 团队编辑者（含管理员）：可以新建项目。 */
export function isTeamEditor(p: Principal): boolean {
  return p.user.is_admin === 1 || p.user.role === "editor";
}

/** 当前凭据在项目里的角色；看不到返回 null。管理员视为所有项目的编辑者；其余人先看项目覆盖，再看团队角色。 */
export function projectRole(db: Db, p: Principal, projectId: string): Role | null {
  if (p.token?.projectIds && !p.token.projectIds.includes(projectId)) return null;
  const project = db.prepare("SELECT archived_at FROM projects WHERE id = ?").get(projectId) as
    | { archived_at: number | null }
    | undefined;
  if (!project) return null;
  return userProjectRole(db, p.user, projectId);
}

/** 某个用户在项目里的实际角色（不考虑令牌限定）。 */
export function userProjectRole(db: Db, user: Pick<UserRow, "id" | "is_admin" | "role" | "project_scope">, projectId: string): Role | null {
  if (user.is_admin === 1) return "editor";
  const row = db.prepare("SELECT role FROM members WHERE project_id = ? AND user_id = ?").get(projectId, user.id) as
    | { role: ProjectOverride }
    | undefined;
  if (row) return row.role === "none" ? null : row.role;
  if (user.project_scope === "assigned") return null;
  return user.role === "editor" ? "editor" : "viewer";
}

export function requireProjectRole(db: Db, p: Principal, projectId: string, need: Role): Role {
  const role = projectRole(db, p, projectId);
  if (!role) throw notFound();
  if (need === "editor" && role !== "editor") throw forbidden("需要项目编辑者权限");
  if (need === "editor") {
    const archived = (db.prepare("SELECT archived_at FROM projects WHERE id = ?").get(projectId) as { archived_at: number | null })
      .archived_at;
    if (archived !== null) throw forbidden("项目已归档，只读", "project_archived");
  }
  return role;
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}
