<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api, formatTime, session, type User } from "../../api";

const users = ref<User[]>([]);
const username = ref("");
const isAdmin = ref(false);
const error = ref("");
const issued = ref<{ username: string; password: string } | null>(null);

async function load() {
  users.value = (await api<{ users: User[] }>("GET", "/admin/users")).users;
}

async function create() {
  error.value = "";
  try {
    const res = await api<{ user: User; initialPassword: string }>("POST", "/admin/users", { username: username.value.trim(), isAdmin: isAdmin.value });
    issued.value = { username: res.user.username, password: res.initialPassword };
    username.value = "";
    isAdmin.value = false;
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function patch(u: User, body: Record<string, unknown>, confirmText?: string) {
  if (confirmText && !confirm(confirmText)) return;
  error.value = "";
  try {
    const res = await api<{ initialPassword?: string }>("PATCH", `/admin/users/${u.id}`, body);
    if (res.initialPassword) issued.value = { username: u.username, password: res.initialPassword };
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

onMounted(() => void load());
</script>

<template>
  <div class="page">
    <h1>用户</h1>
    <form class="card row" @submit.prevent="create">
      <input v-model="username" placeholder="用户名（字母、数字、. _ @ -）" required style="width: 260px" />
      <label class="row"><input v-model="isAdmin" type="checkbox" /> 系统管理员</label>
      <button class="primary">创建用户</button>
      <span class="muted">会生成一次性初始密码，用户首次登录必须修改</span>
    </form>
    <p v-if="error" class="error">{{ error }}</p>
    <div v-if="issued" class="notice">
      「{{ issued.username }}」的初始密码（只显示这一次）：<pre class="code">{{ issued.password }}</pre>
    </div>
    <table class="card" style="padding: 0; margin-top: 16px">
      <thead>
        <tr><th>用户名</th><th>角色</th><th>状态</th><th>创建时间</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="u in users" :key="u.id">
          <td>{{ u.username }}</td>
          <td><span class="tag" :class="{ gray: !u.isAdmin }">{{ u.isAdmin ? "管理员" : "成员" }}</span></td>
          <td>
            <span v-if="u.disabled" class="tag red">已停用</span>
            <span v-else-if="u.mustChangePassword" class="tag gray">待改初始密码</span>
            <span v-else class="muted">正常</span>
          </td>
          <td class="muted">{{ formatTime(u.createdAt) }}</td>
          <td class="row" style="justify-content: flex-end">
            <template v-if="u.id !== session.user?.id">
              <button @click="patch(u, { isAdmin: !u.isAdmin })">{{ u.isAdmin ? "取消管理员" : "设为管理员" }}</button>
              <button @click="patch(u, { resetPassword: true }, `重置「${u.username}」的密码？会让 TA 立即下线。`)">重置密码</button>
              <button
                :class="{ danger: !u.disabled }"
                @click="patch(u, { disabled: !u.disabled }, u.disabled ? undefined : `停用「${u.username}」？会立即下线并吊销其全部令牌。`)"
              >
                {{ u.disabled ? "启用" : "停用" }}
              </button>
            </template>
            <span v-else class="muted">（你自己）</span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
