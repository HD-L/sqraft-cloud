<script setup lang="ts">
/** 系统（G4、D6）：概览、回收站（恢复 / 彻底删除）、手动执行维护。 */
import { computed, onMounted, ref } from "vue";
import { Activity, FileStack, FolderKanban, HardDrive, KeyRound, Layers, RefreshCw, RotateCcw, Server, Trash2, Upload, Users, Wrench } from "lucide-vue-next";
import { api, formatBytes, formatTime, relativeTime } from "../../api";
import { confirmDialog, toast } from "../../ui";
import EmptyState from "../../components/EmptyState.vue";

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
const loading = ref(true);
const error = ref("");
const report = ref("");
const busy = ref(false);
const rowBusy = ref<string | null>(null);

const stats = computed(() => {
  const v = o.value;
  if (!v) return [];
  return [
    { icon: HardDrive, label: "存储占用", value: formatBytes(v.storageBytes), sub: `${v.blobCount} 个文件` },
    { icon: FileStack, label: "设计稿", value: String(v.designs), sub: `回收站 ${v.trash} 个` },
    { icon: Layers, label: "版本", value: String(v.versions), sub: "全部设计稿累计" },
    { icon: FolderKanban, label: "项目", value: String(v.projects), sub: "进行中" },
    { icon: Users, label: "用户", value: String(v.users), sub: "已启用" },
    { icon: KeyRound, label: "有效令牌", value: String(v.activeTokens), sub: "未吊销且未过期" },
    { icon: Upload, label: "近 7 天上传", value: String(v.uploads7d), sub: "成功上传的版本" },
    { icon: Activity, label: "近 7 天 MCP 调用", value: String(v.mcpCalls7d), sub: `${v.mcpUsers7d} 人在用` },
  ];
});

async function load() {
  error.value = "";
  try {
    o.value = await api<Overview>("GET", "/admin/overview");
    trash.value = (await api<{ designs: TrashItem[] }>("GET", "/admin/trash")).designs;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

async function restore(t: TrashItem) {
  rowBusy.value = t.id;
  try {
    await api("POST", `/admin/trash/${t.id}/restore`);
    toast.success(`已恢复「${t.name}」`);
    await load();
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    rowBusy.value = null;
  }
}

async function purge(t: TrashItem) {
  const ok = await confirmDialog({
    title: `彻底删除「${t.name}」？`,
    message: `将同时删除它的 ${t.versionCount} 个版本，此操作不能撤销。`,
    confirmText: "彻底删除",
    danger: true,
  });
  if (!ok) return;
  rowBusy.value = t.id;
  try {
    await api("DELETE", `/admin/trash/${t.id}`);
    toast.success(`已彻底删除「${t.name}」`);
    await load();
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    rowBusy.value = null;
  }
}

async function maintain() {
  const ok = await confirmDialog({
    title: "立即执行维护？",
    message: `会彻底删除回收站里超过 ${o.value?.trashDays ?? 30} 天的设计稿，并回收不再被引用的文件。被清理的数据不能恢复。`,
    confirmText: "执行维护",
    danger: true,
  });
  if (!ok) return;
  busy.value = true;
  try {
    const r = await api<{ purgedDesigns: number; deletedBlobs: number; freedBytes: number }>("POST", "/admin/maintenance");
    report.value = `清理回收站 ${r.purgedDesigns} 个设计稿，回收 ${r.deletedBlobs} 个无用文件（${formatBytes(r.freedBytes)}）`;
    toast.success("维护已完成");
    await load();
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    busy.value = false;
  }
}

function uptime(s: number) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return d ? `${d} 天 ${h} 小时` : `${h} 小时 ${Math.floor((s % 3600) / 60)} 分`;
}

function daysLeft(at: number) {
  const d = Math.ceil((at - Date.now()) / 86_400_000);
  return d <= 0 ? "即将" : `${d} 天后`;
}

onMounted(() => void load());
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>系统</h1>
        <div class="sub">
          <template v-if="o"><Server :size="13" class="inline-icon" />版本 {{ o.version }} · 已运行 {{ uptime(o.uptimeSeconds) }}</template>
          <template v-else>运行状态、存储与回收站</template>
        </div>
      </div>
      <div class="actions">
        <button class="ghost" :disabled="loading" @click="load"><RefreshCw :size="15" />刷新</button>
      </div>
    </div>

    <div v-if="error" class="card error-card">
      <span class="error">{{ error }}</span>
      <button class="sm" @click="load">重试</button>
    </div>

    <!-- 概览 -->
    <div class="stats">
      <template v-if="loading && !o">
        <div v-for="i in 8" :key="i" class="card stat">
          <div class="skeleton" style="width: 80px; height: 12px" />
          <div class="skeleton" style="width: 96px; height: 24px; margin-top: 8px" />
          <div class="skeleton" style="width: 64px; height: 12px; margin-top: 4px" />
        </div>
      </template>
      <div v-for="s in stats" v-else :key="s.label" class="card stat">
        <div class="stat-label"><component :is="s.icon" :size="14" />{{ s.label }}</div>
        <div class="stat-value">{{ s.value }}</div>
        <div class="stat-sub">{{ s.sub }}</div>
      </div>
    </div>

    <!-- 回收站 -->
    <section class="section">
      <div class="section-head">
        <h2>回收站</h2>
        <span class="muted">删除的设计稿保留 {{ o?.trashDays ?? 30 }} 天后自动彻底删除</span>
      </div>

      <div v-if="loading && !o" class="table-wrap">
        <table>
          <tbody>
            <tr v-for="i in 3" :key="i">
              <td><div class="skeleton" style="width: 160px; height: 12px" /></td>
              <td><div class="skeleton" style="width: 96px; height: 12px" /></td>
              <td><div class="skeleton" style="width: 40px; height: 12px" /></td>
              <td><div class="skeleton" style="width: 80px; height: 12px" /></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-else-if="!error && !trash.length" class="card">
        <EmptyState :icon="Trash2" title="回收站是空的" hint="成员删除的设计稿会先放在这里，到期前可以随时恢复。" />
      </div>

      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr><th>设计稿</th><th>项目</th><th class="right">版本数</th><th>删除时间</th><th>彻底删除</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="t in trash" :key="t.id">
              <td><span class="name truncate" :title="t.name">{{ t.name }}</span></td>
              <td class="muted"><span class="truncate proj">{{ t.projectName }}</span></td>
              <td class="right num">{{ t.versionCount }}</td>
              <td class="muted nowrap" :title="formatTime(t.deletedAt)">{{ relativeTime(t.deletedAt) }}</td>
              <td class="nowrap" :title="formatTime(t.purgeAt)">
                <span class="tag" :class="t.purgeAt - Date.now() < 3 * 86_400_000 ? 'red' : 'gray'">{{ daysLeft(t.purgeAt) }}</span>
              </td>
              <td>
                <div class="row-actions">
                  <button class="sm" :disabled="rowBusy === t.id" @click="restore(t)"><RotateCcw :size="14" />恢复</button>
                  <button class="sm danger" :disabled="rowBusy === t.id" @click="purge(t)"><Trash2 :size="14" />彻底删除</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 危险操作 -->
    <section class="section">
      <div class="section-head"><h2>危险操作</h2></div>
      <div class="card danger-zone">
        <div class="dz-row">
          <div class="dz-text">
            <div class="dz-title"><Wrench :size="15" />立即执行维护</div>
            <div class="muted">彻底删除回收站中已到期的设计稿，并回收不再被引用的文件。系统也会定期自动执行。</div>
            <div v-if="report" class="report">{{ report }}</div>
          </div>
          <button class="danger" :disabled="busy" @click="maintain">{{ busy ? "执行中…" : "执行维护" }}</button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.inline-icon {
  vertical-align: -2px;
  margin-right: 4px;
}
.error-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}
.error-card .error {
  margin: 0;
}
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
}
.stat {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 16px;
}
.stat-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--muted);
}
.stat-value {
  margin-top: 4px;
  font-size: 24px;
  font-weight: 650;
  line-height: 1.2;
  color: var(--text);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
}
.stat-sub {
  font-size: 12px;
  color: var(--faint);
}
.section {
  margin-top: 32px;
}
.section-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 12px;
}
.section-head h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
}
.section-head .muted {
  font-size: 12px;
}
.name {
  display: block;
  max-width: 280px;
  font-weight: 500;
}
.proj {
  display: block;
  max-width: 200px;
}
.right {
  text-align: right;
}
.num {
  font-variant-numeric: tabular-nums;
}
.nowrap {
  white-space: nowrap;
}
.row-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.danger-zone {
  border-color: color-mix(in srgb, var(--danger) 32%, var(--border));
}
.dz-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.dz-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.dz-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: var(--text);
}
.report {
  margin-top: 4px;
  font-size: 12px;
  color: var(--ok);
}
</style>
