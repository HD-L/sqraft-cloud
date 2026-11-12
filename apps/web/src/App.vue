<script setup lang="ts">
import { useRoute, useRouter } from "vue-router";
import { computed } from "vue";
import { logout, session } from "./api";

const route = useRoute();
const router = useRouter();
const showNav = computed(() => session.user && !route.meta.public);

async function signOut() {
  await logout();
  await router.push("/login");
}
</script>

<template>
  <header v-if="showNav" class="nav">
    <RouterLink to="/" class="brand">Sqraft 私有云</RouterLink>
    <RouterLink to="/">项目</RouterLink>
    <RouterLink to="/tokens">MCP 接入</RouterLink>
    <template v-if="session.user?.isAdmin">
      <RouterLink to="/admin/users">用户</RouterLink>
      <RouterLink to="/admin/projects">项目管理</RouterLink>
      <RouterLink to="/admin/audit">审计日志</RouterLink>
    </template>
    <span class="spacer" />
    <RouterLink to="/password" class="muted">{{ session.user?.username }}</RouterLink>
    <button @click="signOut">退出</button>
  </header>
  <RouterView />
</template>

<style scoped>
.nav {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 0 24px;
  height: 52px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}
.nav a {
  color: var(--text);
}
.nav a.router-link-exact-active:not(.brand) {
  color: var(--accent);
}
.brand {
  font-weight: 600;
}
</style>
