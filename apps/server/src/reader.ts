/**
 * 设计稿读取服务：网页与 MCP 共用。
 * - 解析版本号（缺省读「当前版本」）；
 * - 加载按页索引与单页节点（LRU 缓存，大稿只加载用到的页）；
 * - 里程碑 1 上传的版本没有索引：首次读取时从 doc.json 补建并写回。
 */

import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import type { DocState } from "@sqraft/core";
import type { AppContext } from "./app";
import { generateSecret, safeEqual } from "./crypto";
import { HttpError, notFound } from "./errors";
import { buildIndex, type SearchRow, type SubtreeDoc, type VersionIndex } from "./indexer";
import { exportNodeSvg, type SvgAsset, type SvgExportResult } from "./svg";
import type { AssetRef } from "./sqraft-file";
import type { DesignRow, VersionRow } from "./routes/projects";

class Lru<K, V> {
  private map = new Map<K, V>();
  constructor(private readonly max: number) {}
  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as K);
  }
}

export const SIGNED_URL_TTL_MS = 10 * 60 * 1000;

export class DesignReader {
  private readonly indexes = new Lru<string, VersionIndex>(32);
  private readonly subtrees = new Lru<string, SubtreeDoc>(128);
  private readonly searches = new Lru<string, SearchRow[]>(8);
  private readonly building = new Map<string, Promise<VersionIndex>>();
  private readonly svgs = new Lru<string, SvgExportResult & { name: string; rootId: string }>(64);
  private secret: string | null = null;

  constructor(private readonly ctx: AppContext) {}

  /** `version` 省略或为 "current" 时取当前版本。 */
  resolveVersion(design: DesignRow, version?: unknown): VersionRow {
    const { db } = this.ctx;
    let number: number | null;
    if (version === undefined || version === null || version === "current" || version === "") number = design.current_version;
    else {
      number = Number(version);
      if (!Number.isInteger(number) || number < 1) throw new HttpError(400, "bad_request", "version 需要正整数版本号");
    }
    if (number === null) throw new HttpError(404, "no_version", "这个设计稿还没有上传任何版本");
    const row = db.prepare("SELECT * FROM versions WHERE design_id = ? AND number = ?").get(design.id, number) as VersionRow | undefined;
    if (!row) throw notFound(`版本 ${number} 不存在`);
    return row;
  }

  async index(v: VersionRow): Promise<VersionIndex> {
    const key = `${v.design_id}@${v.number}`;
    if (v.index_blob) {
      const cached = this.indexes.get(v.index_blob);
      if (cached) return cached;
      const idx = await this.ctx.store.getJson<VersionIndex>(v.index_blob);
      this.indexes.set(v.index_blob, idx);
      return idx;
    }
    const pending = this.building.get(key);
    if (pending) return pending;
    const job = (async () => {
      const doc = JSON.parse(await readFile(this.ctx.store.path(v.doc_blob), "utf8")) as DocState;
      const idx = await buildIndex(doc, JSON.parse(v.assets) as AssetRef[], this.ctx.store);
      const blob = await this.ctx.store.putJson(idx);
      this.ctx.db.prepare("UPDATE versions SET index_blob = ? WHERE design_id = ? AND number = ?").run(blob, v.design_id, v.number);
      v.index_blob = blob;
      this.indexes.set(blob, idx);
      return idx;
    })().finally(() => this.building.delete(key));
    this.building.set(key, job);
    return job;
  }

  async subtree(blob: string): Promise<SubtreeDoc> {
    const cached = this.subtrees.get(blob);
    if (cached) return cached;
    const sub = await this.ctx.store.getJson<SubtreeDoc>(blob);
    this.subtrees.set(blob, sub);
    return sub;
  }

  /** 只含一个页面（或组件）的文档：给渲染器与 ai-tools 的读取工具用。 */
  async subtreeDoc(v: VersionRow, idx: VersionIndex, rootId: string): Promise<DocState> {
    const entry = idx.pages.find((p) => p.id === rootId) ?? idx.components.find((c) => c.id === rootId);
    if (!entry) throw notFound(`页面或组件 ${rootId} 不存在`);
    const sub = await this.subtree(entry.blob);
    return {
      version: 1,
      formatVersion: v.format_version,
      rootIds: sub.rootIds,
      nodes: sub.nodes,
      tokens: idx.tokens,
    } as DocState;
  }

  async search(idx: VersionIndex): Promise<SearchRow[]> {
    const cached = this.searches.get(idx.searchBlob);
    if (cached) return cached;
    const rows = await this.ctx.store.getJson<SearchRow[]>(idx.searchBlob);
    this.searches.set(idx.searchBlob, rows);
    return rows;
  }

  /** 节点所在的页面或主组件：给了就校验，没给就查搜索索引。 */
  async rootOf(idx: VersionIndex, nodeId: string, hint?: string): Promise<string> {
    if (hint) {
      if (!idx.pages.some((p) => p.id === hint) && !idx.components.some((c) => c.id === hint)) throw notFound(`页面或组件 ${hint} 不存在`);
      return hint;
    }
    const row = (await this.search(idx)).find((r) => r[0] === nodeId);
    if (!row) throw notFound(`节点 ${nodeId} 不存在`);
    return row[4];
  }

  /** 节点子树导出为 SVG（图标 / 切图）。位图内嵌；单次内嵌总量上限 20 MB。 */
  async exportSvg(v: VersionRow, idx: VersionIndex, nodeId: string, rootHint?: string): Promise<SvgExportResult & { name: string; rootId: string }> {
    const key = `${v.design_id}@${v.number}/${nodeId}`;
    const cached = this.svgs.get(key);
    if (cached) return cached;
    const rootId = await this.rootOf(idx, nodeId, rootHint);
    const doc = await this.subtreeDoc(v, idx, rootId);
    const node = doc.nodes[nodeId];
    if (!node) throw notFound(`节点 ${nodeId} 不在页面 / 组件 ${rootId} 里`);
    const assets = new Map<string, SvgAsset>();
    let total = 0;
    const stack = [nodeId];
    while (stack.length) {
      const n = doc.nodes[stack.pop()!];
      if (!n) continue;
      const id = n.image?.assetId;
      const entry = id ? idx.assets[id] : undefined;
      if (id && entry && !assets.has(id)) {
        total += entry.size;
        if (total > 20 * 1024 * 1024) throw new HttpError(413, "too_large", "这个节点里的图片太大，不适合导出为 SVG；请用 get_asset 单独下载图片");
        assets.set(id, { mime: entry.mime, bytes: await readFile(this.ctx.store.path(entry.blob)) });
      }
      stack.push(...n.children);
    }
    const result = { ...exportNodeSvg(doc, nodeId, { asset: (id) => assets.get(id) ?? null }), name: node.name ?? nodeId, rootId };
    this.svgs.set(key, result);
    return result;
  }

  // ── 切图签名链接：AI 助手拿到后无需凭据即可下载，10 分钟有效 ──

  private signingSecret(): string {
    if (this.secret) return this.secret;
    const { db } = this.ctx;
    const row = db.prepare("SELECT value FROM settings WHERE key = 'signing_secret'").get() as { value: string } | undefined;
    if (row) this.secret = row.value;
    else {
      this.secret = generateSecret();
      db.prepare("INSERT INTO settings (key, value) VALUES ('signing_secret', ?)").run(this.secret);
    }
    return this.secret;
  }

  private signature(path: string, exp: number): string {
    return createHmac("sha256", this.signingSecret()).update(`${path}\n${exp}`).digest("base64url");
  }

  signPath(path: string, now = Date.now()): { path: string; expiresAt: number } {
    const exp = now + SIGNED_URL_TTL_MS;
    return { path: `${path}?exp=${exp}&sig=${this.signature(path, exp)}`, expiresAt: exp };
  }

  signAssetPath(designId: string, version: number, assetId: string, now = Date.now()): { path: string; expiresAt: number } {
    return this.signPath(`/api/v1/assets/${designId}/${version}/${assetId}`, now);
  }

  signExportPath(designId: string, version: number, rootId: string, nodeId: string, now = Date.now()): { path: string; expiresAt: number } {
    return this.signPath(`/api/v1/exports/${designId}/${version}/${encodeURIComponent(rootId)}/${encodeURIComponent(nodeId)}.svg`, now);
  }

  verifyAssetPath(path: string, exp: unknown, sig: unknown): boolean {
    const e = Number(exp);
    if (!Number.isFinite(e) || e < Date.now() || typeof sig !== "string") return false;
    return safeEqual(sig, this.signature(path, e));
  }
}
