/** 点击复制：复制后在面板底部提示一下。 */
import { ref } from "vue";

export const copiedText = ref("");
let timer = 0;

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 非安全上下文（纯 HTTP 内网部署）没有剪贴板 API：退回 execCommand
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  copiedText.value = text.length > 40 ? `${text.slice(0, 40)}…` : text;
  clearTimeout(timer);
  timer = window.setTimeout(() => (copiedText.value = ""), 1400);
}
