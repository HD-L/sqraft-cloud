import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { strToU8, zipSync } from "fflate";
import { normalizeSections, splitDoc, type CommitManifest } from "@sqraft-cloud/shared";
import { ADMIN, client, login, startServer, upload, type TestServer } from "./helpers";
import { sectionsOf } from "../src/sections";
import type { PageEntry, VersionIndex } from "../src/indexer";

let server: TestServer;
let api: ReturnType<typeof client>;
let designId: string;

function node(id: string, type: string, parentId: string | null, children: string[], extra: Record<string, unknown> = {}) {
  return { id, type, name: id, parentId, children, x: 0, y: 0, width: 100, height: 100, rotation: 0, opacity: 1, visible: true, locked: false, style: {}, ...extra };
}

/** 两个 Sketch 页面：v2 一行两张画板，v1 在下方 */
function doc() {
  return {
    version: 1,
    formatVersion: 7,
    rootIds: ["a1", "a2", "b1"],
    nodes: {
      a1: node("a1", "page", null, [], { x: 0, y: 0, width: 375, height: 812 }),
      a2: node("a2", "page", null, [], { x: 500, y: 0, width: 375, height: 812 }),
      b1: node("b1", "page", null, [], { x: 0, y: 1452, width: 375, height: 812 }),
    },
    tokens: {},
  };
}

const SECTIONS = [
  { name: "v2", pageIds: ["a2", "a1"] },
  { name: "v1", pageIds: ["b1"] },
];

function sqraft(sections?: unknown) {
  return zipSync({
    "manifest.json": strToU8(JSON.stringify({ formatVersion: 7, ...(sections ? { sections } : {}) })),
    "doc.json": strToU8(JSON.stringify(doc())),
  });
}

beforeEach(async () => {
  server = await startServer({ mcpRatePerMinute: 1000 });
  api = client(server.app, await login(server.app, ADMIN.username, ADMIN.password));
  const projectId = (await api.post("/api/v1/projects", { name: "App" })).json().project.id;
  designId = (await api.post(`/api/v1/projects/${projectId}/designs`, { name: "主流程" })).json().design.id;
});
afterEach(async () => server.close());

describe("页面分组", () => {
  it("整理分组：只留存在的页面、每页一组、其余进「未分组」；不合法整体忽略", () => {
    expect(normalizeSections([{ name: "A", pageIds: ["p1", "x", "p1"] }, { name: "B", pageIds: ["p1"] }], ["p1", "p2"])).toEqual([
      { name: "A", pageIds: ["p1"] },
      { name: "未分组", pageIds: ["p2"] },
    ]);
    expect(normalizeSections([{ name: 1 }], ["p1"])).toBeUndefined();
    // 组名在看稿与 MCP 筛选里当标识：重名的加序号，包括与自动补的「未分组」撞名
    expect(normalizeSections([{ name: "首页", pageIds: ["p1"] }, { name: "首页", pageIds: ["p2"] }, { name: "未分组", pageIds: ["p3"] }], ["p1", "p2", "p3", "p4"])).toEqual([
      { name: "首页", pageIds: ["p1"] },
      { name: "首页 (2)", pageIds: ["p2"] },
      { name: "未分组", pageIds: ["p3"] },
      { name: "未分组 (2)", pageIds: ["p4"] },
    ]);
    expect(normalizeSections([{ name: "  ", pageIds: ["p1"] }], ["p1"])).toEqual([{ name: "未命名", pageIds: ["p1"] }]);
    expect(normalizeSections("x", ["p1"])).toBeUndefined();
  });

  it("没有分组时按画布横带推断，散图层页面的名字当组名；组内按阅读顺序", () => {
    const pg = (id: string, name: string, x: number, y: number, h = 800): PageEntry => ({ id, name, x, y, width: 375, height: h, nodeCount: 1, blob: "" });
    const idx = {
      pages: [
        pg("b", "首页", 500, 0),
        pg("a", "登录", 0, 10),
        pg("loose", "v4.3.2 / 散图层 1", 1000, 0, 40),
        pg("c", "设置", 0, 1500),
      ],
    } as unknown as VersionIndex;
    expect(sectionsOf(idx)).toEqual([
      { name: "v4.3.2", pageIds: ["a", "b", "loose"], inferred: true },
      { name: "分组 2", pageIds: ["c"], inferred: true },
    ]);
  });

  it("整包上传读 manifest.json 的分组；页面接口按组返回，组内按阅读顺序", async () => {
    expect((await upload(api, designId, sqraft(SECTIONS))).statusCode).toBe(200);
    const res = (await api.get(`/api/v1/designs/${designId}/versions/1/pages`)).json();
    expect(res.sections).toEqual([
      { name: "v2", pageIds: ["a1", "a2"], inferred: false },
      { name: "v1", pageIds: ["b1"], inferred: false },
    ]);
    expect(res.pages.map((p: { id: string; section: string }) => [p.id, p.section])).toEqual([
      ["a1", "v2"],
      ["a2", "v2"],
      ["b1", "v1"],
    ]);

    // 只改分组也算新版本；同样的分组再传判重
    expect((await upload(api, designId, sqraft([{ name: "全部", pageIds: ["a1", "a2", "b1"] }]))).json()).toMatchObject({ duplicate: false, version: { number: 2 } });
    expect((await upload(api, designId, sqraft([{ name: "全部", pageIds: ["a1", "a2", "b1"] }]))).json()).toMatchObject({ duplicate: true });

    // 没有分组的旧文件：按画布推断
    await upload(api, designId, sqraft());
    const inferred = (await api.get(`/api/v1/designs/${designId}/versions/3/pages`)).json().sections;
    expect(inferred.map((s: { pageIds: string[]; inferred: boolean }) => [s.pageIds, s.inferred])).toEqual([
      [["a1", "a2"], true],
      [["b1"], true],
    ]);
  });

  it("增量提交带分组，与整包上传判重一致；MCP 按分组列页面", async () => {
    expect((await upload(api, designId, sqraft(SECTIONS))).statusCode).toBe(200);
    const parts = splitDoc(doc() as never);
    const manifest: CommitManifest = { formatVersion: 7, tokens: {}, parts: parts.map((p) => ({ rootId: p.rootId, hash: p.hash })), assets: [], sections: SECTIONS };
    // 页面都已在服务端（整包上传时存过），同样的内容 + 分组 → 判重
    expect((await api.post(`/api/v1/designs/${designId}/commits`, { manifest })).json()).toMatchObject({ duplicate: true, version: { number: 1 } });
    const moved = { ...manifest, sections: [{ name: "v1", pageIds: ["b1", "a1"] }] };
    for (const p of parts) await api.put(`/api/v1/designs/${designId}/blobs/${p.hash}?kind=part`, gzipSync(p.json));
    const res = await api.post(`/api/v1/designs/${designId}/commits`, { manifest: moved });
    expect(res.json()).toMatchObject({ duplicate: false, version: { number: 2 } });
    const sections = (await api.get(`/api/v1/designs/${designId}/versions/2/pages`)).json().sections;
    expect(sections.map((s: { name: string; pageIds: string[] }) => [s.name, s.pageIds])).toEqual([
      ["v1", ["a1", "b1"]],
      ["未分组", ["a2"]],
    ]);

    const token = (await api.post("/api/v1/tokens", { name: "t", purpose: "mcp", expiresInDays: 30 })).json().token as string;
    const send = (body: unknown, sid?: string) =>
      server.app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(sid ? { "mcp-session-id": sid } : {}) },
        payload: body as object,
      });
    const init = await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    const sid = init.headers["mcp-session-id"] as string;
    const call = async (args: Record<string, unknown>) =>
      JSON.parse((await send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_pages", arguments: args } }, sid)).json().result.content[0].text);
    const all = await call({ designId });
    expect(all.sections).toEqual([
      { name: "v1", pageCount: 2 },
      { name: "未分组", pageCount: 1 },
    ]);
    expect((await call({ designId, section: "未分组" })).pages.map((p: { id: string; section: string }) => [p.id, p.section])).toEqual([["a2", "未分组"]]);
  });
});

describe("单页原始数据", () => {
  it("直接发 gzip，带长缓存与 ETag；不接受 gzip 时发明文", async () => {
    expect((await upload(api, designId, sqraft(SECTIONS))).statusCode).toBe(200);
    const url = `/api/v1/designs/${designId}/versions/1/parts/a1`;
    const gz = await server.app.inject({ method: "GET", url, headers: { ...(await authHeaders()), "accept-encoding": "gzip, br" } });
    expect(gz.statusCode).toBe(200);
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect(gz.headers["cache-control"]).toContain("immutable");
    const { gunzipSync } = await import("node:zlib");
    expect(JSON.parse(gunzipSync(gz.rawPayload).toString()).rootIds).toEqual(["a1"]);
    const plain = await server.app.inject({ method: "GET", url, headers: await authHeaders() });
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.json().nodes.a1.type).toBe("page");
    const again = await server.app.inject({ method: "GET", url, headers: { ...(await authHeaders()), "if-none-match": gz.headers.etag as string } });
    expect(again.statusCode).toBe(304);
    // current 会随发布变：不能长期缓存，只能用 ETag 校验
    const cur = await server.app.inject({ method: "GET", url: `/api/v1/designs/${designId}/versions/current/parts/a1`, headers: await authHeaders() });
    expect(cur.headers["cache-control"]).toBe("private, no-cache");
    expect(cur.headers.etag).toBe(gz.headers.etag);
    expect((await api.get(`/api/v1/designs/${designId}/versions/1/parts/nope`)).statusCode).toBe(404);

    // 存储里的文件丢了：错误响应不能带长缓存与 ETag
    const { rm } = await import("node:fs/promises");
    await rm(server.ctx.store.path(String(gz.headers.etag).replace(/"/g, "")));
    const broken = await server.app.inject({ method: "GET", url, headers: { ...(await authHeaders()), "accept-encoding": "gzip" } });
    expect(broken.statusCode).toBeGreaterThanOrEqual(500);
    expect(broken.headers["cache-control"]).not.toContain("immutable");
    expect(broken.headers.etag).toBeUndefined();
    expect(broken.headers["content-encoding"]).toBeUndefined();
  });
});

async function authHeaders(): Promise<Record<string, string>> {
  const s = await login(server.app, ADMIN.username, ADMIN.password);
  return { cookie: s.cookie };
}
