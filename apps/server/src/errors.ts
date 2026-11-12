/** 统一错误：`{ error: { code, message } }`，message 面向用户（中文）。 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = "bad_request") => new HttpError(400, code, message);
export const unauthorized = (message = "请先登录") => new HttpError(401, "unauthorized", message);
export const forbidden = (message = "没有权限", code = "forbidden") => new HttpError(403, code, message);
/** 没权限看到的资源一律 404，不暴露是否存在。 */
export const notFound = (message = "不存在或没有权限") => new HttpError(404, "not_found", message);
export const conflict = (message: string, code = "conflict") => new HttpError(409, code, message);
export const tooMany = (message: string, retryAfterSec: number) =>
  new HttpError(429, "rate_limited", message, { retryAfter: retryAfterSec });
