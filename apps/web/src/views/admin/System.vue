<script setup lang="ts">
/** 系统（G4、D6）：概览、回收站（恢复 / 彻底删除）、手动执行维护。 */
import { onMounted, ref } from "vue";
import { api, formatBytes, formatTime } from "../../api";

interface Overview {
  version: string;
  uptimeSeconds: number;
  users: number;
  projects: number;
  designs: number;
  versions: number;
  trash: number;
  activeTokens: number;
  storageBytes: number;
  blobCount: number;
  uploads7d: number;
  mcpCalls7d: number;
  mcpUsers7d: number;
  trashDays: number;
}
interface TrashItem {
  id: string;
  name: string;
  projectName: string;
  versionCount: number;
  deletedAt: number;
  purgeAt: number;
}

const o = ref<Overview | null>(null);
const trash = ref<TrashItem[]>([]);
const error = ref("");
const report = ref("");
const busy = ref(false);

async function load() {
  try {
    o.value = await api<Overview>("GET", "/admin/overview");
    trash.value = (await api<{ designs: TrashItem[] }>("GET", "/admin/trash")).designs;
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function restore(t: TrashItem) {
  await api("POST", `/admin/trash/${t.id}/restore`);
  await load();
}

async function purge(t: TrashItem) {
  if (!confirm(`彻底删除「${t.name}」及其 ${t.versionCount} 个版本？此操作不能撤销。`)) return;
  await api("DELETE", `/admin/trash/${t.id}`);
  await load();
}

async function maintain() {
  busy.value = true;
  try {
    const r = await api<{ purgedDesigns: number; deletedBlobs: number; freedBytes: number }>("POST", "/admin/maintenance");
    report.value = `清理回收站 ${r.purgedDesigns} 个设计稿，回收 ${r.deletedBlobs} 个无用文件（${formatBytes(r.freedBytes)}）`;
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

function uptime(s: number) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return d ? `${d} 天 ${h} 小时` : `${h} 小时 ${Math.floor((s % 3600) / 60)} 分`;
}

onMounted(() => void load());
</script>

<template>
  <div class="page">
    <h1>系统</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <div v-if="o" class="stats">
      <div class="card"><span class="muted">用户</span><strong>{{ o.users }}</strong></div>
      <div class="card"><span class="muted">项目</span><strong>{{ o.projects }}</strong></div>
      <div class="card"><span class="muted">设计稿 / 版本</span><strong>{{ o.designs }} / {{ o.versions }}</strong></div>
      <div class="card"><span class="muted">存储占用</span><strong>{{ formatBytes(o.storageBytes) }}</strong></div>
      <div class="card"><span class="muted">近 7 天上传</span><strong>{{ o.uploads7d }}</strong></div>
      <div class="card"><span class="muted">近 7 天 MCP 调用</span><strong>{{ o.mcpCalls7d }}</strong><span class="muted">{{ o.mcpUsers7d }} 人在用</span></div>
      <div class="card"><span class="muted">有效令牌</span><strong>{{ o.activeTokens }}</strong></div>
      <div class="card"><span class="muted">版本 / 运行</span><strong>{{ o.version }}</strong><span class="muted">{{ uptime(o.uptimeSeconds) }}</span></div>
    </div>

    <div class="row" style="margin-top: 24px">
      <h2 style="margin: 0">回收站</h2>
      <span class="muted">删除的设计稿保留 {{ o?.trashDays ?? 30 }} 天后自动彻底删除</span>
      <span class="spacer" />
      <button :disabled="busy" @click="maintain">{{ busy ? "执行中…" : "立即执行维护" }}</button>
    </div>
    <p v-if="report" class="muted">{{ report }}</p>
    <table class="card" style="padding: 0; margin-top: 12px">
      <thead>
        <tr><th>设计稿</th><th>项目</th><th>版本数</th><th>删除时间</th><th>将于</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="t in trash" :key="t.id">
          <td>{{ t.name }}</td>
          <td>{{ t.projectName }}</td>
          <td>{{ t.versionCount }}</td>
          <td class="muted">{{ formatTime(t.deletedAt) }}</td>
          <td class="muted">{{ formatTime(t.purgeAt) }} 彻底删除</td>
          <td class="row" style="justify-content: flex-end">
            <button @click="restore(t)">恢复</button>
            <button class="danger" @click="purge(t)">彻底删除</button>
          </td>
        </tr>
        <tr v-if="!trash.length"><td colspan="6" class="muted">回收站是空的</td></tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
}
.stats .card {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.stats strong {
  font-size: 22px;
}
</style>
