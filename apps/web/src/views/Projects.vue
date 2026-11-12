<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api, session } from "../api";

interface Project {
  id: string;
  name: string;
  archived: boolean;
  role: "editor" | "viewer";
  designCount: number;
}

const projects = ref<Project[]>([]);
const loaded = ref(false);
const error = ref("");

onMounted(async () => {
  try {
    projects.value = (await api<{ projects: Project[] }>("GET", "/projects")).projects;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loaded.value = true;
  }
});
</script>

<template>
  <div class="page">
    <h1>项目</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-else-if="loaded && !projects.length" class="muted">
      还没有可见的项目。{{ session.user?.isAdmin ? "到「项目管理」新建一个。" : "请联系管理员把你加进项目。" }}
    </p>
    <div class="grid">
      <RouterLink v-for="p in projects" :key="p.id" :to="`/projects/${p.id}`" class="card" style="color: inherit">
        <div class="row">
          <strong>{{ p.name }}</strong>
          <span class="spacer" />
          <span v-if="p.archived" class="tag gray">已归档</span>
          <span class="tag" :class="{ gray: p.role === 'viewer' }">{{ p.role === "editor" ? "编辑者" : "查看者" }}</span>
        </div>
        <p class="muted" style="margin: 8px 0 0">{{ p.designCount }} 个设计稿</p>
      </RouterLink>
    </div>
  </div>
</template>
