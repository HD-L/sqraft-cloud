/** 跨页面共享的界面状态：上传客户端弹窗。 */
import { reactive } from "vue";
import { api } from "./api";

export const ui = reactive({ clientOpen: false, clientUrl: "" });

export async function openClient(): Promise<void> {
  ui.clientOpen = true;
  if (!ui.clientUrl) ui.clientUrl = (await api<{ downloadUrl: string }>("GET", "/client")).downloadUrl;
}
