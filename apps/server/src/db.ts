/**
 * SQLite（WAL）与版本化迁移。迁移只追加不修改：`user_version` 记录已执行到第几条。
 * 已有数据的库在迁移前先 `VACUUM INTO` 备份一份，升级出问题可以直接换回。
 */

import Database from "better-sqlite3";
import { existsSync } from "node:fs";

export type Db = Database.Database;

export const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    disabled_at INTEGER,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('mcp', 'uploader')),
    token_hash TEXT NOT NULL UNIQUE,
    hint TEXT NOT NULL,
    project_ids TEXT,
    expires_at INTEGER,
    last_used_at INTEGER,
    last_used_ip TEXT,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX tokens_user ON tokens(user_id);

  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    archived_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE members (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
    PRIMARY KEY (project_id, user_id)
  );
  CREATE INDEX members_user ON members(user_id);

  CREATE TABLE designs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    current_version INTEGER,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE INDEX designs_project ON designs(project_id);

  CREATE TABLE versions (
    design_id TEXT NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    uploader_id TEXT,
    file_sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    format_version INTEGER NOT NULL,
    doc_blob TEXT NOT NULL,
    manifest_blob TEXT,
    assets TEXT NOT NULL,
    node_count INTEGER NOT NULL,
    page_count INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (design_id, number)
  );

  CREATE TABLE uploads (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    design_id TEXT NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
    note TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL,
    received INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    user_id TEXT,
    username TEXT,
    token_name TEXT,
    ip TEXT,
    action TEXT NOT NULL,
    target TEXT,
    result TEXT NOT NULL,
    detail TEXT
  );
  CREATE INDEX audit_at ON audit(at);
  CREATE INDEX audit_user ON audit(user_id, at);
  `,
  // 里程碑 2：按页索引（gzip JSON blob）与服务端密钥（切图签名链接）
  `
  ALTER TABLE versions ADD COLUMN index_blob TEXT;
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  // 里程碑 3：上传客户端的浏览器登录（OAuth 2.0 授权码 + PKCE）
  `
  CREATE TABLE oauth_codes (
    code_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // 增量上传与页面级变更记录：整版内容指纹（判重）、相对基准版本的变更（JSON）
  `
  ALTER TABLE versions ADD COLUMN content_hash TEXT;
  ALTER TABLE versions ADD COLUMN changes TEXT;
  `,
  // 团队协作：团队角色（项目里可单独覆盖，none = 看不到）、项目简介、设计稿状态、评论、通知、最近浏览
  `
  ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'viewer';
  ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT '';
  UPDATE users SET role = 'admin' WHERE is_admin = 1;

  CREATE TABLE members_v2 (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('editor', 'viewer', 'none')),
    PRIMARY KEY (project_id, user_id)
  );
  INSERT INTO members_v2 (project_id, user_id, role) SELECT project_id, user_id, role FROM members;
  DROP TABLE members;
  ALTER TABLE members_v2 RENAME TO members;
  CREATE INDEX members_user ON members(user_id);
  -- 升级前普通用户只能看到被分配的项目：没分配的记为「看不到」，保持原有可见范围
  INSERT INTO members (project_id, user_id, role)
    SELECT p.id, u.id, 'none' FROM projects p CROSS JOIN users u
    WHERE u.is_admin = 0 AND NOT EXISTS (SELECT 1 FROM members m WHERE m.project_id = p.id AND m.user_id = u.id);

  ALTER TABLE projects ADD COLUMN description TEXT NOT NULL DEFAULT '';
  ALTER TABLE projects ADD COLUMN created_by TEXT;
  ALTER TABLE designs ADD COLUMN status TEXT NOT NULL DEFAULT 'published';

  CREATE TABLE comments (
    id TEXT PRIMARY KEY,
    design_id TEXT NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    version INTEGER,
    page_id TEXT,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE INDEX comments_design ON comments(design_id, created_at);

  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    actor_id TEXT,
    text TEXT NOT NULL,
    link TEXT,
    read_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX notifications_user ON notifications(user_id, created_at);

  CREATE TABLE recent_views (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    design_id TEXT NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
    viewed_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, design_id)
  );
  CREATE INDEX recent_views_user ON recent_views(user_id, viewed_at);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function openDb(file: string): Db {
  const fresh = file === ":memory:" || !existsSync(file);
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db, file, fresh);
  return db;
}

function migrate(db: Db, file: string, fresh: boolean): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > MIGRATIONS.length) {
    throw new Error(`数据库版本 ${current} 高于本程序支持的 ${MIGRATIONS.length}，请升级 sqraft-cloud`);
  }
  if (current === MIGRATIONS.length) return;
  if (!fresh && current > 0) {
    const backup = `${file}.v${current}-${Date.now()}.bak`;
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  }
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
}
