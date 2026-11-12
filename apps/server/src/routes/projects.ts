/**
 * 项目与设计稿（P3、D3、D5、D6）：列表只返回有权限的；编辑者可建稿、改名、删除（进回收站）、回滚版本。
 */

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";
import { audit } from "../audit";
import { projectRole, requireProjectRole, requireUser, requireWriter, type Principal } from "../auth";
import { newId } from "../crypto";
import type { Db } from "../db";
import { badRequest, notFound } from "../errors";

export interface DesignRow {
  id: string;
  project_id: string;
  name: string;
  current_version: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
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
}

export function publicVersion(db: Db, v: VersionRow, current: number | null) {
  const uploader = v.uploader_id
    ? (db.prepare("SELECT username FROM users WHERE id = ?").get(v.uploader_id) as { username: string } | undefined)
    : undefined;
  return {
    number: v.number,
    note: v.note,
    uploader: uploader?.username ?? null,
    size: v.size,
    sha256: v.file_sha256,
    formatVersion: v.format_version,
    nodeCount: v.node_count,
    pageCount: v.page_count,
    assetCount: (JSON.parse(v.assets) as unknown[]).length,
    status: v.status,
    current: v.number === current,
    createdAt: v.created_at,
  };
}

export function publicDesign(db: Db, d: DesignRow) {
  const current = d.current_version
    ? (db.prepare("SELECT * FROM versions WHERE design_id = ? AND number = ?").get(d.id, d.current_version) as VersionRow | undefined)
    : undefined;
  const latest = db.prepare("SELECT MAX(number) AS n FROM versions WHERE design_id = ?").get(d.id) as { n: number | null };
  return {
    id: d.id,
    projectId: d.project_id,
    name: d.name,
    currentVersion: d.current_version,
    latestVersion: latest.n,
    pageCount: current?.page_count ?? 0,
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

function checkName(name: unknown): string {
  if (typeof name !== "string" || !name.trim() || name.length > 200) throw badRequest("设计稿名称必填，最多 200 个字符");
  return name.trim();
}

export function projectRoutes(app: FastifyInstance, { db }: AppContext): void {
  app.get("/api/v1/projects", async (req) => {
    const p = requireUser(req);
    const rows = (
      p.user.is_admin === 1
        ? db.prepare("SELECT * FROM projects ORDER BY name").all()
        : db
            .prepare("SELECT pr.* FROM projects pr JOIN members m ON m.project_id = pr.id WHERE m.user_id = ? ORDER BY pr.name")
            .all(p.user.id)
    ) as Array<{ id: string; name: string; archived_at: number | null }>;
    const projects = rows
      .map((r) => ({ row: r, role: projectRole(db, p, r.id) }))
      .filter((x) => x.role)
      .map(({ row, role }) => ({
        id: row.id,
        name: row.name,
        archived: row.archived_at !== null,
        role,
        designCount: (
          db.prepare("SELECT COUNT(*) AS n FROM designs WHERE project_id = ? AND deleted_at IS NULL").get(row.id) as { n: number }
        ).n,
      }));
    return { projects };
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
    };
    db.prepare(
      "INSERT INTO designs (id, project_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(row.id, row.project_id, row.name, row.created_by, now, now);
    audit(db, p, req.ip, { action: "design.create", target: row.id, detail: { projectId: row.project_id, name } });
    return { design: publicDesign(db, row) };
  });

  app.get<{ Params: { id: string } }>("/api/v1/designs/:id", async (req) => {
    const p = requireUser(req);
    const d = loadDesign(db, p, req.params.id, "viewer");
    return { design: publicDesign(db, d) };
  });

  app.patch<{ Params: { id: string }; Body: { name?: unknown } }>("/api/v1/designs/:id", async (req) => {
    const p = requireWriter(req);
    const d = loadDesign(db, p, req.params.id, "editor");
    const name = checkName(req.body?.name);
    db.prepare("UPDATE designs SET name = ?, updated_at = ? WHERE id = ?").run(name, Date.now(), d.id);
    audit(db, p, req.ip, { action: "design.rename", target: d.id, detail: { name } });
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
