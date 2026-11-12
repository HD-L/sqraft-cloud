import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN, client, login, startServer, type TestServer } from "./helpers";

let server: TestServer;
let admin: ReturnType<typeof client>;

/** 管理员建成员并完成首次改密码，返回该成员的客户端 */
async function member(username: string, role: "admin" | "editor" | "viewer", extra: Record<string, unknown> = {}) {
  const res = await admin.post("/api/v1/team/members", { username, role, ...extra });
  expect(res.statusCode, res.body).toBe(200);
  const { member: m, initialPassword } = res.json();
  const first = await login(server.app, username, initialPassword);
  expect((await client(server.app, first).post("/api/v1/me/password", { currentPassword: initialPassword, newPassword: `${username}-new-pass-1` })).statusCode).toBe(200);
  return { id: m.id as string, api: client(server.app, first) };
}

beforeEach(async () => {
  server = await startServer();
  admin = client(server.app, await login(server.app, ADMIN.username, ADMIN.password));
});
afterEach(async () => server.close());

describe("团队与成员", () => {
  it("团队角色默认对所有项目生效；项目里可覆盖；编辑者可建项目、查看者不行", async () => {
    const p1 = (await admin.post("/api/v1/projects", { name: "官网", description: "官网改版" })).json().project;
    const p2 = (await admin.post("/api/v1/projects", { name: "App" })).json().project;
    const viewer = await member("vivi", "viewer", { displayName: "小薇", email: "vivi@example.com" });
    const editor = await member("eddie", "editor");

    expect((await viewer.api.get("/api/v1/projects")).json().projects.map((p: { name: string }) => p.name)).toEqual(["App", "官网"]);
    expect((await viewer.api.post("/api/v1/projects", { name: "x" })).statusCode).toBe(403);
    expect((await viewer.api.post(`/api/v1/projects/${p1.id}/designs`, { name: "x" })).statusCode).toBe(403);

    const mine = await editor.api.post("/api/v1/projects", { name: "设计规范库", description: "组件与色彩" });
    expect(mine.json().project).toMatchObject({ name: "设计规范库", createdBy: "eddie", createdByMe: true, role: "editor", designCount: 0 });
    expect((await editor.api.post(`/api/v1/projects/${p1.id}/designs`, { name: "首页" })).statusCode).toBe(200);

    // 项目覆盖：查看者在 App 里升为编辑者，在官网里看不到
    await admin.put(`/api/v1/admin/projects/${p2.id}/members/${viewer.id}`, { role: "editor" });
    await admin.put(`/api/v1/admin/projects/${p1.id}/members/${viewer.id}`, { role: "none" });
    expect((await viewer.api.get(`/api/v1/projects/${p1.id}`)).statusCode).toBe(404);
    expect((await viewer.api.post(`/api/v1/projects/${p2.id}/designs`, { name: "个人中心" })).statusCode).toBe(200);
    const access = (await admin.get(`/api/v1/projects/${p1.id}/access`)).json().members;
    expect(access.find((m: { username: string }) => m.username === "vivi")).toMatchObject({ role: "viewer", override: "none", effective: "none", displayName: "小薇" });
    expect(access.find((m: { username: string }) => m.username === "admin")).toMatchObject({ role: "admin", effective: "editor" });

    // 被加入项目有通知
    const notes = (await viewer.api.get("/api/v1/notifications")).json();
    expect(notes.notifications.map((n: { kind: string }) => n.kind)).toEqual(["project_access", "invited"]);
  });

  it("改角色、移除与恢复成员；至少保留一个管理员", async () => {
    const m = await member("mia", "viewer");
    const me = (await admin.get("/api/v1/me")).json().user;
    expect((await admin.patch(`/api/v1/team/members/${me.id}`, { role: "editor" })).statusCode).toBe(400);
    expect((await admin.patch(`/api/v1/team/members/${m.id}`, { role: "admin", displayName: "米娅" })).json().member).toMatchObject({ role: "admin", isAdmin: true, displayName: "米娅" });
    expect((await m.api.get("/api/v1/admin/users")).statusCode).toBe(200);

    expect((await admin.delete(`/api/v1/team/members/${m.id}`)).statusCode).toBe(200);
    expect((await m.api.get("/api/v1/me")).statusCode).toBe(401);
    expect((await admin.get("/api/v1/team/members")).json().members.map((u: { username: string }) => u.username)).toEqual(["admin"]);
    expect((await admin.get("/api/v1/team/members?all=1")).json().members).toHaveLength(2);
    expect((await admin.post(`/api/v1/team/members/${m.id}/restore`)).json().member.disabled).toBe(false);
    expect((await admin.delete(`/api/v1/team/members/${me.id}`)).statusCode).toBe(400);
  });

  it("团队信息、个人资料、上传客户端入口", async () => {
    expect((await admin.patch("/api/v1/team", { name: "鹏图科技", description: "设计团队" })).statusCode).toBe(200);
    const v = await member("val", "viewer");
    expect((await v.api.get("/api/v1/team")).json()).toMatchObject({ team: { name: "鹏图科技" }, stats: { members: 2, admins: 1 } });
    expect((await v.api.patch("/api/v1/team", { name: "x" })).statusCode).toBe(403);
    expect((await v.api.patch("/api/v1/me", { displayName: "小瓦", email: "bad" })).statusCode).toBe(400);
    expect((await v.api.patch("/api/v1/me", { displayName: "小瓦" })).json().user.displayName).toBe("小瓦");
    expect((await v.api.get("/api/v1/client")).json().downloadUrl).toContain("releases");
  });
});

describe("设计稿状态、评论、通知、最近浏览、搜索", () => {
  it("一条完整的协作流程", async () => {
    const project = (await admin.post("/api/v1/projects", { name: "官网改版" })).json().project;
    const designer = await member("dana", "editor", { displayName: "丹娜" });
    const dev = await member("devin", "viewer");
    const outsider = await member("otto", "viewer");
    await admin.put(`/api/v1/admin/projects/${project.id}/members/${outsider.id}`, { role: "none" });

    // 新建的设计稿默认是草稿；编辑者改状态，查看者不能改
    const design = (await designer.api.post(`/api/v1/projects/${project.id}/designs`, { name: "首页改版 V3" })).json().design;
    expect(design).toMatchObject({ status: "draft", createdBy: "丹娜", commentCount: 0 });
    expect((await dev.api.patch(`/api/v1/designs/${design.id}`, { status: "review" })).statusCode).toBe(403);
    expect((await designer.api.patch(`/api/v1/designs/${design.id}`, { status: "bogus" })).statusCode).toBe(400);
    expect((await designer.api.patch(`/api/v1/designs/${design.id}`, { status: "review" })).json().design.status).toBe("review");

    // 查看者也能评论；@ 到的人与创建者收到通知，看不到项目的人不通知
    const c1 = await dev.api.post(`/api/v1/designs/${design.id}/comments`, { body: "Hero 文案再精炼一点 @dana @otto", pageId: "page-1" });
    expect(c1.statusCode, c1.body).toBe(200);
    expect(c1.json().comment).toMatchObject({ author: { username: "devin" }, pageId: "page-1", canDelete: true });
    const danaNotes = (await designer.api.get("/api/v1/notifications")).json();
    expect(danaNotes.unread).toBe(2); // 加入团队 + 被 @
    expect(danaNotes.notifications[0]).toMatchObject({ kind: "mention", link: `/designs/${design.id}`, actor: { username: "devin" } });
    expect((await outsider.api.get("/api/v1/notifications")).json().notifications.map((n: { kind: string }) => n.kind)).toEqual(["invited"]);

    // 回复：之前评论过的人收到「新评论」
    await designer.api.post(`/api/v1/designs/${design.id}/comments`, { body: "已更新，再看下" });
    const devNotes = (await dev.api.get("/api/v1/notifications")).json();
    expect(devNotes.notifications[0]).toMatchObject({ kind: "comment", text: expect.stringContaining("丹娜 评论了「首页改版 V3」") });
    await dev.api.post("/api/v1/notifications/read", {});
    expect((await dev.api.get("/api/v1/notifications")).json().unread).toBe(0);

    // 只有作者或管理员能删评论
    const list = (await dev.api.get(`/api/v1/designs/${design.id}/comments`)).json().comments;
    expect(list.map((c: { canDelete: boolean }) => c.canDelete)).toEqual([true, false]);
    expect((await dev.api.delete(`/api/v1/comments/${list[1].id}`)).statusCode).toBe(404);
    expect((await admin.delete(`/api/v1/comments/${list[1].id}`)).statusCode).toBe(200);
    expect((await dev.api.get(`/api/v1/designs/${design.id}`)).json().design.commentCount).toBe(1);
    expect((await outsider.api.get(`/api/v1/designs/${design.id}/comments`)).statusCode).toBe(404);

    // 最近浏览：网页打开过的设计稿
    expect((await dev.api.get("/api/v1/me/recent")).json().designs.map((d: { name: string; projectName: string }) => [d.name, d.projectName])).toEqual([
      ["首页改版 V3", "官网改版"],
    ]);

    // 全局搜索：只返回有权限看到的
    const found = (await dev.api.get(`/api/v1/search?q=${encodeURIComponent("改版")}`)).json();
    expect(found.projects.map((p: { name: string }) => p.name)).toEqual(["官网改版"]);
    expect(found.designs.map((d: { name: string }) => d.name)).toEqual(["首页改版 V3"]);
    expect((await outsider.api.get(`/api/v1/search?q=${encodeURIComponent("改版")}`)).json()).toMatchObject({ projects: [], designs: [] });
    expect((await dev.api.get("/api/v1/search?q=dan")).json().members).toEqual([expect.objectContaining({ username: "dana", displayName: "丹娜" })]);
  });
});
