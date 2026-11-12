<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api, formatTime } from "../../api";

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

const ACTIONS: Record<string, string> = {
  "auth.login": "登录",
  "auth.logout": "登出",
  "user.create": "创建用户",
  "user.disable": "停用用户",
  "user.enable": "启用用户",
  "user.set_admin": "变更管理员",
  "user.reset_password": "重置密码",
  "user.password_change": "修改密码",
  "token.create": "创建令牌",
  "token.revoke": "吊销令牌",
  "project.create": "创建项目",
  "project.rename": "重命名项目",
  "project.archive": "归档项目",
  "project.unarchive": "取消归档",
  "project.member_set": "设置成员",
  "project.member_remove": "移出成员",
  "design.create": "新建设计稿",
  "design.rename": "重命名设计稿",
  "design.delete": "删除设计稿",
  "design.upload": "上传版本",
  "design.rollback": "回滚版本",
  "mcp.call": "MCP 调用",
};

const entries = ref<Entry[]>([]);
const user = ref("");
const action = ref("");

async function load() {
  const q = new URLSearchParams({ limit: "500" });
  if (user.value.trim()) q.set("user", user.value.trim());
  if (action.value) q.set("action", action.value);
  entries.value = (await api<{ entries: Entry[] }>("GET", `/admin/audit?${q}`)).entries;
}

function csvUrl() {
  const q = new URLSearchParams({ format: "csv" });
  if (user.value.trim()) q.set("user", user.value.trim());
  if (action.value) q.set("action", action.value);
  return `/api/v1/admin/audit?${q}`;
}

onMounted(() => void load());
</script>

<template>
  <div class="page" style="max-width: 1300px">
    <h1>审计日志</h1>
    <form class="row card" @submit.prevent="load">
      <input v-model="user" placeholder="用户名" />
      <select v-model="action">
        <option value="">全部动作</option>
        <option value="auth">登录 / 登出</option>
        <option value="design">设计稿</option>
        <option value="mcp">MCP 调用</option>
        <option value="token">令牌</option>
        <option value="user">用户</option>
        <option value="project">项目</option>
      </select>
      <button class="primary">筛选</button>
      <span class="spacer" />
      <a class="button" :href="csvUrl()">导出 CSV</a>
    </form>
    <table class="card" style="padding: 0; margin-top: 16px">
      <thead>
        <tr><th>时间</th><th>用户</th><th>令牌</th><th>IP</th><th>动作</th><th>对象</th><th>结果</th><th>详情</th></tr>
      </thead>
      <tbody>
        <tr v-for="e in entries" :key="e.id">
          <td class="muted" style="white-space: nowrap">{{ formatTime(e.at) }}</td>
          <td>{{ e.username ?? "—" }}</td>
          <td>{{ e.tokenName ?? "" }}</td>
          <td class="muted">{{ e.ip }}</td>
          <td>{{ ACTIONS[e.action] ?? e.action }}</td>
          <td><code>{{ e.target ?? "" }}</code></td>
          <td><span class="tag" :class="{ red: e.result !== 'ok' }">{{ e.result === "ok" ? "成功" : e.result === "denied" ? "拒绝" : "失败" }}</span></td>
          <td class="muted" style="font-size: 12px; max-width: 320px; word-break: break-all">{{ e.detail ? JSON.stringify(e.detail) : "" }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
