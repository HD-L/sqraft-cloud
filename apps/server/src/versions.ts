/**
 * 生成新版本：整包上传与增量提交共用。
 *
 * - 内容和当前版本完全一致（内容指纹或文件哈希相同）就不生成新版本；
 * - 以当前版本为基准，给索引条目标上 changedIn、算出页面级变更，一起写进版本记录；
 * - 计算期间有人抢先发布了新版本时，以新的当前版本为基准重算（最多几次）；
 * - 评审中的设计稿有了新版本：本轮评审跟到新版本（状态不变），通知评审人。
 */

import type { AppContext } from "./app";
import { diffIndexes, stampChangedIn, type VersionChanges } from "./changes";
import { conflict } from "./errors";
import type { VersionIndex } from "./indexer";
import type { DesignReader } from "./reader";
import type { AssetRef } from "./sqraft-file";
import type { DesignRow, VersionRow } from "./routes/projects";
import { followNewVersion } from "./reviews";

export interface VersionPayload {
  note: string;
  /** 整包上传：文件哈希；增量提交：内容指纹 */
  fileSha256: string;
  size: number;
  formatVersion: number;
  /** 整包上传的 doc.json；增量提交没有整份文档，记为索引本身 */
  docBlob: string | null;
  manifestBlob: string | null;
  assets: AssetRef[];
  nodeCount: number;
  pageCount: number;
  index: VersionIndex;
  contentHash: string;
}

export interface CommitOutcome {
  design: DesignRow;
  version: VersionRow;
  duplicate: boolean;
  changes: VersionChanges | null;
}

export async function commitVersion(ctx: AppContext, reader: DesignReader, uploaderId: string, designId: string, payload: VersionPayload): Promise<CommitOutcome> {
  const { db, store } = ctx;
  for (let attempt = 0; attempt < 5; attempt++) {
    const d = db.prepare("SELECT * FROM designs WHERE id = ?").get(designId) as DesignRow;
    const current = d.current_version
      ? (db.prepare("SELECT * FROM versions WHERE design_id = ? AND number = ?").get(d.id, d.current_version) as VersionRow)
      : undefined;
    if (current && (current.content_hash === payload.contentHash || current.file_sha256 === payload.fileSha256)) {
      return { design: d, version: current, duplicate: true, changes: null };
    }
    const baseIdx = current ? await reader.diffIndex(current) : null;
    const stamped = stampChangedIn(payload.index, current && baseIdx ? { idx: baseIdx, number: current.number } : null);
    const changes = diffIndexes(baseIdx, stamped, current?.number ?? null);
    const indexBlob = await store.putJson(stamped);

    const outcome = db.transaction((): CommitOutcome | null => {
      const now = db.prepare("SELECT current_version FROM designs WHERE id = ?").get(d.id) as { current_version: number | null };
      if (now.current_version !== d.current_version) return null;
      const next = ((db.prepare("SELECT MAX(number) AS n FROM versions WHERE design_id = ?").get(d.id) as { n: number | null }).n ?? 0) + 1;
      const at = Date.now();
      const version: VersionRow = {
        design_id: d.id,
        number: next,
        note: payload.note,
        uploader_id: uploaderId,
        file_sha256: payload.fileSha256,
        size: payload.size,
        format_version: payload.formatVersion,
        doc_blob: payload.docBlob ?? indexBlob,
        manifest_blob: payload.manifestBlob,
        assets: JSON.stringify(payload.assets),
        node_count: payload.nodeCount,
        page_count: payload.pageCount,
        index_blob: indexBlob,
        status: "ready",
        created_at: at,
        content_hash: payload.contentHash,
        changes: JSON.stringify(changes),
      };
      db.prepare(
        `INSERT INTO versions (design_id, number, note, uploader_id, file_sha256, size, format_version, doc_blob, manifest_blob,
                               assets, node_count, page_count, index_blob, status, created_at, content_hash, changes)
         VALUES (@design_id, @number, @note, @uploader_id, @file_sha256, @size, @format_version, @doc_blob, @manifest_blob,
                 @assets, @node_count, @page_count, @index_blob, @status, @created_at, @content_hash, @changes)`,
      ).run(version);
      db.prepare("UPDATE designs SET current_version = ?, updated_at = ? WHERE id = ?").run(next, at, d.id);
      return { design: { ...d, current_version: next, updated_at: at }, version, duplicate: false, changes };
    })();
    if (outcome) {
      // 评审中的设计稿：本轮评审跟到新版本并通知评审人（重复上传在上面就返回了，不会走到这里）
      followNewVersion(db, designId, uploaderId);
      return outcome;
    }
  }
  throw conflict("同时有其他人在发布这个设计稿的新版本，请稍后重试", "busy");
}
