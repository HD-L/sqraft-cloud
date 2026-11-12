<script setup lang="ts">
/** 个人设置：姓名、邮箱；修改密码。 */
import { ref } from "vue";
import { api, loadSession, ROLE_LABEL, session } from "../api";
import Avatar from "../components/Avatar.vue";

const profile = ref({ displayName: session.user?.displayName ?? "", email: session.user?.email ?? "" });
const profileMsg = ref("");
const profileError = ref("");
async function saveProfile() {
  profileMsg.value = "";
  profileError.value = "";
  try {
    await api("PATCH", "/me", profile.value);
    await loadSession();
    profileMsg.value = "已保存";
  } catch (e) {
    profileError.value = (e as Error).message;
  }
}

const pw = ref({ current: "", next: "", confirm: "" });
const pwMsg = ref("");
const pwError = ref("");
async function changePassword() {
  pwMsg.value = "";
  pwError.value = "";
  if (pw.value.next !== pw.value.confirm) {
    pwError.value = "两次输入的新密码不一致";
    return;
  }
  try {
    await api("POST", "/me/password", { currentPassword: pw.value.current, newPassword: pw.value.next });
    pw.value = { current: "", next: "", confirm: "" };
    pwMsg.value = "已修改；其它设备上的登录已失效。";
  } catch (e) {
    pwError.value = (e as Error).message;
  }
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>个人设置</h1>
        <div class="sub">你的资料与登录密码</div>
      </div>
    </div>
    <div class="settings-grid">
      <form class="card pad" @submit.prevent="saveProfile">
        <h3>基本资料</h3>
        <div class="row" style="margin-bottom: 16px; gap: 12px">
          <Avatar :name="profile.displayName || session.user!.username" :size="44" />
          <div>
            <div style="font-weight: 600">@{{ session.user?.username }}</div>
            <div class="muted" style="font-size: 12px">团队{{ ROLE_LABEL[session.user!.role] }}</div>
          </div>
        </div>
        <label class="field">姓名<input v-model="profile.displayName" maxlength="50" placeholder="显示在评论与成员列表里" /></label>
        <label class="field">邮箱<input v-model="profile.email" type="email" maxlength="200" placeholder="name@company.com" /></label>
        <p v-if="profileError" class="error">{{ profileError }}</p>
        <p v-if="profileMsg" style="color: var(--ok); margin: 0 0 10px">{{ profileMsg }}</p>
        <button class="primary">保存</button>
      </form>
      <form class="card pad" @submit.prevent="changePassword">
        <h3>修改密码</h3>
        <label class="field">当前密码<input v-model="pw.current" type="password" autocomplete="current-password" required /></label>
        <label class="field">新密码（至少 8 位）<input v-model="pw.next" type="password" autocomplete="new-password" minlength="8" required /></label>
        <label class="field">再输入一次<input v-model="pw.confirm" type="password" autocomplete="new-password" required /></label>
        <p v-if="pwError" class="error">{{ pwError }}</p>
        <p v-if="pwMsg" style="color: var(--ok); margin: 0 0 10px">{{ pwMsg }}</p>
        <button class="primary">修改密码</button>
      </form>
    </div>
  </div>
</template>

<style scoped>
.pad {
  padding: 20px;
}
</style>
