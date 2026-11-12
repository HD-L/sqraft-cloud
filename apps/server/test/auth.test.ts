import { afterEach, describe, expect, it } from "vitest";
import { ADMIN, client, login, startServer, type TestServer } from "./helpers";

let server: TestServer;
afterEach(async () => server?.close());

describe("登录与会话", () => {
  it("首次启动按环境变量创建管理员，能登录并读到自己", async () => {
    server = await startServer();
    const session = await login(server.app, ADMIN.username, ADMIN.password);
    const me = await client(server.app, session).get("/api/v1/me");
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toMatchObject({ username: "admin", isAdmin: true, mustChangePassword: false });
    expect(me.json().csrfToken).toBe(session.csrf);
  });

  it("会话 Cookie 是 HttpOnly + SameSite=Lax，非内网模式下带 Secure", async () => {
    server = await startServer({ insecureHttp: false });
    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "x-forwarded-proto": "https" },
      payload: { username: ADMIN.username, password: ADMIN.password },
    });
    // 未信任代理时不认 X-Forwarded-Proto：纯 HTTP 一律拒绝
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("https_required");
    await server.close();

    server = await startServer({ insecureHttp: false, trustProxy: true });
    const ok = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "x-forwarded-proto": "https" },
      payload: { username: ADMIN.username, password: ADMIN.password },
    });
    expect(ok.statusCode).toBe(200);
    const cookie = ok.cookies.find((c) => c.name === "sqraft_session")!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", secure: true });
    // 健康检查不受 HTTPS 限制
    expect((await server.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });

  it("密码错误返回统一提示；连续 5 次后锁定账号", async () => {
    server = await startServer();
    for (let i = 0; i < 5; i++) {
      const res = await server.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "wrong-password" } });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.message).toBe("用户名或密码错误");
    }
    const locked = await server.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: ADMIN });
    expect(locked.statusCode).toBe(403);
    expect(locked.json().error.code).toBe("account_locked");
    const unknown = await server.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "nobody", password: "whatever-1" } });
    expect(unknown.json().error.message).toBe("用户名或密码错误");
  });

  it("会话的写请求必须带 CSRF 令牌", async () => {
    server = await startServer();
    const session = await login(server.app, ADMIN.username, ADMIN.password);
    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/admin/projects",
      headers: { cookie: session.cookie },
      payload: { name: "X" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("csrf_failed");
  });

  it("新用户首次登录必须先改密码；改完后其它会话失效", async () => {
    server = await startServer();
    const admin = await login(server.app, ADMIN.username, ADMIN.password);
    const created = await client(server.app, admin).post("/api/v1/admin/users", { username: "alice" });
    const initial = created.json().initialPassword as string;
    expect(initial).toHaveLength(16);

    const first = await login(server.app, "alice", initial);
    const second = await login(server.app, "alice", initial);
    const blocked = await client(server.app, first).get("/api/v1/projects");
    expect(blocked.json().error.code).toBe("password_change_required");

    const weak = await client(server.app, first).post("/api/v1/me/password", { currentPassword: initial, newPassword: "short" });
    expect(weak.json().error.code).toBe("weak_password");
    const ok = await client(server.app, first).post("/api/v1/me/password", { currentPassword: initial, newPassword: "alice-new-pass" });
    expect(ok.statusCode).toBe(200);
    expect((await client(server.app, first).get("/api/v1/projects")).statusCode).toBe(200);
    expect((await client(server.app, second).get("/api/v1/me")).statusCode).toBe(401);
  });

  it("登出后会话失效", async () => {
    server = await startServer();
    const session = await login(server.app, ADMIN.username, ADMIN.password);
    await client(server.app, session).post("/api/v1/auth/logout");
    expect((await client(server.app, session).get("/api/v1/me")).statusCode).toBe(401);
  });

  it("服务信息接口给出 API 与文件格式版本", async () => {
    server = await startServer();
    const res = await server.app.inject({ method: "GET", url: "/api/v1/info" });
    expect(res.json()).toMatchObject({ app: "sqraft-cloud", apiVersion: 1, formatVersion: { min: 1, max: 7 } });
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });
});
