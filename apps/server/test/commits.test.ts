import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { strToU8, zipSync } from "fflate";
import { canonicalJson, makePart, sha256, splitDoc, type CommitManifest } from "@sqraft-cloud/shared";
import { ADMIN, client, fakePng, login, startServer, upload, type TestServer } from "./helpers";

let server: TestServer;
let api: ReturnType<typeof client>;
let designId: string;

function node(id: string, type: string, name: string, parentId: string | null, children: string[], extra: Record<string, unknown> = {}) {
  return { id, type, name, parentId, children, x: 0, y: 0, width: 100, height: 100, rotation: 0, opacity: 1, visible: true, locked: false, style: {}, ...extra };
}

/** 两个页面 + 一个主组件的文档；`edit` 改动其中某些字段 */
function makeDoc(edit: { title2?: string; name1?: string; x1?: number; image?: boolean } = {}) {
  return {
    version: 1,
    formatVersion: 7,
    rootIds: ["page-1", "page-2", "btn"],
    nodes: {
      "page-1": node("page-1", "page", edit.name1 ?? "首页", null, ["t1", ...(edit.image ? ["pic"] : [])], { x: edit.x1 ?? 0, width: 375, height: 812 }),
      t1: node("t1", "text", "标题", "page-1", [], { text: "欢迎" }),
      ...(edit.image ? { pic: node("pic", "image", "配图", "page-1", [], { image: { assetId: "bbbb2222", naturalWidth: 10, naturalHeight: 10 } }) } : {}),
      "page-2": node("page-2", "page", "我的", null, ["t2", "i1"], { x: 500, width: 375, height: 812 }),
      t2: node("t2", "text", "昵称", "page-2", [], { text: edit.title2 ?? "张三" }),
      i1: node("i1", "instance", "按钮", "page-2", [], { componentId: "btn" }),
      btn: node("btn", "component", "按钮", null, [], { width: 80, height: 32 }),
    },
    tokens: { "color/primary": { type: "color", value: "#1677ff" } },
  };
}

function zip(doc: ReturnType<typeof makeDoc>, assets: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({
    "manifest.json": strToU8(JSON.stringify({ formatVersion: 7 })),
    "doc.json": strToU8(JSON.stringify(doc)),
    ...assets,
  });
}

/** 客户端的做法：拆页 → 问缺哪些 → 只传缺的 → 提交清单 */
async function incremental(doc: ReturnType<typeof makeDoc>, assets: Record<string, Uint8Array> = {}, note = "") {
  const parts = splitDoc(doc as never);
  const assetList = Object.entries(assets).map(([name, bytes]) => ({ name, hash: sha256(bytes), size: bytes.length, bytes }));
  const check = await api.post(`/api/v1/designs/${designId}/blobs/check`, { hashes: [...parts.map((p) => p.hash), ...assetList.map((a) => a.hash)] });
  expect(check.statusCode).toBe(200);
  const missing = new Set(check.json().missing as string[]);
  const sent: string[] = [];
  for (const p of parts) {
    if (!missing.has(p.hash)) continue;
    const res = await api.put(`/api/v1/designs/${designId}/blobs/${p.hash}?kind=part`, gzipSync(p.json));
    expect(res.statusCode, res.body).toBe(200);
    sent.push(p.rootId);
  }
  for (const a of assetList) {
    if (!missing.has(a.hash)) continue;
    expect((await api.put(`/api/v1/designs/${designId}/blobs/${a.hash}?kind=asset`, a.bytes)).statusCode).toBe(200);
    sent.push(a.name);
  }
  const manifest: CommitManifest = {
    formatVersion: 7,
    tokens: doc.tokens as CommitManifest["tokens"],
    parts: parts.map((p) => ({ rootId: p.rootId, hash: p.hash })),
    assets: assetList.map(({ name, hash, size }) => ({ name, hash, size })),
  };
  const res = await api.post(`/api/v1/designs/${designId}/commits`, { note, manifest });
  return { res, sent, manifest };
}

async function mcpCall(name: string, args: Record<string, unknown>) {
  const created = await api.post("/api/v1/tokens", { name: "t", purpose: "mcp", expiresInDays: 30 });
  if (created.statusCode !== 200) throw new Error(created.body);
  const token = created.json().token as string;
  const send = (body: unknown, sid?: string) =>
    server.app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(sid ? { "mcp-session-id": sid } : {}) },
      payload: body as object,
    });
  const init = await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  const res = await send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }, init.headers["mcp-session-id"] as string);
  if (!res.json().result) throw new Error(res.body);
  return JSON.parse(res.json().result.content[0].text);
}

beforeEach(async () => {
  server = await startServer({ mcpRatePerMinute: 1000 });
  api = client(server.app, await login(server.app, ADMIN.username, ADMIN.password));
  const projectId = (await api.post("/api/v1/admin/projects", { name: "App" })).json().project.id;
  designId = (await api.post(`/api/v1/projects/${projectId}/designs`, { name: "主流程" })).json().design.id;
});
afterEach(async () => server.close());

describe("拆分规则（服务端与客户端共用）", () => {
  it("规范序列化与键顺序无关；内容哈希不计页面名称与位置", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: undefined, c: 3 }] })).toBe('{"a":[2,{"c":3}],"b":1}');
    const doc = makeDoc();
    const reordered = { ...doc, nodes: Object.fromEntries(Object.entries(doc.nodes).reverse().map(([k, v]) => [k, Object.fromEntries(Object.entries(v).reverse())])) };
    expect(splitDoc(reordered as never).map((p) => p.hash)).toEqual(splitDoc(doc as never).map((p) => p.hash));

    const [p1] = splitDoc(doc as never);
    const [moved] = splitDoc(makeDoc({ name1: "新首页", x1: 900 }) as never);
    expect(moved.hash).not.toBe(p1.hash);
    expect(moved.contentHash).toBe(p1.contentHash);
    expect(JSON.parse(p1.json)).toEqual({ nodes: { "page-1": doc.nodes["page-1"], t1: doc.nodes.t1 }, rootIds: ["page-1"] });
    expect(makePart("page-1", JSON.parse(p1.json).nodes).hash).toBe(p1.hash);
  });
});

describe("增量上传", () => {
  it("整包上传后再增量提交：只传改动的页面，记录变更与每页最后修改的版本", async () => {
    expect((await upload(api, designId, zip(makeDoc()), "首版")).statusCode).toBe(200);

    const v2 = await incremental(makeDoc({ title2: "李四" }), {}, "改昵称");
    expect(v2.res.statusCode, v2.res.body).toBe(200);
    // 整包上传时存下的页面和增量提交用同一个名字：没变的首页、组件不用再传
    expect(v2.sent).toEqual(["page-2"]);
    expect(v2.res.json()).toMatchObject({
      duplicate: false,
      version: { number: 2, note: "改昵称", changes: { base: 1, pages: { added: 0, modified: 1, removed: 0 }, components: { modified: 0 }, tokens: 0 } },
    });

    const changes = (await api.get(`/api/v1/designs/${designId}/versions/2/changes`)).json().changes;
    expect(changes.pages.modified).toEqual([{ id: "page-2", name: "我的" }]);
    const pages = (await api.get(`/api/v1/designs/${designId}/versions/2/pages`)).json().pages;
    expect(pages.map((p: { id: string; changedIn: number }) => [p.id, p.changedIn])).toEqual([["page-1", 1], ["page-2", 2]]);
    expect(pages[0]).not.toHaveProperty("contentHash");

    // 同样的内容再提交一次 / 换成整包上传：都判为重复
    expect((await incremental(makeDoc({ title2: "李四" }))).res.json()).toMatchObject({ duplicate: true, version: { number: 2 } });
    expect((await upload(api, designId, zip(makeDoc({ title2: "李四" })))).json()).toMatchObject({ duplicate: true, version: { number: 2 } });

    // 只改名、只挪位置：不算内容变化，changedIn 不变
    const v3 = await incremental(makeDoc({ title2: "李四", name1: "新首页", x1: 1000 }));
    expect(v3.sent).toEqual(["page-1"]);
    const c3 = (await api.get(`/api/v1/designs/${designId}/versions/3/changes`)).json().changes;
    expect(c3.pages).toMatchObject({ modified: [], renamed: [{ id: "page-1", name: "新首页", from: "首页" }], moved: [{ id: "page-1" }] });
    const pages3 = (await api.get(`/api/v1/designs/${designId}/versions/3/pages`)).json().pages;
    // 首页挪到了右边，阅读顺序变成「我的」在前
    expect(Object.fromEntries(pages3.map((p: { id: string; changedIn: number }) => [p.id, p.changedIn]))).toEqual({ "page-1": 1, "page-2": 2 });

    // 第一个版本相对「无」：全部是新增
    const c1 = (await api.get(`/api/v1/designs/${designId}/versions/1/changes`)).json().changes;
    expect(c1).toMatchObject({ base: null, pages: { added: [{ id: "page-1" }, { id: "page-2" }] }, components: { added: [{ id: "btn" }] } });

    // 读稿与整包上传完全一样：组件实例数、页面内容
    const comps = (await api.get(`/api/v1/designs/${designId}/versions/3/components`)).json().components;
    expect(comps).toEqual([expect.objectContaining({ id: "btn", instanceCount: 1, changedIn: 1 })]);
    const doc = (await api.get(`/api/v1/designs/${designId}/versions/3/pages/page-2`)).json().doc;
    expect(doc.nodes.t2.text).toBe("李四");

    // MCP：版本差异、只列出某版本之后变过的页面
    const diff = await mcpCall("diff_versions", { designId, from: 1 });
    expect(diff).toMatchObject({ from: 1, to: 3, pages: { modified: [{ id: "page-2" }], renamed: [{ id: "page-1" }] } });
    const since = await mcpCall("list_pages", { designId, changedSince: 1 });
    expect(since.pages.map((p: { id: string }) => p.id)).toEqual(["page-2"]);
    const versions = await mcpCall("list_versions", { designId });
    expect(versions.versions[0]).toMatchObject({ number: 3, changes: { pages: { renamed: 1, moved: 1, modified: 0 } } });
  });

  it("切图按字节哈希上传；还缺文件时返回缺的清单", async () => {
    const png = fakePng(3, 4096);
    const doc = makeDoc({ image: true });
    const parts = splitDoc(doc as never);
    const manifest: CommitManifest = {
      formatVersion: 7,
      tokens: {},
      parts: parts.map((p) => ({ rootId: p.rootId, hash: p.hash })),
      assets: [{ name: "assets/bbbb2222.png", hash: sha256(png), size: png.length }],
    };
    const early = await api.post(`/api/v1/designs/${designId}/commits`, { manifest });
    expect(early.statusCode).toBe(409);
    expect(early.json().missing).toHaveLength(4);

    const r = await incremental(doc, { "assets/bbbb2222.png": png });
    expect(r.res.statusCode, r.res.body).toBe(200);
    expect(r.sent).toEqual(["page-1", "page-2", "btn", "assets/bbbb2222.png"]);
    const asset = await api.get(`/api/v1/designs/${designId}/versions/1/assets/bbbb2222`);
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toBe("image/png");
  });

  it("哈希对不上、不是规范序列化、清单不合法都拒收", async () => {
    const [p1] = splitDoc(makeDoc() as never);
    const wrong = await api.put(`/api/v1/designs/${designId}/blobs/${"0".repeat(64)}?kind=part`, gzipSync(p1.json));
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe("hash_mismatch");
    expect((await api.put(`/api/v1/designs/${designId}/blobs/${p1.hash}?kind=part`, Buffer.from(p1.json))).statusCode).toBe(400);

    // 内容合法但带缩进：哈希按它自己的字节算能传上去，提交时因不是规范形式被拒
    const pretty = JSON.stringify(JSON.parse(p1.json), null, 2);
    const prettyHash = sha256(pretty);
    expect((await api.put(`/api/v1/designs/${designId}/blobs/${prettyHash}?kind=part`, gzipSync(pretty))).statusCode).toBe(200);
    const bad = await api.post(`/api/v1/designs/${designId}/commits`, { manifest: { formatVersion: 7, tokens: {}, parts: [{ rootId: "page-1", hash: prettyHash }], assets: [] } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.message).toContain("规范");

    const dup = await api.post(`/api/v1/designs/${designId}/commits`, {
      manifest: { formatVersion: 7, tokens: {}, parts: [{ rootId: "a", hash: prettyHash }, { rootId: "a", hash: prettyHash }], assets: [] },
    });
    expect(dup.statusCode).toBe(422);
    const tooNew = await api.post(`/api/v1/designs/${designId}/commits`, { manifest: { formatVersion: 999, tokens: {}, parts: [], assets: [] } });
    expect(tooNew.json().error.code).toBe("format_too_new");
  });

  it("服务信息声明增量上传能力", async () => {
    expect((await api.get("/api/v1/info")).json().features).toContain("incremental-upload");
  });
});
