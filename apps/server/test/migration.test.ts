import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, openDb } from "../src/db";

describe("升级到团队角色", () => {
  it("原有普通用户仍只能看到被分配的项目；管理员变成团队管理员", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sqraft-mig-"));
    const file = join(dir, "db.sqlite");
    const old = new Database(file);
    const before = MIGRATIONS.length - 1;
    for (let i = 0; i < before; i++) old.exec(MIGRATIONS[i]);
    old.pragma(`user_version = ${before}`);
    const now = Date.now();
    old.prepare("INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES ('a', 'admin', 'x', 1, ?), ('u', 'bob', 'x', 0, ?)").run(now, now);
    old.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', '官网', ?), ('p2', 'App', ?)").run(now, now);
    old.prepare("INSERT INTO members (project_id, user_id, role) VALUES ('p1', 'u', 'editor')").run();
    old.close();

    const db = openDb(file);
    expect(db.prepare("SELECT id, role FROM users ORDER BY id").all()).toEqual([
      { id: "a", role: "admin" },
      { id: "u", role: "viewer" },
    ]);
    expect(db.prepare("SELECT project_id, role FROM members WHERE user_id = 'u' ORDER BY project_id").all()).toEqual([
      { project_id: "p1", role: "editor" },
      { project_id: "p2", role: "none" },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM members WHERE user_id = 'a'").get()).toEqual({ n: 0 });
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
});
