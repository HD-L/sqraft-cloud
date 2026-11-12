/**
 * 接口封装：同源 Cookie 会话 + 写请求自动带 CSRF 头；错误统一成 ApiError（message 是服务端给的中文提示）。
 */

import { reactive } from "vue";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface User {
  id: string;
  username: string;
  isAdmin: boolean;
  mustChangePassword: boolean;
  disabled: boolean;
  createdAt: number;
}

export const session = reactive<{ user: User | null; csrf: string; loaded: boolean }>({ user: null, csrf: "", loaded: false });

export async function api<T = unknown>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const init: RequestInit = { method, headers: { ...headers }, credentials: "same-origin" };
  const h = init.headers as Record<string, string>;
  if (method !== "GET" && method !== "HEAD") h["x-csrf-token"] = session.csrf;
  if (body instanceof Blob) {
    init.body = body;
    h["content-type"] ??= "application/octet-stream";
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    h["content-type"] = "application/json";
  }
  const res = await fetch(`/api/v1${path}`, init);
  const text = await res.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    const err = (data.error ?? {}) as { code?: string; message?: string };
    if (res.status === 401 && path !== "/auth/login") {
      session.user = null;
    }
    throw Object.assign(new ApiError(res.status, err.code ?? "error", err.message ?? `请求失败（${res.status}）`), { data });
  }
  return data as T;
}

export async function loadSession(): Promise<void> {
  try {
    const me = await api<{ user: User; csrfToken?: string }>("GET", "/me");
    session.user = me.user;
    session.csrf = me.csrfToken ?? "";
  } catch {
    session.user = null;
  } finally {
    session.loaded = true;
  }
}

export async function login(username: string, password: string): Promise<void> {
  const res = await api<{ user: User; csrfToken: string }>("POST", "/auth/login", { username, password });
  session.user = res.user;
  session.csrf = res.csrfToken;
}

export async function logout(): Promise<void> {
  await api("POST", "/auth/logout").catch(() => undefined);
  session.user = null;
  session.csrf = "";
}

export function formatTime(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** 分块上传 .sqraft（8 MB 一块，偏移不一致时按服务端偏移续传）。 */
export async function uploadDesign(
  designId: string,
  file: File,
  note: string,
  onProgress: (sent: number, total: number) => void,
  signal?: AbortSignal,
): Promise<{ duplicate: boolean; version: { number: number } }> {
  const start = await api<{ uploadId: string; chunkSize: number }>("POST", `/designs/${designId}/uploads`, { size: file.size, note });
  let offset = 0;
  while (offset < file.size) {
    if (signal?.aborted) {
      await api("DELETE", `/uploads/${start.uploadId}`).catch(() => undefined);
      throw new ApiError(0, "aborted", "已取消上传");
    }
    try {
      const res = await api<{ received: number }>("PUT", `/uploads/${start.uploadId}`, file.slice(offset, offset + start.chunkSize), {
        "upload-offset": String(offset),
      });
      offset = res.received;
    } catch (error) {
      const received = (error as { data?: { received?: number } }).data?.received;
      if (error instanceof ApiError && error.code === "offset_mismatch" && typeof received === "number") offset = received;
      else throw error;
    }
    onProgress(offset, file.size);
  }
  return api("POST", `/uploads/${start.uploadId}/complete`);
}
