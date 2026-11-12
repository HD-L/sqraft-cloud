/**
 * 项目与设计稿（P3、D3、D5、D6、B1–B2、C2、C4）：列表只返回有权限的；
 * 团队编辑者可新建项目，项目编辑者可改项目信息、建稿、改名、改状态、删除（进回收站）、回滚版本。
 */

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";
import { audit } from "../audit";
import {
  isTeamEditor,
  projectRole,
  publicUser,
  requireAdmin,
  requireProjectRole,
  requireUser,
  requireWriter,
  userProjectRole,
  type Principal,
  type UserRow,
} from "../auth";
import { newId } from "../crypto";
import type { Db } from "../db";
import { badRequest, forbidden, notFound } from "../errors";
import { nameOf } from "../notify";
import type { ProjectRow } from "./admin";
import { summarize, type VersionChanges } from "../changes";

export interface DesignRow {
  id: string;
  project_id: string;
  name: string;
  current_version: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  status: DesignStatus;
}

/** 设计稿状态（C4）：草稿 / 评审中 / 已发布 */
export type DesignStatus = "draft" | "review" | "published";
export const DESIGN_STATUSES: DesignStatus[] = ["draft", "review", "published"];

/** 用户 id → 显示用的名字（找不到返回 null） */
export function userName(db: Db, id: string | null): string | null {
  if (!id) return null;
  const u = db.prepare("SELECT username, display_name FROM users WHERE id = ?").get(id) as { username: string; display_name: string } | undefined;
  return u ? nameOf(u) : null;
}

export interface VersionRow {
  design_id: string;
  number: number;
  note: string;
  uploader_id: string | null;
  file_sha256: string;
  size: number;
  format_version: number;
  doc_blob: string;
  manifest_blob: string | null;
  assets: string;
  node_count: number;
  page_count: number;
  index_blob: string | null;
  status: string;
  created_at: number;
  /** 整版内容指纹；增量上传之前的版本为 null */
  content_hash: string | null;
  /** 相对基准版本的变更（VersionChanges JSON）；旧版本为 null，首次查看时补算 */
  changes: string | null;
}

export function publicVersion(db: Db, v: VersionRow, current: number | null) {
  const uploader = v.uploader_id
    ? (db.prepare("SELECT username, display_name FROM users WHERE id = ?").get(v.uploader_id) as { username: string; display_name: string } | undefined)
    : undefined;
  return {
    number: v.number,
    note: v.note,
    uploader: uploader ? nameOf(uploader) : null,
    size: v.size,
    sha256: v.file_sha256,
    formatVersion: v.format_version,
    nodeCount: v.node_count,
    pageCount: v.page_count,
    assetCount: (JSON.parse(v.assets) as unknown[]).length,
    status: v.status,
    /** 相对基准版本改了多少（页面 / 组件 / Token / 切图）；旧版本没有记录时为 null */
    changes: v.changes ? summarize(JSON.parse(v.changes) as VersionChanges) : null,
    current: v.number === current,
    createdAt: v.created_at,
  };
}

export function publicDesign(db: Db, d: DesignRow) {
  const current = d.current_version
    ? (db.prepare("SELECT * FROM versions WHERE design_id = ? AND number = ?").get(d.id, d.current_version) as VersionRow | undefined)
    : undefined;
  const latest = db.prepare("SELECT MAX(number) AS n FROM versions WHERE design_id = ?").get(d.id) as { n: number | null };
  const comments = db.prepare("SELECT COUNT(*) AS n FROM comments WHERE design_id = ? AND deleted_at IS NULL").get(d.id) as { n: number };
  return {
    id: d.id,
    projectId: d.project_id,
    name: d.name,
    status: d.status,
    currentVersion: d.current_version,
    latestVersion: latest.n,
    pageCount: current?.page_count ?? 0,
    createdBy: userName(db, d.created_by),
    commentCount: comments.n,
    updatedAt: d.updated_at,
    createdAt: d.created_at,
  };
}

/** 取设计稿并校验权限；回收站里的、没权限的一律 404。 */
export function loadDesign(db: Db, p: Principal, id: string, need: "viewer" | "editor"): DesignRow {
  const d = db.prepare("SELECT * FROM designs WHERE id = ?").get(id) as DesignRow | undefined;
  if (!d || d.deleted_at !== null) throw notFound();
  requireProjectRole(db, p, d.project_id, need);
  return d;
}

function checkProjectName(name: unknown): string {
  if (typeof name !== "string" || !name.trim() || name.length > 100) throw badRequest("项目名称必填，最多 100 个字符");
  return name.trim();
}

function checkDescription(v: unknown): string {
  if (typeof v !== "string" || v.length > 300) throw badRequest("项目描述最多 300 个字符");
  return v.trim();
}

/** 项目卡片 / 详情：简介、创建者、设计稿数、最近更新时间、我的角色 */
function projectCard(db: Db, row: ProjectRow, role: string) {
  const stat = db
    .prepare("SELECT COUNT(*) AS n, MAX(updated_at) AS t FROM designs WHERE project_id = ? AND deleted_at IS NULL")
    .get(row.id) as { n: number; t: number | null };
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    archived: row.archived_at !== null,
    role,
    createdBy: userName(db, row.created_by),
    createdByMe: undefined as boolean | undefined,
    designCount: stat.n,
    updatedAt: Math.max(stat.t ?? 0, row.created_at),
    createdAt: row.created_at,
  };
}

function checkName(name: unknown): string {
  if (typeof name !== "string" || !name.trim() || name.length > 200) throw badRequest("设计稿名称必填，最多 200 个字符");
  return name.trim();
}

export function projectRoutes(app: FastifyInstance, { db }: AppContext): void {
  app.get("/api/v1/projects", async (req) => {
    const p = requireUser(req);
    const rows = db.prepare("SELECT * FROM projects ORDER BY name").all() as ProjectRow[];
    const projects = rows
      .map((r) => ({ row: r, role: projectRole(db, p, r.id) }))
      .filter((x) => x.role)
      .map(({ row, role }) => ({ ...projectCard(db, row, role!), createdByMe: row.created_by === p.user.id }));
    return { projects };
  });

  // 团队编辑者与管理员可以新建项目（B2）
  app.post<{ Body: { name?: unknown; description?: unknown } }>("/api/v1/projects", async (req) => {
    const p = requireWriter(req);
    if (p.via !== "session" || !isTeamEditor(p)) throw forbidden("只有管理员和编辑者可以新建项目");
    const name = checkProjectName(req.body?.name);
    const description = req.body?.description === undefined ? "" : checkDescription(req.body.description);
    const row: ProjectRow = { id: newId(), name, description, archived_at: null, created_at: Date.now(), created_by: p.user.id };
    db.prepare("INSERT INTO projects (id, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?)").run(
      row.id,
      name,
      description,
      p.user.id,
      row.created_at,
    );
    audit(db, p, req.ip, { action: "project.create", target: row.id, detail: { name } });
    return { project: { ...projectCard(db, row, "editor"), createdByMe: true } };
  });

  app.get<{ Params: { projectId: string } }>("/api/v1/projects/:projectId", async (req) => {
    const p = requireUser(req);
    const role = requireProjectRole(db, p, req.params.projectId, "viewer");
    const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.projectId) as ProjectRow;
    return { project: { ...projectCard(db, row, role), createdByMe: row.created_by === p.user.id } };
  });

  app.patch<{ Params: { projectId: string }; Body: { name?: unknown; description?: unknown } }>("/api/v1/projects/:projectId", async (req) => {
    const p = requireWriter(req);
    requireProjectRole(db, p, req.params.projectId, "editor");
    const { name, description } = req.body ?? {};
    if (name !== undefined) db.prepare("UPDATE projects SET name = ? WHERE id = ?").run(checkProjectName(name), req.params.projectId);
    if (description !== undefined) db.prepare("UPDATE projects SET description = ? WHERE id = ?").run(checkDescription(description), req.params.projectId);
    audit(db, p, req.ip, { action: "project.update", target: req.params.projectId, detail: { name, description } });
    const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.projectId) as ProjectRow;
    return { project: { ...projectCard(db, row, "editor"), createdByMe: row.created_by === p.user.id } };
  });

  // 项目访问设置（管理员）：每个成员的团队角色、项目里的覆盖、实际角色
  app.get<{ Params: { projectId: string } }>("/api/v1/projects/:projectId/access", async (req) => {
    requireAdmin(req);
    if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(req.params.projectId)) throw notFound("项目不存在");
    const users = db.prepare("SELECT * FROM users WHERE disabled_at IS NULL ORDER BY created_at").all() as UserRow[];
    const overrides = new Map(
      (db.prepare("SELECT user_id, role FROM members WHERE project_id = ?").all(req.params.projectId) as Array<{ user_id: string; role: string }>).map(
        (r) => [r.user_id, r.role],
      ),
    );
    return {
      members: users.map((u) => ({
        ...publicUser(u),
        override: u.is_admin === 1 ? null : (overrides.get(u.id) ?? null),
        effective: userProjectRole(db, u, req.params.projectId) ?? "none",
      })),
    };
  });

  app.get<{ Params: { projectId: string }; Querystring: { query?: string } }>("/api/v1/projects/:projectId/designs", async (req) => {
    const p = requireUser(req);
    requireProjectRole(db, p, req.params.projectId, "viewer");
    const q = req.query.query?.trim();
    const rows = (
      q
        ? db
            .prepare("SELECT * FROM designs WHERE project_id = ? AND deleted_at IS NULL AND name LIKE ? ORDER BY updated_at DESC")
            .all(req.params.projectId, `%${q}%`)
        : db.prepare("SELECT * FROM designs WHERE project_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC").all(req.params.projectId)
    ) as DesignRow[];
    return { designs: rows.map((d) => publicDesign(db, d)) };
  });

  app.post<{ Params: { projectId: string }; Body: { name?: unknown } }>("/api/v1/projects/:projectId/designs", async (req) => {
    const p = requireWriter(req);
    requireProjectRole(db, p, req.params.projectId, "editor");
    const name = checkName(req.body?.name);
    const now = Date.now();
    const row: DesignRow = {
      id: newId(),
      project_id: req.params.projectId,
      name,
      current_version: null,
      created_by: p.user.id,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      status: "draft",
    };
    db.prepare(
      "INSERT INTO designs (id, project_id, name, status, created_by, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?, ?)",
    ).run(row.id, row.project_id, row.name, row.created_by, now, now);
    audit(db, p, req.ip, { action: "design.create", target: row.id, detail: { projectId: row.project_id, name } });
    return { design: publicDesign(db, row) };
  });

  app.get<{ Params: { id: string } }>("/api/v1/designs/:id", async (req) => {
    const p = requireUser(req);
    const d = loadDesign(db, p, req.params.id, "viewer");
    // 网页打开设计稿记入「最近浏览」（B5）
    if (p.via === "session") {
      db.prepare(
        "INSERT INTO recent_views (user_id, design_id, viewed_at) VALUES (?, ?, ?) ON CONFLICT (user_id, design_id) DO UPDATE SET viewed_at = excluded.viewed_at",
      ).run(p.user.id, d.id, Date.now());
    }
    return { design: publicDesign(db, d) };
  });

  app.patch<{ Params: { id: string }; Body: { name?: unknown; status?: unknown } }>("/api/v1/designs/:id", async (req) => {
    const p = requireWriter(req);
    const d = loadDesign(db, p, req.params.id, "editor");
    const { name, status } = req.body ?? {};
    if (name === undefined && status === undefined) throw badRequest("没有要修改的内容");
    if (name !== undefined) {
      const n = checkName(name);
      db.prepare("UPDATE designs SET name = ?, updated_at = ? WHERE id = ?").run(n, Date.now(), d.id);
      audit(db, p, req.ip, { action: "design.rename", target: d.id, detail: { name: n } });
    }
    if (status !== undefined) {
      if (!DESIGN_STATUSES.includes(status as DesignStatus)) throw badRequest("状态只能是 draft（草稿）、review（评审中）或 published（已发布）");
      db.prepare("UPDATE designs SET status = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), d.id);
      audit(db, p, req.ip, { action: "design.status", target: d.id, detail: { from: d.status, to: status } });
    }
    return { design: publicDesign(db, db.prepare("SELECT * FROM designs WHERE id = ?").get(d.id) as DesignRow) };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/designs/:id", async (req) => {
    const p = requireWriter(req);
    const d = loadDesign(db, p, req.params.id, "editor");
    db.prepare("UPDATE designs SET deleted_at = ? WHERE id = ?").run(Date.now(), d.id);
    audit(db, p, req.ip, { action: "design.delete", target: d.id, detail: { name: d.name } });
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/v1/designs/:id/versions", async (req) => {
    const p = requireUser(req);
    const d = loadDesign(db, p, req.params.id, "viewer");
    const rows = db.prepare("SELECT * FROM versions WHERE design_id = ? ORDER BY number DESC").all(d.id) as VersionRow[];
    return { versions: rows.map((v) => publicVersion(db, v, d.current_version)) };
  });

  app.post<{ Params: { id: string }; Body: { version?: unknown } }>("/api/v1/designs/:id/rollback", async (req) => {
    const p = requireWriter(req);
    const d = loadDesign(db, p, req.params.id, "editor");
    const version = req.body?.version;
    if (typeof version !== "number" || !db.prepare("SELECT 1 FROM versions WHERE design_id = ? AND number = ?").get(d.id, version)) {
      throw badRequest("版本不存在");
    }
    db.prepare("UPDATE designs SET current_version = ?, updated_at = ? WHERE id = ?").run(version, Date.now(), d.id);
    audit(db, p, req.ip, { action: "design.rollback", target: d.id, detail: { from: d.current_version, to: version } });
    return { design: publicDesign(db, db.prepare("SELECT * FROM designs WHERE id = ?").get(d.id) as DesignRow) };
  });
}
