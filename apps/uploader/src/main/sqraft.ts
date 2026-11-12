/**
 * 在本地拆开 .sqraft（增量上传用）：doc.json 按页 / 组件拆成部件（规则与服务端同一份代码），
 * 切图按字节算哈希。切图字节等确定要传时再从 zip 里读出来，不常驻内存。
 */

import yauzl from "yauzl";
import { createHash } from "node:crypto";
import { splitDoc, ASSET_NAME_RE, type DocPart } from "@sqraft-cloud/shared";
import type { DocState } from "@sqraft/core";

export interface LocalAsset {
  name: string;
  hash: string;
  size: number;
  read(): Promise<Buffer>;
}

export interface LocalDesign {
  formatVersion: number;
  tokens: DocState["tokens"];
  parts: DocPart[];
  assets: LocalAsset[];
  /** manifest.json 里的页面分组（sketch2sqraft 写的），原样转给服务端整理 */
  sections?: unknown;
  close(): void;
}

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => (err || !zip ? reject(new Error("不是有效的 .sqraft 文件")) : resolve(zip)));
  });
}

function entries(zip: yauzl.ZipFile): Promise<yauzl.Entry[]> {
  return new Promise((resolve, reject) => {
    const out: yauzl.Entry[] = [];
    zip.on("entry", (e: yauzl.Entry) => {
      out.push(e);
      zip.readEntry();
    });
    zip.once("end", () => resolve(out));
    zip.once("error", reject);
    zip.readEntry();
  });
}

function stream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (err, s) => (err || !s ? reject(err ?? new Error("读取失败")) : resolve(s))));
}

/** 逐块读完一个条目。注意：yauzl 对未压缩（stored）条目给的流不支持 for await，只能用事件读。 */
async function each(zip: yauzl.ZipFile, entry: yauzl.Entry, onChunk: (c: Buffer) => void): Promise<void> {
  const s = await stream(zip, entry);
  await new Promise<void>((resolve, reject) => {
    s.on("data", (c: Buffer) => onChunk(c));
    s.once("end", () => resolve());
    s.once("error", reject);
  });
}

async function readAll(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await each(zip, entry, (c) => chunks.push(c));
  return Buffer.concat(chunks);
}

async function hashEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<string> {
  const h = createHash("sha256");
  await each(zip, entry, (c) => h.update(c));
  return h.digest("hex");
}

export async function readLocalDesign(file: string): Promise<LocalDesign> {
  const zip = await openZip(file);
  try {
    const list = await entries(zip);
    const docEntry = list.find((e) => e.fileName === "doc.json");
    if (!docEntry) throw new Error("文件里缺少 doc.json");
    const doc = JSON.parse((await readAll(zip, docEntry)).toString("utf8")) as DocState;
    if (!doc || !Array.isArray(doc.rootIds) || !doc.nodes) throw new Error("doc.json 结构不对");
    let formatVersion = typeof doc.formatVersion === "number" ? doc.formatVersion : 1;
    let sections: unknown;
    const manifest = list.find((e) => e.fileName === "manifest.json");
    if (manifest) {
      const m = JSON.parse((await readAll(zip, manifest)).toString("utf8")) as { formatVersion?: unknown; sections?: unknown };
      if (typeof m.formatVersion === "number") formatVersion = Math.max(formatVersion, m.formatVersion);
      if (Array.isArray(m.sections)) sections = m.sections;
    }
    const assets: LocalAsset[] = [];
    for (const e of list) {
      if (!ASSET_NAME_RE.test(e.fileName)) continue;
      assets.push({ name: e.fileName, hash: await hashEntry(zip, e), size: e.uncompressedSize, read: () => readAll(zip, e) });
    }
    return { formatVersion, tokens: doc.tokens ?? {}, parts: splitDoc(doc), assets, sections, close: () => zip.close() };
  } catch (error) {
    zip.close();
    throw error;
  }
}
