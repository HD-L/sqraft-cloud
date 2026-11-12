/** 跨页面共享的界面状态：上传客户端弹窗、轻提示（toast）、确认弹窗。 */
import { reactive } from "vue";
import { api } from "./api";

export const ui = reactive({ clientOpen: false, clientUrl: "" });

export async function openClient(): Promise<void> {
  ui.clientOpen = true;
  if (!ui.clientUrl) ui.clientUrl = (await api<{ downloadUrl: string }>("GET", "/client")).downloadUrl;
}

// ── 轻提示 ──
export interface Toast {
  id: number;
  kind: "success" | "error" | "info";
  text: string;
}
export const toasts = reactive<Toast[]>([]);
let toastSeq = 0;
function push(kind: Toast["kind"], text: string, ms: number) {
  const id = ++toastSeq;
  toasts.push({ id, kind, text });
  window.setTimeout(() => dismissToast(id), ms);
}
export function dismissToast(id: number) {
  const i = toasts.findIndex((t) => t.id === id);
  if (i >= 0) toasts.splice(i, 1);
}
/** 页面右下角的轻提示：操作成功 / 失败的即时反馈，几秒后自动消失 */
export const toast = {
  success: (text: string) => push("success", text, 2600),
  info: (text: string) => push("info", text, 2600),
  error: (text: string) => push("error", text, 5000),
};

// ── 确认弹窗 ──
export interface ConfirmOptions {
  title: string;
  /** 说明文字：后果、是否可恢复 */
  message?: string;
  /** 确认按钮的文字，默认「确定」 */
  confirmText?: string;
  /** 危险操作：确认按钮用红色 */
  danger?: boolean;
}
export const confirmState = reactive<{ open: boolean; options: ConfirmOptions; resolve: ((ok: boolean) => void) | null }>({
  open: false,
  options: { title: "" },
  resolve: null,
});
/** 代替浏览器原生 confirm()：返回用户是否确认 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  confirmState.resolve?.(false);
  return new Promise((resolve) => {
    confirmState.options = options;
    confirmState.resolve = resolve;
    confirmState.open = true;
  });
}
export function answerConfirm(ok: boolean) {
  confirmState.open = false;
  confirmState.resolve?.(ok);
  confirmState.resolve = null;
}
