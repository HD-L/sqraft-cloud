<script setup lang="ts">
/** 登录（A1）：账号密码；登录后回到 next 指定的页面。 */
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { AlertCircle, ArrowRight, Bot, Eye, EyeOff, Layers, Loader2, Lock, MessageSquareText, User } from "lucide-vue-next";
import { login } from "../api";

const route = useRoute();
const router = useRouter();
const username = ref("");
const password = ref("");
const error = ref("");
const busy = ref(false);
const showPassword = ref(false);
const capsLock = ref(false);

function onKey(e: KeyboardEvent) {
  capsLock.value = typeof e.getModifierState === "function" && e.getModifierState("CapsLock");
}

async function submit() {
  if (busy.value) return;
  error.value = "";
  if (!username.value.trim() || !password.value) {
    error.value = "请输入用户名和密码";
    return;
  }
  busy.value = true;
  try {
    await login(username.value.trim(), password.value);
    const next = typeof route.query.next === "string" && route.query.next.startsWith("/") ? route.query.next : "/";
    await router.replace(next);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

const features = [
  { icon: Layers, title: "设计稿集中管理", text: "按项目归档，每次上传自动留存版本" },
  { icon: MessageSquareText, title: "在线评审与标注", text: "直接在画板上评论、查看尺寸与样式" },
  { icon: Bot, title: "AI 助手接入", text: "通过 MCP 让 AI 读取设计稿，生成代码" },
];
</script>

<template>
  <div class="auth">
    <div class="bg" aria-hidden="true" />
    <aside class="brand-side">
      <div class="logo"><span class="mark">云</span><span>云设计</span></div>
      <div class="pitch">
        <h2>团队私有的设计稿协作平台</h2>
        <p>上传、查看、评审、交付，设计稿只存在你们自己的服务器上。</p>
        <ul class="features">
          <li v-for="f in features" :key="f.title">
            <span class="f-icon"><component :is="f.icon" :size="16" /></span>
            <div>
              <div class="f-title">{{ f.title }}</div>
              <div class="f-text">{{ f.text }}</div>
            </div>
          </li>
        </ul>
      </div>
      <div class="foot">私有化部署 · 数据不出内网</div>
    </aside>

    <main class="form-side">
      <form class="panel" novalidate @submit.prevent="submit">
        <div class="logo compact"><span class="mark">云</span><span>云设计</span></div>
        <h1>登录</h1>
        <p class="lead">使用团队管理员为你开通的账号登录</p>

        <label class="field">
          用户名
          <span class="input-wrap">
            <User :size="15" class="lead-icon" />
            <input v-model="username" autocomplete="username" autofocus placeholder="输入用户名" :disabled="busy" @input="error = ''" />
          </span>
        </label>
        <label class="field">
          密码
          <span class="input-wrap">
            <Lock :size="15" class="lead-icon" />
            <input
              v-model="password"
              class="has-eye"
              :type="showPassword ? 'text' : 'password'"
              autocomplete="current-password"
              placeholder="输入密码"
              :disabled="busy"
              @input="error = ''"
              @keydown="onKey"
              @keyup="onKey"
            />
            <button
              type="button"
              class="ghost icon-btn sm eye"
              :title="showPassword ? '隐藏密码' : '显示密码'"
              :aria-label="showPassword ? '隐藏密码' : '显示密码'"
              @click="showPassword = !showPassword"
            >
              <EyeOff v-if="showPassword" :size="15" />
              <Eye v-else :size="15" />
            </button>
          </span>
          <span v-if="capsLock" class="field-hint warn">大写锁定已开启</span>
        </label>

        <div v-if="error" class="alert" role="alert">
          <AlertCircle :size="15" />
          <span>{{ error }}</span>
        </div>

        <button type="submit" class="primary submit" :disabled="busy">
          <Loader2 v-if="busy" :size="15" class="spin" />
          <span>{{ busy ? "登录中…" : "登录" }}</span>
          <ArrowRight v-if="!busy" :size="15" />
        </button>

        <p class="hint">没有账号或忘记密码？请联系团队管理员。</p>
      </form>
    </main>
  </div>
</template>

<style scoped>
.auth {
  position: relative;
  min-height: 100vh;
  display: grid;
  grid-template-columns: minmax(400px, 5fr) 7fr;
  background: var(--bg);
  overflow: hidden;
}
.bg {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px);
  background-size: 32px 32px;
  mask-image: radial-gradient(ellipse 70% 60% at 70% 40%, black, transparent 75%);
  -webkit-mask-image: radial-gradient(ellipse 70% 60% at 70% 40%, black, transparent 75%);
  opacity: 0.6;
}

/* 左侧品牌区 */
.brand-side {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 40px;
  padding: 40px 48px;
  background:
    radial-gradient(circle at 0% 0%, var(--brand-soft-2), transparent 55%),
    radial-gradient(circle at 100% 100%, var(--purple-soft), transparent 50%),
    var(--panel);
  border-right: 1px solid var(--border);
}
.logo {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 650;
  color: var(--text);
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
.pitch h2 {
  margin: 0 0 12px;
  font-size: 28px;
  line-height: 1.3;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: var(--text);
}
.pitch > p {
  margin: 0 0 32px;
  font-size: 14px;
  color: var(--text-2);
  max-width: 360px;
}
.features {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.features li {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.f-icon {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border-radius: var(--radius-sm);
  background: var(--panel);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-xs);
  color: var(--brand);
  display: grid;
  place-items: center;
}
.f-title {
  font-weight: 600;
  color: var(--text);
}
.f-text {
  font-size: 12px;
  color: var(--muted);
}
.foot {
  font-size: 12px;
  color: var(--muted);
}

/* 右侧表单 */
.form-side {
  position: relative;
  display: grid;
  place-items: center;
  padding: 40px 24px;
}
.panel {
  width: 360px;
  max-width: 100%;
  padding: 32px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
  animation: rise 0.32s var(--ease);
}
.logo.compact {
  display: none;
  margin-bottom: 24px;
}
.panel h1 {
  margin: 0 0 4px;
}
.lead {
  margin: 0 0 24px;
  color: var(--muted);
}
.input-wrap {
  position: relative;
  display: flex;
  align-items: center;
}
.input-wrap input {
  width: 100%;
  height: 36px;
  padding-left: 32px;
}
.input-wrap input.has-eye {
  padding-right: 36px;
}
.lead-icon {
  position: absolute;
  left: 10px;
  color: var(--faint);
  pointer-events: none;
}
.input-wrap:focus-within .lead-icon {
  color: var(--brand);
}
.eye {
  position: absolute;
  right: 4px;
  color: var(--muted);
}
.warn {
  color: var(--warning);
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
  line-height: 1.5;
}
.alert svg {
  margin-top: 1px;
}
.submit {
  width: 100%;
  height: 36px;
  margin-top: 4px;
  gap: 8px;
}
.hint {
  margin: 16px 0 0;
  font-size: 12px;
  text-align: center;
  color: var(--muted);
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

@media (max-width: 880px) {
  .auth {
    grid-template-columns: 1fr;
  }
  .brand-side {
    display: none;
  }
  .logo.compact {
    display: flex;
  }
}
</style>
