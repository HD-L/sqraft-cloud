import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN, client, createUser, fakePng, login, makeSqraft, startServer, upload, type TestServer } from "./helpers";

let server: TestServer;
let admin: { cookie: string; csrf: string };
let projectId: string;
let designId: string;
let token: string;

const PNG = fakePng(7, 4096);

/** 带会话的 MCP 客户端：initialize 后自动带 Mcp-Session-Id。 */
async function mcp(bearer: string, headers: Record<string, string> = {}) {
  let id = 0;
  const send = (body: unknown, sid?: string) =>
    server.app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...(sid ? { "mcp-session-id": sid } : {}), ...headers },
      payload: body as object,
    });
  const init = await send({ jsonrpc: "2.0", id: ++id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  const sid = init.headers["mcp-session-id"] as string;
  return {
    init,
    sid,
    raw: (body: unknown, s = sid) => send(body, s),
    async call(name: string, args: Record<string, unknown> = {}) {
      const res = await send({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }, sid);
      const result = res.json().result as { content: Array<{ text: string }>; isError?: boolean };
      return { isError: Boolean(result.isError), text: result.content[0].text, json: () => JSON.parse(result.content[0].text) };
    },
  };
}

beforeEach(async () => {
  server = await startServer({ mcpRatePerMinute: 1000 });
  admin = await login(server.app, ADMIN.username, ADMIN.password);
  const api = client(server.app, admin);
  projectId = (await api.post("/api/v1/admin/projects", { name: "官网" })).json().project.id;
  designId = (await api.post(`/api/v1/projects/${projectId}/designs`, { name: "首页" })).json().design.id;
  await upload(api, designId, makeSqraft({ title: "欢迎回来", assets: { "assets/aaaa1111.png": PNG } }), "首版");
  token = (await api.post("/api/v1/tokens", { name: "Claude Code", purpose: "mcp", expiresInDays: 30 })).json().token;
});
afterEach(async () => server.close());

describe("MCP 协议", () => {
  it("没有令牌（或只有网页会话）返回 401 与 WWW-Authenticate", async () => {
    const res = await server.app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", id: 1, method: "initialize" } });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("Bearer");
    const withCookie = await server.app.inject({
      method: "POST",
      url: "/mcp",
      headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
      payload: { jsonrpc: "2.0", id: 1, method: "initialize" },
    });
    expect(withCookie.statusCode).toBe(401);
  });

  it("initialize 协商版本并下发会话；没带或带错会话分别 400 / 404；GET 返回 405", async () => {
    const c = await mcp(token);
    expect(c.init.json().result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "sqraft-cloud" } });
    expect(c.sid).toBeTruthy();
    expect((await c.raw({ jsonrpc: "2.0", id: 2, method: "tools/list" }, "")).statusCode).toBe(400);
    expect((await c.raw({ jsonrpc: "2.0", id: 2, method: "tools/list" }, "nope")).statusCode).toBe(404);
    expect((await c.raw({ jsonrpc: "2.0", method: "notifications/initialized" })).statusCode).toBe(202);
    expect((await server.app.inject({ method: "GET", url: "/mcp" })).statusCode).toBe(405);
    // OAuth 发现地址必须是 JSON 404，不能回落成网页
    const wk = await server.app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource/mcp" });
    expect(wk.statusCode).toBe(404);
    expect(wk.headers["content-type"]).toContain("application/json");
    // 会话绑定令牌：换一个令牌拿不到别人的会话
    const other = (await client(server.app, admin).post("/api/v1/tokens", { name: "x", purpose: "mcp", expiresInDays: 30 })).json().token;
    const res = await server.app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${other}`, "mcp-session-id": c.sid },
      payload: { jsonrpc: "2.0", id: 3, method: "tools/list" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("只列出只读工具；调用写工具被拒绝并记审计", async () => {
    const c = await mcp(token);
    const listed = (await c.raw({ jsonrpc: "2.0", id: 9, method: "tools/list" })).json().result.tools as Array<{ name: string; inputSchema: unknown }>;
    // 兼容性：参数 schema 里不出现 type 数组
    expect(JSON.stringify(listed)).not.toMatch(/"type":\[/);
    const names = listed.map((t) => t.name);
    expect(names).toEqual([
      "list_projects",
      "list_designs",
      "list_versions",
      "diff_versions",
      "list_pages",
      "read_page",
      "inspect_layout",
      "get_tokens",
      "list_components",
      "read_component",
      "get_asset",
      "export_svg",
      "search_nodes",
    ]);
    const res = await c.raw({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "update_node", arguments: {} } });
    expect(res.json().error.message).toContain("只读");
    const audit = (await client(server.app, admin).get("/api/v1/admin/audit?action=mcp.call")).json().entries;
    expect(audit[0]).toMatchObject({ result: "denied", tokenName: "Claude Code", detail: { tool: "update_node" } });
  });

  it("拒绝浏览器跨站 Origin", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${token}`, origin: "https://evil.example" },
      payload: { jsonrpc: "2.0", id: 1, method: "initialize" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("超过每分钟调用上限返回 429", async () => {
    await server.close();
    server = await startServer({ mcpRatePerMinute: 2 });
    admin = await login(server.app, ADMIN.username, ADMIN.password);
    const t = (await client(server.app, admin).post("/api/v1/tokens", { name: "x", purpose: "mcp", expiresInDays: 30 })).json().token;
    const c = await mcp(t);
    await c.call("list_projects");
    await c.call("list_projects");
    const res = await c.raw({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "list_projects", arguments: {} } });
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBeTruthy();
  });
});

describe("MCP 只读工具", () => {
  it("项目 → 设计稿 → 页面 → 节点逐层下钻", async () => {
    const c = await mcp(token);
    expect((await c.call("list_projects")).json().projects).toEqual([{ id: projectId, name: "官网", role: "editor", archived: false, designCount: 1 }]);
    const designs = (await c.call("list_designs", { query: "首" })).json().designs;
    expect(designs[0]).toMatchObject({ id: designId, projectName: "官网", currentVersion: 1, pageCount: 1 });
    expect((await c.call("list_versions", { designId })).json().versions[0]).toMatchObject({ number: 1, note: "首版", current: true });

    const pages = (await c.call("list_pages", { designId })).json();
    expect(pages).toMatchObject({ version: 1, total: 1, pages: [{ id: "page-1", name: "欢迎回来", width: 375, height: 812, nodeCount: 4, x: 0, y: 0 }] });
    expect(pages.pages[0].sameNameCount).toBeUndefined();
    expect((await c.call("list_pages", { designId, query: "不存在" })).json().pages).toEqual([]);

    const page = (await c.call("read_page", { designId, pageId: "page-1" })).json();
    expect(page.total).toBe(4);
    expect(page.nodes.map((n: { id: string }) => n.id)).toEqual(["page-1", "card", "t1", "pic"]);
    expect(page.nodes[2]).toMatchObject({ type: "text", text: "欢迎回来", w: 200, h: 24 });
    // 子节点只给数量，不给 id 列表
    expect(page.nodes[1]).toMatchObject({ id: "card", childCount: 2 });
    expect(page.nodes[1].children).toBeUndefined();
    expect(page.nextCursor).toBeUndefined();
  });

  it("read_page 支持子树、层数与分页", async () => {
    const c = await mcp(token);
    const sub = (await c.call("read_page", { designId, pageId: "page-1", nodeId: "card", depth: 0 })).json();
    expect(sub.nodes).toEqual([expect.objectContaining({ id: "card", truncated: true })]);
    const first = (await c.call("read_page", { designId, pageId: "page-1", limit: 3 })).json();
    expect(first).toMatchObject({ total: 4, nextCursor: "3" });
    const rest = (await c.call("read_page", { designId, pageId: "page-1", limit: 3, cursor: first.nextCursor })).json();
    expect(rest.nodes.map((n: { id: string }) => n.id)).toEqual(["pic"]);
    expect((await c.call("read_page", { designId, pageId: "nope" })).isError).toBe(true);
  });

  it("inspect_layout 给出世界坐标与自动布局；get_tokens 给出 Token", async () => {
    const c = await mcp(token);
    const layout = (await c.call("inspect_layout", { designId, pageId: "page-1", nodeIds: ["card"] })).json();
    // 世界坐标 = 页面原点 + 卡片偏移；子树一并返回
    expect(layout.nodes[0]).toMatchObject({ id: "card", depth: 0, x: 16, y: 100, width: 343, absolute: false, layout: { direction: "vertical", gap: 12 } });
    expect(layout.nodes.map((n: { id: string }) => n.id)).toEqual(["card", "t1", "pic"]);
    expect(layout.nodes[1]).toMatchObject({ id: "t1", x: 32, y: 116 });
    expect((await c.call("get_tokens", { designId })).json().tokens).toEqual({ "color/primary": { type: "color", value: "#1677ff" } });
  });

  it("get_asset 返回 10 分钟签名链接，免登录可下载；篡改或过期失效", async () => {
    const c = await mcp(token);
    const asset = (await c.call("get_asset", { designId, assetId: "aaaa1111" })).json();
    expect(asset).toMatchObject({ mime: "image/png", bytes: PNG.length, fileName: "aaaa1111.png" });
    const url = new URL(asset.url);
    const ok = await server.app.inject({ method: "GET", url: url.pathname + url.search });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toBe("image/png");
    expect(ok.rawPayload.equals(Buffer.from(PNG))).toBe(true);

    const tampered = await server.app.inject({ method: "GET", url: url.pathname + url.search.replace(/sig=[^&]+/, "sig=invalid") });
    expect(tampered.statusCode).toBe(404);
    const expired = await server.app.inject({ method: "GET", url: url.pathname + url.search.replace(/exp=\d+/, "exp=1") });
    expect(expired.statusCode).toBe(404);
    // 设计稿删除后链接立即失效
    await client(server.app, admin).delete(`/api/v1/designs/${designId}`);
    expect((await server.app.inject({ method: "GET", url: url.pathname + url.search })).statusCode).toBe(404);
  });

  it("export_svg 导出节点为 SVG：签名链接免登录下载、内嵌图片；篡改失效；网页登录后也能下载", async () => {
    const c = await mcp(token);
    const res = (await c.call("export_svg", { designId, nodeId: "card" })).json();
    expect(res).toMatchObject({ nodeId: "card", name: "卡片", width: 343, height: 200 });
    const url = new URL(res.url);
    expect(url.pathname).toBe(`/api/v1/exports/${designId}/1/page-1/card.svg`);
    const svg = await server.app.inject({ method: "GET", url: url.pathname + url.search });
    expect(svg.statusCode).toBe(200);
    expect(svg.headers["content-type"]).toContain("image/svg+xml");
    expect(svg.headers["content-security-policy"]).toContain("sandbox");
    expect(svg.body).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="343" height="200"/);
    expect(svg.body).toContain("欢迎回来");
    expect(svg.body).toContain(`data:image/png;base64,${Buffer.from(PNG).toString("base64").slice(0, 40)}`);
    expect((await server.app.inject({ method: "GET", url: url.pathname + url.search.replace(/sig=[^&]+/, "sig=invalid") })).statusCode).toBe(404);

    // 给了 pageId 也行；不存在的节点报错
    expect((await c.call("export_svg", { designId, nodeId: "t1", pageId: "page-1" })).json().name).toBe("标题");
    expect((await c.call("export_svg", { designId, nodeId: "nope" })).isError).toBe(true);

    const web = await client(server.app, admin).get(`/api/v1/designs/${designId}/versions/1/nodes/page-1/svg`);
    expect(web.statusCode).toBe(200);
    expect(web.headers["content-disposition"]).toContain("attachment");
  });

  it("search_nodes 按文字与图层名搜索", async () => {
    const c = await mcp(token);
    const res = (await c.call("search_nodes", { designId, query: "欢迎" })).json();
    expect(res.results.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining(["page-1", "t1"]));
    const onlyImages = (await c.call("search_nodes", { designId, query: "配", type: "image" })).json();
    expect(onlyImages.results).toEqual([expect.objectContaining({ id: "pic", pageId: "page-1", in: "欢迎回来" })]);
  });

  it("令牌只能读有权限的设计稿；指定旧版本读旧内容", async () => {
    const api = client(server.app, admin);
    await upload(api, designId, makeSqraft({ title: "第二版", assets: { "assets/aaaa1111.png": PNG } }));
    const user = await createUser(server.app, admin, "dev");
    await api.put(`/api/v1/admin/projects/${projectId}/members/${user.id}`, { role: "none" });
    const devToken = (await client(server.app, user.session).post("/api/v1/tokens", { name: "t", purpose: "mcp", expiresInDays: 30 })).json().token;
    const dev = await mcp(devToken);
    expect((await dev.call("list_designs")).json().designs).toEqual([]);
    expect((await dev.call("list_pages", { designId })).isError).toBe(true);

    const c = await mcp(token);
    expect((await c.call("list_pages", { designId })).json().pages[0].name).toBe("第二版");
    expect((await c.call("list_pages", { designId, version: 1 })).json().pages[0].name).toBe("欢迎回来");
  });

  it("每次工具调用记审计：令牌名与设计稿", async () => {
    const c = await mcp(token);
    await c.call("list_pages", { designId });
    const entries = (await client(server.app, admin).get("/api/v1/admin/audit?action=mcp.call")).json().entries;
    expect(entries[0]).toMatchObject({ tokenName: "Claude Code", target: designId, result: "ok", detail: { tool: "list_pages" } });
  });
});

describe("网页只读接口", () => {
  it("页面列表、单页文档、切图（长缓存）", async () => {
    const api = client(server.app, admin);
    const pages = (await api.get(`/api/v1/designs/${designId}/versions/current/pages`)).json();
    expect(pages).toMatchObject({ version: 1, pages: [{ id: "page-1", nodeCount: 4 }] });
    const page = (await api.get(`/api/v1/designs/${designId}/versions/1/pages/page-1`)).json();
    expect(Object.keys(page.doc.nodes).sort()).toEqual(["card", "page-1", "pic", "t1"]);
    expect(page.doc.tokens["color/primary"]).toBeTruthy();
    const asset = await api.get(`/api/v1/designs/${designId}/versions/1/assets/aaaa1111`);
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toContain("immutable");
    expect((await client(server.app, null).get(`/api/v1/designs/${designId}/versions/1/assets/aaaa1111`)).statusCode).toBe(401);
  });

  it("里程碑 1 上传、没有索引的旧版本在首次读取时补建索引", async () => {
    server.ctx.db.prepare("UPDATE versions SET index_blob = NULL").run();
    const api = client(server.app, admin);
    const pages = (await api.get(`/api/v1/designs/${designId}/versions/1/pages`)).json();
    expect(pages.pages[0].id).toBe("page-1");
    const row = server.ctx.db.prepare("SELECT index_blob FROM versions").get() as { index_blob: string | null };
    expect(row.index_blob).toMatch(/^[0-9a-f]{64}$/);
  });
});
