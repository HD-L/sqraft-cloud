/**
 * 按页索引（D7）：上传时把 doc.json 拆成「每个页面 / 每个主组件一份」的 gzip JSON，
 * 另建名称 / 文字搜索索引。读取时只加载需要的那一页，不再解析整份大稿。
 *
 * 页面子树是自足的：实例已物化，子节点都在页面子树里，渲染与读取都不需要母版。
 */

import type { DocNode, DocState } from "@sqraft/core";
import type { BlobStore } from "./storage";
import type { AssetRef } from "./sqraft-file";
import { sniffImage } from "./image";

export const INDEX_SCHEMA = 1;

export interface PageEntry {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  nodeCount: number;
  blob: string;
}

export interface ComponentEntry {
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

function collect(nodes: Record<string, DocNode>, rootId: string): Record<string, DocNode> {
  const out: Record<string, DocNode> = {};
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    const n = nodes[id];
    if (!n || out[id]) continue;
    out[id] = n;
    for (const c of n.children ?? []) stack.push(c);
  }
  return out;
}

export async function buildIndex(doc: DocState, assets: AssetRef[], store: BlobStore): Promise<VersionIndex> {
  const nodes = doc.nodes as Record<string, DocNode>;
  const instanceCounts = new Map<string, number>();
  for (const n of Object.values(nodes)) {
    if (n.type === "instance" && n.componentId) instanceCounts.set(n.componentId, (instanceCounts.get(n.componentId) ?? 0) + 1);
  }

  const pages: PageEntry[] = [];
  const components: ComponentEntry[] = [];
  const search: SearchRow[] = [];
  for (const id of doc.rootIds) {
    const root = nodes[id];
    if (!root || (root.type !== "page" && root.type !== "component")) continue;
    const sub = collect(nodes, id);
    const blob = await store.putJson({ rootIds: [id], nodes: sub } satisfies SubtreeDoc);
    for (const n of Object.values(sub)) {
      search.push([n.id, n.type, n.name ?? "", typeof n.text === "string" ? n.text.slice(0, 200) : "", id]);
    }
    const count = Object.keys(sub).length;
    if (root.type === "page") {
      pages.push({ id, name: root.name, x: root.x, y: root.y, width: root.width, height: root.height, nodeCount: count, blob });
    } else {
      components.push({
        id,
        name: root.name,
        width: root.width,
        height: root.height,
        nodeCount: count,
        instanceCount: instanceCounts.get(id) ?? 0,
        ...(root.propertyDefs?.length ? { propertyDefs: root.propertyDefs } : {}),
        blob,
      });
    }
  }

  const assetMap: Record<string, AssetEntry> = {};
  for (const a of assets) {
    const file = a.name.slice("assets/".length);
    const ext = file.split(".").pop() ?? "bin";
    const info = sniffImage(await store.head(a.blob), ext);
    assetMap[file.replace(/\.[^.]+$/, "")] = { name: file, blob: a.blob, size: a.size, ...info };
  }

  return {
    schema: INDEX_SCHEMA,
    tokens: doc.tokens ?? {},
    pages,
    components,
    assets: assetMap,
    searchBlob: await store.putJson(search),
  };
}
