/**
 * 设计稿评审（P0）：状态只能由评审动作驱动。
 *
 * - submit：草稿 / 已发布 → 评审中，开一轮评审（可指定评审人、写说明）。一份稿同时最多一轮进行中；
 * - approve：评审中 → 已发布，记下通过的版本；必须带客户端看到的版本号，与当前版本不同则 409；
 * - reject：评审中 → 草稿，原因必填；
 * - withdraw：评审中 → 发起前的状态（发起前已发布且通过的版本仍是当前版本才回到已发布，否则草稿）；
 * - publish：草稿 → 已发布，跳过评审（记一轮 skipped 的通过记录，界面标「未经评审」）；
 * - unpublish：已发布 → 草稿，保留通过的版本；
 * - reviewers：修改进行中一轮的评审人（新加入的人收到通知）。
 *
 * 权限：只认网页会话；项目归档时一律 403。提交 / 撤回 / 直接发布 / 改回草稿 / 改评审人需要项目编辑者；
 * 通过 / 退回：指定了评审人时是名单里仍有效的人（查看者也可以），名单为空或全部失效时任一项目编辑者
 * （指定了评审人时提交者不能审自己的提交），管理员始终可以（记录上标 by_admin）。
 *
 * 状态校验、权限、更新、写评审记录、写审计在一个事务里完成；事务提交后再发通知。
 */

import type { FastifyInstance } from "fastify";
import type { AppContext } from "./app";
import { audit } from "./audit";
import { projectRole, requireSession, requireUser, userProjectRole, type Principal, type UserRow } from "./auth";
import { newId } from "./crypto";
import type { Db } from "./db";
import { badRequest, conflict, forbidden } from "./errors";
import { nameOf, notify, type NotificationKind } from "./notify";
import { loadDesign, publicDesign, type DesignRow, type DesignStatus } from "./routes/projects";

export type ReviewState = "open" | "approved" | "rejected" | "cancelled";
export type ReviewAction = "submit" | "approve" | "reject" | "withdraw" | "publish" | "unpublish" | "reviewers";
export const REVIEW_ACTIONS: ReviewAction[] = ["submit", "approve", "reject", "withdraw", "publish", "unpublish", "reviewers"];

export interface ReviewRow {
  id: string;
  design_id: string;
  /** 这一轮评审针对的版本：评审中上传 / 回滚时跟到新的当前版本 */
  version: number | null;
  requested_by: string | null;
  /** 评审人 id 的 JSON 数组 */
  reviewers: string;
  note: string;
  state: ReviewState;
  skipped: number;
  prev_status: DesignStatus | null;
  decided_by: string | null;
  decided_note: string | null;
  by_admin: number;
  created_at: number;
  closed_at: number | null;
}

export interface ReviewInput {
  action: ReviewAction;
  reviewers?: string[];
  note?: string;
  version?: number;
}

interface PendingNote {
  userId: string;
  kind: NotificationKind;
  text: string;
}

/** 审计里的动作名 */
const AUDIT_ACTION: Record<ReviewAction, string> = {
  submit: "review.submit",
  approve: "review.approve",
  reject: "review.reject",
  withdraw: "review.withdraw",
  publish: "review.publish_direct",
  unpublish: "review.unpublish",
  reviewers: "review.reviewers",
};

type TimelineType = "submit" | "approve" | "reject" | "withdraw" | "publish_direct" | "unpublish" | "reviewers";

interface ReviewEventRow {
  id: number;
  design_id: string;
  review_id: string | null;
  type: TimelineType;
  actor_id: string | null;
  version: number | null;
  reviewers: string | null;
  note: string | null;
  by_admin: number;
  created_at: number;
}

const MAX_REVIEWERS = 50;
const MAX_NOTE = 2000;

export function parseReviewers(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function openReviewOf(db: Db, designId: string): ReviewRow | undefined {
  return db.prepare("SELECT * FROM reviews WHERE design_id = ? AND state = 'open'").get(designId) as ReviewRow | undefined;
}

function loadUserRow(db: Db, id: string | null): UserRow | undefined {
  if (!id) return undefined;
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

/** 人员的显示信息：{ id, displayName }；找不到返回 null */
export function personOf(db: Db, id: string | null): { id: string; displayName: string } | null {
  const u = loadUserRow(db, id);
  return u ? { id: u.id, displayName: nameOf(u) } : null;
}

/** 某人对项目是否仍有效：账号未停用，且仍能看到这个项目（查看者也算） */
export function isActiveMember(db: Db, userId: string | null, projectId: string): boolean {
  const u = loadUserRow(db, userId);
  return !!u && u.disabled_at === null && userProjectRole(db, u, projectId) !== null;
}

function isArchived(db: Db, projectId: string): boolean {
  const row = db.prepare("SELECT archived_at FROM projects WHERE id = ?").get(projectId) as { archived_at: number | null } | undefined;
  return !!row && row.archived_at !== null;
}

/**
 * 这个人能否通过 / 退回这一轮评审。返回 null 表示不能；byAdmin 表示只是凭管理员身份。
 */
function reviewAuthority(db: Db, user: UserRow, d: DesignRow, r: ReviewRow): { byAdmin: boolean } | null {
  if (user.disabled_at !== null) return null;
  const listed = parseReviewers(r.reviewers);
  const valid = listed.filter((id) => isActiveMember(db, id, d.project_id));
  let eligible: boolean;
  if (valid.length) eligible = valid.includes(user.id);
  // 名单为空或全部失效：任一项目编辑者；但指定过评审人时，提交者不能审自己的提交
  else eligible = userProjectRole(db, user, d.project_id) === "editor" && !(listed.length > 0 && r.requested_by === user.id);
  if (eligible) return { byAdmin: false };
  if (user.is_admin === 1) return { byAdmin: true };
  return null;
}

/** 当前凭据能否通过 / 退回（服务端下发给网页的 canReview） */
export function canReviewDesign(db: Db, p: Principal | null | undefined, d: DesignRow, r?: ReviewRow): boolean {
  if (!p || p.via !== "session" || d.status !== "review" || d.deleted_at !== null) return false;
  const open = r ?? openReviewOf(db, d.id);
  if (!open || isArchived(db, d.project_id) || !projectRole(db, p, d.project_id)) return false;
  return reviewAuthority(db, p.user, d, open) !== null;
}

/** publicDesign 里的 openReview */
export function publicOpenReview(db: Db, d: DesignRow, r: ReviewRow | undefined) {
  if (!r) return null;
  return {
    id: r.id,
    version: r.version,
    note: r.note,
    requestedBy: personOf(db, r.requested_by),
    reviewers: parseReviewers(r.reviewers).map((id) => ({
      id,
      displayName: personOf(db, id)?.displayName ?? "已删除的用户",
      valid: isActiveMember(db, id, d.project_id),
    })),
    createdAt: r.created_at,
  };
}

/** 校验请求体，非法输入 400 */
export function parseReviewInput(body: unknown): ReviewInput {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!REVIEW_ACTIONS.includes(b.action as ReviewAction)) {
    throw badRequest(`action 只能是 ${REVIEW_ACTIONS.join(" / ")}`);
  }
  const out: ReviewInput = { action: b.action as ReviewAction };
  if (b.reviewers !== undefined && b.reviewers !== null) {
    if (!Array.isArray(b.reviewers) || b.reviewers.length > MAX_REVIEWERS || b.reviewers.some((x) => typeof x !== "string" || !x || x.length > 64)) {
      throw badRequest(`reviewers 需要用户 id 数组，最多 ${MAX_REVIEWERS} 人`);
    }
    out.reviewers = [...new Set(b.reviewers as string[])];
  }
  if (b.note !== undefined && b.note !== null) {
    if (typeof b.note !== "string" || b.note.length > MAX_NOTE) throw badRequest(`说明最多 ${MAX_NOTE} 个字符`);
    out.note = b.note.trim();
  }
  if (b.version !== undefined && b.version !== null) {
    if (typeof b.version !== "number" || !Number.isInteger(b.version) || b.version < 1) throw badRequest("version 需要正整数");
    out.version = b.version;
  }
  return out;
}

const invalid = (message: string) => conflict(message, "invalid_transition");

function excerpt(s: string, n = 60): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * 执行一次评审动作。调用方已确认设计稿存在、当前凭据能看到它（loadDesign viewer）。
 * 返回更新后的设计稿行。
 */
export function performReview(db: Db, p: Principal, designId: string, input: ReviewInput, ip: string | null): DesignRow {
  if (p.via !== "session") throw forbidden("这个操作只能在网页上登录后进行", "session_required");
  const actor = nameOf(p.user);

  const run = db.transaction((): { design: DesignRow; notes: PendingNote[] } => {
    const d = db.prepare("SELECT * FROM designs WHERE id = ?").get(designId) as DesignRow;
    if (isArchived(db, d.project_id)) throw forbidden("项目已归档，只读", "project_archived");
    const role = projectRole(db, p, d.project_id);
    const requireEditor = () => {
      if (role !== "editor") throw forbidden("需要项目编辑者权限");
    };
    const now = Date.now();
    const notes: PendingNote[] = [];
    const vText = (n: number | null) => (n ? `v${n}` : "");
    const r = openReviewOf(db, d.id);
    let next: DesignStatus = d.status;
    let detail: Record<string, unknown> = { from: d.status };

    const checkReviewers = (ids: string[]) => {
      for (const id of ids) {
        if (!isActiveMember(db, id, d.project_id)) throw badRequest("评审人需要是能看到这个项目的成员", "invalid_reviewer");
      }
    };
    const requestNotes = (ids: string[], version: number | null, note: string) => {
      for (const id of ids) {
        notes.push({
          userId: id,
          kind: "review_request",
          text: `${actor} 请你评审「${d.name}」${vText(version)}${note ? `：${excerpt(note)}` : ""}`,
        });
      }
    };
    /** 时间线事件：单独存在 review_events，不依赖会被清理的审计记录 */
    const event = (
      type: TimelineType,
      e: { reviewId?: string | null; version?: number | null; reviewers?: string[] | null; note?: string | null; byAdmin?: boolean } = {},
    ) => {
      db.prepare(
        `INSERT INTO review_events (design_id, review_id, type, actor_id, version, reviewers, note, by_admin, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(d.id, e.reviewId ?? null, type, p.user.id, e.version ?? null, e.reviewers ? JSON.stringify(e.reviewers) : null, e.note || null, e.byAdmin ? 1 : 0, now);
    };
    const resultNotes = (review: ReviewRow, text: string) => {
      for (const id of new Set([review.requested_by, d.created_by])) {
        if (id && isActiveMember(db, id, d.project_id)) notes.push({ userId: id, kind: "review_result", text });
      }
    };

    switch (input.action) {
      case "submit": {
        requireEditor();
        if (d.status !== "draft" && d.status !== "published") throw invalid("已经在评审中");
        const reviewers = input.reviewers ?? [];
        checkReviewers(reviewers);
        const note = input.note ?? "";
        if (r) db.prepare("UPDATE reviews SET state = 'cancelled', closed_at = ? WHERE id = ?").run(now, r.id); // 防御：不应存在
        const id = newId();
        db.prepare(
          `INSERT INTO reviews (id, design_id, version, requested_by, reviewers, note, state, skipped, prev_status, by_admin, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'open', 0, ?, 0, ?)`,
        ).run(id, d.id, d.current_version, p.user.id, JSON.stringify(reviewers), note, d.status, now);
        next = "review";
        detail = { ...detail, review: id, version: d.current_version, reviewers };
        event("submit", { reviewId: id, version: d.current_version, reviewers, note });
        requestNotes(reviewers, d.current_version, note);
        break;
      }
      case "approve":
      case "reject": {
        if (d.status !== "review" || !r) throw invalid("这份设计稿没有进行中的评审");
        const authority = reviewAuthority(db, p.user, d, r);
        if (!authority) throw forbidden("你不是这一轮的评审人", "not_reviewer");
        if (input.action === "approve") {
          if (d.current_version === null) throw conflict("还没有上传任何版本，不能通过", "no_version");
          if (input.version === undefined) throw badRequest("需要带上你看到的版本号 version");
          if (input.version !== d.current_version) throw conflict("有新版本，请刷新后再确认", "version_mismatch");
          db.prepare(
            "UPDATE reviews SET state = 'approved', version = ?, decided_by = ?, decided_note = ?, by_admin = ?, closed_at = ? WHERE id = ?",
          ).run(d.current_version, p.user.id, input.note || null, authority.byAdmin ? 1 : 0, now, r.id);
          db.prepare("UPDATE designs SET approved_version = ?, approved_at = ?, approved_by = ? WHERE id = ?").run(d.current_version, now, p.user.id, d.id);
          next = "published";
          detail = { ...detail, review: r.id, version: d.current_version, byAdmin: authority.byAdmin };
          event("approve", { reviewId: r.id, version: d.current_version, note: input.note, byAdmin: authority.byAdmin });
          resultNotes(r, `${actor} 通过了「${d.name}」v${d.current_version} 的评审`);
        } else {
          const reason = input.note ?? "";
          if (!reason) throw badRequest("请填写退回原因", "reason_required");
          db.prepare(
            "UPDATE reviews SET state = 'rejected', version = ?, decided_by = ?, decided_note = ?, by_admin = ?, closed_at = ? WHERE id = ?",
          ).run(d.current_version, p.user.id, reason, authority.byAdmin ? 1 : 0, now, r.id);
          next = "draft";
          detail = { ...detail, review: r.id, version: d.current_version, byAdmin: authority.byAdmin };
          event("reject", { reviewId: r.id, version: d.current_version, note: reason, byAdmin: authority.byAdmin });
          resultNotes(r, `${actor} 退回了「${d.name}」${vText(d.current_version)}：${excerpt(reason)}`);
        }
        break;
      }
      case "withdraw": {
        requireEditor();
        if (d.status !== "review") throw invalid("这份设计稿不在评审中");
        if (r) db.prepare("UPDATE reviews SET state = 'cancelled', decided_by = ?, closed_at = ? WHERE id = ?").run(p.user.id, now, r.id);
        const backToPublished = r?.prev_status === "published" && d.approved_version !== null && d.approved_version === d.current_version;
        next = backToPublished ? "published" : "draft";
        detail = { ...detail, review: r?.id ?? null };
        event("withdraw", { reviewId: r?.id ?? null, version: r?.version ?? d.current_version });
        break;
      }
      case "publish": {
        requireEditor();
        if (d.status !== "draft") throw invalid(d.status === "review" ? "评审中的设计稿请先撤回或等评审结果" : "已经是已发布");
        if (d.current_version === null) throw conflict("还没有上传任何版本，不能发布", "no_version");
        const id = newId();
        db.prepare(
          `INSERT INTO reviews (id, design_id, version, requested_by, reviewers, note, state, skipped, prev_status, decided_by, decided_note, by_admin, created_at, closed_at)
           VALUES (?, ?, ?, ?, '[]', ?, 'approved', 1, 'draft', ?, NULL, 0, ?, ?)`,
        ).run(id, d.id, d.current_version, p.user.id, input.note ?? "", p.user.id, now, now);
        db.prepare("UPDATE designs SET approved_version = ?, approved_at = ?, approved_by = ? WHERE id = ?").run(d.current_version, now, p.user.id, d.id);
        next = "published";
        detail = { ...detail, review: id, version: d.current_version };
        event("publish_direct", { reviewId: id, version: d.current_version, note: input.note });
        break;
      }
      case "unpublish": {
        requireEditor();
        if (d.status !== "published") throw invalid("只有已发布的设计稿能改回草稿");
        next = "draft";
        detail = { ...detail, version: d.current_version, approvedVersion: d.approved_version };
        event("unpublish", { version: d.current_version });
        break;
      }
      case "reviewers": {
        requireEditor();
        if (d.status !== "review" || !r) throw invalid("这份设计稿没有进行中的评审");
        if (!input.reviewers) throw badRequest("需要 reviewers");
        const before = parseReviewers(r.reviewers);
        // 原本就在名单里、后来失效（停用 / 看不到项目）的人直接去掉，不让他们挡住换人；新加入的人必须有效
        const reviewers = input.reviewers.filter((id) => !before.includes(id) || isActiveMember(db, id, d.project_id));
        const added = reviewers.filter((id) => !before.includes(id));
        checkReviewers(added);
        db.prepare("UPDATE reviews SET reviewers = ? WHERE id = ?").run(JSON.stringify(reviewers), r.id);
        requestNotes(added, r.version, r.note);
        detail = { review: r.id, reviewers, added };
        event("reviewers", { reviewId: r.id, reviewers });
        break;
      }
    }

    if (next !== d.status) db.prepare("UPDATE designs SET status = ?, updated_at = ? WHERE id = ?").run(next, now, d.id);
    audit(db, p, ip, { action: AUDIT_ACTION[input.action], target: d.id, detail: { ...detail, to: next } });
    return { design: db.prepare("SELECT * FROM designs WHERE id = ?").get(d.id) as DesignRow, notes };
  });

  const { design, notes } = run();
  if (design.deleted_at === null) {
    const link = `/designs/${design.id}`;
    for (const n of notes) notify(db, n.userId, n.kind, p.user.id, n.text, link);
  }
  return design;
}

/**
 * 评审中的设计稿换了当前版本（上传新版本 / 回滚）：本轮评审跟到新版本，通知有效评审人。
 * 同一人同一链接已有未读的 review_updated 就不再重复通知。重复上传（没产生新版本）不要调用。
 */
export function followNewVersion(db: Db, designId: string, actorId: string | null): void {
  const d = db.prepare("SELECT * FROM designs WHERE id = ?").get(designId) as DesignRow | undefined;
  if (!d || d.status !== "review") return;
  const r = openReviewOf(db, d.id);
  if (!r || r.version === d.current_version) return;
  db.prepare("UPDATE reviews SET version = ? WHERE id = ?").run(d.current_version, r.id);
  if (d.deleted_at !== null) return;
  const link = `/designs/${d.id}`;
  const actor = actorId ? personOf(db, actorId)?.displayName : null;
  const text = `${actor ? `${actor} 更新了` : ""}评审中的「${d.name}」，现在是 v${d.current_version}`;
  const unread = db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'review_updated' AND link = ? AND read_at IS NULL");
  for (const id of parseReviewers(r.reviewers)) {
    if (!isActiveMember(db, id, d.project_id) || unread.get(id, link)) continue;
    notify(db, id, "review_updated", actorId, text, link);
  }
}


export function reviewRoutes(app: FastifyInstance, { db }: AppContext): void {
  app.post<{ Params: { id: string }; Body: unknown }>("/api/v1/designs/:id/review", async (req) => {
    const p = requireSession(req);
    const d = loadDesign(db, p, req.params.id, "viewer");
    const input = parseReviewInput(req.body);
    const updated = performReview(db, p, d.id, input, req.ip);
    return { design: publicDesign(db, updated, p) };
  });

  // 可选的评审人：能看到这个项目的有效成员（查看者也算）。能看到设计稿的人都能查
  app.get<{ Params: { id: string } }>("/api/v1/designs/:id/reviewer-candidates", async (req) => {
    const p = requireUser(req);
    const d = loadDesign(db, p, req.params.id, "viewer");
    const rows = db.prepare("SELECT * FROM users WHERE disabled_at IS NULL ORDER BY created_at").all() as UserRow[];
    return {
      members: rows
        .filter((u) => userProjectRole(db, u, d.project_id) !== null)
        .map((u) => ({ id: u.id, username: u.username, displayName: nameOf(u) })),
    };
  });

  // 评审历史（时间线）：每一轮的状态，外加按时间排好的评审事件
  app.get<{ Params: { id: string } }>("/api/v1/designs/:id/reviews", async (req) => {
    const p = requireUser(req);
    const d = loadDesign(db, p, req.params.id, "viewer");
    const rows = db.prepare("SELECT * FROM reviews WHERE design_id = ? ORDER BY created_at, rowid").all(d.id) as ReviewRow[];
    const names = (ids: string[]) => ids.map((id) => ({ id, displayName: personOf(db, id)?.displayName ?? "已删除的用户" }));
    const reviews = rows.map((r) => ({
      id: r.id,
      version: r.version,
      state: r.state,
      skipped: r.skipped === 1,
      note: r.note,
      prevStatus: r.prev_status,
      requestedBy: personOf(db, r.requested_by),
      reviewers: parseReviewers(r.reviewers).map((id) => ({
        id,
        displayName: personOf(db, id)?.displayName ?? "已删除的用户",
        valid: isActiveMember(db, id, d.project_id),
      })),
      decidedBy: personOf(db, r.decided_by),
      decidedNote: r.decided_note,
      byAdmin: r.by_admin === 1,
      createdAt: r.created_at,
      closedAt: r.closed_at,
    }));

    // 时间线来自 review_events（审计会按保留期清理，不能用）
    const eventRows = db.prepare("SELECT * FROM review_events WHERE design_id = ? ORDER BY created_at, id").all(d.id) as ReviewEventRow[];
    const events = eventRows.map((e) => ({
      type: e.type,
      at: e.created_at,
      actor: personOf(db, e.actor_id),
      version: e.version,
      note: e.note,
      reviewId: e.review_id,
      ...(e.reviewers !== null ? { reviewers: names(parseReviewers(e.reviewers)) } : {}),
      ...(e.type === "approve" || e.type === "reject" ? { byAdmin: e.by_admin === 1 } : {}),
    }));
    return { reviews, events };
  });
}
