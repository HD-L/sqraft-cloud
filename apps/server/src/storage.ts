/**
 * 内容寻址的文件仓库：`blobs/<sha256 前两位>/<sha256>`。同一份字节只存一次，
 * 多个设计稿版本共用同一批切图，更新一版只多占改动的部分。
 */

import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
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
