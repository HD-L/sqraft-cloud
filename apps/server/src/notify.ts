/**
 * 站内通知（D2）：被 @、设计稿有新评论、被加入团队 / 项目、设计稿评审。只存在数据库里，网页右上角的铃铛读取。
 */

import type { Db } from "./db";

export type NotificationKind =
  | "mention"
  | "comment"
  | "invited"
  | "project_access"
  /** 请你评审（提交评审、追加评审人） */
  | "review_request"
  /** 评审结果（通过 / 退回），发给提交者与设计稿创建者 */
  | "review_result"
  /** 评审中的设计稿有了新版本（上传 / 回滚），发给评审人 */
  | "review_updated";

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
