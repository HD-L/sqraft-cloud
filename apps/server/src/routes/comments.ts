/**
 * 评论（D1）与站内通知（D2）。
 *
 * - 能看到设计稿的人都能评论（查看者也可以）；作者本人或管理员可以删除（软删除）；
 * - 评论里 `@用户名` 通知被提到的人（只通知能看到这个项目的成员）；
 * - 设计稿的创建者与之前参与评论的人收到「有新评论」通知；
 * - 评论记下当时看的版本与页面，方便对照；
 * - 评论可以标为「已解决」：评论作者、项目编辑者、管理员可以标记 / 取消。
 *   评审上线时已发布设计稿上的旧评论统一标为已解决（legacy，显示为「上线前的评论」）。
 */

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";
import { audit } from "../audit";
import { projectRole, requireSession, requireUser, userProjectRole, type Principal, type Role, type UserRow } from "../auth";
import { newId } from "../crypto";
import { badRequest, forbidden, notFound } from "../errors";
import { nameOf, notify } from "../notify";
import { loadDesign } from "./projects";

interface CommentRow {
  id: string;
  design_id: string;
  user_id: string | null;
  body: string;
  version: number | null;
  page_id: string | null;
  created_at: number;
  deleted_at: number | null;
  resolved_at: number | null;
  resolved_by: string | null;
  resolved_legacy: number;
}

const MENTION = /@([A-Za-z0-9._-]{2,64})/g;

export function commentRoutes(app: FastifyInstance, { db }: AppContext): void {
  const author = (id: string | null) => {
    if (!id) return null;
    const u = db.prepare("SELECT id, username, display_name FROM users WHERE id = ?").get(id) as Pick<UserRow, "id" | "username" | "display_name"> | undefined;
    return u ? { id: u.id, username: u.username, displayName: nameOf(u) } : null;
  };

  /** 能否标记 / 取消「已解决」：评论作者、项目编辑者、管理员 */
  const mayResolve = (c: CommentRow, viewer: Principal, role: Role | null) =>
    viewer.via === "session" && (c.user_id === viewer.user.id || role === "editor" || viewer.user.is_admin === 1);

  const publicComment = (c: CommentRow, viewer: Principal, role: Role | null) => ({
    id: c.id,
    body: c.body,
    author: author(c.user_id),
    version: c.version,
    pageId: c.page_id,
    createdAt: c.created_at,
    canDelete: c.user_id === viewer.user.id || viewer.user.is_admin === 1,
    resolved: c.resolved_at !== null,
    resolvedAt: c.resolved_at,
    resolvedBy: c.resolved_legacy === 1 ? null : author(c.resolved_by),
    /** 评审上线前已发布设计稿上的旧评论（自动标为已解决） */
    legacy: c.resolved_legacy === 1,
    canResolve: mayResolve(c, viewer, role),
  });

  app.get<{ Params: { id: string } }>("/api/v1/designs/:id/comments", async (req) => {
    const p = requireUser(req);
    const d = loadDesign(db, p, req.params.id, "viewer");
    const rows = db.prepare("SELECT * FROM comments WHERE design_id = ? AND deleted_at IS NULL ORDER BY created_at").all(d.id) as CommentRow[];
    const role = projectRole(db, p, d.project_id);
    return { comments: rows.map((c) => publicComment(c, p, role)) };
  });

  app.post<{ Params: { id: string }; Body: { body?: unknown; version?: unknown; pageId?: unknown } }>("/api/v1/designs/:id/comments", async (req) => {
    const p = requireSession(req);
    const d = loadDesign(db, p, req.params.id, "viewer");
    const { body, version, pageId } = req.body ?? {};
    if (typeof body !== "string" || !body.trim() || body.length > 2000) throw badRequest("评论不能为空，最多 2000 个字符");
    if (version !== undefined && version !== null && (typeof version !== "number" || !Number.isInteger(version) || version < 1)) throw badRequest("version 需要正整数");
    if (pageId !== undefined && pageId !== null && (typeof pageId !== "string" || pageId.length > 200)) throw badRequest("pageId 无效");
    const row: CommentRow = {
      id: newId(),
      design_id: d.id,
      user_id: p.user.id,
      body: body.trim(),
      version: (version as number | undefined) ?? d.current_version,
      page_id: (pageId as string | undefined) ?? null,
      created_at: Date.now(),
      deleted_at: null,
      resolved_at: null,
      resolved_by: null,
      resolved_legacy: 0,
    };
    db.prepare("INSERT INTO comments (id, design_id, user_id, body, version, page_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      row.id,
      row.design_id,
      row.user_id,
      row.body,
      row.version,
      row.page_id,
      row.created_at,
    );

    // 通知：被 @ 的人；设计稿创建者与之前参与评论的人
    const link = `/designs/${d.id}`;
    const actor = nameOf(p.user);
    const excerpt = row.body.length > 60 ? `${row.body.slice(0, 60)}…` : row.body;
    const canSee = (u: UserRow) => u.disabled_at === null && userProjectRole(db, u, d.project_id) !== null;
    const notified = new Set<string>([p.user.id]);
    for (const [, name] of row.body.matchAll(MENTION)) {
      const u = db.prepare("SELECT * FROM users WHERE username = ?").get(name) as UserRow | undefined;
      if (!u || notified.has(u.id) || !canSee(u)) continue;
      notified.add(u.id);
      notify(db, u.id, "mention", p.user.id, `${actor} 在「${d.name}」里提到了你：${excerpt}`, link);
    }
    const watchers = db
      .prepare("SELECT DISTINCT user_id FROM comments WHERE design_id = ? AND deleted_at IS NULL AND user_id IS NOT NULL")
      .all(d.id) as Array<{ user_id: string }>;
    for (const id of [d.created_by, ...watchers.map((w) => w.user_id)]) {
      if (!id || notified.has(id)) continue;
      notified.add(id);
      const u = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
      if (u && canSee(u)) notify(db, u.id, "comment", p.user.id, `${actor} 评论了「${d.name}」：${excerpt}`, link);
    }
    audit(db, p, req.ip, { action: "comment.create", target: d.id, detail: { comment: row.id } });
    return { comment: publicComment(row, p, projectRole(db, p, d.project_id)) };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/comments/:id", async (req) => {
    const p = requireSession(req);
    const c = db.prepare("SELECT * FROM comments WHERE id = ? AND deleted_at IS NULL").get(req.params.id) as CommentRow | undefined;
    if (!c) throw notFound("评论不存在");
    loadDesign(db, p, c.design_id, "viewer");
    if (c.user_id !== p.user.id && p.user.is_admin !== 1) throw notFound("评论不存在");
    db.prepare("UPDATE comments SET deleted_at = ? WHERE id = ?").run(Date.now(), c.id);
    audit(db, p, req.ip, { action: "comment.delete", target: c.design_id, detail: { comment: c.id } });
    return { ok: true };
  });

  // 标记 / 取消「已解决」
  app.post<{ Params: { id: string }; Body: { resolved?: unknown } }>("/api/v1/comments/:id/resolve", async (req) => {
    const p = requireSession(req);
    const resolved = req.body?.resolved;
    if (typeof resolved !== "boolean") throw badRequest("resolved 需要 true 或 false");
    const c = db.prepare("SELECT * FROM comments WHERE id = ? AND deleted_at IS NULL").get(req.params.id) as CommentRow | undefined;
    if (!c) throw notFound("评论不存在");
    const d = loadDesign(db, p, c.design_id, "viewer");
    const role = projectRole(db, p, d.project_id);
    if (!mayResolve(c, p, role)) throw forbidden("只有评论作者、项目编辑者或管理员可以标记已解决");
    if (resolved && c.resolved_at === null) {
      db.prepare("UPDATE comments SET resolved_at = ?, resolved_by = ?, resolved_legacy = 0 WHERE id = ?").run(Date.now(), p.user.id, c.id);
    } else if (!resolved && c.resolved_at !== null) {
      db.prepare("UPDATE comments SET resolved_at = NULL, resolved_by = NULL, resolved_legacy = 0 WHERE id = ?").run(c.id);
    }
    audit(db, p, req.ip, { action: resolved ? "comment.resolve" : "comment.unresolve", target: c.design_id, detail: { comment: c.id } });
    const row = db.prepare("SELECT * FROM comments WHERE id = ?").get(c.id) as CommentRow;
    return { comment: publicComment(row, p, role) };
  });

  // ── 通知 ──
  app.get<{ Querystring: { limit?: string } }>("/api/v1/notifications", async (req) => {
    const p = requireSession(req);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const rows = db.prepare("SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?").all(p.user.id, limit) as Array<{
      id: number;
      kind: string;
      actor_id: string | null;
      text: string;
      link: string | null;
      read_at: number | null;
      created_at: number;
    }>;
    const unread = (db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL").get(p.user.id) as { n: number }).n;
    return {
      unread,
      notifications: rows.map((n) => ({
        id: n.id,
        kind: n.kind,
        actor: author(n.actor_id),
        text: n.text,
        link: n.link,
        read: n.read_at !== null,
        createdAt: n.created_at,
      })),
    };
  });

  app.post<{ Body: { ids?: unknown } }>("/api/v1/notifications/read", async (req) => {
    const p = requireSession(req);
    const ids = req.body?.ids;
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > 500 || ids.some((x) => !Number.isInteger(x)))) throw badRequest("ids 需要整数数组");
    const now = Date.now();
    if (ids === undefined) db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(now, p.user.id);
    else {
      const stmt = db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND id = ? AND read_at IS NULL");
      db.transaction(() => (ids as number[]).forEach((id) => stmt.run(now, p.user.id, id)))();
    }
    return { ok: true };
  });
}
