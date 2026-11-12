/**
 * 看稿用的页面分组：版本索引里存了分组（来自 sketch2sqraft 写的 manifest.json）就直接用；
 * 没有时按画布推断——sketch2sqraft 把每个 Sketch 页面的画板排成一个横带，横带之间留出较大的竖向空隙。
 *
 * 组内页面按画布阅读顺序（先行后列）排列，和总览画布上看到的一致。
 */

import { uniqueNames, type PageSection } from "@sqraft-cloud/shared";
import type { PageEntry, VersionIndex } from "./indexer";

export interface ResolvedSection extends PageSection {
  /** true = 没有存分组，按画布推断出来的 */
  inferred: boolean;
}

/** 横带之间至少这么大的竖向空隙才算分组边界（sketch2sqraft 的页面间距是 640） */
const BAND_GAP = 400;
/** 顶边相差在这个范围内的画板视为同一行 */
const ROW_TOLERANCE = 40;

/** 画布阅读顺序：先按行（顶边接近的算一行），行内从左到右。 */
export function readingOrder(pages: PageEntry[]): PageEntry[] {
  const byY = [...pages].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: PageEntry[][] = [];
  for (const p of byY) {
    const row = rows[rows.length - 1];
    if (row && p.y - row[0].y <= ROW_TOLERANCE) row.push(p);
    else rows.push([p]);
  }
  return rows.flatMap((r) => r.sort((a, b) => a.x - b.x));
}

/** 「V5.9.0 / 散图层 1」这类散图层页面带着 Sketch 页面名，推断分组时拿来当组名 */
const LOOSE_NAME = /^(.+?) \/ 散图层/;

export function sectionsOf(idx: VersionIndex): ResolvedSection[] {
  const byId = new Map(idx.pages.map((p) => [p.id, p]));
  if (idx.sections?.length) {
    // 存下来的分组整理时已去重；早期索引可能没有，这里再保证一次
    return uniqueNames(idx.sections).map((s) => ({
      name: s.name,
      pageIds: readingOrder(s.pageIds.map((id) => byId.get(id)).filter((p): p is PageEntry => !!p)).map((p) => p.id),
      inferred: false,
    }));
  }
  // 推断：按顶边排序，累计当前横带的底边；下一张画板离底边超过 BAND_GAP 就另起一组
  const sorted = [...idx.pages].sort((a, b) => a.y - b.y || a.x - b.x);
  const bands: PageEntry[][] = [];
  let bottom = -Infinity;
  for (const p of sorted) {
    if (!bands.length || p.y > bottom + BAND_GAP) {
      bands.push([p]);
      bottom = p.y + p.height;
    } else {
      bands[bands.length - 1].push(p);
      bottom = Math.max(bottom, p.y + p.height);
    }
  }
  return uniqueNames(
    bands.map((band, i) => {
      const hint = band.map((p) => LOOSE_NAME.exec(p.name)?.[1]).find(Boolean);
      return { name: hint ?? `分组 ${i + 1}`, pageIds: readingOrder(band).map((p) => p.id), inferred: true };
    }),
  );
}

/** 页面 id → 所在分组名 */
export function sectionNameMap(sections: ResolvedSection[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of sections) for (const id of s.pageIds) map.set(id, s.name);
  return map;
}
