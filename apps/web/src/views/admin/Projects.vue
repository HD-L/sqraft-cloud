<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api, formatTime, type User } from "../../api";

interface Project {
  id: string;
  name: string;
  archived: boolean;
  createdAt: number;
}
interface Member {
  userId: string;
  username: string;
  role: "editor" | "viewer";
}

const projects = ref<Project[]>([]);
const users = ref<User[]>([]);
const name = ref("");
const error = ref("");
const selected = ref<Project | null>(null);
const members = ref<Member[]>([]);
const addUser = ref("");
const addRole = ref<"editor" | "viewer">("viewer");
const candidates = computed(() => users.value.filter((u) => !u.disabled && !members.value.some((m) => m.userId === u.id)));

async function load() {
  projects.value = (await api<{ projects: Project[] }>("GET", "/admin/projects")).projects;
  users.value = (await api<{ users: User[] }>("GET", "/admin/users")).users;
}

async function create() {
  error.value = "";
  try {
    await api("POST", "/admin/projects", { name: name.value.trim() });
    name.value = "";
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function toggleArchive(p: Project) {
  await api("PATCH", `/admin/projects/${p.id}`, { archived: !p.archived });
  await load();
}

async function open(p: Project) {
  selected.value = p;
  members.value = (await api<{ members: Member[] }>("GET", `/admin/projects/${p.id}/members`)).members;
}

async function setRole(userId: string, role: "editor" | "viewer") {
  await api("PUT", `/admin/projects/${selected.value!.id}/members/${userId}`, { role });
  await open(selected.value!);
}

async function remove(m: Member) {
  await api("DELETE", `/admin/projects/${selected.value!.id}/members/${m.userId}`);
  await open(selected.value!);
}

async function add() {
  if (!addUser.value) return;
  await setRole(addUser.value, addRole.value);
  addUser.value = "";
}

onMounted(() => void load());
</script>

<template>
  <div class="page">
    <h1>项目管理</h1>
    <form class="card row" @submit.prevent="create">
      <input v-model="name" placeholder="项目名称" maxlength="100" required style="width: 260px" />
      <button class="primary">新建项目</button>
    </form>
    <p v-if="error" class="error">{{ error }}</p>
    <table class="card" style="padding: 0; margin-top: 16px">
      <thead>
        <tr><th>项目</th><th>状态</th><th>创建时间</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="p in projects" :key="p.id" :style="{ background: selected?.id === p.id ? 'var(--accent-weak)' : undefined }">
          <td><RouterLink :to="`/projects/${p.id}`">{{ p.name }}</RouterLink></td>
          <td><span v-if="p.archived" class="tag gray">已归档</span><span v-else class="muted">进行中</span></td>
          <td class="muted">{{ formatTime(p.createdAt) }}</td>
          <td class="row" style="justify-content: flex-end">
            <button @click="open(p)">成员</button>
            <button @click="toggleArchive(p)">{{ p.archived ? "取消归档" : "归档" }}</button>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-if="selected" class="card" style="margin-top: 16px">
      <h2 style="margin-top: 0">「{{ selected.name }}」的成员</h2>
      <p class="muted">编辑者可上传、回滚、删除设计稿；查看者只读。系统管理员自动拥有所有项目的编辑权限。</p>
      <form class="row" style="margin-bottom: 12px" @submit.prevent="add">
        <select v-model="addUser">
          <option value="" disabled>选择用户</option>
          <option v-for="u in candidates" :key="u.id" :value="u.id">{{ u.username }}</option>
        </select>
        <select v-model="addRole">
          <option value="viewer">查看者</option>
          <option value="editor">编辑者</option>
        </select>
        <button class="primary" :disabled="!addUser">添加</button>
      </form>
      <table>
        <tbody>
          <tr v-for="m in members" :key="m.userId">
            <td>{{ m.username }}</td>
            <td>
              <select :value="m.role" @change="setRole(m.userId, ($event.target as HTMLSelectElement).value as 'editor' | 'viewer')">
                <option value="viewer">查看者</option>
                <option value="editor">编辑者</option>
              </select>
            </td>
            <td style="text-align: right"><button class="danger" @click="remove(m)">移出</button></td>
          </tr>
          <tr v-if="!members.length"><td class="muted">还没有成员</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
