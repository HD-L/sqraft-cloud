/**
 * 凭据工具：密码用 bcrypt（cost 12），会话与令牌只存 SHA-256。
 * 令牌带固定前缀 `sqr_`，方便密钥扫描工具识别误提交的令牌。
 */

import bcrypt from "bcryptjs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const BCRYPT_COST = 12;
export const TOKEN_PREFIX = "sqr_";

/** 不存在的用户也要跑一次 bcrypt，避免用响应时间探测用户名是否存在。 */
const DUMMY_HASH = bcrypt.hashSync("sqraft-cloud-dummy-password", BCRYPT_COST);

export function newId(): string {
  return randomBytes(9).toString("base64url");
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export async function verifyPassword(password: string, hash: string | null): Promise<boolean> {
  const ok = await bcrypt.compare(password, hash ?? DUMMY_HASH);
  return hash !== null && ok;
}

/** 一次性初始密码：16 位，去掉易混字符。 */
export function generatePassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(16);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function generateSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const PASSWORD_MIN_LENGTH = 8;

export function checkPasswordPolicy(password: unknown): string | null {
  if (typeof password !== "string") return "密码必须是字符串";
  if (password.length < PASSWORD_MIN_LENGTH) return `密码至少 ${PASSWORD_MIN_LENGTH} 位`;
  if (password.length > 200) return "密码过长";
  return null;
}
