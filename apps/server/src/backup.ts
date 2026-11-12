/**
 * 备份与恢复（NFR「一条命令备份 / 恢复」）。
 *
 * 备份：SQLite 在线快照（服务运行中也能备，WAL 下结果一致）+ 文件仓库里的全部 blob，打成一个 .tar.gz。
 * blob 按内容寻址、写入后不再修改，备份期间新写入的 blob 不会被快照里的数据库引用，不影响一致性。
 *
 * 恢复：解包到空的数据目录（非空时需要 --force，并先把原目录改名保留），下次启动自动执行迁移。
 */

import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import * as tar from "tar";
import { SCHEMA_VERSION } from "./db";
import { APP_VERSION } from "./routes/system";

export const DB_FILE = "sqraft-cloud.db";
export const BACKUP_MANIFEST = "sqraft-backup.json";

export interface BackupManifest {
  app: "sqraft-cloud";
  version: string;
  schemaVersion: number;
  createdAt: string;
  blobs: number;
}

export async function createBackup(dataDir: string, outFile: string): Promise<BackupManifest & { file: string }> {
  const dbPath = join(dataDir, DB_FILE);
  if (!existsSync(dbPath)) throw new Error(`数据目录里没有数据库：${dbPath}`);
  const stage = join(dataDir, "tmp", `backup-${Date.now()}`);
  await mkdir(stage, { recursive: true });
  try {
    // 在线快照：不阻塞正在运行的服务
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      await db.backup(join(stage, DB_FILE));
    } finally {
      db.close();
    }
    const blobFiles: string[] = [];
    const blobsDir = join(dataDir, "blobs");
    for (const prefix of await readdir(blobsDir).catch(() => [] as string[])) {
      for (const name of await readdir(join(blobsDir, prefix)).catch(() => [] as string[])) blobFiles.push(join("blobs", prefix, name));
    }
    const manifest: BackupManifest = {
      app: "sqraft-cloud",
      version: APP_VERSION,
      schemaVersion: SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      blobs: blobFiles.length,
    };
    await writeFile(join(stage, BACKUP_MANIFEST), JSON.stringify(manifest, null, 2));
    await mkdir(dirname(outFile), { recursive: true });
    // 一次打包：快照与清单在临时目录（包内路径带 tmp/backup-* 前缀，恢复时识别），blob 直接从数据目录读
    const staged = relative(dataDir, stage);
    await tar.create({ gzip: { level: 1 }, file: `${outFile}.tmp`, cwd: dataDir, portable: true }, [
      join(staged, BACKUP_MANIFEST),
      join(staged, DB_FILE),
      ...blobFiles,
    ]);
    await rename(`${outFile}.tmp`, outFile);
    return { ...manifest, file: outFile };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function restoreBackup(archive: string, dataDir: string, force = false): Promise<BackupManifest> {
  if (!existsSync(archive)) throw new Error(`找不到备份文件：${archive}`);
  if (existsSync(join(dataDir, DB_FILE))) {
    if (!force) throw new Error(`数据目录 ${dataDir} 已有数据。确认要覆盖请加 --force（原目录会改名保留）`);
    const kept = `${dataDir.replace(/\/+$/, "")}.before-restore-${Date.now()}`;
    await rename(dataDir, kept);
    console.log(`原数据目录已改名保留：${kept}`);
  }
  await mkdir(dataDir, { recursive: true });
  const stage = join(dataDir, ".restore");
  await mkdir(stage, { recursive: true });
  await tar.extract({
    file: archive,
    cwd: stage,
    // 只接受备份里该有的路径，防止恶意备份包写到别处
    filter: (path) => /^(tmp\/backup-\d+\/)?(sqraft-backup\.json|sqraft-cloud\.db)$|^blobs\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(path),
  });
  const stagedRoot = existsSync(join(stage, BACKUP_MANIFEST))
    ? stage
    : join(stage, "tmp", (await readdir(join(stage, "tmp")))[0] ?? "");
  const manifestPath = join(stagedRoot, BACKUP_MANIFEST);
  if (!existsSync(manifestPath)) throw new Error("不是 sqraft-cloud 的备份文件（缺少 sqraft-backup.json）");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as BackupManifest;
  if (manifest.app !== "sqraft-cloud") throw new Error("不是 sqraft-cloud 的备份文件");
  if (manifest.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`备份来自更新的版本（数据库版本 ${manifest.schemaVersion}），请先升级 sqraft-cloud 再恢复`);
  }
  await rename(join(stagedRoot, DB_FILE), join(dataDir, DB_FILE));
  if (existsSync(join(stage, "blobs"))) await rename(join(stage, "blobs"), join(dataDir, "blobs"));
  await rm(stage, { recursive: true, force: true });
  return manifest;
}

export function defaultBackupName(dir: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  return join(dir, `sqraft-cloud-${stamp}.tar.gz`);
}
