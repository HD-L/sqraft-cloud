/** 测试工具：临时数据目录上的应用实例、登录、带凭据的请求、合成 .sqraft 文件。 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync, type Zippable } from "fflate";
import type { FastifyInstance, InjectOptions } from "fastify";
import { buildApp, type AppContext } from "../src/app";
import { loadConfig, type Config } from "../src/config";

export const ADMIN = { username: "admin", password: "admin-pass-123" };

export interface TestServer {
  app: FastifyInstance;
  ctx: AppContext;
  close(): Promise<void>;
}

export async function startServer(overrides: Partial<Config> = {}): Promise<TestServer> {
  const dir = await mkdtemp(join(tmpdir(), "sqraft-cloud-test-"));
  const config: Config = {
    ...loadConfig({}),
    dataDir: dir,
    insecureHttp: true,
    adminUser: ADMIN.username,
    adminPassword: ADMIN.password,
    ...overrides,
  };
  const { app, ctx } = await buildApp(config);
  return {
    app,
    ctx,
    async close() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export type Creds = { cookie: string; csrf: string } | { bearer: string } | null;

/** 带凭据发请求：会话自动带 Cookie + CSRF 头，令牌带 Authorization。 */
export function client(app: FastifyInstance, creds: Creds) {
  const send = (method: InjectOptions["method"], url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const h: Record<string, string> = { ...headers };
    if (creds && "cookie" in creds) {
      h.cookie = creds.cookie;
      h["x-csrf-token"] = creds.csrf;
    }
    if (creds && "bearer" in creds) h.authorization = `Bearer ${creds.bearer}`;
    const opts: InjectOptions = { method, url, headers: h };
    if (payload instanceof Uint8Array) {
      opts.payload = Buffer.from(payload);
      h["content-type"] ??= "application/octet-stream";
    } else if (payload !== undefined) {
      opts.payload = payload as InjectOptions["payload"];
    }
    return app.inject(opts);
  };
  return {
    get: (url: string) => send("GET", url),
    post: (url: string, body?: unknown, headers?: Record<string, string>) => send("POST", url, body ?? {}, headers),
    put: (url: string, body?: unknown, headers?: Record<string, string>) => send("PUT", url, body, headers),
    patch: (url: string, body?: unknown) => send("PATCH", url, body ?? {}),
    delete: (url: string) => send("DELETE", url),
  };
}

export async function login(app: FastifyInstance, username: string, password: string): Promise<{ cookie: string; csrf: string }> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password } });
  if (res.statusCode !== 200) throw new Error(`登录失败 ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === "sqraft_session");
  if (!cookie) throw new Error("没有会话 Cookie");
  return { cookie: `${cookie.name}=${cookie.value}`, csrf: res.json().csrfToken as string };
}

/** 建一个已改过初始密码的普通用户，返回其会话。 */
export async function createUser(app: FastifyInstance, admin: Creds, username: string): Promise<{ id: string; session: { cookie: string; csrf: string } }> {
  const password = `${username}-pass-123`;
  const created = await client(app, admin).post("/api/v1/admin/users", { username, password });
  if (created.statusCode !== 200) throw new Error(created.body);
  const first = await login(app, username, password);
  const changed = await client(app, first).post("/api/v1/me/password", { currentPassword: password, newPassword: `${password}-new` });
  if (changed.statusCode !== 200) throw new Error(changed.body);
  return { id: created.json().user.id as string, session: first };
}

export function fakePng(seed: number, length = 2048): Uint8Array {
  const b = new Uint8Array(length);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let i = 8; i < length; i++) b[i] = (i * 31 + seed * 17) & 0xff;
  return b;
}

function node(id: string, type: string, name: string, parentId: string | null, children: string[], extra: Record<string, unknown> = {}) {
  return { id, type, name, parentId, children, x: 0, y: 0, width: 100, height: 100, rotation: 0, opacity: 1, visible: true, locked: false, style: {}, ...extra };
}

/** 合成一个最小的 .sqraft：一个页面、若干节点、可选切图。 */
export function makeSqraft(opts: { title?: string; assets?: Record<string, Uint8Array>; formatVersion?: number; extra?: Zippable } = {}): Uint8Array {
  const formatVersion = opts.formatVersion ?? 7;
  const doc = {
    version: 1,
    formatVersion,
    rootIds: ["page-1"],
    nodes: {
      "page-1": node("page-1", "page", opts.title ?? "首页", null, ["card"], { width: 375, height: 812 }),
      card: node("card", "frame", "卡片", "page-1", ["t1", "pic"], {
        x: 16,
        y: 100,
        width: 343,
        height: 200,
        layout: { direction: "vertical", gap: 12, crossGap: 0, padding: { top: 16, right: 16, bottom: 16, left: 16 }, align: "start", justify: "start", wrap: false },
      }),
      t1: node("t1", "text", "标题", "card", [], { x: 16, y: 16, width: 200, height: 24, text: opts.title ?? "你好" }),
      pic: node("pic", "image", "配图", "card", [], {
        x: 16,
        y: 52,
        width: 64,
        height: 64,
        image: { assetId: "aaaa1111", naturalWidth: 64, naturalHeight: 64 },
      }),
    },
    tokens: { "color/primary": { type: "color", value: "#1677ff" } },
  };
  const files: Zippable = {
    "manifest.json": strToU8(JSON.stringify({ formatVersion, app: "sqraft", version: "test" })),
    "doc.json": strToU8(JSON.stringify(doc)),
    "ops.ndjson": new Uint8Array(0),
    ...opts.extra,
  };
  for (const [name, bytes] of Object.entries(opts.assets ?? {})) files[name] = [bytes, { level: 0 }];
  return zipSync(files);
}

/** 分块上传整个文件并提交，返回 complete 的响应。 */
export async function upload(
  api: ReturnType<typeof client>,
  designId: string,
  bytes: Uint8Array,
  note = "",
  chunk = 1024,
) {
  const start = await api.post(`/api/v1/designs/${designId}/uploads`, { size: bytes.length, note });
  if (start.statusCode !== 200) return start;
  const id = start.json().uploadId as string;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    const res = await api.put(`/api/v1/uploads/${id}`, bytes.subarray(offset, offset + chunk), { "upload-offset": String(offset) });
    if (res.statusCode !== 200) return res;
  }
  return api.post(`/api/v1/uploads/${id}/complete`);
}
