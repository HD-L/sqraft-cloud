/**
 * 校验并收录一个 .sqraft 文件（zip：manifest.json + doc.json + ops.ndjson + assets/）。
 *
 * 安全检查：
 * - 条目名白名单（拒绝路径穿越、绝对路径、未知文件）、不允许重名；
 * - 单条目与总解压大小上限、压缩比上限（zip 炸弹）；
 * - doc.json 结构与节点数上限；格式版本高于本服务支持的拒绝（提示升级）。
 *
 * 条目逐个流式写入文件仓库，不把整个大稿读进内存（doc.json 解析除外）。
 */

import { createWriteStream } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import yauzl from "yauzl";
import { CURRENT_FORMAT_VERSION, type DocState } from "@sqraft/core";
import { versionFingerprint } from "@sqraft-cloud/shared";
import { buildIndex, type IndexBase, type VersionIndex } from "./indexer";
import { HttpError } from "./errors";
import { sha256File, type BlobStore } from "./storage";

export interface AssetRef {
  /** zip 内路径，如 `assets/ab12cd34.png` */
  name: string;
  blob: string;
  size: number;
}

export interface IngestResult {
  fileSha256: string;
  size: number;
  formatVersion: number;
  docBlob: string;
  manifestBlob: string | null;
  assets: AssetRef[];
  nodeCount: number;
  pageCount: number;
  /** 按页索引（见 indexer.ts），还没存进仓库：生成版本时要先标上变更记录 */
  index: VersionIndex;
  /** 整版内容指纹（见 shared/versionFingerprint） */
  contentHash: string;
}

export interface IngestLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  /** 解压后 / 压缩后 的上限（只对 1 MB 以上的条目检查） */
  maxRatio: number;
  maxNodes: number;
}

export const DEFAULT_LIMITS: IngestLimits = {
  maxEntries: 200_000,
  maxEntryBytes: 1024 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024 * 1024,
  maxRatio: 1000,
  maxNodes: 3_000_000,
};

const ENTRY_NAME = /^(manifest\.json|doc\.json|ops\.ndjson|assets\/[A-Za-z0-9_-]{1,128}\.(png|jpe?g|gif|webp|svg|bin))$/;

const invalid = (message: string) => new HttpError(422, "invalid_sqraft", message);

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }, (err, zip) => {
      if (err || !zip) reject(invalid("不是有效的 .sqraft 文件（zip 无法打开）"));
      else resolve(zip);
    });
  });
}

function nextEntry(zip: yauzl.ZipFile): Promise<yauzl.Entry | null> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: yauzl.Entry) => {
      cleanup();
      resolve(entry);
    };
    const onEnd = () => {
      cleanup();
      resolve(null);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(invalid(`zip 结构损坏：${err.message}`));
    };
    const cleanup = () => {
      zip.off("entry", onEntry);
      zip.off("end", onEnd);
      zip.off("error", onError);
    };
    zip.once("entry", onEntry);
    zip.once("end", onEnd);
    zip.once("error", onError);
    zip.readEntry();
  });
}

function openEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) reject(invalid(`无法读取条目 ${entry.fileName}`));
      else resolve(stream);
    });
  });
}

/** 把一个条目写进临时文件并算哈希，返回 [临时文件, sha256, 字节数]。 */
async function extractEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, tmp: string, maxBytes: number): Promise<[string, number]> {
  const hash = createHash("sha256");
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length;
      if (size > maxBytes) {
        done(invalid(`条目 ${entry.fileName} 超过大小上限`));
        return;
      }
      hash.update(chunk);
      done(null, chunk);
    },
  });
  try {
    await pipeline(await openEntry(zip, entry), meter, createWriteStream(tmp));
  } catch (error) {
    await rm(tmp, { force: true });
    if (error instanceof HttpError) throw error;
    throw invalid(`条目 ${entry.fileName} 解压失败：${error instanceof Error ? error.message : String(error)}`);
  }
  return [hash.digest("hex"), size];
}

interface DocShape {
  formatVersion?: unknown;
  rootIds?: unknown;
  nodes?: unknown;
}

export async function ingestSqraft(file: string, store: BlobStore, limits: IngestLimits = DEFAULT_LIMITS, base?: IndexBase): Promise<IngestResult> {
  const { size } = await stat(file);
  const fileSha256 = await sha256File(file);
  const zip = await openZip(file);
  const seen = new Set<string>();
  const adopted: Array<{ name: string; blob: string; size: number }> = [];
  let total = 0;
  let count = 0;
  try {
    for (let entry = await nextEntry(zip); entry; entry = await nextEntry(zip)) {
      const name = entry.fileName;
      if (name === "assets/") continue;
      if (!ENTRY_NAME.test(name)) throw invalid(`包含不允许的文件：${name}`);
      if (seen.has(name)) throw invalid(`重复的条目：${name}`);
      seen.add(name);
      if (++count > limits.maxEntries) throw invalid("条目数量超过上限");
      if (entry.uncompressedSize > limits.maxEntryBytes) throw invalid(`条目 ${name} 超过大小上限`);
      total += entry.uncompressedSize;
      if (total > limits.maxTotalBytes) throw invalid("解压后总大小超过上限");
      if (
        entry.uncompressedSize > 1024 * 1024 &&
        entry.compressedSize > 0 &&
        entry.uncompressedSize / entry.compressedSize > limits.maxRatio
      ) {
        throw invalid(`条目 ${name} 压缩比异常`);
      }
      const tmp = store.tmpPath();
      const [blob, bytes] = await extractEntry(zip, entry, tmp, limits.maxEntryBytes);
      // ops.ndjson 是编辑操作日志，读稿用不到：校验能解压即可，不进文件仓库
      if (name === "ops.ndjson") {
        await rm(tmp, { force: true });
        continue;
      }
      await store.adopt(tmp, blob);
      adopted.push({ name, blob, size: bytes });
    }
  } finally {
    zip.close();
  }

  const doc = adopted.find((a) => a.name === "doc.json");
  if (!doc) throw invalid("缺少 doc.json");
  const manifest = adopted.find((a) => a.name === "manifest.json") ?? null;

  let manifestVersion = 1;
  if (manifest) {
    try {
      const parsed = JSON.parse(await readFile(store.path(manifest.blob), "utf8")) as { formatVersion?: unknown };
      if (typeof parsed.formatVersion === "number") manifestVersion = parsed.formatVersion;
    } catch {
      throw invalid("manifest.json 不是有效的 JSON");
    }
  }

  let parsed: DocShape;
  try {
    parsed = JSON.parse(await readFile(store.path(doc.blob), "utf8")) as DocShape;
  } catch {
    throw invalid("doc.json 不是有效的 JSON");
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.rootIds) || !parsed.nodes || typeof parsed.nodes !== "object") {
    throw invalid("doc.json 结构不对：缺少 rootIds / nodes");
  }
  const nodes = parsed.nodes as Record<string, { type?: unknown } | undefined>;
  const nodeCount = Object.keys(nodes).length;
  if (nodeCount > limits.maxNodes) throw invalid(`节点数 ${nodeCount} 超过上限 ${limits.maxNodes}`);
  const docVersion = typeof parsed.formatVersion === "number" ? parsed.formatVersion : 1;
  const formatVersion = Math.max(docVersion, manifestVersion);
  if (formatVersion > CURRENT_FORMAT_VERSION) {
    throw new HttpError(
      422,
      "format_too_new",
      `设计稿格式版本 ${formatVersion} 高于服务端支持的 ${CURRENT_FORMAT_VERSION}，请升级 sqraft-cloud`,
    );
  }
  const pageCount = (parsed.rootIds as unknown[]).filter((id) => typeof id === "string" && nodes[id]?.type === "page").length;
  const assets = adopted.filter((a) => a.name.startsWith("assets/"));
  const doc2 = parsed as unknown as DocState;
  const built = await buildIndex(doc2, assets, store, base);
  const order = new Map(doc2.rootIds.map((id, i) => [id, i]));
  const contentHash = versionFingerprint({
    formatVersion,
    tokens: doc2.tokens,
    parts: [...built.index.pages, ...built.index.components]
      .map((e) => ({ rootId: e.id, hash: e.blob }))
      .sort((a, b) => order.get(a.rootId)! - order.get(b.rootId)!),
    assets: assets.map((a) => ({ name: a.name, hash: a.blob })),
  });

  return {
    fileSha256,
    size,
    formatVersion,
    docBlob: doc.blob,
    manifestBlob: manifest?.blob ?? null,
    assets,
    nodeCount,
    pageCount,
    index: built.index,
    contentHash,
  };
}
