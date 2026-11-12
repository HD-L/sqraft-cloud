/**
 * 设计稿拆分规则：服务端建索引与上传客户端做增量上传共用同一份代码，保证两边算出的哈希一致。
 *
 * - 一个「部件」= 一个页面或一个主组件的完整子树，序列化为 `{"nodes":{…},"rootIds":[id]}`；
 * - 序列化是规范的：对象键按字典序排列、无多余空白。同样的内容不论原文件里键的顺序如何，字节都相同；
 * - `hash` = 规范 JSON（未压缩）的 SHA-256，也是它在文件仓库里的名字；
 * - `contentHash` 不计页面根节点的名称与画布位置：只改名、只挪位置不算「改了内容」。
 */

import { createHash } from "node:crypto";
import type { DocNode, DocState } from "@sqraft/core";

export type PartKind = "page" | "component";

export interface DocPart {
  rootId: string;
  kind: PartKind;
  name: string;
  /** 规范 JSON 文本 */
  json: string;
  hash: string;
  contentHash: string;
  nodeCount: number;
  nodes: Record<string, DocNode>;
}

/** 页面分组（如 Sketch 页面）：sketch2sqraft 写在 manifest.json 的 `sections` 里，看稿时按组浏览。 */
export interface PageSection {
  name: string;
  pageIds: string[];
}

/**
 * 校验并整理分组：只留真实存在的页面、每页只归一组、去掉空组；不合法的输入整体忽略（返回 undefined）。
 * 没被任何组收录的页面放进末尾的「未分组」。
 */
export function normalizeSections(raw: unknown, pageIds: readonly string[]): PageSection[] | undefined {
  if (!Array.isArray(raw) || !raw.length || raw.length > 10_000) return undefined;
  const exists = new Set(pageIds);
  const taken = new Set<string>();
  const out: PageSection[] = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") return undefined;
    const { name, pageIds: ids } = s as { name?: unknown; pageIds?: unknown };
    if (typeof name !== "string" || !Array.isArray(ids)) return undefined;
    const kept: string[] = [];
    for (const id of ids) {
      if (typeof id !== "string" || !exists.has(id) || taken.has(id)) continue;
      taken.add(id);
      kept.push(id);
    }
    if (kept.length) out.push({ name: name.trim().slice(0, 200) || "未命名", pageIds: kept });
  }
  if (!out.length) return undefined;
  const rest = pageIds.filter((id) => !taken.has(id));
  if (rest.length) out.push({ name: "未分组", pageIds: rest });
  return uniqueNames(out);
}

/** 组名去重：重名的依次加「(2)」「(3)」……组名在看稿、MCP 筛选里当标识用，必须唯一。 */
export function uniqueNames<T extends { name: string }>(sections: T[]): T[] {
  const used = new Set<string>();
  return sections.map((s) => {
    let name = s.name;
    for (let n = 2; used.has(name); n++) name = `${s.name} (${n})`;
    used.add(name);
    return name === s.name ? s : { ...s, name };
  });
}

/** 增量提交的清单（客户端 → 服务端）。部件与切图的字节事先按哈希上传。 */
export interface CommitManifest {
  formatVersion: number;
  tokens: DocState["tokens"];
  /** 按原文件 rootIds 的顺序 */
  parts: Array<{ rootId: string; hash: string }>;
  /** `name` 是 zip 内路径（`assets/<id>.<ext>`），`hash` 是文件字节的 SHA-256 */
  assets: Array<{ name: string; hash: string; size: number }>;
  /** 页面分组（manifest.json 里有就带上） */
  sections?: PageSection[];
}

export const HASH_RE = /^[0-9a-f]{64}$/;
export const ASSET_NAME_RE = /^assets\/[A-Za-z0-9_-]{1,128}\.(png|jpe?g|gif|webp|svg|bin)$/;

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** 规范 JSON：键排序；`undefined`、函数按 JSON.stringify 的规则省略（数组里变成 null）。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const s = JSON.stringify(value);
    return s === undefined ? "null" : s;
  }
  if (Array.isArray(value)) {
    let out = "[";
    for (let i = 0; i < value.length; i++) {
      if (i) out += ",";
      const v = value[i];
      out += v === undefined || typeof v === "function" ? "null" : canonicalJson(v);
    }
    return `${out}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  let out = "{";
  let first = true;
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined || typeof v === "function") continue;
    if (!first) out += ",";
    first = false;
    out += `${JSON.stringify(k)}:${canonicalJson(v)}`;
  }
  return `${out}}`;
}

/** 从根节点收集整棵子树（防环、防重复）。 */
export function collectSubtree(nodes: Record<string, DocNode>, rootId: string): Record<string, DocNode> {
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

/** 把一棵子树做成部件。`nodes` 里只应有这棵子树（多余的节点也会被序列化）。 */
export function makePart(rootId: string, nodes: Record<string, DocNode>): DocPart {
  const root = nodes[rootId];
  if (!root) throw new Error(`部件缺少根节点 ${rootId}`);
  const ids = Object.keys(nodes).sort();
  const pieces: string[] = [];
  let rootPiece = -1;
  for (const id of ids) {
    if (id === rootId) rootPiece = pieces.length;
    pieces.push(`${JSON.stringify(id)}:${canonicalJson(nodes[id])}`);
  }
  const head = '{"nodes":{';
  const tail = `},"rootIds":[${JSON.stringify(rootId)}]}`;
  const json = head + pieces.join(",") + tail;

  // 内容哈希：根节点的名称、位置置空后的同一份序列化
  const content = createHash("sha256");
  content.update(head);
  const neutral = `${JSON.stringify(rootId)}:${canonicalJson({ ...root, name: "", x: 0, y: 0 })}`;
  for (let i = 0; i < pieces.length; i++) {
    if (i) content.update(",");
    content.update(i === rootPiece ? neutral : pieces[i]);
  }
  content.update(tail);

  return {
    rootId,
    kind: root.type === "component" ? "component" : "page",
    name: root.name ?? "",
    json,
    hash: sha256(json),
    contentHash: content.digest("hex"),
    nodeCount: ids.length,
    nodes,
  };
}

/** 整份文档拆成部件：只取顶层的页面与主组件（与网页、MCP 能读到的范围一致）。 */
export function splitDoc(doc: Pick<DocState, "rootIds" | "nodes">): DocPart[] {
  const nodes = doc.nodes as Record<string, DocNode>;
  const parts: DocPart[] = [];
  for (const id of doc.rootIds) {
    const root = nodes[id];
    if (!root || (root.type !== "page" && root.type !== "component")) continue;
    parts.push(makePart(id, collectSubtree(nodes, id)));
  }
  return parts;
}

/** 解析一个部件的 JSON 并校验结构；`expectedHash` 给了就要求它确实是规范序列化。 */
export function parsePart(json: string, expectedRootId?: string, expectedHash?: string): DocPart {
  let parsed: { rootIds?: unknown; nodes?: unknown };
  try {
    parsed = JSON.parse(json) as typeof parsed;
  } catch {
    throw new Error("部件不是有效的 JSON");
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.rootIds) || parsed.rootIds.length !== 1) {
    throw new Error("部件结构不对：rootIds 需要恰好一个");
  }
  const rootId = parsed.rootIds[0];
  if (typeof rootId !== "string" || (expectedRootId !== undefined && rootId !== expectedRootId)) throw new Error("部件的根节点与清单不一致");
  if (!parsed.nodes || typeof parsed.nodes !== "object" || Array.isArray(parsed.nodes)) throw new Error("部件结构不对：缺少 nodes");
  const nodes = parsed.nodes as Record<string, DocNode>;
  const root = nodes[rootId];
  if (!root || (root.type !== "page" && root.type !== "component")) throw new Error("部件的根节点必须是页面或主组件");
  const part = makePart(rootId, nodes);
  if (expectedHash !== undefined && part.hash !== expectedHash) throw new Error("部件不是规范序列化（哈希对不上）");
  return part;
}

/** 整版内容指纹：内容完全一致的两次上传判为重复，不生成新版本。 */
export function versionFingerprint(m: {
  formatVersion: number;
  tokens: unknown;
  parts: Array<{ rootId: string; hash: string }>;
  assets: Array<{ name: string; hash: string }>;
  sections?: PageSection[];
}): string {
  return sha256(
    canonicalJson({
      formatVersion: m.formatVersion,
      tokens: m.tokens ?? {},
      parts: m.parts.map((p) => [p.rootId, p.hash]),
      assets: m.assets.map((a) => [a.name, a.hash]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
      // 没有分组时不出现这个键：保持与加分组之前算出的指纹一致
      ...(m.sections?.length ? { sections: m.sections.map((s) => [s.name, s.pageIds]) } : {}),
    }),
  );
}
