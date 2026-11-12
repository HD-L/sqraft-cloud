<script setup lang="ts">
/** 登录（A1）：账号密码。 */
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { login } from "../api";

const route = useRoute();
const router = useRouter();
const username = ref("");
const password = ref("");
const error = ref("");
const busy = ref(false);

async function submit() {
  error.value = "";
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
</script>

<template>
  <div class="wrap">
    <div class="brand">
      <div class="logo"><span class="mark">云</span>云设计</div>
      <p>团队私有的设计稿共享平台</p>
    </div>
    <form class="card" @submit.prevent="submit">
      <h1>登录</h1>
      <label class="field">用户名<input v-model="username" autocomplete="username" autofocus required /></label>
      <label class="field">密码<input v-model="password" type="password" autocomplete="current-password" required /></label>
      <p v-if="error" class="error">{{ error }}</p>
      <button class="primary" :disabled="busy" style="width: 100%; padding: 10px">登录</button>
      <p class="muted hint">没有账号？请联系团队管理员为你开通。</p>
    </form>
  </div>
</template>

<style scoped>
.wrap {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 24px;
  padding: 16px;
  background: linear-gradient(160deg, var(--sidebar-bg), #2c3352 60%, #3b4675);
}
.brand {
  text-align: center;
  color: #cfd6f2;
}
.logo {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: #fff;
  font-size: 22px;
  font-weight: 700;
}
.mark {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  background: linear-gradient(135deg, #4d7cff, #2f5cff);
  display: grid;
  place-items: center;
  font-size: 16px;
}
.brand p {
  margin: 6px 0 0;
  font-size: 13px;
}
form {
  width: 360px;
  max-width: 100%;
  padding: 28px;
  box-shadow: var(--shadow-lg);
}
h1 {
  font-size: 18px;
}
input {
  width: 100%;
}
.hint {
  font-size: 12px;
  text-align: center;
  margin: 14px 0 0;
}
</style>
