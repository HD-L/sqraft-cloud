<script setup lang="ts">
/** 审计日志（G3）：按用户 / 动作 / 时间范围筛选，导出 CSV。 */
import { computed, onMounted, ref } from "vue";
import { Download, KeyRound, RefreshCw, ScrollText, Search, X } from "lucide-vue-next";
import { api, formatTime, relativeTime } from "../../api";
import Avatar from "../../components/Avatar.vue";
import EmptyState from "../../components/EmptyState.vue";

interface Entry {
  id: number;
  at: number;
  username: string | null;
  tokenName: string | null;
  ip: string | null;
  action: string;
  target: string | null;
  result: string;
  detail: Record<string, unknown> | null;
}

const LIMIT = 500;

const ACTIONS: Record<string, string> = {
  "auth.login": "登录",
  "auth.logout": "登出",
  "user.create": "创建用户",
  "user.disable": "停用用户",
  "user.enable": "启用用户",
  "user.set_admin": "变更管理员",
  "user.set_role": "变更角色",
  "user.project_scope": "变更项目范围",
  "user.reset_password": "重置密码",
  "user.password_change": "修改密码",
  "token.create": "创建令牌",
  "token.revoke": "吊销令牌",
  "project.create": "创建项目",
  "project.update": "编辑项目",
  "project.rename": "重命名项目",
  "project.archive": "归档项目",
  "project.unarchive": "取消归档",
  "project.member_set": "设置成员",
  "project.member_remove": "移出成员",
  "design.create": "新建设计稿",
  "design.rename": "重命名设计稿",
  "design.status": "变更状态",
  "design.delete": "删除设计稿",
  "design.upload": "上传版本",
  "design.rollback": "回滚版本",
  "design.restore": "恢复设计稿",
  "design.purge": "彻底删除设计稿",
  "comment.create": "发表评论",
  "comment.delete": "删除评论",
  "mcp.call": "MCP 调用",
  "oauth.authorize": "授权客户端",
  "system.maintenance": "执行维护",
};

/** 动作分类 → 标签颜色 */
const CATEGORY_TAG: Record<string, string> = {
  auth: "gray",
  user: "orange",
  token: "yellow",
  oauth: "yellow",
  project: "",
  design: "green",
  comment: "green",
  mcp: "purple",
  system: "red",
};

const CATEGORIES = [
  { value: "", label: "全部动作" },
  { value: "auth", label: "登录 / 登出" },
  { value: "design", label: "设计稿" },
  { value: "comment", label: "评论" },
  { value: "mcp", label: "MCP 调用" },
  { value: "token", label: "令牌" },
  { value: "oauth", label: "客户端授权" },
  { value: "user", label: "用户" },
  { value: "project", label: "项目" },
  { value: "system", label: "系统" },
];

const RANGES = [
  { value: "all", label: "全部时间" },
  { value: "1", label: "近 24 小时" },
  { value: "7", label: "近 7 天" },
  { value: "30", label: "近 30 天" },
];

const entries = ref<Entry[]>([]);
const user = ref("");
const action = ref("");
const range = ref("all");
const loading = ref(true);
const error = ref("");

const filtered = computed(() => !!(user.value.trim() || action.value || range.value !== "all"));

function query(extra: Record<string, string>) {
  const q = new URLSearchParams(extra);
  if (user.value.trim()) q.set("user", user.value.trim());
  if (action.value) q.set("action", action.value);
  if (range.value !== "all") q.set("from", String(Date.now() - Number(range.value) * 86_400_000));
  return q;
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    entries.value = (await api<{ entries: Entry[] }>("GET", `/admin/audit?${query({ limit: String(LIMIT) })}`)).entries;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

function csvUrl() {
  return `/api/v1/admin/audit?${query({ format: "csv" })}`;
}

function reset() {
  user.value = "";
  action.value = "";
  range.value = "all";
  void load();
}

function actionTag(a: string) {
  return CATEGORY_TAG[a.split(".")[0]] ?? "gray";
}

function resultLabel(r: string) {
  return r === "ok" ? "成功" : r === "denied" ? "拒绝" : "失败";
}

function detailText(d: Record<string, unknown> | null) {
  if (!d) return "";
  return Object.entries(d)
    .map(([k, v]) => `${k}: ${typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}`)
    .join("  ·  ");
}

onMounted(() => void load());
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>审计日志</h1>
        <div class="sub">登录、权限变更、上传、MCP 调用等操作都会记录在这里</div>
      </div>
      <div class="actions">
        <a class="button" :href="csvUrl()"><Download :size="15" />导出 CSV</a>
      </div>
    </div>

    <form class="toolbar" @submit.prevent="load">
      <label class="search-box user-box">
        <Search :size="15" />
        <input v-model="user" placeholder="用户名，回车筛选" />
      </label>
      <select v-model="action" @change="load">
        <option v-for="c in CATEGORIES" :key="c.value" :value="c.value">{{ c.label }}</option>
      </select>
      <select v-model="range" @change="load">
        <option v-for="r in RANGES" :key="r.value" :value="r.value">{{ r.label }}</option>
      </select>
      <button type="submit" class="primary">筛选</button>
      <button v-if="filtered" type="button" class="ghost" @click="reset"><X :size="15" />清除</button>
      <span class="spacer" />
      <span v-if="!loading && !error" class="muted count">
        {{ entries.length >= LIMIT ? `显示最近 ${LIMIT} 条` : `共 ${entries.length} 条` }}
      </span>
      <button type="button" class="icon-btn ghost" title="刷新" :disabled="loading" @click="load"><RefreshCw :size="15" /></button>
    </form>

    <div v-if="error" class="card error-card">
      <span class="error">{{ error }}</span>
      <button class="sm" @click="load">重试</button>
    </div>

    <div v-else-if="loading" class="table-wrap">
      <table>
        <thead>
          <tr><th>时间</th><th>操作者</th><th>动作</th><th>对象</th><th>结果</th><th>详情</th><th>IP</th></tr>
        </thead>
        <tbody>
          <tr v-for="i in 8" :key="i">
            <td><div class="skeleton" style="width: 64px; height: 12px" /></td>
            <td><div class="row"><div class="skeleton" style="width: 24px; height: 24px; border-radius: 50%" /><div class="skeleton" style="width: 72px; height: 12px" /></div></td>
            <td><div class="skeleton" style="width: 72px; height: 20px; border-radius: 999px" /></td>
            <td><div class="skeleton" style="width: 120px; height: 12px" /></td>
            <td><div class="skeleton" style="width: 40px; height: 20px; border-radius: 999px" /></td>
            <td><div class="skeleton" style="width: 180px; height: 12px" /></td>
            <td><div class="skeleton" style="width: 80px; height: 12px" /></td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-else-if="!entries.length" class="card">
      <EmptyState
        :icon="ScrollText"
        :title="filtered ? '没有符合条件的记录' : '还没有审计记录'"
        :hint="filtered ? '换个用户名、动作或时间范围试试。' : '成员登录、上传设计稿、调用 MCP 后，记录会出现在这里。'"
      >
        <button v-if="filtered" @click="reset">清除筛选</button>
      </EmptyState>
    </div>

    <div v-else class="table-wrap">
      <table>
        <thead>
          <tr><th>时间</th><th>操作者</th><th>动作</th><th>对象</th><th>结果</th><th>详情</th><th>IP</th></tr>
        </thead>
        <tbody>
          <tr v-for="e in entries" :key="e.id">
            <td class="muted nowrap num" :title="formatTime(e.at)">{{ relativeTime(e.at) }}</td>
            <td>
              <div v-if="e.username" class="actor">
                <Avatar :name="e.username" :size="24" />
                <div class="actor-text">
                  <span class="truncate">{{ e.username }}</span>
                  <span v-if="e.tokenName" class="token truncate" :title="`令牌：${e.tokenName}`"><KeyRound :size="11" />{{ e.tokenName }}</span>
                </div>
              </div>
              <span v-else class="muted">—</span>
            </td>
            <td class="nowrap">
              <span class="tag" :class="actionTag(e.action)" :title="e.action">{{ ACTIONS[e.action] ?? e.action }}</span>
            </td>
            <td><code v-if="e.target" class="mono target truncate" :title="e.target">{{ e.target }}</code><span v-else class="muted">—</span></td>
            <td class="nowrap">
              <span class="tag dot" :class="e.result === 'ok' ? 'green' : 'red'">{{ resultLabel(e.result) }}</span>
            </td>
            <td>
              <div v-if="e.detail" class="detail" :title="JSON.stringify(e.detail, null, 2)">{{ detailText(e.detail) }}</div>
              <span v-else class="muted">—</span>
            </td>
            <td class="muted mono nowrap ip">{{ e.ip ?? "—" }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.user-box {
  width: 220px;
}
.toolbar select {
  width: auto;
  min-width: 128px;
}
.count {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.error-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.error-card .error {
  margin: 0;
}
.nowrap {
  white-space: nowrap;
}
.num {
  font-variant-numeric: tabular-nums;
}
.actor {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 180px;
}
.actor-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.3;
}
.token {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}
.target {
  display: inline-block;
  max-width: 180px;
  font-size: 12px;
  color: var(--text-2);
  vertical-align: middle;
}
.detail {
  max-width: 360px;
  white-space: normal;
  word-break: break-all;
  line-height: 1.5;
  font-size: 12px;
  color: var(--muted);
}
.ip {
  font-size: 12px;
}
</style>
