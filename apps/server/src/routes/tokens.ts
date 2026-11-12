/**
 * 令牌管理（T1–T3）：只能在网页会话里创建，明文只在创建时返回一次，服务端只存哈希。
 * 用途：mcp（只读）/ uploader（可上传）；可限定项目范围；用户和管理员都能吊销。
 */

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";
import { audit } from "../audit";
import { projectRole, requireSession, requireUser } from "../auth";
import { generateToken, newId, sha256 } from "../crypto";
import { badRequest, notFound } from "../errors";

const DAY = 24 * 60 * 60 * 1000;
const ALLOWED_DAYS = [30, 90, 365];

interface TokenRow {
  id: string;
  user_id: string;
  name: string;
  purpose: string;
  hint: string;
  project_ids: string | null;
  expires_at: number | null;
  last_used_at: number | null;
  last_used_ip: string | null;
  revoked_at: number | null;
  created_at: number;
}

export function publicToken(t: TokenRow) {
  return {
    id: t.id,
    name: t.name,
    purpose: t.purpose,
    hint: `sqr_…${t.hint}`,
    projectIds: t.project_ids ? (JSON.parse(t.project_ids) as string[]) : null,
    expiresAt: t.expires_at,
    lastUsedAt: t.last_used_at,
    lastUsedIp: t.last_used_ip,
    revoked: t.revoked_at !== null,
    createdAt: t.created_at,
  };
}

export function tokenRoutes(app: FastifyInstance, { db, config }: AppContext): void {
  app.get("/api/v1/tokens", async (req) => {
    const p = requireUser(req);
    const rows = db.prepare("SELECT * FROM tokens WHERE user_id = ? ORDER BY created_at DESC").all(p.user.id) as TokenRow[];
    return { tokens: rows.map(publicToken) };
  });

  app.post<{ Body: { name?: unknown; purpose?: unknown; expiresInDays?: unknown; projectIds?: unknown } }>(
    "/api/v1/tokens",
    async (req) => {
      const p = requireSession(req);
      const { name, purpose, expiresInDays, projectIds } = req.body ?? {};
      if (typeof name !== "string" || !name.trim() || name.length > 64) throw badRequest("令牌名称必填，最多 64 个字符");
      if (purpose !== "mcp" && purpose !== "uploader") throw badRequest("用途只能是 mcp 或 uploader");
      let expiresAt: number | null = null;
      if (expiresInDays === null || expiresInDays === undefined) {
        if (config.tokenMaxDays !== null) throw badRequest(`管理员要求令牌最长 ${config.tokenMaxDays} 天，请选择有效期`);
      } else {
        if (typeof expiresInDays !== "number" || !ALLOWED_DAYS.includes(expiresInDays)) {
          throw badRequest("有效期只能是 30 / 90 / 365 天或不过期");
        }
        if (config.tokenMaxDays !== null && expiresInDays > config.tokenMaxDays) {
          throw badRequest(`管理员要求令牌最长 ${config.tokenMaxDays} 天`);
        }
        expiresAt = Date.now() + expiresInDays * DAY;
      }
      let scope: string[] | null = null;
      if (projectIds !== undefined && projectIds !== null) {
        if (!Array.isArray(projectIds) || projectIds.some((id) => typeof id !== "string") || projectIds.length === 0) {
          throw badRequest("projectIds 需要非空的项目 id 列表");
        }
        for (const id of projectIds as string[]) if (!projectRole(db, p, id)) throw notFound(`项目 ${id} 不存在或没有权限`);
        scope = [...new Set(projectIds as string[])];
      }
      const token = generateToken();
      const row: TokenRow = {
        id: newId(),
        user_id: p.user.id,
        name: name.trim(),
        purpose,
        hint: token.slice(-4),
        project_ids: scope ? JSON.stringify(scope) : null,
        expires_at: expiresAt,
        last_used_at: null,
        last_used_ip: null,
        revoked_at: null,
        created_at: Date.now(),
      };
      db.prepare(
        `INSERT INTO tokens (id, user_id, name, purpose, token_hash, hint, project_ids, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(row.id, row.user_id, row.name, row.purpose, sha256(token), row.hint, row.project_ids, row.expires_at, row.created_at);
      audit(db, p, req.ip, { action: "token.create", target: row.id, detail: { name: row.name, purpose, projectIds: scope } });
      return { token, info: publicToken(row) };
    },
  );

  app.delete<{ Params: { id: string } }>("/api/v1/tokens/:id", async (req) => {
    const p = requireSession(req);
    const row = db.prepare("SELECT * FROM tokens WHERE id = ?").get(req.params.id) as TokenRow | undefined;
    if (!row || (row.user_id !== p.user.id && p.user.is_admin !== 1)) throw notFound();
    if (row.revoked_at === null) db.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ?").run(Date.now(), row.id);
    audit(db, p, req.ip, { action: "token.revoke", target: row.id, detail: { name: row.name, owner: row.user_id } });
    return { ok: true };
  });
}
