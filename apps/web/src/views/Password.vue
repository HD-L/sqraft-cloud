<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { api, loadSession, session } from "../api";

const router = useRouter();
const current = ref("");
const next = ref("");
const confirm = ref("");
const error = ref("");
const done = ref(false);

async function submit() {
  error.value = "";
  if (next.value !== confirm.value) {
    error.value = "两次输入的新密码不一致";
    return;
  }
  try {
    await api("POST", "/me/password", { currentPassword: current.value, newPassword: next.value });
    done.value = true;
    const first = session.user?.mustChangePassword;
    await loadSession();
    if (first) await router.replace("/");
  } catch (e) {
    error.value = (e as Error).message;
  }
}
</script>

<template>
  <div class="page" style="max-width: 420px">
    <h1>修改密码</h1>
    <p v-if="session.user?.mustChangePassword" class="notice">首次登录，请先把初始密码改成你自己的密码。</p>
    <form class="card" @submit.prevent="submit">
      <label class="field">当前密码<input v-model="current" type="password" autocomplete="current-password" required /></label>
      <label class="field">新密码（至少 8 位）<input v-model="next" type="password" autocomplete="new-password" minlength="8" required /></label>
      <label class="field">再输入一次<input v-model="confirm" type="password" autocomplete="new-password" required /></label>
      <p v-if="error" class="error">{{ error }}</p>
      <p v-if="done" style="color: var(--ok)">已修改；其它设备上的登录已失效。</p>
      <button class="primary">保存</button>
    </form>
  </div>
</template>
