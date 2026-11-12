/**
 * 管理后台接口（G1–G3、P1–P2）：用户、项目与成员、审计日志。全部要求系统管理员的网页会话。
 */

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";
import { audit, type AuditRow } from "../audit";
import { publicUser, requireAdmin, TEAM_ROLES, type TeamRole, type UserRow } from "../auth";
import { newId } from "../crypto";
import { badRequest, notFound } from "../errors";
import { nameOf, notify } from "../notify";
import { publicToken } from "./tokens";
import { createMember, resetPassword, setDisabled, setRole } from "./members";

export interface ProjectRow {
  id: string;
  name: string;
  archived_at: number | null;
  created_at: number;
  description: string;
  created_by: string | null;
}

export function publicProject(p: ProjectRow) {
  return { id: p.id, name: p.name, description: p.description ?? "", archived: p.archived_at !== null, createdAt: p.created_at };
}

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function adminRoutes(app: FastifyInstance, { db }: AppContext): void {
  // ── 用户 ──
  app.get("/api/v1/admin/users", async (req) => {
    requireAdmin(req);
    const rows = db.prepare("SELECT * FROM users ORDER BY created_at").all() as UserRow[];
    return { users: rows.map(publicUser) };
  });

  app.post<{ Body: Record<string, unknown> }>("/api/v1/admin/users", async (req) => {
    const p = requireAdmin(req);
    const { user, initialPassword } = await createMember(db, p, req.ip, req.body ?? {});
    return { user: publicUser(user), ...(initialPassword ? { initialPassword } : {}) };
  });

  app.patch<{ Params: { id: string }; Body: { disabled?: unknown; isAdmin?: unknown; role?: unknown; resetPassword?: unknown } }>(
    "/api/v1/admin/users/:id",
    async (req) => {
      const p = requireAdmin(req);
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id) as UserRow | undefined;
      if (!user) throw notFound("用户不存在");
      const { disabled, isAdmin, role, resetPassword: reset } = req.body ?? {};
      if (disabled !== undefined) {
        if (typeof disabled !== "boolean") throw badRequest("disabled 需要布尔值");
        setDisabled(db, p, req.ip, user, disabled);
      }
      if (role !== undefined) {
        if (!TEAM_ROLES.includes(role as TeamRole)) throw badRequest("角色只能是 admin、editor 或 viewer");
        setRole(db, p, req.ip, db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as UserRow, role as TeamRole);
      } else if (isAdmin !== undefined) {
        if (typeof isAdmin !== "boolean") throw badRequest("isAdmin 需要布尔值");
        // 兼容旧接口：取消管理员时降为编辑者
        setRole(db, p, req.ip, db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as UserRow, isAdmin ? "admin" : "editor");
      }
      const newPassword = reset === true ? await resetPassword(db, p, req.ip, user) : null;
      const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as UserRow;
      return { user: publicUser(updated), ...(newPassword ? { initialPassword: newPassword } : {}) };
    },
  );

  app.get<{ Params: { id: string } }>("/api/v1/admin/users/:id/tokens", async (req) => {
    requireAdmin(req);
    const rows = db.prepare("SELECT * FROM tokens WHERE user_id = ? ORDER BY created_at DESC").all(req.params.id);
    return { tokens: (rows as Parameters<typeof publicToken>[0][]).map(publicToken) };
  });

  // ── 项目与成员 ──
  app.get("/api/v1/admin/projects", async (req) => {
    requireAdmin(req);
    const rows = db.prepare("SELECT * FROM projects ORDER BY created_at").all() as ProjectRow[];
    return { projects: rows.map(publicProject) };
  });

  app.post<{ Body: { name?: unknown } }>("/api/v1/admin/projects", async (req) => {
    const p = requireAdmin(req);
    const { name } = req.body ?? {};
    if (typeof name !== "string" || !name.trim() || name.length > 100) throw badRequest("项目名称必填，最多 100 个字符");
    const row: ProjectRow = { id: newId(), name: name.trim(), archived_at: null, created_at: Date.now(), description: "", created_by: p.user.id };
    db.prepare("INSERT INTO projects (id, name, created_by, created_at) VALUES (?, ?, ?, ?)").run(row.id, row.name, p.user.id, row.created_at);
    audit(db, p, req.ip, { action: "project.create", target: row.id, detail: { name: row.name } });
    return { project: publicProject(row) };
  });

  app.patch<{ Params: { id: string }; Body: { name?: unknown; archived?: unknown } }>("/api/v1/admin/projects/:id", async (req) => {
    const p = requireAdmin(req);
    const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id) as ProjectRow | undefined;
    if (!row) throw notFound("项目不存在");
    const { name, archived } = req.body ?? {};
    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim() || name.length > 100) throw badRequest("项目名称必填，最多 100 个字符");
      db.prepare("UPDATE projects SET name = ? WHERE id = ?").run(name.trim(), row.id);
      audit(db, p, req.ip, { action: "project.rename", target: row.id, detail: { name: name.trim() } });
    }
    if (archived !== undefined) {
      if (typeof archived !== "boolean") throw badRequest("archived 需要布尔值");
      db.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").run(archived ? Date.now() : null, row.id);
      audit(db, p, req.ip, { action: archived ? "project.archive" : "project.unarchive", target: row.id });
    }
    return { project: publicProject(db.prepare("SELECT * FROM projects WHERE id = ?").get(row.id) as ProjectRow) };
  });

  app.get<{ Params: { id: string } }>("/api/v1/admin/projects/:id/members", async (req) => {
    requireAdmin(req);
    if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(req.params.id)) throw notFound("项目不存在");
    const rows = db
      .prepare(
        "SELECT u.id, u.username, m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY u.username",
      )
      .all(req.params.id) as Array<{ id: string; username: string; role: string }>;
    return { members: rows.map((r) => ({ userId: r.id, username: r.username, role: r.role })) };
  });

  app.put<{ Params: { id: string; userId: string }; Body: { role?: unknown } }>(
    "/api/v1/admin/projects/:id/members/:userId",
    async (req) => {
      const p = requireAdmin(req);
      const { role } = req.body ?? {};
      if (role !== "editor" && role !== "viewer" && role !== "none") {
        throw badRequest("角色只能是 editor（编辑者）、viewer（查看者）或 none（看不到这个项目）");
      }
      const project = db.prepare("SELECT name FROM projects WHERE id = ?").get(req.params.id) as { name: string } | undefined;
      if (!project) throw notFound("项目不存在");
      if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(req.params.userId)) throw notFound("用户不存在");
      if (role !== "none") {
        notify(db, req.params.userId, "project_access", p.user.id, `${nameOf(p.user)} 把你加入了项目「${project.name}」（${role === "editor" ? "编辑者" : "查看者"}）`, `/projects/${req.params.id}`);
      }
      db.prepare(
        `INSERT INTO members (project_id, user_id, role) VALUES (?, ?, ?)
         ON CONFLICT (project_id, user_id) DO UPDATE SET role = excluded.role`,
      ).run(req.params.id, req.params.userId, role);
      audit(db, p, req.ip, { action: "project.member_set", target: req.params.id, detail: { userId: req.params.userId, role } });
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string; userId: string } }>("/api/v1/admin/projects/:id/members/:userId", async (req) => {
    const p = requireAdmin(req);
    db.prepare("DELETE FROM members WHERE project_id = ? AND user_id = ?").run(req.params.id, req.params.userId);
    audit(db, p, req.ip, { action: "project.member_remove", target: req.params.id, detail: { userId: req.params.userId } });
    return { ok: true };
  });

  // ── 审计日志（G3）──
  app.get<{ Querystring: { user?: string; action?: string; from?: string; to?: string; limit?: string; format?: string } }>(
    "/api/v1/admin/audit",
    async (req, reply) => {
      requireAdmin(req);
      const { user, action, from, to, limit, format } = req.query;
      const where: string[] = [];
      const args: unknown[] = [];
      if (user) {
        where.push("(user_id = ? OR username = ?)");
        args.push(user, user);
      }
      if (action) {
        where.push("action LIKE ?");
        args.push(`${action}%`);
      }
      if (from) {
        where.push("at >= ?");
        args.push(Number(from));
      }
      if (to) {
        where.push("at < ?");
        args.push(Number(to));
      }
      const max = format === "csv" ? 100_000 : Math.min(Math.max(Number(limit) || 200, 1), 1000);
      const rows = db
        .prepare(`SELECT * FROM audit ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
        .all(...args, max) as AuditRow[];
      if (format === "csv") {
        const header = ["时间", "用户", "令牌", "IP", "动作", "对象", "结果", "详情"];
        const lines = rows.map((r) =>
          [new Date(r.at).toISOString(), r.username, r.token_name, r.ip, r.action, r.target, r.result, r.detail].map(csvCell).join(","),
        );
        reply.header("Content-Type", "text/csv; charset=utf-8");
        reply.header("Content-Disposition", 'attachment; filename="audit.csv"');
        return `﻿${[header.join(","), ...lines].join("\n")}\n`;
      }
      return {
        entries: rows.map((r) => ({
          id: r.id,
          at: r.at,
          userId: r.user_id,
          username: r.username,
          tokenName: r.token_name,
          ip: r.ip,
          action: r.action,
          target: r.target,
          result: r.result,
          detail: r.detail ? JSON.parse(r.detail) : null,
        })),
      };
    },
  );
}
