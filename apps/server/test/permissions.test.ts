import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN, client, createUser, login, startServer, type TestServer } from "./helpers";

let server: TestServer;
let admin: { cookie: string; csrf: string };
let projectId: string;
let otherProjectId: string;

beforeEach(async () => {
  server = await startServer();
  admin = await login(server.app, ADMIN.username, ADMIN.password);
  const api = client(server.app, admin);
  projectId = (await api.post("/api/v1/admin/projects", { name: "官网改版" })).json().project.id;
  otherProjectId = (await api.post("/api/v1/admin/projects", { name: "保密项目" })).json().project.id;
});
afterEach(async () => server.close());

describe("项目权限", () => {
  it("查看者只读、编辑者可建稿、非成员看不到（404）", async () => {
    const viewer = await createUser(server.app, admin, "viewer");
    const editor = await createUser(server.app, admin, "editor");
    const api = client(server.app, admin);
    await api.put(`/api/v1/admin/projects/${projectId}/members/${viewer.id}`, { role: "viewer" });
    await api.put(`/api/v1/admin/projects/${projectId}/members/${editor.id}`, { role: "editor" });
    // 团队角色默认对所有项目生效；在另一个项目里单独设为「看不到」
    await api.put(`/api/v1/admin/projects/${otherProjectId}/members/${viewer.id}`, { role: "none" });
    await api.put(`/api/v1/admin/projects/${otherProjectId}/members/${editor.id}`, { role: "none" });

    const asEditor = client(server.app, editor.session);
    const created = await asEditor.post(`/api/v1/projects/${projectId}/designs`, { name: "首页" });
    expect(created.statusCode).toBe(200);
    const designId = created.json().design.id;

    const asViewer = client(server.app, viewer.session);
    expect((await asViewer.get("/api/v1/projects")).json().projects.map((p: { name: string }) => p.name)).toEqual(["官网改版"]);
    expect((await asViewer.get(`/api/v1/designs/${designId}`)).statusCode).toBe(200);
    expect((await asViewer.post(`/api/v1/projects/${projectId}/designs`, { name: "x" })).statusCode).toBe(403);
    expect((await asViewer.delete(`/api/v1/designs/${designId}`)).statusCode).toBe(403);

    expect((await asViewer.get(`/api/v1/projects/${otherProjectId}/designs`)).statusCode).toBe(404);
    expect((await asEditor.post(`/api/v1/projects/${otherProjectId}/designs`, { name: "x" })).statusCode).toBe(404);
  });

  it("归档项目只读；删除的设计稿对所有人 404", async () => {
    const api = client(server.app, admin);
    const designId = (await api.post(`/api/v1/projects/${projectId}/designs`, { name: "首页" })).json().design.id;
    await api.patch(`/api/v1/admin/projects/${projectId}`, { archived: true });
    const res = await api.post(`/api/v1/projects/${projectId}/designs`, { name: "x" });
    expect(res.json().error.code).toBe("project_archived");
    await api.patch(`/api/v1/admin/projects/${projectId}`, { archived: false });
    expect((await api.delete(`/api/v1/designs/${designId}`)).statusCode).toBe(200);
    expect((await api.get(`/api/v1/designs/${designId}`)).statusCode).toBe(404);
  });

  it("普通用户调用管理接口被拒绝", async () => {
    const user = await createUser(server.app, admin, "bob");
    const res = await client(server.app, user.session).get("/api/v1/admin/users");
    expect(res.statusCode).toBe(403);
  });

  it("不能停用自己，也不能去掉最后一个管理员", async () => {
    const api = client(server.app, admin);
    const me = (await api.get("/api/v1/me")).json().user.id;
    expect((await api.patch(`/api/v1/admin/users/${me}`, { disabled: true })).statusCode).toBe(400);
    expect((await api.patch(`/api/v1/admin/users/${me}`, { isAdmin: false })).statusCode).toBe(400);
  });
});

describe("令牌", () => {
  it("明文只返回一次，服务端只存哈希；MCP 令牌只读，uploader 令牌可写", async () => {
    const api = client(server.app, admin);
    const mcp = await api.post("/api/v1/tokens", { name: "Claude Code", purpose: "mcp", expiresInDays: 90 });
    expect(mcp.statusCode).toBe(200);
    const token = mcp.json().token as string;
    expect(token).toMatch(/^sqr_[A-Za-z0-9_-]{43}$/);
    expect(mcp.json().info.hint).toBe(`sqr_…${token.slice(-4)}`);
    const stored = server.ctx.db.prepare("SELECT token_hash FROM tokens").all() as Array<{ token_hash: string }>;
    expect(JSON.stringify(stored)).not.toContain(token);
    expect((await api.get("/api/v1/tokens")).body).not.toContain(token);

    const asMcp = client(server.app, { bearer: token });
    expect((await asMcp.get("/api/v1/projects")).statusCode).toBe(200);
    const write = await asMcp.post(`/api/v1/projects/${projectId}/designs`, { name: "x" });
    expect(write.json().error.code).toBe("read_only_token");
    // 令牌不能再派生令牌，也不能做管理操作
    expect((await asMcp.post("/api/v1/tokens", { name: "x", purpose: "mcp", expiresInDays: 30 })).statusCode).toBe(403);
    expect((await asMcp.get("/api/v1/admin/users")).statusCode).toBe(403);

    const up = (await api.post("/api/v1/tokens", { name: "Mac 客户端", purpose: "uploader", expiresInDays: 30 })).json().token;
    expect((await client(server.app, { bearer: up }).post(`/api/v1/projects/${projectId}/designs`, { name: "x" })).statusCode).toBe(200);
  });

  it("限定项目的令牌看不到其它项目；吊销后立即失效", async () => {
    const api = client(server.app, admin);
    const res = await api.post("/api/v1/tokens", { name: "只看官网", purpose: "mcp", expiresInDays: 30, projectIds: [projectId] });
    const asToken = client(server.app, { bearer: res.json().token });
    expect((await asToken.get("/api/v1/projects")).json().projects.map((p: { id: string }) => p.id)).toEqual([projectId]);
    expect((await asToken.get(`/api/v1/projects/${otherProjectId}/designs`)).statusCode).toBe(404);

    await api.delete(`/api/v1/tokens/${res.json().info.id}`);
    expect((await asToken.get("/api/v1/projects")).statusCode).toBe(401);
  });

  it("停用用户会吊销其全部令牌并踢下线", async () => {
    const user = await createUser(server.app, admin, "carol");
    const token = (await client(server.app, user.session).post("/api/v1/tokens", { name: "t", purpose: "mcp", expiresInDays: 30 })).json().token;
    await client(server.app, admin).patch(`/api/v1/admin/users/${user.id}`, { disabled: true });
    expect((await client(server.app, { bearer: token }).get("/api/v1/me")).statusCode).toBe(401);
    expect((await client(server.app, user.session).get("/api/v1/me")).statusCode).toBe(401);
    const login = await server.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "carol", password: "carol-pass-123-new" } });
    expect(login.statusCode).toBe(401);
  });

  it("管理员配置了令牌最长有效期时，不允许不过期的令牌", async () => {
    await server.close();
    server = await startServer({ tokenMaxDays: 90 });
    admin = await login(server.app, ADMIN.username, ADMIN.password);
    const api = client(server.app, admin);
    expect((await api.post("/api/v1/tokens", { name: "x", purpose: "mcp", expiresInDays: null })).statusCode).toBe(400);
    expect((await api.post("/api/v1/tokens", { name: "x", purpose: "mcp", expiresInDays: 365 })).statusCode).toBe(400);
    expect((await api.post("/api/v1/tokens", { name: "x", purpose: "mcp", expiresInDays: 90 })).statusCode).toBe(200);
  });
});
