import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { ADMIN, client, login, makeSqraft, startServer, upload, type TestServer } from "./helpers";

let server: TestServer;
let admin: { cookie: string; csrf: string };
const CLIENT = "sqraft-uploader";
const REDIRECT = "sqraft-uploader://oauth/callback";

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function authorize(over: Record<string, unknown> = {}) {
  const { verifier, challenge } = pkce();
  const res = await client(server.app, admin).post("/api/v1/oauth/authorize", {
    clientId: CLIENT,
    redirectUri: REDIRECT,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    state: "state-123456",
    ...over,
  });
  return { res, verifier };
}

function token(body: Record<string, string>, form = true) {
  return server.app.inject({
    method: "POST",
    url: "/oauth/token",
    headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" },
    payload: form ? new URLSearchParams(body).toString() : body,
  });
}

beforeEach(async () => {
  server = await startServer();
  admin = await login(server.app, ADMIN.username, ADMIN.password);
});
afterEach(async () => server.close());

describe("上传客户端浏览器登录（授权码 + PKCE）", () => {
  it("授权 → 回调带 code 与 state → 换出 uploader 令牌，可建稿上传", async () => {
    const info = await client(server.app, admin).get(`/api/v1/oauth/client?client_id=${CLIENT}&redirect_uri=${encodeURIComponent(REDIRECT)}`);
    expect(info.json()).toMatchObject({ name: "Sqraft 上传客户端", purpose: "uploader", tokenDays: 90 });

    const { res, verifier } = await authorize();
    const url = new URL(res.json().redirectUrl);
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe(REDIRECT);
    expect(url.searchParams.get("state")).toBe("state-123456");
    const code = url.searchParams.get("code")!;

    const tok = await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: CLIENT, redirect_uri: REDIRECT, device_name: "MacBook Pro" });
    expect(tok.statusCode).toBe(200);
    expect(tok.headers["cache-control"]).toBe("no-store");
    expect(tok.json()).toMatchObject({ token_type: "Bearer", scope: "uploader", expires_in: 90 * 86400 });
    const bearer = tok.json().access_token as string;
    expect(bearer).toMatch(/^sqr_/);

    const api = client(server.app, { bearer });
    expect((await api.get("/api/v1/me")).json().token).toMatchObject({ name: "Sqraft 上传客户端 · MacBook Pro", purpose: "uploader" });
    const projectId = (await client(server.app, admin).post("/api/v1/admin/projects", { name: "官网" })).json().project.id;
    const designId = (await api.post(`/api/v1/projects/${projectId}/designs`, { name: "首页" })).json().design.id;
    expect((await upload(api, designId, makeSqraft())).json().version.number).toBe(1);

    // 退出登录：令牌吊销自己
    expect((await api.post("/api/v1/oauth/revoke")).statusCode).toBe(200);
    expect((await api.get("/api/v1/me")).statusCode).toBe(401);
  });

  it("授权码只能用一次；verifier 不对、client / redirect 不一致都拒绝", async () => {
    const a = await authorize();
    const code = new URL(a.res.json().redirectUrl).searchParams.get("code")!;
    const wrong = await token({ grant_type: "authorization_code", code, code_verifier: "x".repeat(43), client_id: CLIENT, redirect_uri: REDIRECT });
    expect(wrong.json().error).toBe("invalid_grant");
    // 校验失败也会消耗掉授权码，正确的 verifier 也换不出来
    const replay = await token({ grant_type: "authorization_code", code, code_verifier: a.verifier, client_id: CLIENT, redirect_uri: REDIRECT });
    expect(replay.json().error).toBe("invalid_grant");

    const b = await authorize();
    const code2 = new URL(b.res.json().redirectUrl).searchParams.get("code")!;
    const badRedirect = await token({ grant_type: "authorization_code", code: code2, code_verifier: b.verifier, client_id: CLIENT, redirect_uri: "sqraft-uploader://evil" });
    expect(badRedirect.json().error).toBe("invalid_grant");

    expect((await token({ grant_type: "password", username: "admin", password: "x" })).json().error).toBe("unsupported_grant_type");
  });

  it("授权码 60 秒过期", async () => {
    const a = await authorize();
    const code = new URL(a.res.json().redirectUrl).searchParams.get("code")!;
    server.ctx.db.prepare("UPDATE oauth_codes SET expires_at = 1").run();
    const res = await token({ grant_type: "authorization_code", code, code_verifier: a.verifier, client_id: CLIENT, redirect_uri: REDIRECT }, false);
    expect(res.json().error).toBe("invalid_grant");
  });

  it("未登记的客户端或回调地址、非 S256、缺 state 都拒绝；授权必须是网页会话", async () => {
    expect((await authorize({ clientId: "evil" })).res.json().error.code).toBe("invalid_client");
    expect((await authorize({ redirectUri: "https://evil.example/cb" })).res.json().error.code).toBe("invalid_redirect_uri");
    expect((await authorize({ codeChallengeMethod: "plain" })).res.json().error.code).toBe("invalid_request");
    expect((await authorize({ state: "" })).res.json().error.code).toBe("invalid_request");

    const t = (await client(server.app, admin).post("/api/v1/tokens", { name: "x", purpose: "uploader", expiresInDays: 30 })).json().token;
    const { challenge } = pkce();
    const res = await client(server.app, { bearer: t }).post("/api/v1/oauth/authorize", {
      clientId: CLIENT, redirectUri: REDIRECT, codeChallenge: challenge, codeChallengeMethod: "S256", state: "state-123456",
    });
    expect(res.json().error.code).toBe("session_required");
  });

  it("管理员配置了令牌最长期限时，客户端令牌不超过它", async () => {
    await server.close();
    server = await startServer({ tokenMaxDays: 30 });
    admin = await login(server.app, ADMIN.username, ADMIN.password);
    const a = await authorize();
    const code = new URL(a.res.json().redirectUrl).searchParams.get("code")!;
    const res = await token({ grant_type: "authorization_code", code, code_verifier: a.verifier, client_id: CLIENT, redirect_uri: REDIRECT });
    expect(res.json().expires_in).toBe(30 * 86400);
  });

  it("/oauth/authorize 是网页前端路由（网页构建后回落到 index.html）", async () => {
    const res = await server.app.inject({ method: "GET", url: "/oauth/authorize?client_id=sqraft-uploader" });
    expect([200, 404]).toContain(res.statusCode);
  });
});
