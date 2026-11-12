/** 跨页面共享的界面状态：团队名称（侧栏、页头）、上传客户端弹窗。 */
import { reactive } from "vue";
import { api } from "./api";

export const ui = reactive({ teamName: "", clientOpen: false, clientUrl: "" });

export async function loadTeam(): Promise<void> {
  try {
    ui.teamName = (await api<{ team: { name: string } }>("GET", "/team")).team.name;
  } catch {
    // 未登录时读不到，忽略
  }
}

export async function openClient(): Promise<void> {
  ui.clientOpen = true;
  if (!ui.clientUrl) ui.clientUrl = (await api<{ downloadUrl: string }>("GET", "/client")).downloadUrl;
}
