/**
 * 内容寻址的文件仓库：`blobs/<sha256 前两位>/<sha256>`。同一份字节只存一次，
 * 多个设计稿版本共用同一批切图，更新一版只多占改动的部分。
 */

import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

export class BlobStore {
  readonly blobsDir: string;
  readonly tmpDir: string;
  readonly uploadsDir: string;

  constructor(dataDir: string) {
    this.blobsDir = join(dataDir, "blobs");
    this.tmpDir = join(dataDir, "tmp");
    this.uploadsDir = join(dataDir, "uploads");
  }

  async init(): Promise<void> {
    await mkdir(this.blobsDir, { recursive: true });
    await mkdir(this.tmpDir, { recursive: true });
    await mkdir(this.uploadsDir, { recursive: true });
  }

  path(hash: string): string {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`非法的 blob 哈希：${hash}`);
    return join(this.blobsDir, hash.slice(0, 2), hash);
  }

  tmpPath(): string {
    return join(this.tmpDir, `${Date.now()}-${randomBytes(6).toString("hex")}`);
  }

  uploadPath(uploadId: string): string {
    return join(this.uploadsDir, `${uploadId}.part`);
  }

  async has(hash: string): Promise<boolean> {
    try {
      await stat(this.path(hash));
      return true;
    } catch {
      return false;
    }
  }

  /** 存一段字节，返回其哈希。 */
  async putBuffer(bytes: Buffer): Promise<string> {
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (await this.has(hash)) return hash;
    const tmp = this.tmpPath();
    await writeFile(tmp, bytes);
    await this.adopt(tmp, hash);
    return hash;
  }

  /** 存 JSON（gzip 压缩），用于索引与按页拆分的节点数据。 */
  putJson(value: unknown): Promise<string> {
    return this.putBuffer(gzipSync(Buffer.from(JSON.stringify(value))));
  }

  async getJson<T>(hash: string): Promise<T> {
    return JSON.parse(gunzipSync(await readFile(this.path(hash))).toString("utf8")) as T;
  }

  /** 读开头若干字节（嗅探图片格式与尺寸用）。 */
  async head(hash: string, bytes = 65536): Promise<Buffer> {
    const fh = await open(this.path(hash), "r");
    try {
      const buf = Buffer.alloc(bytes);
      const { bytesRead } = await fh.read(buf, 0, bytes, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  /** 把临时文件收进仓库；已存在则丢弃临时文件。 */
  async adopt(tmpFile: string, hash: string): Promise<void> {
    const dest = this.path(hash);
    if (await this.has(hash)) {
      await rm(tmpFile, { force: true });
      return;
    }
    await mkdir(join(this.blobsDir, hash.slice(0, 2)), { recursive: true });
    await rename(tmpFile, dest);
  }
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
