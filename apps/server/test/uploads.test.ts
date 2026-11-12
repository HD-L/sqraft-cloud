import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readdir } from "node:fs/promises";
import { strToU8, zipSync } from "fflate";
import { ADMIN, client, fakePng, login, makeSqraft, startServer, upload, type TestServer } from "./helpers";

let server: TestServer;
let api: ReturnType<typeof client>;
let designId: string;

async function blobCount(): Promise<number> {
  let n = 0;
  for (const dir of await readdir(server.ctx.store.blobsDir)) n += (await readdir(`${server.ctx.store.blobsDir}/${dir}`)).length;
  return n;
}

beforeEach(async () => {
  server = await startServer();
  api = client(server.app, await login(server.app, ADMIN.username, ADMIN.password));
  const projectId = (await api.post("/api/v1/admin/projects", { name: "官网" })).json().project.id;
  designId = (await api.post(`/api/v1/projects/${projectId}/designs`, { name: "首页" })).json().design.id;
});
afterEach(async () => server.close());

describe("分块上传与版本", () => {
  it("分块上传生成 v1；内容相同不出新版本；改动后生成 v2，切图去重", async () => {
    const png = fakePng(1, 4096);
    const v1 = makeSqraft({ title: "v1", assets: { "assets/aaaa1111.png": png } });
    const first = await upload(api, designId, v1, "首版");
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ duplicate: false, version: { number: 1, note: "首版", pageCount: 1, nodeCount: 2, assetCount: 1, current: true } });

    const again = await upload(api, designId, v1);
    expect(again.json()).toMatchObject({ duplicate: true, version: { number: 1 } });

    const blobsBefore = await blobCount();
    const v2 = makeSqraft({ title: "v2", assets: { "assets/aaaa1111.png": png } });
    const second = await upload(api, designId, v2, "改了标题");
    expect(second.json()).toMatchObject({ duplicate: false, version: { number: 2 } });
    // 同一张切图只存一份：v2 只多了新的 doc.json（manifest、ops 与切图都复用）
    expect(await blobCount()).toBe(blobsBefore + 1);

    const versions = (await api.get(`/api/v1/designs/${designId}/versions`)).json().versions;
    expect(versions.map((v: { number: number; current: boolean }) => [v.number, v.current])).toEqual([
      [2, true],
      [1, false],
    ]);
    expect(versions[1].uploader).toBe("admin");
  });

  it("回滚把当前版本指回旧版", async () => {
    await upload(api, designId, makeSqraft({ title: "a" }));
    await upload(api, designId, makeSqraft({ title: "b" }));
    const res = await api.post(`/api/v1/designs/${designId}/rollback`, { version: 1 });
    expect(res.json().design).toMatchObject({ currentVersion: 1, latestVersion: 2 });
    expect((await api.post(`/api/v1/designs/${designId}/rollback`, { version: 9 })).statusCode).toBe(400);
  });

  it("偏移不一致返回 409 与服务端偏移，可按其续传", async () => {
    const bytes = makeSqraft();
    const id = (await api.post(`/api/v1/designs/${designId}/uploads`, { size: bytes.length })).json().uploadId;
    await api.put(`/api/v1/uploads/${id}`, bytes.subarray(0, 100), { "upload-offset": "0" });
    const wrong = await api.put(`/api/v1/uploads/${id}`, bytes.subarray(0, 100), { "upload-offset": "0" });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().received).toBe(100);
    expect((await api.get(`/api/v1/uploads/${id}`)).json().received).toBe(100);
    expect((await api.post(`/api/v1/uploads/${id}/complete`)).json().error.code).toBe("incomplete");
    await api.put(`/api/v1/uploads/${id}`, bytes.subarray(100), { "upload-offset": "100" });
    expect((await api.post(`/api/v1/uploads/${id}/complete`)).statusCode).toBe(200);
  });

  it("超过声明大小的分块被拒绝", async () => {
    const id = (await api.post(`/api/v1/designs/${designId}/uploads`, { size: 10 })).json().uploadId;
    const res = await api.put(`/api/v1/uploads/${id}`, new Uint8Array(20), { "upload-offset": "0" });
    expect(res.statusCode).toBe(413);
    expect((await api.get(`/api/v1/uploads/${id}`)).json().received).toBe(0);
  });

  it("超过上传上限的文件在开始时就被拒绝", async () => {
    const res = await api.post(`/api/v1/designs/${designId}/uploads`, { size: 3 * 1024 * 1024 * 1024 });
    expect(res.statusCode).toBe(413);
  });
});

describe(".sqraft 校验", () => {
  it("不是 zip、缺 doc.json、含未知文件都拒绝", async () => {
    const notZip = await upload(api, designId, strToU8("hello world, not a zip"));
    expect(notZip.json().error.code).toBe("invalid_sqraft");

    const noDoc = await upload(api, designId, zipSync({ "manifest.json": strToU8("{}") }));
    expect(noDoc.json().error.message).toContain("缺少 doc.json");

    const evil = await upload(api, designId, makeSqraft({ extra: { "scripts/run.sh": strToU8("rm -rf /") } }));
    expect(evil.json().error.message).toContain("不允许的文件");
  });

  it("路径穿越的条目被拒绝", async () => {
    const zip = zipSync({ "doc.json": strToU8("{}"), "assets/../../etc/passwd": strToU8("x") });
    const res = await upload(api, designId, zip);
    expect(res.json().error.code).toBe("invalid_sqraft");
  });

  it("格式版本高于服务端支持的提示升级", async () => {
    const res = await upload(api, designId, makeSqraft({ formatVersion: 99 }));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("format_too_new");
    // 失败的上传不产生版本，并记进审计
    expect((await api.get(`/api/v1/designs/${designId}/versions`)).json().versions).toEqual([]);
    const auditRes = await api.get("/api/v1/admin/audit?action=design.upload");
    expect(auditRes.json().entries[0]).toMatchObject({ action: "design.upload", result: "failed" });
  });
});

describe("审计日志", () => {
  it("记录登录、建项目、上传等，并能导出 CSV", async () => {
    await upload(api, designId, makeSqraft());
    const entries = (await api.get("/api/v1/admin/audit")).json().entries as Array<{ action: string; username: string }>;
    const actions = entries.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["auth.login", "project.create", "design.create", "design.upload"]));
    expect(entries.every((e) => e.username === "admin")).toBe(true);

    const csv = await api.get("/api/v1/admin/audit?format=csv");
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.split("\n")[0]).toContain("时间,用户,令牌,IP,动作");
    expect(csv.body).toContain("design.upload");
  });
});
