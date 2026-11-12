/**
 * 上传客户端的浏览器登录（U3）：OAuth 2.0 授权码 + PKCE（RFC 6749 / 7636），公共客户端，无客户端密钥。
 *
 * 1. 客户端打开浏览器访问 `/oauth/authorize?client_id&redirect_uri&code_challenge&code_challenge_method=S256&state`
 *    （网页的前端路由：没登录先登录，再显示授权确认）；
 * 2. 用户点「授权」→ `POST /api/v1/oauth/authorize`（网页会话 + CSRF）→ 一次性授权码（60 秒有效），
 *    网页跳转到 `redirect_uri?code&state`（客户端注册的自定义协议）；
 * 3. 客户端 `POST /oauth/token` 用授权码 + code_verifier 换 uploader 用途的令牌。客户端从不接触密码。
 *
 * 客户端注册表写在代码里：只有登记过的 client_id + redirect_uri 组合能拿到授权码。
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { createHash } from "node:crypto";
import type { AppContext } from "../app";
import { audit } from "../audit";
import { requireSession, requireUser, type UserRow } from "../auth";
import { generateSecret, generateToken, newId, sha256 } from "../crypto";
import { badRequest, forbidden } from "../errors";

export interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  /** 换出的令牌用途 */
  purpose: "uploader";
  /** 令牌有效期（天），不超过管理员配置的上限 */
  tokenDays: number;
}

export const OAUTH_CLIENTS: Record<string, OAuthClient> = {
  "sqraft-uploader": {
    id: "sqraft-uploader",
    name: "Sqraft 上传客户端",
    redirectUris: ["sqraft-uploader://oauth/callback"],
    purpose: "uploader",
    tokenDays: 90,
  },
};

const CODE_TTL_MS = 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const PKCE = /^[A-Za-z0-9._~-]{43,128}$/;

function lookupClient(clientId: unknown, redirectUri: unknown): OAuthClient {
  const client = typeof clientId === "string" ? OAUTH_CLIENTS[clientId] : undefined;
  if (!client) throw badRequest("未知的客户端", "invalid_client");
  if (typeof redirectUri !== "string" || !client.redirectUris.includes(redirectUri)) {
    throw badRequest("回调地址与客户端登记的不一致", "invalid_redirect_uri");
  }
  return client;
}

/** 按 RFC 6749 的格式回错误（令牌端点是给客户端程序读的）。 */
function oauthError(reply: FastifyReply, error: string, description: string, status = 400) {
  return reply.status(status).header("Cache-Control", "no-store").send({ error, error_description: description });
}

export function oauthRoutes(app: FastifyInstance, { db, config }: AppContext): void {
  // 标准要求令牌端点接受表单编码
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  /** 网页授权确认页用：校验参数并给出客户端名称。 */
  app.get<{ Querystring: { client_id?: string; redirect_uri?: string } }>("/api/v1/oauth/client", async (req) => {
    requireUser(req);
    const client = lookupClient(req.query.client_id, req.query.redirect_uri);
    return { id: client.id, name: client.name, purpose: client.purpose, tokenDays: tokenDays(client) };
  });

  const tokenDays = (client: OAuthClient) =>
    config.tokenMaxDays !== null ? Math.min(client.tokenDays, config.tokenMaxDays) : client.tokenDays;

  app.post<{
    Body: { clientId?: unknown; redirectUri?: unknown; codeChallenge?: unknown; codeChallengeMethod?: unknown; state?: unknown };
  }>("/api/v1/oauth/authorize", async (req) => {
    const p = requireSession(req);
    const { clientId, redirectUri, codeChallenge, codeChallengeMethod, state } = req.body ?? {};
    const client = lookupClient(clientId, redirectUri);
    if (codeChallengeMethod !== "S256") throw badRequest("只支持 code_challenge_method=S256", "invalid_request");
    if (typeof codeChallenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
      throw badRequest("code_challenge 格式不对", "invalid_request");
    }
    if (typeof state !== "string" || state.length < 8 || state.length > 200) throw badRequest("缺少 state", "invalid_request");

    const code = generateSecret();
    const now = Date.now();
    db.prepare("DELETE FROM oauth_codes WHERE expires_at <= ?").run(now);
    db.prepare(
      `INSERT INTO oauth_codes (code_hash, user_id, client_id, redirect_uri, code_challenge, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(sha256(code), p.user.id, client.id, redirectUri, codeChallenge, now + CODE_TTL_MS, now);
    audit(db, p, req.ip, { action: "oauth.authorize", target: client.id });
    const url = new URL(redirectUri as string);
    url.searchParams.set("code", code);
    url.searchParams.set("state", state);
    return { redirectUrl: url.toString() };
  });

  app.post<{ Body: Record<string, unknown> }>("/oauth/token", async (req, reply) => {
    const body = req.body ?? {};
    if (body.grant_type !== "authorization_code") return oauthError(reply, "unsupported_grant_type", "只支持 authorization_code");
    const { code, code_verifier: verifier, client_id: clientId, redirect_uri: redirectUri, device_name: deviceName } = body;
    if (typeof code !== "string" || typeof verifier !== "string" || !PKCE.test(verifier)) {
      return oauthError(reply, "invalid_request", "缺少 code 或 code_verifier");
    }
    // 授权码只能用一次：先删再校验，重放的请求一定拿不到令牌
    const row = db.prepare("DELETE FROM oauth_codes WHERE code_hash = ? RETURNING *").get(sha256(code)) as
      | { user_id: string; client_id: string; redirect_uri: string; code_challenge: string; expires_at: number }
      | undefined;
    if (!row || row.expires_at <= Date.now()) return oauthError(reply, "invalid_grant", "授权码无效或已过期，请重新登录");
    if (row.client_id !== clientId || row.redirect_uri !== redirectUri) {
      return oauthError(reply, "invalid_grant", "client_id 或 redirect_uri 与授权时不一致");
    }
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (challenge !== row.code_challenge) return oauthError(reply, "invalid_grant", "code_verifier 不匹配");
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(row.user_id) as UserRow | undefined;
    if (!user || user.disabled_at !== null) return oauthError(reply, "invalid_grant", "账号不可用");

    const client = OAUTH_CLIENTS[row.client_id];
    const days = tokenDays(client);
    const token = generateToken();
    const now = Date.now();
    const device = typeof deviceName === "string" ? deviceName.trim().slice(0, 40) : "";
    const name = device ? `${client.name} · ${device}` : client.name;
    const tokenId = newId();
    db.prepare(
      `INSERT INTO tokens (id, user_id, name, purpose, token_hash, hint, project_ids, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(tokenId, user.id, name, client.purpose, sha256(token), token.slice(-4), now + days * DAY, now);
    audit(db, { user, via: "token", token: { id: tokenId, name, purpose: client.purpose, projectIds: null } }, req.ip, {
      action: "token.create",
      target: tokenId,
      detail: { name, purpose: client.purpose, via: "oauth" },
    });
    return reply.header("Cache-Control", "no-store").send({
      access_token: token,
      token_type: "Bearer",
      expires_in: days * 24 * 60 * 60,
      scope: client.purpose,
    });
  });

  /** 客户端退出登录：令牌吊销自己。 */
  app.post("/api/v1/oauth/revoke", async (req) => {
    const p = requireUser(req);
    if (p.via !== "token" || !p.token) throw forbidden("只能由令牌调用", "token_required");
    db.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(Date.now(), p.token.id);
    audit(db, p, req.ip, { action: "token.revoke", target: p.token.id, detail: { name: p.token.name, via: "self" } });
    return { ok: true };
  });
}
