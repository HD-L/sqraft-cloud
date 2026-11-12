/**
 * 页面数据缓存：总览画布与单页查看共用。
 * 单页节点走 /parts/:pageId（服务端直接发 gzip、长缓存），Token 每个版本取一次，拼成只含这一页的 DocState。
 */
import type { DocState } from "@sqraft/core";
import { api } from "../api";

const MAX_DOCS = 60;
const docs = new Map<string, Promise<DocState>>();
const tokens = new Map<string, Promise<DocState["tokens"]>>();

function getTokens(designId: string, version: number): Promise<DocState["tokens"]> {
  const key = `${designId}@${version}`;
  let p = tokens.get(key);
  if (!p) {
    p = api<{ tokens: DocState["tokens"] }>("GET", `/designs/${designId}/versions/${version}/tokens`).then((r) => r.tokens);
    p.catch(() => tokens.delete(key));
    tokens.set(key, p);
  }
  return p;
}

async function fetchPart(designId: string, version: number, pageId: string): Promise<{ rootIds: string[]; nodes: DocState["nodes"] }> {
  const res = await fetch(`/api/v1/designs/${designId}/versions/${version}/parts/${encodeURIComponent(pageId)}`, { credentials: "same-origin" });
  if (!res.ok) throw new Error(res.status === 404 ? "页面不存在" : `加载页面失败（${res.status}）`);
  return res.json();
}

/** 只含一个页面（及其子树）的文档。同一页并发请求只发一次；最近用过的 MAX_DOCS 页留在内存里。 */
export function getPageDoc(designId: string, version: number, pageId: string): Promise<DocState> {
  const key = `${designId}@${version}/${pageId}`;
  const hit = docs.get(key);
  if (hit) {
    docs.delete(key);
    docs.set(key, hit);
    return hit;
  }
  const p = Promise.all([fetchPart(designId, version, pageId), getTokens(designId, version)]).then(
    ([part, t]) => ({ version: 1, rootIds: part.rootIds, nodes: part.nodes, tokens: t }) as unknown as DocState,
  );
  p.catch(() => docs.delete(key));
  docs.set(key, p);
  while (docs.size > MAX_DOCS) docs.delete(docs.keys().next().value as string);
  return p;
}
