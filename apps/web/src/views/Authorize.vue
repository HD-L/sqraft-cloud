<script setup lang="ts">
/**
 * 上传客户端的授权确认页（U3）：客户端打开浏览器到 /oauth/authorize?…，用户确认后跳回客户端的自定义协议。
 */
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { AlertTriangle, ArrowLeftRight, CheckCircle2, Clock, Eye, Loader2, LogOut, MonitorUp, ShieldAlert, Upload, XCircle } from "lucide-vue-next";
import { api, logout, session } from "../api";
import Avatar from "../components/Avatar.vue";
import { toast } from "../ui";

const route = useRoute();
const router = useRouter();
const q = (k: string) => (typeof route.query[k] === "string" ? (route.query[k] as string) : "");
const clientId = q("client_id");
const redirectUri = q("redirect_uri");
const state = q("state");

const client = ref<{ id?: string; name: string; purpose?: string; tokenDays: number } | null>(null);
const error = ref("");
/** 授权后接口失败：保留授权界面，只在下方提示 */
const actionError = ref("");
const done = ref<"" | "allowed" | "denied">("");
const busy = ref(false);

const permissions = computed(() => {
  const days = client.value?.tokenDays ?? 0;
  const list = [{ icon: Eye, title: "查看项目与设计稿", text: "你有权限访问的项目、设计稿和版本" }];
  if (client.value?.purpose !== "mcp") {
    list.push({ icon: Upload, title: "上传设计稿", text: "在你有编辑权限的项目里新建设计稿、上传新版本" });
  }
  list.push({ icon: Clock, title: `有效期 ${days} 天`, text: "到期自动失效，也可以随时在「MCP 令牌」页吊销" });
  return list;
});

onMounted(async () => {
  if (q("response_type") !== "code") {
    error.value = "请求参数不对：response_type 必须是 code";
    return;
  }
  try {
    client.value = await api("GET", `/oauth/client?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}`);
  } catch (e) {
    error.value = (e as Error).message;
  }
});

async function allow() {
  busy.value = true;
  actionError.value = "";
  try {
    const res = await api<{ redirectUrl: string }>("POST", "/oauth/authorize", {
      clientId,
      redirectUri,
      codeChallenge: q("code_challenge"),
      codeChallengeMethod: q("code_challenge_method"),
      state,
    });
    done.value = "allowed";
    window.location.href = res.redirectUrl;
  } catch (e) {
    actionError.value = (e as Error).message;
    toast.error(actionError.value);
  } finally {
    busy.value = false;
  }
}

function deny() {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    actionError.value = "回调地址无效，请直接关闭此页面";
    return;
  }
  url.searchParams.set("error", "access_denied");
  if (state) url.searchParams.set("state", state);
  done.value = "denied";
  window.location.href = url.toString();
}

async function switchAccount() {
  await logout();
  await router.replace({ path: "/login", query: { next: route.fullPath } });
}
</script>

<template>
  <div class="auth">
    <div class="bg" aria-hidden="true" />
    <main class="center">
      <div class="panel">
        <!-- 加载中 -->
        <div v-if="!error && !client && !done" class="loading" aria-busy="true">
          <div class="pair">
            <span class="skeleton sq" />
            <span class="skeleton dash" />
            <span class="skeleton sq" />
          </div>
          <div class="skeleton line w60" />
          <div class="skeleton line w80" />
          <div class="skeleton block" />
          <div class="skeleton line w100" />
        </div>

        <!-- 参数或客户端错误 -->
        <div v-else-if="error" class="result">
          <span class="badge danger"><ShieldAlert :size="22" /></span>
          <h1>无法完成授权</h1>
          <p class="lead">{{ error }}</p>
          <p class="foot">请回到客户端重新发起登录。如果问题持续，请联系管理员。</p>
        </div>

        <!-- 已完成 -->
        <div v-else-if="done" class="result">
          <span class="badge" :class="done === 'allowed' ? 'ok' : 'gray'">
            <CheckCircle2 v-if="done === 'allowed'" :size="22" />
            <XCircle v-else :size="22" />
          </span>
          <h1>{{ done === "allowed" ? "已授权" : "已拒绝" }}</h1>
          <p class="lead">可以回到客户端了。如果客户端没有自动切到前台，请手动切换。</p>
          <p class="foot">此页面可以关闭。</p>
        </div>

        <!-- 授权确认 -->
        <template v-else-if="client">
          <div class="pair">
            <span class="app"><MonitorUp :size="20" /></span>
            <span class="connector"><ArrowLeftRight :size="14" /></span>
            <span class="app brand">云</span>
          </div>
          <h1 class="title">
            <strong>{{ client.name }}</strong> 申请访问你的云设计账号
          </h1>

          <div class="account">
            <Avatar :name="session.user?.displayName || session.user?.username || '?'" :size="28" />
            <div class="who">
              <div class="truncate name">{{ session.user?.displayName || session.user?.username }}</div>
              <div class="truncate muted">{{ session.user?.username }}{{ session.user?.email ? ` · ${session.user.email}` : "" }}</div>
            </div>
            <button class="link sm" :disabled="busy" @click="switchAccount"><LogOut :size="13" />换个账号</button>
          </div>

          <div class="section-label">授权后，它将可以</div>
          <ul class="perms">
            <li v-for="p in permissions" :key="p.title">
              <span class="p-icon"><component :is="p.icon" :size="15" /></span>
              <div>
                <div class="p-title">{{ p.title }}</div>
                <div class="p-text">{{ p.text }}</div>
              </div>
            </li>
          </ul>

          <div class="warn">
            <AlertTriangle :size="15" />
            <span>只有你自己刚在客户端点了「登录」时才授权。客户端不会拿到你的密码。</span>
          </div>

          <p v-if="actionError" class="alert" role="alert">{{ actionError }}</p>

          <div class="actions">
            <button :disabled="busy" @click="deny">拒绝</button>
            <button class="primary" :disabled="busy" @click="allow">
              <Loader2 v-if="busy" :size="15" class="spin" />
              {{ busy ? "授权中…" : "允许" }}
            </button>
          </div>
        </template>
      </div>
      <p class="brandline"><span class="mark">云</span>云设计</p>
    </main>
  </div>
</template>

<style scoped>
.auth {
  position: relative;
  min-height: 100vh;
  background:
    radial-gradient(ellipse 60% 40% at 50% 0%, var(--brand-soft), transparent 70%),
    var(--bg);
  overflow: hidden;
}
.bg {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px);
  background-size: 32px 32px;
  mask-image: radial-gradient(ellipse 50% 50% at 50% 35%, black, transparent 75%);
  -webkit-mask-image: radial-gradient(ellipse 50% 50% at 50% 35%, black, transparent 75%);
  opacity: 0.5;
}
.center {
  position: relative;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 20px;
  padding: 48px 24px;
}
.panel {
  width: 420px;
  max-width: 100%;
  padding: 32px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
  animation: rise 0.32s var(--ease);
}

/* 双方图标 */
.pair {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-bottom: 20px;
}
.app {
  width: 44px;
  height: 44px;
  border-radius: var(--radius);
  display: grid;
  place-items: center;
  background: var(--panel-2);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-xs);
  color: var(--text-2);
}
.app.brand {
  background: var(--brand);
  border-color: var(--brand);
  color: var(--panel);
  font-size: 16px;
  font-weight: 700;
}
.connector {
  color: var(--faint);
}
.title {
  font-size: 16px;
  font-weight: 500;
  text-align: center;
  line-height: 1.5;
  margin: 0 0 20px;
}
.title strong {
  font-weight: 650;
}

/* 当前账号 */
.account {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel-2);
  margin-bottom: 20px;
}
.who {
  flex: 1;
  min-width: 0;
  font-size: 12px;
}
.who .name {
  font-size: 13px;
  font-weight: 600;
}
.account button {
  gap: 4px;
  font-size: 12px;
  flex-shrink: 0;
}

.section-label {
  font-size: 12px;
  font-weight: 550;
  color: var(--muted);
  margin-bottom: 8px;
}
.perms {
  list-style: none;
  margin: 0 0 16px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.perms li {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.p-icon {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  border-radius: var(--radius-sm);
  background: var(--brand-soft);
  color: var(--brand);
  display: grid;
  place-items: center;
}
.p-title {
  font-weight: 600;
}
.p-text {
  font-size: 12px;
  color: var(--muted);
}
.warn {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  background: var(--warning-soft);
  color: var(--warning);
  font-size: 12px;
  margin-bottom: 20px;
}
.warn svg {
  margin-top: 1px;
}
.alert {
  padding: 8px 12px;
  margin: -8px 0 16px;
  border-radius: var(--radius-sm);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 12px;
}
.actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.actions button {
  height: 36px;
  gap: 8px;
}

/* 结果 / 错误 */
.result {
  text-align: center;
}
.result h1 {
  margin: 0 0 4px;
}
.lead {
  margin: 0 0 12px;
  color: var(--text-2);
}
.foot {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}
.badge {
  width: 44px;
  height: 44px;
  border-radius: var(--radius);
  display: inline-grid;
  place-items: center;
  margin-bottom: 16px;
  background: var(--brand-soft);
  color: var(--brand);
}
.badge.ok {
  background: var(--ok-soft);
  color: var(--ok);
}
.badge.danger {
  background: var(--danger-soft);
  color: var(--danger);
}
.badge.gray {
  background: var(--hover);
  color: var(--text-2);
}

/* 骨架 */
.loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
.loading .pair {
  margin-bottom: 8px;
}
.skeleton.sq {
  width: 44px;
  height: 44px;
  border-radius: var(--radius);
}
.skeleton.dash {
  width: 24px;
  height: 8px;
}
.skeleton.line {
  height: 12px;
}
.skeleton.block {
  width: 100%;
  height: 120px;
  border-radius: var(--radius);
}
.w60 {
  width: 60%;
}
.w80 {
  width: 80%;
}
.w100 {
  width: 100%;
}

.brandline {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
}
.mark {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  background: var(--brand);
  color: var(--panel);
  display: grid;
  place-items: center;
  font-size: 10px;
  font-weight: 700;
}
.spin {
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}
</style>
