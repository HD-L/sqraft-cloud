/**
 * 与私有云通信（只在主进程里）：服务校验、浏览器登录（授权码 + PKCE）、项目 / 设计稿、分块上传。
 */

import { shell } from "electron";
import { createHash, randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { hostname } from "node:os";
import type { CloudUser, Design, Project, UploadProgress } from "../shared/types";

export const CLIENT_ID = "sqraft-uploader";
export const REDIRECT_URI = "sqraft-uploader://oauth/callback";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export class CloudError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** 规范化用户输入的地址：补协议、去掉末尾斜杠与路径。 */
export function normalizeServer(input: string): string {
  let raw = input.trim();
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  const url = new URL(raw);
  return `${url.protocol}//${url.host}`;
}

export function isInsecure(server: string): boolean {
  const url = new URL(server);
  return url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

async function request<T>(server: string, token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const h: Record<string, string> = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let payload: string | Uint8Array | undefined;
  if (body instanceof Uint8Array) {
    payload = body;
    h["content-type"] = "application/octet-stream";
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    h["content-type"] = "application/json";
  }
  let res: Response;
  try {
    res = await fetch(`${server}${path}`, { method, headers: h, body: payload, redirect: "error" });
  } catch (error) {
    throw new CloudError(0, "network", `连不上私有云：${(error as Error).message}`);
  }
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    if (!res.ok) throw new CloudError(res.status, "bad_response", `私有云返回了意外的内容（HTTP ${res.status}）`);
  }
  if (!res.ok) {
    const err = (data.error ?? {}) as { code?: string; message?: string } | string;
    if (typeof err === "string") throw new CloudError(res.status, err, String(data.error_description ?? err), data);
    throw new CloudError(res.status, err.code ?? "error", err.message ?? `请求失败（HTTP ${res.status}）`, data);
  }
  return data as T;
}

/** 连接前校验：确实是 Sqraft 私有云，且 API 版本兼容（U2）。 */
export async function checkServer(server: string): Promise<void> {
  const info = await request<{ app?: string; apiVersion?: number }>(server, null, "GET", "/api/v1/info");
  if (info.app !== "sqraft-cloud") throw new CloudError(0, "not_sqraft", "这个地址不是 Sqraft 私有云");
  if (info.apiVersion !== 1) throw new CloudError(0, "incompatible", `私有云 API 版本 ${info.apiVersion} 与客户端不兼容，请升级客户端`);
}

// ── 浏览器登录（U3）──

interface PendingLogin {
  server: string;
  state: string;
  verifier: string;
  resolve(code: string): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

let pending: PendingLogin | null = null;

/** 打开浏览器授权页，等自定义协议回调带回授权码，再换令牌。 */
export async function login(server: string): Promise<string> {
  cancelLogin();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  const code = await new Promise<string>((resolve, reject) => {
    pending = {
      server,
      state,
      verifier,
      resolve,
      reject,
      timer: setTimeout(() => {
        pending = null;
        reject(new CloudError(0, "timeout", "等待浏览器授权超时，请重试"));
      }, LOGIN_TIMEOUT_MS),
    };
    const url = new URL(`${server}/oauth/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    }).toString();
    void shell.openExternal(url.toString());
  });
  const res = await fetch(`${server}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      device_name: hostname().replace(/\.local$/, ""),
    }),
  });
  const data = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !data.access_token) throw new CloudError(res.status, data.error ?? "token_failed", data.error_description ?? "换取令牌失败");
  return data.access_token;
}

export function cancelLogin(): void {
  if (!pending) return;
  clearTimeout(pending.timer);
  pending.reject(new CloudError(0, "cancelled", "已取消登录"));
  pending = null;
}

/** 处理 `sqraft-uploader://oauth/callback?code&state`；state 对不上的一律丢弃。 */
export function handleCallback(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "sqraft-uploader:" || url.host !== "oauth" || url.pathname !== "/callback") return false;
  const p = pending;
  if (!p || url.searchParams.get("state") !== p.state) return false;
  clearTimeout(p.timer);
  pending = null;
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  if (error || !code) p.reject(new CloudError(0, error ?? "denied", error === "access_denied" ? "你在浏览器里取消了授权" : "授权失败"));
  else p.resolve(code);
  return true;
}

// ── 业务接口 ──

export const me = (server: string, token: string) => request<{ user: CloudUser }>(server, token, "GET", "/api/v1/me").then((r) => r.user);

export const revoke = (server: string, token: string) => request(server, token, "POST", "/api/v1/oauth/revoke", {});

export async function listProjects(server: string, token: string): Promise<Project[]> {
  return (await request<{ projects: Project[] }>(server, token, "GET", "/api/v1/projects")).projects;
}

export async function listDesigns(server: string, token: string, projectId: string): Promise<Design[]> {
  return (await request<{ designs: Design[] }>(server, token, "GET", `/api/v1/projects/${encodeURIComponent(projectId)}/designs`)).designs;
}

export async function getDesign(server: string, token: string, designId: string): Promise<Design> {
  return (await request<{ design: Design }>(server, token, "GET", `/api/v1/designs/${encodeURIComponent(designId)}`)).design;
}

export async function createDesign(server: string, token: string, projectId: string, name: string): Promise<Design> {
  return (await request<{ design: Design }>(server, token, "POST", `/api/v1/projects/${encodeURIComponent(projectId)}/designs`, { name })).design;
}

/** 分块上传（U5、U6）：8 MB 一块，偏移不一致时按服务端偏移续传，可取消。 */
export async function uploadFile(
  server: string,
  token: string,
  designId: string,
  path: string,
  note: string,
  onProgress: (p: UploadProgress) => void,
  signal: AbortSignal,
): Promise<{ duplicate: boolean; version: number }> {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    const start = await request<{ uploadId: string; chunkSize: number }>(server, token, "POST", `/api/v1/designs/${encodeURIComponent(designId)}/uploads`, {
      size,
      note,
    });
    const id = start.uploadId;
    let offset = 0;
    while (offset < size) {
      if (signal.aborted) {
        await request(server, token, "DELETE", `/api/v1/uploads/${id}`).catch(() => undefined);
        throw new CloudError(0, "aborted", "已取消上传");
      }
      const length = Math.min(start.chunkSize, size - offset);
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, offset);
      try {
        const res = await request<{ received: number }>(server, token, "PUT", `/api/v1/uploads/${id}`, buf, { "upload-offset": String(offset) });
        offset = res.received;
      } catch (error) {
        const received = (error as CloudError).data?.received;
        if (error instanceof CloudError && error.code === "offset_mismatch" && typeof received === "number") offset = received;
        else throw error;
      }
      onProgress({ sent: offset, total: size, phase: offset < size ? "uploading" : "verifying" });
    }
    const done = await request<{ duplicate: boolean; version: { number: number } }>(server, token, "POST", `/api/v1/uploads/${id}/complete`, {});
    return { duplicate: done.duplicate, version: done.version.number };
  } finally {
    await fh.close();
  }
}
