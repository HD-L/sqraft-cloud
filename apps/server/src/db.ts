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
  // 成员的项目可见范围：all = 默认能看到所有项目；assigned = 只能看到单独分配了的项目
  `
  ALTER TABLE users ADD COLUMN project_scope TEXT NOT NULL DEFAULT 'all';
  `,
  // 设计稿评审：评审轮次、通过的版本、评论「已解决」
  `
  CREATE TABLE reviews (
    id TEXT PRIMARY KEY,
    design_id TEXT NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
    version INTEGER,
    requested_by TEXT,
    reviewers TEXT NOT NULL DEFAULT '[]',
    note TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL CHECK (state IN ('open', 'approved', 'rejected', 'cancelled')),
    skipped INTEGER NOT NULL DEFAULT 0,
    prev_status TEXT,
    decided_by TEXT,
    decided_note TEXT,
    by_admin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    closed_at INTEGER
  );
  CREATE UNIQUE INDEX reviews_one_open ON reviews(design_id) WHERE state = 'open';
  CREATE INDEX reviews_design ON reviews(design_id, created_at);

  ALTER TABLE designs ADD COLUMN approved_version INTEGER;
  ALTER TABLE designs ADD COLUMN approved_at INTEGER;
  ALTER TABLE designs ADD COLUMN approved_by TEXT;

  ALTER TABLE comments ADD COLUMN resolved_at INTEGER;
  ALTER TABLE comments ADD COLUMN resolved_by TEXT;
  ALTER TABLE comments ADD COLUMN resolved_legacy INTEGER NOT NULL DEFAULT 0;

  -- 上线前已发布的：当前版本视为通过的版本（approved_by 为空 = 上线前已发布）
  UPDATE designs SET approved_version = current_version WHERE status = 'published' AND current_version IS NOT NULL;
  -- 上线前就在评审中的：补一轮进行中的评审（不指定评审人）
  INSERT INTO reviews (id, design_id, version, requested_by, reviewers, note, state, skipped, prev_status, by_admin, created_at)
    SELECT lower(hex(randomblob(12))), id, current_version, created_by, '[]', '', 'open', 0, 'draft', 0, updated_at
    FROM designs WHERE status = 'review';
  -- 已发布设计稿上的旧评论一律视为已解决（显示为「上线前的评论」）
  UPDATE comments SET resolved_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000, resolved_legacy = 1
    WHERE deleted_at IS NULL AND design_id IN (SELECT id FROM designs WHERE status = 'published');
  `,
  // 评审时间线单独存一张表：审计会按保留期清理，不能当时间线的数据源。
  // 每个评审动作一行；version 是动作发生时的版本（提交事件记提交时的版本），reviewers 是当时的评审人名单
  `
  CREATE TABLE review_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    design_id TEXT NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
    review_id TEXT,
    type TEXT NOT NULL CHECK (type IN ('submit', 'approve', 'reject', 'withdraw', 'publish_direct', 'unpublish', 'reviewers')),
    actor_id TEXT,
    version INTEGER,
    reviewers TEXT,
    note TEXT,
    by_admin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX review_events_design ON review_events(design_id, created_at, id);

  -- 补已有的记录：评审轮次来自 reviews，提交时的版本 / 评审人、改回草稿、修改评审人尽量从审计里找回
  INSERT INTO review_events (design_id, review_id, type, actor_id, version, reviewers, note, by_admin, created_at)
  SELECT design_id, review_id, type, actor_id, version, reviewers, note, by_admin, at FROM (
    SELECT r.design_id, r.id AS review_id, 'submit' AS type, r.requested_by AS actor_id,
      COALESCE(
        (SELECT json_extract(a.detail, '$.version') FROM audit a
          WHERE a.target = r.design_id AND a.action = 'review.submit' AND a.result = 'ok' AND json_valid(a.detail) AND json_extract(a.detail, '$.review') = r.id),
        r.version) AS version,
      COALESCE(
        (SELECT json_extract(a.detail, '$.reviewers') FROM audit a
          WHERE a.target = r.design_id AND a.action = 'review.submit' AND a.result = 'ok' AND json_valid(a.detail) AND json_extract(a.detail, '$.review') = r.id),
        r.reviewers) AS reviewers,
      NULLIF(r.note, '') AS note, 0 AS by_admin, r.created_at AS at,
      (SELECT a.id FROM audit a WHERE a.target = r.design_id AND a.action = 'review.submit' AND json_valid(a.detail) AND json_extract(a.detail, '$.review') = r.id) AS seq
    FROM reviews r WHERE r.skipped = 0
    UNION ALL
    SELECT r.design_id, r.id, 'publish_direct', r.requested_by, r.version, NULL, NULLIF(r.note, ''), 0, r.created_at,
      (SELECT a.id FROM audit a WHERE a.target = r.design_id AND a.action = 'review.publish_direct' AND json_valid(a.detail) AND json_extract(a.detail, '$.review') = r.id)
    FROM reviews r WHERE r.skipped = 1
    UNION ALL
    SELECT r.design_id, r.id, CASE r.state WHEN 'approved' THEN 'approve' WHEN 'rejected' THEN 'reject' ELSE 'withdraw' END,
      r.decided_by, r.version, NULL, r.decided_note, r.by_admin, r.closed_at,
      (SELECT a.id FROM audit a WHERE a.target = r.design_id AND a.action IN ('review.approve', 'review.reject', 'review.withdraw') AND json_valid(a.detail) AND json_extract(a.detail, '$.review') = r.id)
    FROM reviews r WHERE r.skipped = 0 AND r.state <> 'open' AND r.closed_at IS NOT NULL
    UNION ALL
    SELECT a.target, NULL, 'unpublish', a.user_id, json_extract(a.detail, '$.version'), NULL, NULL, 0, a.at, a.id
    FROM audit a WHERE a.action = 'review.unpublish' AND a.result = 'ok' AND json_valid(a.detail) AND a.target IN (SELECT id FROM designs)
    UNION ALL
    SELECT a.target, json_extract(a.detail, '$.review'), 'reviewers', a.user_id, NULL, COALESCE(json_extract(a.detail, '$.reviewers'), '[]'), NULL, 0, a.at, a.id
    FROM audit a WHERE a.action = 'review.reviewers' AND a.result = 'ok' AND json_valid(a.detail) AND a.target IN (SELECT id FROM designs)
  ) ORDER BY at, COALESCE(seq, 9007199254740991);
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
