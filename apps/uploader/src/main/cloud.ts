/**
 * 与私有云通信（只在主进程里）：服务校验、浏览器登录（授权码 + PKCE）、项目 / 设计稿、上传。
 *
 * 上传优先走增量：本地拆页、只传服务端没有的页面与切图；服务端不支持时退回整包分块上传。
 */

import { shell } from "electron";
import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import type { CloudUser, Design, Project } from "../shared/types";
import { CloudError, request } from "./http";

export { CloudError } from "./http";
export { uploadFile, type UploadOutcome } from "./upload";

export const CLIENT_ID = "sqraft-uploader";
export const REDIRECT_URI = "sqraft-uploader://oauth/callback";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

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

