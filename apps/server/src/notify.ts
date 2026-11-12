/**
 * 站内通知（D2）：被 @、设计稿有新评论、被加入团队 / 项目。只存在数据库里，网页右上角的铃铛读取。
 */

import type { Db } from "./db";

export type NotificationKind = "mention" | "comment" | "invited" | "project_access";

export function notify(db: Db, userId: string, kind: NotificationKind, actorId: string | null, text: string, link: string | null): void {
  if (actorId && userId === actorId) return;
  db.prepare("INSERT INTO notifications (user_id, kind, actor_id, text, link, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    userId,
    kind,
    actorId,
    text.slice(0, 500),
    link,
    Date.now(),
  );
}

/** 显示用的名字：有昵称用昵称，否则用户名。 */
export function nameOf(u: { username: string; display_name?: string | null }): string {
  return u.display_name || u.username;
}
