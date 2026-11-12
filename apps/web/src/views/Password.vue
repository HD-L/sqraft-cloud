<script setup lang="ts">
/** 修改密码：首次登录强制修改（路由守卫会把人带到这里），也可以从设置页进来主动修改。 */
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { AlertCircle, ArrowLeft, Check, CheckCircle2, Circle, KeyRound, Loader2, LogOut } from "lucide-vue-next";
import { api, loadSession, logout, session } from "../api";
import { toast } from "../ui";

const MIN_LENGTH = 8;

const router = useRouter();
const route = useRoute();
const current = ref("");
const next = ref("");
const confirm = ref("");
const error = ref("");
const done = ref(false);
const busy = ref(false);

/** 打开页面时是否是首次登录强制改密码（提交后 session 会刷新，这里记住初始状态） */
const forced = ref(!!session.user?.mustChangePassword);

const rules = computed(() => [
  { text: `至少 ${MIN_LENGTH} 位`, ok: next.value.length >= MIN_LENGTH },
  { text: "与当前密码不同", ok: !!next.value && next.value !== current.value },
  { text: "两次输入一致", ok: !!confirm.value && next.value === confirm.value },
]);
const mismatch = computed(() => !!confirm.value && next.value !== confirm.value);

const target = () => (typeof route.query.next === "string" && route.query.next.startsWith("/") ? route.query.next : "/");

async function submit() {
  if (busy.value) return;
  error.value = "";
  if (!current.value || !next.value) {
    error.value = "请填写当前密码和新密码";
    return;
  }
  if (next.value.length < MIN_LENGTH) {
    error.value = `新密码至少 ${MIN_LENGTH} 位`;
    return;
  }
  if (next.value !== confirm.value) {
    error.value = "两次输入的新密码不一致";
    return;
  }
  busy.value = true;
  try {
    await api("POST", "/me/password", { currentPassword: current.value, newPassword: next.value });
    done.value = true;
    const first = session.user?.mustChangePassword;
    await loadSession();
    toast.success("密码已修改");
    if (first) await router.replace(target());
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

function back() {
  if (window.history.length > 1) router.back();
  else void router.push("/");
}

async function switchAccount() {
  await logout();
  await router.replace("/login");
}
</script>

<template>
  <div class="auth">
    <div class="bg" aria-hidden="true" />
    <header class="top">
      <div class="logo"><span class="mark">云</span><span>云设计</span></div>
      <button v-if="forced" class="ghost sm" @click="switchAccount"><LogOut :size="14" />换个账号</button>
      <button v-else class="ghost sm" @click="back"><ArrowLeft :size="14" />返回</button>
    </header>

    <main class="center">
      <div v-if="done && !forced" class="panel done">
        <span class="badge ok"><CheckCircle2 :size="22" /></span>
        <h1>密码已修改</h1>
        <p class="lead">其它设备上的登录已失效，需要用新密码重新登录。</p>
        <button class="primary wide" @click="back">返回</button>
      </div>

      <form v-else class="panel" novalidate @submit.prevent="submit">
        <span class="badge"><KeyRound :size="20" /></span>
        <h1>{{ forced ? "设置你的密码" : "修改密码" }}</h1>
        <p class="lead">
          <template v-if="forced">
            你正在使用管理员分配的初始密码。为了账号安全，请先换成只有你自己知道的密码，再继续使用。
          </template>
          <template v-else>修改后，其它设备上的登录会全部失效。</template>
        </p>

        <label class="field">
          {{ forced ? "初始密码" : "当前密码" }}
          <input v-model="current" type="password" autocomplete="current-password" autofocus :disabled="busy" @input="error = ''" />
        </label>
        <label class="field">
          新密码
          <input v-model="next" type="password" autocomplete="new-password" :disabled="busy" @input="error = ''" />
        </label>
        <label class="field">
          再输入一次
          <input v-model="confirm" type="password" autocomplete="new-password" :class="{ invalid: mismatch }" :disabled="busy" @input="error = ''" />
        </label>

        <ul class="rules" aria-label="密码要求">
          <li v-for="r in rules" :key="r.text" :class="{ ok: r.ok }">
            <Check v-if="r.ok" :size="13" />
            <Circle v-else :size="13" />
            {{ r.text }}
          </li>
        </ul>

        <div v-if="error" class="alert" role="alert">
          <AlertCircle :size="15" />
          <span>{{ error }}</span>
        </div>

        <button type="submit" class="primary wide" :disabled="busy">
          <Loader2 v-if="busy" :size="15" class="spin" />
          {{ busy ? "保存中…" : forced ? "保存并继续" : "保存新密码" }}
        </button>
      </form>
    </main>
  </div>
</template>

<style scoped>
.auth {
  position: relative;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
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
  mask-image: radial-gradient(ellipse 50% 50% at 50% 40%, black, transparent 75%);
  -webkit-mask-image: radial-gradient(ellipse 50% 50% at 50% 40%, black, transparent 75%);
  opacity: 0.5;
}
.top {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 32px;
}
.top button {
  gap: 4px;
  color: var(--text-2);
}
.logo {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 650;
}
.mark {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  background: var(--brand);
  color: var(--panel);
  display: grid;
  place-items: center;
  font-size: 13px;
  font-weight: 700;
  box-shadow: var(--shadow-xs);
}
.center {
  position: relative;
  flex: 1;
  display: grid;
  place-items: center;
  padding: 24px 24px 80px;
}
.panel {
  width: 400px;
  max-width: 100%;
  padding: 32px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
  animation: rise 0.32s var(--ease);
}
.panel.done {
  text-align: center;
}
.badge {
  width: 40px;
  height: 40px;
  border-radius: var(--radius);
  background: var(--brand-soft);
  color: var(--brand);
  display: inline-grid;
  place-items: center;
  margin-bottom: 16px;
}
.badge.ok {
  background: var(--ok-soft);
  color: var(--ok);
}
.panel h1 {
  margin: 0 0 4px;
}
.lead {
  margin: 0 0 24px;
  color: var(--muted);
}
.panel input {
  width: 100%;
  height: 36px;
}
input.invalid,
input.invalid:focus {
  border-color: var(--danger);
}
.rules {
  list-style: none;
  margin: -4px 0 20px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--muted);
}
.rules li {
  display: flex;
  align-items: center;
  gap: 8px;
  transition: color 0.12s var(--ease);
}
.rules li.ok {
  color: var(--ok);
}
.alert {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 12px;
  margin: 0 0 16px;
  border-radius: var(--radius-sm);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 12px;
}
.alert svg {
  margin-top: 1px;
}
.wide {
  width: 100%;
  height: 36px;
  gap: 8px;
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
