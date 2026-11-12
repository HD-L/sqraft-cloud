/**
 * 内容寻址的文件仓库：`blobs/<sha256 前两位>/<sha256>`。同一份内容只存一次，
 * 多个设计稿版本共用同一批切图与页面，更新一版只多占改动的部分。
 *
 * - 切图等原始文件：名字 = 文件字节的 SHA-256；
 * - JSON（索引、按页拆分的节点）：名字 = **未压缩** JSON 文本的 SHA-256，内容 gzip 存放。
 *   这样上传客户端不用复现服务端的 gzip 字节，只按规范 JSON 算哈希就能判断服务端有没有。
 *   里程碑 4 之前写入的 JSON 以 gzip 字节命名，仍可正常读取。
 */

import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
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
    return this.putJsonText(JSON.stringify(value));
  }

  /** 存一段 JSON 文本：以文本哈希命名、gzip 存放。`hash` 已算好时直接传入。 */
  async putJsonText(text: string, hash = createHash("sha256").update(text).digest("hex")): Promise<string> {
    if (await this.has(hash)) return hash;
    const tmp = this.tmpPath();
    await writeFile(tmp, gzipSync(Buffer.from(text)));
    await this.adopt(tmp, hash);
    return hash;
  }

  async getJson<T>(hash: string): Promise<T> {
    return JSON.parse(await this.getText(hash)) as T;
  }

  /** 读 JSON 文本；兼容没压缩的内容（按 gzip 魔数判断）。 */
  async getText(hash: string): Promise<string> {
    const buf = await readFile(this.path(hash));
    return (buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf).toString("utf8");
  }

  /** 刷新修改时间：增量上传判定「服务端已有」的文件，在提交前不会被孤儿回收删掉。 */
  async touch(hash: string): Promise<void> {
    const now = new Date();
    await utimes(this.path(hash), now, now).catch(() => undefined);
  }

  async size(hash: string): Promise<number | null> {
    try {
      return (await stat(this.path(hash))).size;
    } catch {
      return null;
    }
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
