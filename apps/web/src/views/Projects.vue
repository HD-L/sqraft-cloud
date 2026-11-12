<script setup lang="ts">
/**
 * 项目总览（B1–B4）：卡片网格，可按「全部 / 我创建的」筛选、按名称搜索、按更新时间或名称排序；
 * 管理员与编辑者可以新建项目。
 */
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { api, colorOf, relativeTime, session } from "../api";
import { openClient, ui } from "../ui";
import Modal from "../components/Modal.vue";

interface Project {
  id: string;
  name: string;
  description: string;
  archived: boolean;
  role: "editor" | "viewer";
  createdBy: string | null;
  createdByMe: boolean;
  designCount: number;
  updatedAt: number;
}

const router = useRouter();
const projects = ref<Project[]>([]);
const loaded = ref(false);
const error = ref("");
const tab = ref<"all" | "mine">("all");
const q = ref("");
const sort = ref<"updated" | "name">("updated");
const canCreate = computed(() => session.user?.role === "admin" || session.user?.role === "editor");

const shown = computed(() => {
  const k = q.value.trim().toLowerCase();
  const list = projects.value.filter(
    (p) =>
      (tab.value === "all" || p.createdByMe) &&
      (!k || p.name.toLowerCase().includes(k) || p.description.toLowerCase().includes(k) || (p.createdBy ?? "").toLowerCase().includes(k)),
  );
  return [...list].sort((a, b) => (sort.value === "name" ? a.name.localeCompare(b.name, "zh-CN") : b.updatedAt - a.updatedAt));
});

async function load() {
  try {
    projects.value = (await api<{ projects: Project[] }>("GET", "/projects")).projects;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loaded.value = true;
  }
}

// ── 新建项目 ──
const creating = ref(false);
const form = ref({ name: "", description: "" });
const formError = ref("");
async function create() {
  formError.value = "";
  try {
    const res = await api<{ project: Project }>("POST", "/projects", { name: form.value.name.trim(), description: form.value.description.trim() });
    creating.value = false;
    form.value = { name: "", description: "" };
    await router.push(`/projects/${res.project.id}`);
  } catch (e) {
    formError.value = (e as Error).message;
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>项目</h1>
        <div class="sub">{{ ui.teamName }} · 共 {{ projects.length }} 个项目</div>
      </div>
      <div class="actions">
        <button @click="openClient()">⬇ 下载上传客户端</button>
        <button v-if="canCreate" class="primary" @click="creating = true">＋ 新建项目</button>
      </div>
    </div>

    <div class="tabs">
      <button class="tab" :class="{ active: tab === 'all' }" @click="tab = 'all'">全部</button>
      <button class="tab" :class="{ active: tab === 'mine' }" @click="tab = 'mine'">我创建的</button>
      <button class="tab" @click="router.push('/recent')">最近浏览</button>
    </div>
    <div class="toolbar">
      <div class="search-box"><span>🔍</span><input v-model="q" placeholder="输入名称搜索" /></div>
      <span class="spacer" />
      <select v-model="sort" aria-label="排序">
        <option value="updated">按更新时间</option>
        <option value="name">按名称</option>
      </select>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
    <div v-else-if="loaded && !shown.length" class="empty">
      <div class="big">📁</div>
      <template v-if="q || tab === 'mine'">没有匹配的项目</template>
      <template v-else>还没有项目{{ canCreate ? "，点右上角「新建项目」开始" : "，请联系管理员" }}</template>
    </div>
    <div class="grid">
      <RouterLink v-for="p in shown" :key="p.id" :to="`/projects/${p.id}`" class="pcard">
        <div class="thumb" :style="{ background: `linear-gradient(135deg, ${colorOf(p.id)}22, ${colorOf(p.id)}0d)` }">
          <span v-if="p.archived" class="badge">已归档</span>
          <span v-else-if="p.role === 'viewer'" class="badge">只读</span>
          <div class="frame" :style="{ boxShadow: `0 4px 18px ${colorOf(p.id)}33` }" />
        </div>
        <div class="body">
          <div class="title">{{ p.name }}</div>
          <div class="desc">{{ p.description || "暂无描述" }}</div>
          <div class="meta">
            {{ relativeTime(p.updatedAt) }}更新<template v-if="p.createdBy"><span class="sep" />{{ p.createdBy }}</template>
          </div>
          <div class="stats"><b>{{ p.designCount }}</b> 个设计稿</div>
        </div>
      </RouterLink>
    </div>

    <Modal v-if="creating" title="新建项目" @close="creating = false">
      <form @submit.prevent="create">
        <label class="field">项目名称<input v-model="form.name" maxlength="100" placeholder="例如：官网改版 3.0" required autofocus /></label>
        <label class="field">项目描述<input v-model="form.description" maxlength="300" placeholder="一句话说明这个项目（可选）" /></label>
        <p v-if="formError" class="error">{{ formError }}</p>
        <button class="primary" style="width: 100%">创建项目</button>
      </form>
    </Modal>
  </div>
</template>

<style scoped>
.pcard {
  display: block;
  color: inherit;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  overflow: hidden;
  transition: transform 0.15s, box-shadow 0.15s, border-color 0.15s;
}
.pcard:hover {
  transform: translateY(-3px);
  box-shadow: var(--shadow-lg);
  border-color: #cdd4ea;
}
.thumb {
  height: 120px;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}
.frame {
  width: 66%;
  height: 70%;
  background: #fff;
  border-radius: 6px;
  position: relative;
}
.frame::before,
.frame::after {
  content: "";
  position: absolute;
  left: 15%;
  height: 8px;
  border-radius: 4px;
}
.frame::before {
  top: 26%;
  width: 70%;
  background: #dfe4f5;
}
.frame::after {
  top: 48%;
  width: 45%;
  background: #cdd5f0;
}
.badge {
  position: absolute;
  top: 10px;
  left: 10px;
  background: rgba(255, 255, 255, 0.92);
  color: var(--text-2);
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 6px;
  font-weight: 600;
}
.body {
  padding: 14px 16px 15px;
}
.title {
  font-weight: 650;
  font-size: 15px;
}
.desc {
  color: var(--text-2);
  font-size: 12.5px;
  margin: 2px 0 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta {
  color: var(--muted);
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.sep {
  width: 3px;
  height: 3px;
  background: #c3c8d6;
  border-radius: 50%;
}
.stats {
  margin-top: 12px;
  padding-top: 11px;
  border-top: 1px solid var(--border);
  color: var(--text-2);
  font-size: 12px;
}
.stats b {
  color: var(--text);
}
</style>
