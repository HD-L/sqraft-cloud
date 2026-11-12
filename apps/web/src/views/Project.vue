<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { api, formatTime } from "../api";

const props = defineProps<{ id: string }>();
const router = useRouter();

interface Design {
  id: string;
  name: string;
  currentVersion: number | null;
  latestVersion: number | null;
  pageCount: number;
  updatedAt: number;
}
interface Project {
  id: string;
  name: string;
  role: "editor" | "viewer";
  archived: boolean;
}

const project = ref<Project | null>(null);
const designs = ref<Design[]>([]);
const query = ref("");
const error = ref("");
const newName = ref("");
const canEdit = computed(() => project.value?.role === "editor" && !project.value.archived);
const shown = computed(() => designs.value.filter((d) => d.name.toLowerCase().includes(query.value.trim().toLowerCase())));

async function load() {
  try {
    const projects = (await api<{ projects: Project[] }>("GET", "/projects")).projects;
    project.value = projects.find((p) => p.id === props.id) ?? null;
    if (!project.value) {
      error.value = "项目不存在或没有权限";
      return;
    }
    designs.value = (await api<{ designs: Design[] }>("GET", `/projects/${props.id}/designs`)).designs;
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function create() {
  if (!newName.value.trim()) return;
  try {
    const res = await api<{ design: Design }>("POST", `/projects/${props.id}/designs`, { name: newName.value.trim() });
    await router.push(`/designs/${res.design.id}`);
  } catch (e) {
    error.value = (e as Error).message;
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <p class="muted"><RouterLink to="/">项目</RouterLink> /</p>
    <div class="row">
      <h1 style="margin: 0">{{ project?.name ?? "…" }}</h1>
      <span v-if="project?.archived" class="tag gray">已归档（只读）</span>
      <span class="spacer" />
      <input v-model="query" placeholder="搜索设计稿" />
    </div>
    <p v-if="error" class="error">{{ error }}</p>
    <form v-if="canEdit" class="row" style="margin: 16px 0" @submit.prevent="create">
      <input v-model="newName" placeholder="新设计稿名称" maxlength="200" />
      <button class="primary">新建设计稿</button>
      <span class="muted">新建后可在网页或 Mac 上传客户端上传 .sqraft</span>
    </form>
    <table class="card" style="padding: 0; margin-top: 16px">
      <thead>
        <tr><th>名称</th><th>当前版本</th><th>页面</th><th>更新时间</th></tr>
      </thead>
      <tbody>
        <tr v-for="d in shown" :key="d.id">
          <td><RouterLink :to="`/designs/${d.id}`">{{ d.name }}</RouterLink></td>
          <td>
            <span v-if="d.currentVersion">v{{ d.currentVersion }}</span>
            <span v-else class="muted">未上传</span>
            <span v-if="d.latestVersion && d.latestVersion !== d.currentVersion" class="tag gray" style="margin-left: 6px">已回滚，最新 v{{ d.latestVersion }}</span>
          </td>
          <td>{{ d.pageCount }}</td>
          <td class="muted">{{ formatTime(d.updatedAt) }}</td>
        </tr>
        <tr v-if="!shown.length">
          <td colspan="4" class="muted">没有设计稿</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
