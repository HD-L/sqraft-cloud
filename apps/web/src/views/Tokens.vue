<script setup lang="ts">
/**
 * MCP 接入（M4、T1–T3）：创建令牌（明文只显示一次）、吊销，给出 Claude Code / Cursor / VS Code 的复制即用配置。
 */
import { computed, onMounted, ref } from "vue";
import { AlertTriangle, Bot, Check, Copy, Eye, FolderLock, KeyRound, Plus, ShieldCheck, Terminal } from "lucide-vue-next";
import { api, formatTime, relativeTime } from "../api";
import { confirmDialog, toast } from "../ui";
import EmptyState from "../components/EmptyState.vue";
import Modal from "../components/Modal.vue";

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
const loading = ref(true);
const loadError = ref("");

const formOpen = ref(false);
const name = ref("");
const purpose = ref<"mcp" | "uploader">("mcp");
const days = ref<string>("90");
const scoped = ref(false);
const scope = ref<string[]>([]);
const creating = ref(false);
const error = ref("");
/** 刚创建的令牌明文：只在本页内存里，刷新即消失 */
const created = ref<string | null>(null);
/** 弹窗是否处于「已创建、展示明文」阶段 */
const showCreated = ref(false);
const client = ref<"claude" | "cursor" | "vscode">("claude");
const copied = ref<string | null>(null);

const CLIENTS = [
  { id: "claude", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "vscode", label: "VS Code" },
] as const;

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

const projectName = (id: string) => projects.value.find((p) => p.id === id)?.name ?? "已删除的项目";
const scopeTitle = (t: Token) => (t.projectIds ? t.projectIds.map(projectName).join("、") : "");
const isExpired = (t: Token) => t.expiresAt !== null && t.expiresAt < Date.now();
const activeCount = computed(() => tokens.value.filter((t) => !t.revoked && !isExpired(t)).length);
const canSubmit = computed(() => !!name.value.trim() && (!scoped.value || scope.value.length > 0) && !creating.value);

async function load() {
  loadError.value = "";
  try {
    const [t, p] = await Promise.all([
      api<{ tokens: Token[] }>("GET", "/tokens"),
      api<{ projects: Array<{ id: string; name: string }> }>("GET", "/projects"),
    ]);
    tokens.value = t.tokens;
    projects.value = p.projects;
  } catch (e) {
    loadError.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

function openForm() {
  // 上一个令牌的「已复制」状态不能带到新令牌上，否则没复制就关闭也不会提醒
  copied.value = null;
  name.value = "";
  purpose.value = "mcp";
  days.value = "90";
  scoped.value = false;
  scope.value = [];
  error.value = "";
  showCreated.value = false;
  formOpen.value = true;
}

async function create() {
  if (!canSubmit.value) return;
  error.value = "";
  creating.value = true;
  try {
    const res = await api<{ token: string }>("POST", "/tokens", {
      name: name.value.trim(),
      purpose: purpose.value,
      expiresInDays: days.value === "never" ? null : Number(days.value),
      ...(scoped.value ? { projectIds: scope.value } : {}),
    });
    created.value = res.token;
    showCreated.value = true;
    name.value = "";
    toast.success("令牌已创建");
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    creating.value = false;
  }
}

async function closeForm() {
  if (showCreated.value && copied.value !== "token") {
    const ok = await confirmDialog({
      title: "还没有复制令牌",
      message: "关闭后无法再次查看完整令牌，只能吊销后重新创建。",
      confirmText: "仍然关闭",
    });
    if (!ok) return;
  }
  formOpen.value = false;
}

async function revoke(t: Token) {
  const ok = await confirmDialog({
    title: `吊销令牌「${t.name}」？`,
    message: "使用它的 AI 助手 / 客户端会立即失去访问，此操作不可撤销。",
    confirmText: "吊销",
    danger: true,
  });
  if (!ok) return;
  try {
    await api("DELETE", `/tokens/${t.id}`);
    toast.success("令牌已吊销");
    await load();
  } catch (e) {
    toast.error((e as Error).message);
  }
}

async function copy(text: string, key: string) {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = key;
    if (key !== "token") window.setTimeout(() => copied.value === key && (copied.value = null), 1600);
    toast.success("已复制");
  } catch {
    toast.error("复制失败，请手动选中复制");
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>MCP 令牌</h1>
        <div class="sub">让 AI 编码助手读取设计稿，按设计直接写代码</div>
      </div>
      <div class="actions">
        <button class="primary" @click="openForm"><Plus :size="16" />新建令牌</button>
      </div>
    </div>

    <!-- 说明 -->
    <section class="card intro">
      <div class="intro-icon"><Bot :size="20" /></div>
      <div class="intro-body">
        <div class="intro-title">AI 助手接入</div>
        <p class="muted">
          Claude Code、Cursor、VS Code 等支持 MCP 的 AI 助手，可以用令牌读取你有权限的设计稿：页面布局、设计 Token、组件和切图。
        </p>
        <ul class="points">
          <li><Eye :size="15" />MCP 令牌只读，不能修改任何内容</li>
          <li><ShieldCheck :size="15" />继承你的项目权限</li>
          <li><FolderLock :size="15" />可限定到部分项目，随时吊销</li>
        </ul>
      </div>
    </section>

    <!-- 接入配置 -->
    <section class="card setup">
      <div class="setup-head">
        <div>
          <h3><Terminal :size="16" />接入配置</h3>
          <div class="muted small">{{ snippetHint }}</div>
        </div>
        <div class="segmented" role="tablist" aria-label="选择 AI 助手">
          <button
            v-for="c in CLIENTS"
            :key="c.id"
            role="tab"
            :aria-selected="client === c.id"
            :class="{ active: client === c.id }"
            @click="client = c.id"
          >
            {{ c.label }}
          </button>
        </div>
      </div>
      <div class="code-wrap">
        <pre class="code">{{ snippet }}</pre>
        <button class="sm copy-btn" @click="copy(snippet, 'snippet')">
          <component :is="copied === 'snippet' ? Check : Copy" :size="14" />{{ copied === "snippet" ? "已复制" : "复制" }}
        </button>
      </div>
      <div class="setup-foot muted small">
        <span v-if="created" class="tag green dot">已填入刚创建的令牌</span>
        <span v-else>把 <code class="mono">&lt;你的令牌&gt;</code> 换成新建的令牌。</span>
        <span>配置好后，对 AI 说「用 sqraft 的设计稿实现登录页」即可。</span>
      </div>
    </section>

    <!-- 令牌列表 -->
    <div class="list-head">
      <h2>我的令牌</h2>
      <span v-if="!loading && tokens.length" class="muted small">{{ activeCount }} 个有效</span>
    </div>

    <div v-if="loadError" class="card load-error">
      <span class="error">{{ loadError }}</span>
      <button class="sm" @click="load">重试</button>
    </div>
    <div v-else class="table-wrap">
      <table v-if="loading || tokens.length">
        <thead>
          <tr>
            <th>名称</th>
            <th>用途</th>
            <th>令牌</th>
            <th>范围</th>
            <th>到期</th>
            <th>最近使用</th>
            <th class="th-actions"></th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 3" :key="i">
            <td><div class="skeleton" style="width: 120px; height: 14px" /></td>
            <td><div class="skeleton" style="width: 56px; height: 20px; border-radius: 999px" /></td>
            <td><div class="skeleton" style="width: 72px; height: 14px" /></td>
            <td><div class="skeleton" style="width: 96px; height: 14px" /></td>
            <td><div class="skeleton" style="width: 64px; height: 14px" /></td>
            <td><div class="skeleton" style="width: 88px; height: 14px" /></td>
            <td></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="t in tokens" :key="t.id" :class="{ dim: t.revoked || isExpired(t) }">
            <td>
              <div class="name-cell">
                <KeyRound :size="15" class="muted" />
                <span class="truncate" :title="t.name">{{ t.name }}</span>
              </div>
            </td>
            <td>
              <span class="tag" :class="t.purpose === 'mcp' ? 'purple' : 'orange'">{{ t.purpose === "mcp" ? "MCP 只读" : "上传" }}</span>
            </td>
            <td><code class="mono hint">{{ t.hint }}</code></td>
            <td>
              <span v-if="t.projectIds" :title="scopeTitle(t)">{{ t.projectIds.length }} 个项目</span>
              <span v-else class="muted">全部有权限的项目</span>
            </td>
            <td class="num">
              <span v-if="!t.expiresAt" class="muted">不过期</span>
              <span v-else-if="isExpired(t)" class="tag gray" :title="formatTime(t.expiresAt)">已过期</span>
              <span v-else :title="formatTime(t.expiresAt)">{{ formatTime(t.expiresAt) }}</span>
            </td>
            <td class="num">
              <span v-if="t.lastUsedAt" :title="formatTime(t.lastUsedAt)">
                {{ relativeTime(t.lastUsedAt) }}<span v-if="t.lastUsedIp" class="muted"> · {{ t.lastUsedIp }}</span>
              </span>
              <span v-else class="muted">从未使用</span>
            </td>
            <td class="td-actions">
              <span v-if="t.revoked" class="tag red">已吊销</span>
              <div v-else class="row-actions">
                <button class="ghost sm danger-text" @click="revoke(t)">吊销</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-else :icon="KeyRound" title="还没有令牌" hint="新建一个 MCP 令牌并配置到 AI 助手里，AI 就能读取设计稿。">
        <button class="primary" @click="openForm"><Plus :size="16" />新建令牌</button>
      </EmptyState>
    </div>

    <!-- 新建令牌 -->
    <Modal v-if="formOpen" :title="showCreated ? '令牌已创建' : '新建令牌'" :width="500" @close="closeForm">
      <form v-if="!showCreated" id="token-form" @submit.prevent="create">
        <label class="field">
          名称
          <input v-model="name" placeholder="如「我的 Claude Code」" maxlength="64" required autofocus />
        </label>
        <div class="field-group">
          <div class="group-label">用途</div>
          <div class="choice-grid">
            <label class="choice" :class="{ on: purpose === 'mcp' }">
              <input v-model="purpose" type="radio" value="mcp" />
              <span>
                <span class="choice-title">MCP 读稿</span>
                <span class="choice-desc">AI 助手只读访问</span>
              </span>
            </label>
            <label class="choice" :class="{ on: purpose === 'uploader' }">
              <input v-model="purpose" type="radio" value="uploader" />
              <span>
                <span class="choice-title">上传客户端</span>
                <span class="choice-desc">可以上传设计稿</span>
              </span>
            </label>
          </div>
        </div>
        <label class="field">
          有效期
          <select v-model="days">
            <option value="30">30 天</option>
            <option value="90">90 天</option>
            <option value="365">365 天</option>
            <option value="never">不过期</option>
          </select>
        </label>
        <div class="field-group">
          <label class="check"><input v-model="scoped" type="checkbox" />只允许部分项目</label>
          <template v-if="scoped">
            <div class="project-list">
              <label v-for="p in projects" :key="p.id" class="check project-item">
                <input v-model="scope" type="checkbox" :value="p.id" />
                <span class="truncate">{{ p.name }}</span>
              </label>
              <div v-if="!projects.length" class="muted small empty-projects">没有可选的项目</div>
            </div>
            <div class="field-hint scope-hint">已选 {{ scope.length }} 个项目</div>
          </template>
        </div>
        <p v-if="error" class="error">{{ error }}</p>
      </form>
      <template v-else>
        <div class="once-warning">
          <AlertTriangle :size="16" />
          <span>令牌只显示这一次，关闭后无法再查看，请立即复制保存。</span>
        </div>
        <div class="token-box">
          <code class="mono">{{ created }}</code>
          <button class="sm primary" @click="copy(created ?? '', 'token')">
            <component :is="copied === 'token' ? Check : Copy" :size="14" />{{ copied === "token" ? "已复制" : "复制" }}
          </button>
        </div>
        <p class="muted small created-tip">令牌已填入页面上的接入配置，可以直接复制配置使用。</p>
      </template>
      <template #footer>
        <template v-if="!showCreated">
          <button type="button" @click="closeForm">取消</button>
          <button type="submit" form="token-form" class="primary" :disabled="!canSubmit">
            {{ creating ? "创建中…" : "创建" }}
          </button>
        </template>
        <button v-else class="primary" @click="closeForm">完成</button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.small {
  font-size: 12px;
}

/* 说明 */
.intro {
  display: flex;
  gap: 16px;
  padding: 20px;
  margin-bottom: 16px;
}
.intro-icon {
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: var(--radius);
  background: var(--purple-soft);
  color: var(--purple);
}
.intro-body {
  min-width: 0;
}
.intro-title {
  font-size: 14px;
  font-weight: 650;
}
.intro-body p {
  margin: 4px 0 12px;
  line-height: 1.6;
  max-width: 720px;
}
.points {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 24px;
  margin: 0;
  padding: 0;
  list-style: none;
  color: var(--text-2);
}
.points li {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.points svg {
  color: var(--muted);
}

/* 接入配置 */
.setup {
  padding: 20px;
}
.setup-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.setup-head h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 4px;
}
.code-wrap {
  position: relative;
}
.code-wrap pre.code {
  margin: 0;
  padding-right: 96px;
  min-height: 48px;
}
.copy-btn {
  position: absolute;
  top: 8px;
  right: 8px;
}
.setup-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 12px;
}

/* 列表 */
.list-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 28px 0 12px;
}
.list-head h2 {
  margin: 0;
}
.load-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.load-error .error {
  margin: 0;
}
.name-cell {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 240px;
  font-weight: 550;
}
.hint {
  color: var(--text-2);
  background: var(--hover);
  padding: 2px 6px;
  border-radius: 4px;
}
.num {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.th-actions,
.td-actions {
  width: 1%;
  text-align: right;
  white-space: nowrap;
}
.danger-text {
  color: var(--danger);
}
.danger-text:hover {
  background: var(--danger-soft);
  color: var(--danger);
}
tr.dim td {
  color: var(--muted);
}
tr.dim .tag:not(.red) {
  opacity: 0.6;
}

/* 弹窗表单 */
.field-group {
  margin-bottom: 16px;
}
.group-label {
  font-size: 12px;
  font-weight: 550;
  color: var(--text-2);
  margin-bottom: 6px;
}
.choice-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.choice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition:
    border-color 0.12s var(--ease),
    background 0.12s var(--ease);
}
.choice:hover {
  background: var(--panel-2);
}
.choice.on {
  border-color: var(--brand);
  background: var(--brand-soft);
}
.choice input {
  margin-top: 2px;
}
.choice > span {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.choice-title {
  font-weight: 600;
}
.choice-desc {
  font-size: 12px;
  color: var(--muted);
}
.check {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.project-list {
  margin-top: 8px;
  max-height: 200px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 4px;
}
.project-item {
  display: flex;
  padding: 4px 8px;
  border-radius: 5px;
  min-width: 0;
  height: 32px;
}
.project-item:hover {
  background: var(--hover);
}
.empty-projects {
  padding: 8px;
}
.scope-hint {
  margin-top: 8px;
}

/* 一次性展示 */
.once-warning {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 12px;
  border-radius: var(--radius-sm);
  background: var(--warning-soft);
  color: var(--warning);
  font-weight: 550;
  line-height: 1.5;
  margin-bottom: 12px;
}
.once-warning svg {
  margin-top: 2px;
}
.token-box {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 8px 8px 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
}
.token-box code {
  flex: 1;
  min-width: 0;
  word-break: break-all;
  color: var(--text);
  user-select: all;
}
.created-tip {
  margin: 12px 0 0;
}
</style>
