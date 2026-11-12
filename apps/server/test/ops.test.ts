import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app";
import { createBackup, restoreBackup } from "../src/backup";
import { SCHEMA_VERSION } from "../src/db";
import { collectGarbage, purgeTrash, referencedBlobs } from "../src/maintenance";
import { ADMIN, client, fakePng, login, makeSqraft, startServer, upload, type TestServer } from "./helpers";

let server: TestServer;
let api: ReturnType<typeof client>;
let projectId: string;

async function newDesign(name: string, title = name) {
  const id = (await api.post(`/api/v1/projects/${projectId}/designs`, { name })).json().design.id as string;
  await upload(api, id, makeSqraft({ title, assets: { "assets/aaaa1111.png": fakePng(name.length, 3000) } }));
  return id;
}

async function allBlobs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const p of await readdir(dir)) for (const f of await readdir(join(dir, p))) out.push(f);
  return out;
}

beforeEach(async () => {
  server = await startServer({ metricsToken: "metrics-secret" });
  api = client(server.app, await login(server.app, ADMIN.username, ADMIN.password));
  projectId = (await api.post("/api/v1/admin/projects", { name: "官网" })).json().project.id;
});
afterEach(async () => server.close());

describe("回收站与存储回收", () => {
  it("删除进回收站，管理员可恢复或立即彻底删除", async () => {
    const id = await newDesign("首页");
    await api.delete(`/api/v1/designs/${id}`);
    const trash = (await api.get("/api/v1/admin/trash")).json().designs;
    expect(trash[0]).toMatchObject({ id, name: "首页", projectName: "官网", versionCount: 1 });
    expect(trash[0].purgeAt - trash[0].deletedAt).toBe(30 * 86400000);

    expect((await api.post(`/api/v1/admin/trash/${id}/restore`)).statusCode).toBe(200);
    expect((await api.get(`/api/v1/designs/${id}`)).statusCode).toBe(200);

    await api.delete(`/api/v1/designs/${id}`);
    expect((await api.delete(`/api/v1/admin/trash/${id}`)).statusCode).toBe(200);
    expect(server.ctx.db.prepare("SELECT COUNT(*) AS n FROM versions").get()).toEqual({ n: 0 });
  });

  it("超过保留天数的回收站条目自动彻底删除", async () => {
    const id = await newDesign("旧稿");
    await api.delete(`/api/v1/designs/${id}`);
    expect(purgeTrash(server.ctx)).toBe(0);
    expect(purgeTrash(server.ctx, 30, Date.now() + 31 * 86400000)).toBe(1);
  });

  it("孤儿文件超过宽限期才回收；被引用的一个不动（含按页索引）", async () => {
    const keep = await newDesign("保留");
    const gone = await newDesign("删掉", "完全不同的标题");
    const before = await allBlobs(server.ctx.store.blobsDir);
    const refs = await referencedBlobs(server.ctx);
    expect(before.every((b) => refs.has(b))).toBe(true);

    await api.delete(`/api/v1/designs/${gone}`);
    await api.delete(`/api/v1/admin/trash/${gone}`);
    // 刚写入的文件在宽限期内：不回收
    expect((await collectGarbage(server.ctx)).deletedBlobs).toBe(0);
    const r = await collectGarbage(server.ctx, 0);
    expect(r.deletedBlobs).toBeGreaterThan(0);
    expect(r.freedBytes).toBeGreaterThan(0);

    // 留下的设计稿依然完整可读（页面、切图）
    expect((await api.get(`/api/v1/designs/${keep}/versions/1/pages/page-1`)).statusCode).toBe(200);
    expect((await api.get(`/api/v1/designs/${keep}/versions/1/assets/aaaa1111`)).statusCode).toBe(200);
    const left = await allBlobs(server.ctx.store.blobsDir);
    const refsAfter = await referencedBlobs(server.ctx);
    expect(left.sort()).toEqual([...refsAfter].sort());
  });

  it("超过一天的临时文件被清理", async () => {
    const file = join(server.ctx.store.tmpDir, "stale");
    await writeFile(file, "x");
    const old = new Date(Date.now() - 2 * 86400000);
    await utimes(file, old, old);
    expect((await collectGarbage(server.ctx)).tmpFiles).toBe(1);
  });

  it("管理后台手动触发维护并记审计", async () => {
    const res = await api.post("/api/v1/admin/maintenance");
    expect(res.json()).toMatchObject({ purgedDesigns: 0, deletedBlobs: 0 });
    const audit = (await api.get("/api/v1/admin/audit?action=system")).json().entries;
    expect(audit[0].action).toBe("system.maintenance");
  });
});

describe("系统概览与指标", () => {
  it("概览给出数量、存储与近 7 天活跃度", async () => {
    await newDesign("首页");
    const o = (await api.get("/api/v1/admin/overview")).json();
    expect(o).toMatchObject({ users: 1, projects: 1, designs: 1, versions: 1, uploads7d: 1, trashDays: 30 });
    expect(o.storageBytes).toBeGreaterThan(0);
  });

  it("/metrics 需要令牌；输出 Prometheus 文本格式", async () => {
    await newDesign("首页");
    expect((await server.app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(404);
    const res = await server.app.inject({ method: "GET", url: "/metrics", headers: { authorization: "Bearer metrics-secret" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toContain("sqraft_designs 1");
    expect(res.body).toMatch(/sqraft_http_requests_total\{method="POST",route="\/api\/v1\/uploads\/:id\/complete",status="200"\} 1/);
  });
});

describe("备份与恢复", () => {
  it("运行中备份，恢复到新目录后数据完整", async () => {
    const id = await newDesign("首页", "备份前的标题");
    const backupDir = await mkdtemp(join(tmpdir(), "sqraft-backup-"));
    const file = join(backupDir, "b.tar.gz");
    const m = await createBackup(server.ctx.config.dataDir, file);
    expect(m).toMatchObject({ app: "sqraft-cloud", schemaVersion: SCHEMA_VERSION });
    expect(m.blobs).toBeGreaterThan(0);

    const target = join(backupDir, "restored");
    await restoreBackup(file, target);
    const restored = await buildApp({ ...server.ctx.config, dataDir: target });
    try {
      const a = client(restored.app, await login(restored.app, ADMIN.username, ADMIN.password));
      const page = (await a.get(`/api/v1/designs/${id}/versions/1/pages/page-1`)).json();
      expect(page.doc.nodes["page-1"].name).toBe("备份前的标题");
      expect((await a.get(`/api/v1/designs/${id}/versions/1/assets/aaaa1111`)).statusCode).toBe(200);
    } finally {
      await restored.app.close();
    }
    // 已有数据的目录不加 --force 不覆盖；加了则原目录改名保留
    await expect(restoreBackup(file, target)).rejects.toThrow("--force");
    await restoreBackup(file, target, true);
    const siblings = await readdir(backupDir);
    expect(siblings.some((n) => n.startsWith("restored.before-restore-"))).toBe(true);
    await rm(backupDir, { recursive: true, force: true });
  });

  it("拒绝不是备份的文件", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sqraft-bad-"));
    const bad = join(dir, "x.tar.gz");
    await writeFile(bad, "not a tar");
    await expect(restoreBackup(bad, join(dir, "data"))).rejects.toThrow();
    await rm(dir, { recursive: true, force: true });
  });
});
