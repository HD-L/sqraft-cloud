/**
 * 按页索引（D7）：把设计稿拆成「每个页面 / 每个主组件一份」的 gzip JSON（拆分规则见 @sqraft-cloud/shared），
 * 另建名称 / 文字搜索索引。读取时只加载需要的那一页，不再解析整份大稿。
 *
 * 页面子树是自足的：实例已物化，子节点都在页面子树里，渲染与读取都不需要母版。
 *
 * 两种来源：整份 .sqraft（`buildIndex`）与增量提交的清单（`buildIndexFromManifest`）。
 * 都可以传入基准版本的索引：没变的页面直接沿用基准里的条目与搜索行，提交的开销只跟改动量有关。
 */

import type { DocNode, DocState } from "@sqraft/core";
import { makePart, parsePart, splitDoc, type CommitManifest, type DocPart } from "@sqraft-cloud/shared";
import type { BlobStore } from "./storage";
import type { AssetRef } from "./sqraft-file";
import { sniffImage } from "./image";

/** 2：条目带 contentHash / changedIn / uses，页面 blob 以规范 JSON 的哈希命名 */
export const INDEX_SCHEMA = 2;

interface EntryHistory {
  /** 不计根节点名称与位置的内容哈希（见 shared/makePart） */
  contentHash?: string;
  /** 内容最后一次变化的版本号；null = 就是这个版本；缺省 = 未知（旧索引） */
  changedIn?: number | null;
  /** 这一页里各主组件的实例数，汇总成组件的 instanceCount */
  uses?: Record<string, number>;
}

export interface PageEntry extends EntryHistory {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  nodeCount: number;
  blob: string;
}

export interface ComponentEntry extends EntryHistory {
  id: string;
  name: string;
  width: number;
  height: number;
  nodeCount: number;
  instanceCount: number;
  propertyDefs?: unknown;
  blob: string;
}

export interface AssetEntry {
  name: string;
  blob: string;
  size: number;
  mime: string;
  width: number | null;
  height: number | null;
}

export interface VersionIndex {
  schema: number;
  tokens: DocState["tokens"];
  pages: PageEntry[];
  components: ComponentEntry[];
  /** assetId（文件名去扩展名）→ 资源 */
  assets: Record<string, AssetEntry>;
  searchBlob: string;
}

/** 一页（或一个组件）的节点：只含该子树，`rootIds` 只有它自己。 */
export interface SubtreeDoc {
  rootIds: string[];
  nodes: Record<string, DocNode>;
}

/** 搜索索引的一行：[id, type, name, 文字（截断）, 所在页面或组件 id] */
export type SearchRow = [string, string, string, string, string];

/** 基准版本：用来沿用没变的页面 */
export interface IndexBase {
  idx: VersionIndex;
  /** 基准里某个页面 / 组件的搜索行（实现方应按页分组缓存，别每次扫全表） */
  rowsFor(rootId: string): Promise<SearchRow[]>;
}

export interface BuiltIndex {
  index: VersionIndex;
  nodeCount: number;
  pageCount: number;
  /** 所有页面 / 组件规范 JSON 的总字节数 */
  partBytes: number;
}

type Described = { kind: "page"; entry: PageEntry; rows: SearchRow[] } | { kind: "component"; entry: ComponentEntry; rows: SearchRow[] };

function describe(part: DocPart): Described {
  const root = part.nodes[part.rootId];
  const rows: SearchRow[] = [];
  const uses: Record<string, number> = {};
  for (const n of Object.values(part.nodes)) {
    rows.push([n.id, n.type, n.name ?? "", typeof n.text === "string" ? n.text.slice(0, 200) : "", part.rootId]);
    if (n.type === "instance" && n.componentId) uses[n.componentId] = (uses[n.componentId] ?? 0) + 1;
  }
  const history = { contentHash: part.contentHash, ...(Object.keys(uses).length ? { uses } : {}) };
  if (part.kind === "page") {
    return {
      kind: "page",
      rows,
      entry: { id: part.rootId, name: root.name, x: root.x, y: root.y, width: root.width, height: root.height, nodeCount: part.nodeCount, blob: part.hash, ...history },
    };
  }
  return {
    kind: "component",
    rows,
    entry: {
      id: part.rootId,
      name: root.name,
      width: root.width,
      height: root.height,
      nodeCount: part.nodeCount,
      instanceCount: 0,
      ...(root.propertyDefs?.length ? { propertyDefs: root.propertyDefs } : {}),
      blob: part.hash,
      ...history,
    },
  };
}

/** 基准里同一个 blob 的条目（新格式索引才能沿用：旧索引的 blob 名字规则不同）。 */
async function reuse(base: IndexBase | undefined, rootId: string, hash: string): Promise<Described | null> {
  if (!base || base.idx.schema < 2) return null;
  const page = base.idx.pages.find((p) => p.id === rootId && p.blob === hash && p.contentHash);
  const comp = page ? undefined : base.idx.components.find((c) => c.id === rootId && c.blob === hash && c.contentHash);
  if (!page && !comp) return null;
  const rows = await base.rowsFor(rootId);
  const { changedIn: _c, ...entry } = (page ?? comp)!;
  return page ? { kind: "page", entry: entry as PageEntry, rows } : { kind: "component", entry: { ...(entry as ComponentEntry), instanceCount: 0 }, rows };
}

async function assets(refs: AssetRef[], store: BlobStore, base?: IndexBase): Promise<Record<string, AssetEntry>> {
  const known = new Map(Object.values(base?.idx.assets ?? {}).map((a) => [`${a.name}\n${a.blob}`, a]));
  const out: Record<string, AssetEntry> = {};
  for (const a of refs) {
    const file = a.name.slice("assets/".length);
    const hit = known.get(`${file}\n${a.blob}`);
    if (hit) {
      out[file.replace(/\.[^.]+$/, "")] = hit;
      continue;
    }
    const ext = file.split(".").pop() ?? "bin";
    const info = sniffImage(await store.head(a.blob), ext);
    out[file.replace(/\.[^.]+$/, "")] = { name: file, blob: a.blob, size: a.size, ...info };
  }
  return out;
}

async function assemble(described: Described[], tokens: DocState["tokens"], refs: AssetRef[], store: BlobStore, base?: IndexBase): Promise<VersionIndex> {
  const pages: PageEntry[] = [];
  const components: ComponentEntry[] = [];
  const search: SearchRow[] = [];
  const instanceCounts = new Map<string, number>();
  for (const d of described) {
    for (const r of d.rows) search.push(r);
    for (const [id, n] of Object.entries(d.entry.uses ?? {})) instanceCounts.set(id, (instanceCounts.get(id) ?? 0) + n);
    if (d.kind === "page") pages.push(d.entry);
    else components.push(d.entry);
  }
  for (const c of components) c.instanceCount = instanceCounts.get(c.id) ?? 0;
  return {
    schema: INDEX_SCHEMA,
    tokens: tokens ?? {},
    pages,
    components,
    assets: await assets(refs, store, base),
    searchBlob: await store.putJson(search),
  };
}

/** 整份文档建索引（网页上传 / 旧版客户端上传的 .sqraft）。 */
export async function buildIndex(doc: DocState, refs: AssetRef[], store: BlobStore, base?: IndexBase): Promise<BuiltIndex> {
  const described: Described[] = [];
  let partBytes = 0;
  for (const part of splitDoc(doc)) {
    partBytes += Buffer.byteLength(part.json);
    const reused = await reuse(base, part.rootId, part.hash);
    if (reused) {
      described.push(reused);
      continue;
    }
    await store.putJsonText(part.json, part.hash);
    described.push(describe(part));
  }
  return {
    index: await assemble(described, doc.tokens, refs, store, base),
    nodeCount: Object.keys(doc.nodes).length,
    pageCount: described.filter((d) => d.kind === "page").length,
    partBytes,
  };
}

/** 增量提交：部件与切图已按哈希上传，这里逐个校验并建索引。部件出错时抛出带说明的 Error。 */
export async function buildIndexFromManifest(m: CommitManifest, store: BlobStore, base?: IndexBase, maxNodes = Infinity): Promise<BuiltIndex> {
  const described: Described[] = [];
  let nodeCount = 0;
  let partBytes = 0;
  for (const { rootId, hash } of m.parts) {
    const reused = await reuse(base, rootId, hash);
    if (reused) {
      described.push(reused);
      nodeCount += reused.entry.nodeCount;
      partBytes += (await store.size(hash)) ?? 0;
    } else {
      const text = await store.getText(hash);
      let part: DocPart;
      try {
        part = parsePart(text, rootId, hash);
      } catch (error) {
        throw new Error(`页面 / 组件 ${rootId}：${(error as Error).message}`);
      }
      described.push(describe(part));
      nodeCount += part.nodeCount;
      partBytes += Buffer.byteLength(text);
    }
    if (nodeCount > maxNodes) throw new Error(`节点数超过上限 ${maxNodes}`);
  }
  const refs: AssetRef[] = m.assets.map((a) => ({ name: a.name, blob: a.hash, size: a.size }));
  return {
    index: await assemble(described, m.tokens, refs, store, base),
    nodeCount,
    pageCount: described.filter((d) => d.kind === "page").length,
    partBytes,
  };
}

/** 旧索引（schema 1）补算内容哈希：比较版本差异时用，不写回。 */
export async function withContentHashes(idx: VersionIndex, store: BlobStore): Promise<VersionIndex> {
  if (idx.schema >= 2) return idx;
  const hashOf = async (id: string, blob: string) => {
    const sub = await store.getJson<SubtreeDoc>(blob);
    return makePart(id, sub.nodes).contentHash;
  };
  // 逐页加载：大稿一次性全读进内存会撑爆
  const pages: PageEntry[] = [];
  for (const p of idx.pages) pages.push({ ...p, contentHash: await hashOf(p.id, p.blob) });
  const components: ComponentEntry[] = [];
  for (const c of idx.components) components.push({ ...c, contentHash: await hashOf(c.id, c.blob) });
  return { ...idx, pages, components };
}
