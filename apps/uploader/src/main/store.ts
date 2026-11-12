/**
 * 本地持久化：
 * - config.json：私有云地址、本地文件 ↔ 云端设计稿的对应关系（不含任何凭据）；
 * - tokens/<地址哈希>.bin：用 Electron safeStorage 加密的令牌（macOS 上由钥匙串保护的密钥加密），
 *   每个私有云地址一份。safeStorage 不可用时拒绝保存，不落明文。
 */

import { app, safeStorage } from "electron";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FileMapping } from "../shared/types";

interface Config {
  server: string | null;
  mappings: Record<string, FileMapping>;
}

const dir = () => app.getPath("userData");
const configPath = () => join(dir(), "config.json");
const tokenPath = (server: string) => join(dir(), "tokens", `${createHash("sha256").update(server).digest("hex").slice(0, 16)}.bin`);

let cache: Config | null = null;

function load(): Config {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(readFileSync(configPath(), "utf8")) as Partial<Config>;
    cache = { server: parsed.server ?? null, mappings: parsed.mappings ?? {} };
  } catch {
    cache = { server: null, mappings: {} };
  }
  return cache;
}

function save(): void {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(load(), null, 2));
}

export function getServer(): string | null {
  return load().server;
}

export function setServer(server: string): void {
  load().server = server;
  save();
}

export function getMapping(path: string, server: string): FileMapping | null {
  const m = load().mappings[path];
  return m && m.server === server ? m : null;
}

export function setMapping(path: string, mapping: FileMapping): void {
  load().mappings[path] = mapping;
  save();
}

export function saveToken(server: string, token: string): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("系统钥匙串不可用，无法安全保存登录状态");
  mkdirSync(join(dir(), "tokens"), { recursive: true });
  writeFileSync(tokenPath(server), safeStorage.encryptString(token), { mode: 0o600 });
}

export function loadToken(server: string): string | null {
  try {
    return safeStorage.decryptString(readFileSync(tokenPath(server)));
  } catch {
    return null;
  }
}

export function clearToken(server: string): void {
  rmSync(tokenPath(server), { force: true });
}
