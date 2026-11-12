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

export type TeamRole = "admin" | "editor" | "viewer";
export type DesignStatus = "draft" | "review" | "published";

export interface User {
  id: string;
  username: string;
  displayName: string;
  email: string;
  role: TeamRole;
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

export const ROLE_LABEL: Record<TeamRole, string> = { admin: "管理员", editor: "编辑者", viewer: "查看者" };
export const ROLE_TAG: Record<TeamRole, string> = { admin: "orange", editor: "", viewer: "green" };
export const STATUS_LABEL: Record<DesignStatus, string> = { draft: "草稿", review: "评审中", published: "已发布" };
export const STATUS_TAG: Record<DesignStatus, string> = { draft: "yellow", review: "", published: "green" };

/** 「刚刚 / 5 分钟前 / 昨天 / 11/06」 */
export function relativeTime(ms: number | null | undefined): string {
  if (!ms) return "—";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 2 * 86_400_000) return "昨天";
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const md = `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
  return sameYear ? md : `${d.getFullYear()}/${md}`;
}

const PALETTE = ["#2f5cff", "#22b07d", "#f5a623", "#e5484d", "#8b5cf6", "#0ea5e9", "#ec4899", "#14b8a6"];
/** 由字符串稳定地挑一个颜色（头像、项目封面） */
export function colorOf(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
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
