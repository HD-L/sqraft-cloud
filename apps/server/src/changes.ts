/**
 * 版本之间的页面级差异：新增 / 修改 / 删除 / 改名 / 挪位置，组件同理，另有 Token 与切图的增减。
 *
 * 判断依据是索引条目的 contentHash（不计页面根节点的名称与画布位置），所以只改名、只在画布上挪动
 * 不算「改了内容」，单独列为 renamed / moved。
 */

import type { ComponentEntry, PageEntry, VersionIndex } from "./indexer";

export interface ChangeRef {
  id: string;
  name: string;
}

export interface ChangeSet {
  added: ChangeRef[];
  /** 内容变了；同时改了名的带 from（旧名） */
  modified: Array<ChangeRef & { from?: string }>;
  removed: ChangeRef[];
  /** 内容没变、只改了名 */
  renamed: Array<ChangeRef & { from: string }>;
  /** 内容没变、只在画布上挪了位置（只对页面） */
  moved: ChangeRef[];
}

export interface VersionChanges {
  /** 和哪个版本比；null = 第一个版本 */
  base: number | null;
  pages: ChangeSet;
  components: ChangeSet;
  tokens: { added: string[]; modified: string[]; removed: string[] };
  assets: { added: number; removed: number };
}

export interface ChangeSummary {
  base: number | null;
  pages: Record<keyof ChangeSet, number>;
  components: Record<keyof ChangeSet, number>;
  tokens: number;
  assets: { added: number; removed: number };
}

type Entry = (PageEntry | ComponentEntry) & { x?: number; y?: number };

function diffEntries(from: Entry[], to: Entry[]): ChangeSet {
  const set: ChangeSet = { added: [], modified: [], removed: [], renamed: [], moved: [] };
  const before = new Map(from.map((e) => [e.id, e]));
  const after = new Set(to.map((e) => e.id));
  for (const e of to) {
    const old = before.get(e.id);
    const ref = { id: e.id, name: e.name };
    if (!old) {
      set.added.push(ref);
      continue;
    }
    const same = old.contentHash !== undefined && old.contentHash === e.contentHash;
    if (!same) {
      set.modified.push(old.name !== e.name ? { ...ref, from: old.name } : ref);
      continue;
    }
    if (old.name !== e.name) set.renamed.push({ ...ref, from: old.name });
    if (e.x !== undefined && (old.x !== e.x || old.y !== e.y)) set.moved.push(ref);
  }
  for (const e of from) if (!after.has(e.id)) set.removed.push({ id: e.id, name: e.name });
  return set;
}

/** 两个索引之间的差异。`from` 为 null 时一切都算新增。两边都需要有 contentHash（旧索引先补算）。 */
export function diffIndexes(from: VersionIndex | null, to: VersionIndex, base: number | null): VersionChanges {
  const tokensBefore = from?.tokens ?? {};
  const tokensAfter = to.tokens ?? {};
  const tokens = { added: [] as string[], modified: [] as string[], removed: [] as string[] };
  for (const [k, v] of Object.entries(tokensAfter)) {
    if (!(k in tokensBefore)) tokens.added.push(k);
    else if (JSON.stringify(tokensBefore[k]) !== JSON.stringify(v)) tokens.modified.push(k);
  }
  for (const k of Object.keys(tokensBefore)) if (!(k in tokensAfter)) tokens.removed.push(k);

  const blobsBefore = new Set(Object.values(from?.assets ?? {}).map((a) => a.blob));
  const blobsAfter = new Set(Object.values(to.assets).map((a) => a.blob));
  let added = 0;
  let removed = 0;
  for (const b of blobsAfter) if (!blobsBefore.has(b)) added++;
  for (const b of blobsBefore) if (!blobsAfter.has(b)) removed++;

  return {
    base,
    pages: diffEntries(from?.pages ?? [], to.pages),
    components: diffEntries(from?.components ?? [], to.components),
    tokens,
    assets: { added, removed },
  };
}

/**
 * 给新索引的每个条目标上「内容最后变化的版本」：内容和基准相同就沿用基准的记录，否则记为本版本（null）。
 * 基准是旧索引（没有记录）时按基准版本号算：宁可多报，不漏报。
 */
export function stampChangedIn(to: VersionIndex, base: { idx: VersionIndex; number: number } | null): VersionIndex {
  const stamp = <T extends Entry>(entries: T[], before: Entry[]): T[] => {
    const old = new Map(before.map((e) => [e.id, e]));
    return entries.map((e) => {
      const o = old.get(e.id);
      if (!base || !o || o.contentHash === undefined || o.contentHash !== e.contentHash) return { ...e, changedIn: null };
      return { ...e, changedIn: o.changedIn === null || o.changedIn === undefined ? base.number : o.changedIn };
    });
  };
  return {
    ...to,
    pages: stamp(to.pages, base?.idx.pages ?? []),
    components: stamp(to.components, base?.idx.components ?? []),
  };
}

export function summarize(c: VersionChanges): ChangeSummary {
  const count = (s: ChangeSet) => ({ added: s.added.length, modified: s.modified.length, removed: s.removed.length, renamed: s.renamed.length, moved: s.moved.length });
  return {
    base: c.base,
    pages: count(c.pages),
    components: count(c.components),
    tokens: c.tokens.added.length + c.tokens.modified.length + c.tokens.removed.length,
    assets: c.assets,
  };
}

/** 索引条目里的 changedIn 换成具体版本号（null = 条目所在的版本）。 */
export function resolveChangedIn(e: { changedIn?: number | null }, version: number): number | undefined {
  return e.changedIn === null ? version : e.changedIn;
}
