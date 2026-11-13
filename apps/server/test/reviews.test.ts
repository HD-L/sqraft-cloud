import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { gzipSync } from "node:zlib";
import { strFromU8, unzipSync } from "fflate";
import { splitDoc } from "@sqraft-cloud/shared";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, openDb } from "../src/db";
import { ADMIN, client, login, makeSqraft, startServer, upload, type TestServer } from "./helpers";

let server: TestServer;
let admin: ReturnType<typeof client>;
let projectId: string;

/** 管理员建成员并完成首次改密码，返回该成员的客户端 */
async function member(username: string, role: "admin" | "editor" | "viewer", extra: Record<string, unknown> = {}) {
  const res = await admin.post("/api/v1/team/members", { username, role, ...extra });
  expect(res.statusCode, res.body).toBe(200);
  const { member: m, initialPassword } = res.json();
  const first = await login(server.app, username, initialPassword);
  expect((await client(server.app, first).post("/api/v1/me/password", { currentPassword: initialPassword, newPassword: `${username}-new-pass-1` })).statusCode).toBe(200);
  return { id: m.id as string, api: client(server.app, first) };
}

type Api = ReturnType<typeof client>;

async function newDesign(api: Api, name = "首页") {
  const res = await api.post(`/api/v1/projects/${projectId}/designs`, { name });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().design.id as string;
}

async function put(api: Api, designId: string, title: string) {
  const res = await upload(api, designId, makeSqraft({ title }));
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

const review = (api: Api, designId: string, body: Record<string, unknown>) => api.post(`/api/v1/designs/${designId}/review`, body);
const getDesign = async (api: Api, designId: string) => (await api.get(`/api/v1/designs/${designId}`)).json().design;
const notes = async (api: Api) => (await api.get("/api/v1/notifications")).json().notifications as Array<{ kind: string; text: string; link: string }>;
const kinds = async (api: Api, kind: string) => (await notes(api)).filter((n) => n.kind === kind);

beforeEach(async () => {
  server = await startServer();
  admin = client(server.app, await login(server.app, ADMIN.username, ADMIN.password));
  projectId = (await admin.post("/api/v1/projects", { name: "官网改版" })).json().project.id;
});
afterEach(async () => server.close());

describe("评审状态机", () => {
  it("合法的转换与不合法的 409；直接发布记「未经评审」；改回草稿保留通过的版本", async () => {
    const ed = await member("eddie", "editor", { displayName: "艾迪" });
    const id = await newDesign(ed.api);
    // 没有版本不能直接发布
    expect((await review(ed.api, id, { action: "publish" })).json().error.code).toBe("no_version");
    await put(ed.api, id, "v1");

    // 草稿不能通过 / 退回 / 撤回 / 改回草稿
    for (const action of ["approve", "withdraw", "unpublish"]) {
      const res = await review(ed.api, id, { action, version: 1 });
      expect(res.statusCode, action).toBe(409);
      expect(res.json().error.code).toBe("invalid_transition");
    }
    expect((await review(ed.api, id, { action: "bogus" })).statusCode).toBe(400);

    const pub = await review(ed.api, id, { action: "publish" });
    expect(pub.statusCode, pub.body).toBe(200);
    expect(pub.json().design).toMatchObject({ status: "published", approvedVersion: 1, approvedBy: { id: ed.id, displayName: "艾迪" }, openReview: null, canReview: false });
    expect((await review(ed.api, id, { action: "publish" })).statusCode).toBe(409);

    // 已发布 → 重新提交评审；评审中再提交、直接发布、改回草稿都是 409
    const sub = await review(ed.api, id, { action: "submit", note: "请看看" });
    expect(sub.json().design).toMatchObject({ status: "review", openReview: { version: 1, note: "请看看", reviewers: [], requestedBy: { id: ed.id } } });
    for (const action of ["submit", "publish", "unpublish"]) expect((await review(ed.api, id, { action })).statusCode, action).toBe(409);

    // 退回原因必填
    expect((await review(ed.api, id, { action: "reject" })).json().error.code).toBe("reason_required");
    const rej = await review(ed.api, id, { action: "reject", note: "颜色不对" });
    expect(rej.json().design).toMatchObject({ status: "draft", approvedVersion: 1, openReview: null });

    // 再走一轮：通过 → 已发布 → 改回草稿（保留通过的版本）
    await review(ed.api, id, { action: "submit" });
    expect((await review(ed.api, id, { action: "approve" })).statusCode).toBe(400); // 必须带版本
    expect((await review(ed.api, id, { action: "approve", version: 1 })).json().design.status).toBe("published");
    const un = await review(ed.api, id, { action: "unpublish" });
    expect(un.json().design).toMatchObject({ status: "draft", approvedVersion: 1 });

    // 时间线
    const hist = (await ed.api.get(`/api/v1/designs/${id}/reviews`)).json();
    expect(hist.reviews.map((r: { state: string; skipped: boolean }) => [r.state, r.skipped])).toEqual([
      ["approved", true],
      ["rejected", false],
      ["approved", false],
    ]);
    expect(hist.events.map((e: { type: string }) => e.type)).toEqual(["publish_direct", "submit", "reject", "submit", "approve", "unpublish"]);
    expect(hist.events[2]).toMatchObject({ actor: { displayName: "艾迪" }, version: 1, note: "颜色不对" });

    // 审计
    const actions = (server.ctx.db.prepare("SELECT action FROM audit WHERE target = ? AND action LIKE 'review.%' ORDER BY id").all(id) as Array<{ action: string }>).map(
      (a) => a.action,
    );
    expect(actions).toEqual(["review.publish_direct", "review.submit", "review.reject", "review.submit", "review.approve", "review.unpublish"]);
  });

  it("通过时带的版本与当前版本不同返回 409", async () => {
    const ed = await member("eddie", "editor");
    const id = await newDesign(ed.api);
    await put(ed.api, id, "v1");
    await review(ed.api, id, { action: "submit" });
    await put(ed.api, id, "v2");
    const stale = await review(ed.api, id, { action: "approve", version: 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({ code: "version_mismatch", message: "有新版本，请刷新后再确认" });
    const ok = await review(ed.api, id, { action: "approve", version: 2 });
    expect(ok.json().design).toMatchObject({ status: "published", approvedVersion: 2, currentVersion: 2 });
  });

  it("撤回回到发起前的状态", async () => {
    const ed = await member("eddie", "editor");
    const id = await newDesign(ed.api);
    await put(ed.api, id, "v1");
    // 草稿 → 评审 → 撤回 = 草稿
    await review(ed.api, id, { action: "submit" });
    expect((await review(ed.api, id, { action: "withdraw" })).json().design.status).toBe("draft");
    // 已发布 → 评审 → 撤回 = 已发布（通过的版本仍是当前版本）
    await review(ed.api, id, { action: "publish" });
    await review(ed.api, id, { action: "submit" });
    expect((await review(ed.api, id, { action: "withdraw" })).json().design.status).toBe("published");
    // 已发布 → 评审 → 上传新版本 → 撤回 = 草稿
    await review(ed.api, id, { action: "submit" });
    await put(ed.api, id, "v2");
    expect((await review(ed.api, id, { action: "withdraw" })).json().design).toMatchObject({ status: "draft", approvedVersion: 1 });
    // 回滚到通过的版本后再走一遍：又能回到已发布
    await review(ed.api, id, { action: "publish" }); // 现在通过的是 v2
    await review(ed.api, id, { action: "submit" });
    await ed.api.post(`/api/v1/designs/${id}/rollback`, { version: 1 });
    await ed.api.post(`/api/v1/designs/${id}/rollback`, { version: 2 });
    expect((await review(ed.api, id, { action: "withdraw" })).json().design.status).toBe("published");
    const events = (await ed.api.get(`/api/v1/designs/${id}/reviews`)).json().events.map((e: { type: string }) => e.type);
    expect(events.filter((t: string) => t === "withdraw")).toHaveLength(4);
  });

  it("旧接口 PATCH status 转成评审动作并留记录；同状态不变", async () => {
    const ed = await member("eddie", "editor");
    const id = await newDesign(ed.api);
    await put(ed.api, id, "v1");
    expect((await ed.api.patch(`/api/v1/designs/${id}`, { status: "draft" })).json().design.status).toBe("draft");
    expect((await ed.api.patch(`/api/v1/designs/${id}`, { status: "published" })).json().design).toMatchObject({ status: "published", approvedVersion: 1 });
    expect((await ed.api.patch(`/api/v1/designs/${id}`, { status: "review" })).json().design.status).toBe("review");
    expect((await ed.api.patch(`/api/v1/designs/${id}`, { status: "draft" })).json().design.status).toBe("published"); // = 撤回
    await ed.api.patch(`/api/v1/designs/${id}`, { status: "review" });
    expect((await ed.api.patch(`/api/v1/designs/${id}`, { status: "published" })).json().design.status).toBe("published"); // = 通过当前版本
    expect((await ed.api.patch(`/api/v1/designs/${id}`, { status: "draft", name: "新名字" })).json().design).toMatchObject({ status: "draft", name: "新名字" });
    const events = (await ed.api.get(`/api/v1/designs/${id}/reviews`)).json().events.map((e: { type: string }) => e.type);
    expect(events).toEqual(["publish_direct", "submit", "withdraw", "submit", "approve", "unpublish"]);
  });
});

describe("评审权限", () => {
  it("指定的评审人（查看者也可以）能通过；名单外的人不能；canReview 由服务端下发", async () => {
    const ed = await member("eddie", "editor");
    const ed2 = await member("emma", "editor");
    const vi = await member("vivi", "viewer", { displayName: "小薇" });
    const vi2 = await member("victor", "viewer");
    const id = await newDesign(ed.api);
    await put(ed.api, id, "v1");

    // 查看者不能提交评审；评审人必须是能看到项目的成员
    expect((await review(vi.api, id, { action: "submit" })).statusCode).toBe(403);
    expect((await review(ed.api, id, { action: "submit", reviewers: ["nobody"] })).json().error.code).toBe("invalid_reviewer");

    const sub = await review(ed.api, id, { action: "submit", reviewers: [vi.id] });
    expect(sub.json().design.openReview.reviewers).toEqual([{ id: vi.id, displayName: "小薇", valid: true }]);
    expect(sub.json().design.canReview).toBe(false); // 提交者不在名单里

    expect((await getDesign(vi.api, id)).canReview).toBe(true);
    expect((await getDesign(vi2.api, id)).canReview).toBe(false);
    expect((await getDesign(ed2.api, id)).canReview).toBe(false);
    expect((await getDesign(admin, id)).canReview).toBe(true);

    expect((await review(vi2.api, id, { action: "approve", version: 1 })).json().error.code).toBe("not_reviewer");
    expect((await review(ed2.api, id, { action: "reject", note: "x" })).json().error.code).toBe("not_reviewer");
    expect((await review(ed.api, id, { action: "approve", version: 1 })).json().error.code).toBe("not_reviewer");
    // 查看者评审人不能撤回 / 改评审人（编辑者才行）
    expect((await review(vi.api, id, { action: "withdraw" })).statusCode).toBe(403);
    expect((await review(vi.api, id, { action: "reviewers", reviewers: [] })).statusCode).toBe(403);

    const ok = await review(vi.api, id, { action: "approve", version: 1 });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().design).toMatchObject({ status: "published", approvedBy: { id: vi.id } });
    const last = (await ed.api.get(`/api/v1/designs/${id}/reviews`)).json().reviews.at(-1);
    expect(last).toMatchObject({ state: "approved", byAdmin: false, decidedBy: { id: vi.id } });
  });

  it("评审人全部失效时任一编辑者可审，但提交者不能审自己的提交；管理员始终可以（标 by_admin）", async () => {
    const ed = await member("eddie", "editor");
    const ed2 = await member("emma", "editor");
    const vi = await member("vivi", "viewer");
    const id = await newDesign(ed.api);
    await put(ed.api, id, "v1");
    await review(ed.api, id, { action: "submit", reviewers: [vi.id] });
    // 停用评审人 → 名单全部失效
    expect((await admin.delete(`/api/v1/team/members/${vi.id}`)).statusCode).toBe(200);
    expect((await getDesign(ed.api, id)).openReview.reviewers).toEqual([expect.objectContaining({ id: vi.id, valid: false })]);
    expect((await getDesign(ed.api, id)).canReview).toBe(false);
    expect((await getDesign(ed2.api, id)).canReview).toBe(true);
    expect((await review(ed.api, id, { action: "approve", version: 1 })).statusCode).toBe(403);
    expect((await review(ed2.api, id, { action: "reject", note: "再改改" })).statusCode).toBe(200);

    // 没指定评审人：任一编辑者都能审，包括提交者自己
    await review(ed.api, id, { action: "submit" });
    expect((await getDesign(ed.api, id)).canReview).toBe(true);
    expect((await review(ed.api, id, { action: "approve", version: 1 })).statusCode).toBe(200);

    // 管理员不在名单里也能审，记录上标 by_admin
    await review(ed.api, id, { action: "submit", reviewers: [ed2.id] });
    expect((await review(admin, id, { action: "approve", version: 1 })).statusCode).toBe(200);
    const last = (await ed.api.get(`/api/v1/designs/${id}/reviews`)).json().reviews.at(-1);
    expect(last).toMatchObject({ state: "approved", byAdmin: true });
  });

  it("项目归档时评审动作 403；上传令牌不能改状态、不能评审，改名仍可以", async () => {
    const ed = await member("eddie", "editor");
    const vi = await member("vivi", "viewer");
    const id = await newDesign(ed.api);
    await put(ed.api, id, "v1");
    await review(ed.api, id, { action: "submit", reviewers: [vi.id] });

    const token = (await ed.api.post("/api/v1/tokens", { name: "上传", purpose: "uploader", expiresInDays: 30 })).json().token;
    const asToken = client(server.app, { bearer: token });
    expect((await asToken.patch(`/api/v1/designs/${id}`, { status: "published" })).json().error.code).toBe("session_required");
    expect((await asToken.patch(`/api/v1/designs/${id}`, { status: "draft" })).json().error.code).toBe("session_required");
    expect((await asToken.post(`/api/v1/designs/${id}/review`, { action: "withdraw" })).json().error.code).toBe("session_required");
    expect((await asToken.patch(`/api/v1/designs/${id}`, { name: "改个名" })).statusCode).toBe(200);
    expect((await getDesign(ed.api, id)).status).toBe("review");

    await admin.patch(`/api/v1/admin/projects/${projectId}`, { archived: true });
    expect((await getDesign(vi.api, id)).canReview).toBe(false);
    for (const [api, body] of [
      [vi.api, { action: "approve", version: 1 }],
      [ed.api, { action: "withdraw" }],
      [admin, { action: "approve", version: 1 }],
    ] as const) {
      const res = await review(api, id, body);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("project_archived");
    }
  });
});

describe("上传、回滚与评审联动", () => {
  it("评审中上传跟随新版本并通知评审人（未读时不重复）；重复上传不联动；已发布后上传保持已发布", async () => {
    const ed = await member("eddie", "editor", { displayName: "艾迪" });
    const vi = await member("vivi", "viewer");
    const id = await newDesign(ed.api);
    await put(ed.api, id, "v1");
    await review(ed.api, id, { action: "submit", reviewers: [vi.id], note: "看看首页" });
    expect(await kinds(vi.api, "review_request")).toEqual([
      expect.objectContaining({ text: "艾迪 请你评审「首页」v1：看看首页", link: `/designs/${id}` }),
    ]);

    const up = await put(ed.api, id, "v2");
    expect(up.design).toMatchObject({ status: "review", openReview: { version: 2 } });
    expect(await kinds(vi.api, "review_updated")).toHaveLength(1);
    const unreadUpdated = () =>
      (server.ctx.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'review_updated' AND read_at IS NULL").get(vi.id) as { n: number }).n;
    const readAll = () => vi.api.post("/api/v1/notifications/read", {});

    // 重复上传：先读掉通知，免得去重把多余的通知吞掉；之后不产生新版本、不通知、评审版本不动
    await readAll();
    let total = (await notes(vi.api)).length;
    const dup = await put(ed.api, id, "v2");
    expect(dup.duplicate).toBe(true);
    expect(unreadUpdated()).toBe(0);
    expect((await notes(vi.api)).length).toBe(total);
    expect((await getDesign(ed.api, id)).openReview.version).toBe(2);

    // 增量提交入口：新内容跟随并通知；同样的清单再提交一次（内容指纹相同提前返回）不联动
    const doc = JSON.parse(strFromU8(unzipSync(makeSqraft({ title: "v3" }))["doc.json"]));
    const parts = splitDoc(doc);
    for (const part of parts) expect((await ed.api.put(`/api/v1/designs/${id}/blobs/${part.hash}?kind=part`, gzipSync(part.json))).statusCode).toBe(200);
    const manifest = { formatVersion: 7, tokens: doc.tokens, parts: parts.map((x) => ({ rootId: x.rootId, hash: x.hash })), assets: [] };
    const c1 = await ed.api.post(`/api/v1/designs/${id}/commits`, { manifest });
    expect(c1.json(), c1.body).toMatchObject({ duplicate: false, design: { openReview: { version: 3 } } });
    expect(unreadUpdated()).toBe(1);
    await readAll();
    total = (await notes(vi.api)).length;
    expect((await ed.api.post(`/api/v1/designs/${id}/commits`, { manifest })).json()).toMatchObject({ duplicate: true });
    expect(unreadUpdated()).toBe(0);
    expect((await notes(vi.api)).length).toBe(total);
    expect((await getDesign(ed.api, id)).openReview.version).toBe(3);

    // 还没读又上传：不重复插入
    await put(ed.api, id, "v4");
    await put(ed.api, id, "v5");
    expect(unreadUpdated()).toBe(1);
    expect((await getDesign(ed.api, id)).openReview.version).toBe(5);
    // 读了之后再更新（回滚）：再来一条
    await readAll();
    await ed.api.post(`/api/v1/designs/${id}/rollback`, { version: 2 });
    expect((await getDesign(ed.api, id)).openReview.version).toBe(2);
    expect(unreadUpdated()).toBe(1);
    // 自己不通知自己：提交者没有 review_updated
    expect(await kinds(ed.api, "review_updated")).toHaveLength(0);

    // 时间线里提交事件记的是提交时的版本与评审人；审计被清理后也不变
    server.ctx.db.prepare("DELETE FROM audit").run();
    const submit = (await ed.api.get(`/api/v1/designs/${id}/reviews`)).json().events.find((e: { type: string }) => e.type === "submit");
    expect(submit).toMatchObject({ version: 1, reviewers: [{ id: vi.id, displayName: "vivi" }] });

    await review(vi.api, id, { action: "approve", version: 2 });
    const after = await put(ed.api, id, "v6");
    expect(after.design).toMatchObject({ status: "published", approvedVersion: 2, currentVersion: 6 });
  });

  it("时间线不依赖审计：清理审计后改回草稿、修改评审人、提交时的版本与评审人都还在", async () => {
    const ed = await member("eddie", "editor", { displayName: "艾迪" });
    const vi = await member("vivi", "viewer", { displayName: "小薇" });
    const vi2 = await member("victor", "viewer", { displayName: "维克多" });
    const id = await newDesign(ed.api);
    await put(ed.api, id, "v1");
    await review(ed.api, id, { action: "publish" });
    await review(ed.api, id, { action: "unpublish" });
    await review(ed.api, id, { action: "submit", reviewers: [vi.id] });
    await review(ed.api, id, { action: "reviewers", reviewers: [vi2.id] });
    await put(ed.api, id, "v2");
    await review(vi2.api, id, { action: "reject", note: "再改改" });
    server.ctx.db.prepare("DELETE FROM audit").run();

    const events = (await ed.api.get(`/api/v1/designs/${id}/reviews`)).json().events;
    expect(events.map((e: { type: string; version: number | null }) => [e.type, e.version])).toEqual([
      ["publish_direct", 1],
      ["unpublish", 1],
      ["submit", 1],
      ["reviewers", null],
      ["reject", 2],
    ]);
    expect(events[2].reviewers).toEqual([{ id: vi.id, displayName: "小薇" }]);
    expect(events[3]).toMatchObject({ actor: { displayName: "艾迪" }, reviewers: [{ id: vi2.id, displayName: "维克多" }] });
    expect(events[4]).toMatchObject({ actor: { displayName: "维克多" }, note: "再改改", byAdmin: false });
  });

  it("修改评审人：名单里已失效的人可以直接去掉，新加入的失效成员仍然 400；候选名单只含能看到项目的人", async () => {
    const ed = await member("eddie", "editor");
    const vi = await member("vivi", "viewer");
    const vi2 = await member("victor", "viewer");
    const outsider = await member("olga", "viewer", { projectScope: "assigned" });
    const id = await newDesign(ed.api);
    await put(ed.api, id, "v1");

    const cands = (await ed.api.get(`/api/v1/designs/${id}/reviewer-candidates`)).json().members.map((m: { id: string }) => m.id);
    expect(cands).toEqual(expect.arrayContaining([ed.id, vi.id, vi2.id]));
    expect(cands).not.toContain(outsider.id);
    // 查看者也能查
    expect((await vi.api.get(`/api/v1/designs/${id}/reviewer-candidates`)).statusCode).toBe(200);
    expect((await review(ed.api, id, { action: "submit", reviewers: [outsider.id] })).json().error.code).toBe("invalid_reviewer");

    await review(ed.api, id, { action: "submit", reviewers: [vi.id] });
    expect((await admin.delete(`/api/v1/team/members/${vi.id}`)).statusCode).toBe(200);
    expect((await ed.api.get(`/api/v1/designs/${id}/reviewer-candidates`)).json().members.map((m: { id: string }) => m.id)).not.toContain(vi.id);
    // 网页旧版本可能把失效的人原样带回来：服务端丢掉他，只校验新加入的人
    const res = await review(ed.api, id, { action: "reviewers", reviewers: [vi.id, vi2.id] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().design.openReview.reviewers.map((r: { id: string }) => r.id)).toEqual([vi2.id]);
    expect((await review(ed.api, id, { action: "reviewers", reviewers: [vi2.id, outsider.id] })).json().error.code).toBe("invalid_reviewer");
  });

  it("通知：提交与追加评审人发 review_request；通过 / 退回发 review_result 给提交者与创建者；撤回等不通知", async () => {
    const creator = await member("cathy", "editor");
    const ed = await member("eddie", "editor", { displayName: "艾迪" });
    const vi = await member("vivi", "viewer", { displayName: "小薇" });
    const vi2 = await member("victor", "viewer");
    const id = await newDesign(creator.api);
    await put(creator.api, id, "v1");

    // 没指定评审人不发 review_request
    await review(ed.api, id, { action: "submit" });
    expect(await kinds(vi.api, "review_request")).toHaveLength(0);
    // 追加评审人：只通知新加入的人
    await review(ed.api, id, { action: "reviewers", reviewers: [vi.id] });
    await review(ed.api, id, { action: "reviewers", reviewers: [vi.id, vi2.id] });
    expect(await kinds(vi.api, "review_request")).toHaveLength(1);
    expect(await kinds(vi2.api, "review_request")).toHaveLength(1);

    await review(vi.api, id, { action: "reject", note: "按钮颜色不对" });
    for (const api of [ed.api, creator.api]) {
      expect(await kinds(api, "review_result")).toEqual([expect.objectContaining({ text: "小薇 退回了「首页」v1：按钮颜色不对" })]);
    }
    expect(await kinds(vi.api, "review_result")).toHaveLength(0);

    await review(ed.api, id, { action: "submit", reviewers: [vi.id] });
    await review(vi.api, id, { action: "approve", version: 1 });
    expect((await kinds(creator.api, "review_result"))[0].text).toBe("小薇 通过了「首页」v1 的评审");

    // 撤回、直接发布、改回草稿：不发通知
    const before = (await notes(vi.api)).length + (await notes(creator.api)).length;
    await review(ed.api, id, { action: "unpublish" });
    await review(ed.api, id, { action: "publish" });
    await review(ed.api, id, { action: "submit", reviewers: [vi2.id] });
    await review(ed.api, id, { action: "withdraw" });
    expect((await notes(vi.api)).length + (await notes(creator.api)).length).toBe(before);

    // 软删的设计稿：评审保留，不再通知
    await review(ed.api, id, { action: "submit", reviewers: [vi.id] });
    const count = (await kinds(vi.api, "review_updated")).length;
    expect((await creator.api.delete(`/api/v1/designs/${id}`)).statusCode).toBe(200);
    const { followNewVersion } = await import("../src/reviews");
    server.ctx.db.prepare("UPDATE designs SET current_version = 1 WHERE id = ?").run(id);
    server.ctx.db.prepare("UPDATE reviews SET version = 0 WHERE design_id = ? AND state = 'open'").run(id);
    followNewVersion(server.ctx.db, id, ed.id);
    expect((await kinds(vi.api, "review_updated")).length).toBe(count);
    expect(server.ctx.db.prepare("SELECT COUNT(*) AS n FROM reviews WHERE design_id = ? AND state = 'open'").get(id)).toEqual({ n: 1 });
  });
});

describe("评论已解决", () => {
  it("作者、项目编辑者、管理员可以标记 / 取消；未解决数随之变化", async () => {
    const ed = await member("eddie", "editor");
    const vi = await member("vivi", "viewer");
    const vi2 = await member("victor", "viewer");
    const id = await newDesign(ed.api);
    await put(ed.api, id, "v1");
    const c1 = (await vi.api.post(`/api/v1/designs/${id}/comments`, { body: "第一条" })).json().comment;
    const c2 = (await vi.api.post(`/api/v1/designs/${id}/comments`, { body: "第二条" })).json().comment;
    expect(c1).toMatchObject({ resolved: false, resolvedAt: null, resolvedBy: null, legacy: false, canResolve: true, version: 1 });
    expect((await getDesign(ed.api, id)).unresolvedCount).toBe(2);

    const others = (await vi2.api.get(`/api/v1/designs/${id}/comments`)).json().comments;
    expect(others.map((c: { canResolve: boolean }) => c.canResolve)).toEqual([false, false]);
    expect((await vi2.api.post(`/api/v1/comments/${c1.id}/resolve`, { resolved: true })).statusCode).toBe(403);
    expect((await vi.api.post(`/api/v1/comments/${c1.id}/resolve`, {})).statusCode).toBe(400);

    const r1 = await vi.api.post(`/api/v1/comments/${c1.id}/resolve`, { resolved: true });
    expect(r1.json().comment).toMatchObject({ resolved: true, resolvedBy: { id: vi.id }, legacy: false });
    expect((await ed.api.post(`/api/v1/comments/${c2.id}/resolve`, { resolved: true })).statusCode).toBe(200);
    expect((await getDesign(ed.api, id)).unresolvedCount).toBe(0);
    expect((await getDesign(ed.api, id)).commentCount).toBe(2);
    expect((await admin.post(`/api/v1/comments/${c2.id}/resolve`, { resolved: false })).json().comment).toMatchObject({ resolved: false, resolvedBy: null });
    expect((await getDesign(ed.api, id)).unresolvedCount).toBe(1);
  });
});

describe("升级到评审", () => {
  it("已发布的记通过版本、旧评论标为上线前已解决；评审中的补一轮进行中的评审", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sqraft-mig-"));
    const file = join(dir, "db.sqlite");
    const old = new Database(file);
    const before = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE reviews"));
    for (let i = 0; i < before; i++) old.exec(MIGRATIONS[i]);
    old.pragma(`user_version = ${before}`);
    const now = Date.now();
    old.prepare("INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES ('u', 'bob', 'x', 0, ?)").run(now);
    old.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p', '官网', ?)").run(now);
    const ins = old.prepare("INSERT INTO designs (id, project_id, name, current_version, created_by, created_at, updated_at, status) VALUES (?, 'p', ?, ?, 'u', ?, ?, ?)");
    ins.run("pub", "已发布", 3, now, now, "published");
    ins.run("empty", "已发布但没版本", null, now, now, "published");
    ins.run("rev", "评审中", 2, now, now, "review");
    ins.run("dra", "草稿", 1, now, now, "draft");
    const c = old.prepare("INSERT INTO comments (id, design_id, user_id, body, version, created_at) VALUES (?, ?, 'u', 'x', 1, ?)");
    c.run("c1", "pub", now);
    c.run("c2", "rev", now);
    c.run("c3", "dra", now);
    old.close();

    const db = openDb(file);
    expect(db.prepare("SELECT id, approved_version, approved_by FROM designs ORDER BY id").all()).toEqual([
      { id: "dra", approved_version: null, approved_by: null },
      { id: "empty", approved_version: null, approved_by: null },
      { id: "pub", approved_version: 3, approved_by: null },
      { id: "rev", approved_version: null, approved_by: null },
    ]);
    expect(db.prepare("SELECT design_id, version, requested_by, reviewers, state FROM reviews").all()).toEqual([
      { design_id: "rev", version: 2, requested_by: "u", reviewers: "[]", state: "open" },
    ]);
    const comments = db.prepare("SELECT id, resolved_at IS NOT NULL AS resolved, resolved_legacy FROM comments ORDER BY id").all();
    expect(comments).toEqual([
      { id: "c1", resolved: 1, resolved_legacy: 1 },
      { id: "c2", resolved: 0, resolved_legacy: 0 },
      { id: "c3", resolved: 0, resolved_legacy: 0 },
    ]);
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("评审时间线表：从已有的评审记录与审计补齐事件（提交时的版本取审计里的）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sqraft-mig-"));
    const file = join(dir, "db.sqlite");
    const old = new Database(file);
    const before = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE review_events"));
    for (let i = 0; i < before; i++) old.exec(MIGRATIONS[i]);
    old.pragma(`user_version = ${before}`);
    old.prepare("INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES ('u', 'bob', 'x', 0, 1)").run();
    old.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p', '官网', 1)").run();
    old.prepare("INSERT INTO designs (id, project_id, name, current_version, created_by, created_at, updated_at, status) VALUES ('d', 'p', '首页', 3, 'u', 1, 1, 'draft')").run();
    const rev = old.prepare(
      `INSERT INTO reviews (id, design_id, version, requested_by, reviewers, note, state, skipped, prev_status, decided_by, decided_note, by_admin, created_at, closed_at)
       VALUES (?, 'd', ?, 'u', ?, ?, ?, ?, 'draft', ?, ?, 0, ?, ?)`,
    );
    rev.run("r1", 1, "[]", "", "approved", 1, "u", null, 100, 100);
    rev.run("r2", 3, '["u"]', "看看", "rejected", 0, "u", "不行", 300, 500);
    const au = old.prepare("INSERT INTO audit (at, user_id, action, target, result, detail) VALUES (?, 'u', ?, 'd', 'ok', ?)");
    au.run(100, "review.publish_direct", JSON.stringify({ review: "r1", version: 1 }));
    au.run(200, "review.unpublish", JSON.stringify({ version: 1 }));
    au.run(300, "review.submit", JSON.stringify({ review: "r2", version: 2, reviewers: [] }));
    au.run(400, "review.reviewers", JSON.stringify({ review: "r2", reviewers: ["u"] }));
    au.run(500, "review.reject", JSON.stringify({ review: "r2", version: 3 }));
    old.close();

    const db = openDb(file);
    expect(db.prepare("SELECT type, version, reviewers, note, created_at FROM review_events ORDER BY created_at, id").all()).toEqual([
      { type: "publish_direct", version: 1, reviewers: null, note: null, created_at: 100 },
      { type: "unpublish", version: 1, reviewers: null, note: null, created_at: 200 },
      { type: "submit", version: 2, reviewers: "[]", note: "看看", created_at: 300 },
      { type: "reviewers", version: null, reviewers: '["u"]', note: null, created_at: 400 },
      { type: "reject", version: 3, reviewers: null, note: "不行", created_at: 500 },
    ]);
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
});
