/** 与私有云的 HTTP 请求与统一的错误格式（不依赖 Electron，便于在 Node 里直接测试上传流程）。 */

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

export async function request<T>(server: string, token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
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

