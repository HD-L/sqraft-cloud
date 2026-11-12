<script setup lang="ts">
/**
 * MCP 接入（M4、T1–T3）：创建令牌（明文只显示一次）、吊销，给出 Claude Code / Cursor / VS Code 的复制即用配置。
 */
import { computed, onMounted, ref } from "vue";
import { api, formatTime } from "../api";

interface Token {
  id: string;
  name: string;
  purpose: "mcp" | "uploader";
  hint: string;
  projectIds: string[] | null;
  expiresAt: number | null;
  lastUsedAt: number | null;
  lastUsedIp: string | null;
  revoked: boolean;
  createdAt: number;
}

const tokens = ref<Token[]>([]);
const projects = ref<Array<{ id: string; name: string }>>([]);
const name = ref("");
const purpose = ref<"mcp" | "uploader">("mcp");
const days = ref<string>("90");
const scoped = ref(false);
const scope = ref<string[]>([]);
const created = ref<string | null>(null);
const error = ref("");
const client = ref<"claude" | "cursor" | "vscode">("claude");

const endpoint = `${location.origin}/mcp`;
const shownToken = computed(() => created.value ?? "<你的令牌>");
const snippet = computed(() => {
  const t = shownToken.value;
  if (client.value === "claude") return `claude mcp add --transport http sqraft ${endpoint} --header "Authorization: Bearer ${t}"`;
  if (client.value === "cursor") {
    return JSON.stringify({ mcpServers: { sqraft: { url: endpoint, headers: { Authorization: `Bearer ${t}` } } } }, null, 2);
  }
  return JSON.stringify({ servers: { sqraft: { type: "http", url: endpoint, headers: { Authorization: `Bearer ${t}` } } } }, null, 2);
});
const snippetHint = computed(
  () =>
    ({
      claude: "在项目目录的终端里执行：",
      cursor: "写进 ~/.cursor/mcp.json（全局）或项目里的 .cursor/mcp.json：",
      vscode: "写进项目里的 .vscode/mcp.json：",
    })[client.value],
);

async function load() {
  tokens.value = (await api<{ tokens: Token[] }>("GET", "/tokens")).tokens;
  projects.value = (await api<{ projects: Array<{ id: string; name: string }> }>("GET", "/projects")).projects;
}

async function create() {
  error.value = "";
  try {
    const res = await api<{ token: string }>("POST", "/tokens", {
      name: name.value.trim(),
      purpose: purpose.value,
      expiresInDays: days.value === "never" ? null : Number(days.value),
      ...(scoped.value ? { projectIds: scope.value } : {}),
    });
    created.value = res.token;
    name.value = "";
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function revoke(t: Token) {
  if (!confirm(`吊销令牌「${t.name}」？使用它的 AI 助手 / 客户端会立即失去访问。`)) return;
  await api("DELETE", `/tokens/${t.id}`);
  await load();
}

async function copy(text: string) {
  await navigator.clipboard.writeText(text);
}

onMounted(() => void load().catch((e) => (error.value = (e as Error).message)));
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>MCP 令牌</h1>
        <div class="sub">
          让 Claude Code、Cursor 等 AI 编码助手通过 MCP 只读访问你有权限的设计稿：页面布局、Token、组件和切图。
          令牌继承你的项目权限，可再限定到部分项目。
        </div>
      </div>
    </div>

    <div class="card">
      <h2 style="margin-top: 0">1. 创建令牌</h2>
      <form class="row" @submit.prevent="create">
        <input v-model="name" placeholder="名称，如「我的 Claude Code」" maxlength="64" required style="width: 220px" />
        <select v-model="purpose">
          <option value="mcp">MCP 读稿（只读）</option>
          <option value="uploader">上传客户端（可上传）</option>
        </select>
        <select v-model="days">
          <option value="30">30 天</option>
          <option value="90">90 天</option>
          <option value="365">365 天</option>
          <option value="never">不过期</option>
        </select>
        <label class="row"><input v-model="scoped" type="checkbox" /> 只允许部分项目</label>
        <button class="primary">创建</button>
      </form>
      <div v-if="scoped" class="row" style="margin-top: 8px">
        <label v-for="p in projects" :key="p.id" class="row"><input v-model="scope" type="checkbox" :value="p.id" /> {{ p.name }}</label>
      </div>
      <p v-if="error" class="error">{{ error }}</p>
      <div v-if="created" class="notice">
        <strong>令牌只显示这一次，请立即复制保存：</strong>
        <pre class="code">{{ created }}</pre>
        <button @click="copy(created)">复制令牌</button>
      </div>

      <h2>2. 配置 AI 助手</h2>
      <div class="row" style="margin-bottom: 8px">
        <button :class="{ primary: client === 'claude' }" @click="client = 'claude'">Claude Code</button>
        <button :class="{ primary: client === 'cursor' }" @click="client = 'cursor'">Cursor</button>
        <button :class="{ primary: client === 'vscode' }" @click="client = 'vscode'">VS Code</button>
      </div>
      <p class="muted">{{ snippetHint }}</p>
      <pre class="code">{{ snippet }}</pre>
      <button @click="copy(snippet)">复制配置</button>
      <p class="muted">配置好后，对 AI 说「用 sqraft 的设计稿实现登录页」即可；它会依次列出设计稿、页面并读取布局。</p>
    </div>

    <h2>我的令牌</h2>
    <div class="table-wrap"><table>
      <thead>
        <tr><th>名称</th><th>用途</th><th>令牌</th><th>范围</th><th>到期</th><th>最近使用</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="t in tokens" :key="t.id" :class="{ muted: t.revoked }">
          <td>{{ t.name }}</td>
          <td><span class="tag" :class="{ gray: t.purpose === 'mcp' }">{{ t.purpose === "mcp" ? "MCP 只读" : "上传" }}</span></td>
          <td><code>{{ t.hint }}</code></td>
          <td>{{ t.projectIds ? `${t.projectIds.length} 个项目` : "全部有权限的项目" }}</td>
          <td>{{ t.expiresAt ? formatTime(t.expiresAt) : "不过期" }}</td>
          <td>{{ t.lastUsedAt ? `${formatTime(t.lastUsedAt)} · ${t.lastUsedIp}` : "从未使用" }}</td>
          <td>
            <span v-if="t.revoked" class="tag red">已吊销</span>
            <button v-else class="link danger" @click="revoke(t)">吊销</button>
          </td>
        </tr>
        <tr v-if="!tokens.length"><td colspan="7" class="muted">还没有令牌</td></tr>
      </tbody>
    </table></div>
  </div>
</template>
