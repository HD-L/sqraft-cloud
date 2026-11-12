<script setup lang="ts">
/** 团队管理（E1）：团队名称与简介（管理员可改）、成员与内容概况。 */
import { computed, onMounted, ref } from "vue";
import { api, session } from "../api";
import { ui } from "../ui";

interface Stats {
  members: number;
  admins: number;
  projects: number;
  designs: number;
}

const form = ref({ name: "", description: "" });
const stats = ref<Stats | null>(null);
const error = ref("");
const saved = ref(false);
const isAdmin = computed(() => session.user?.isAdmin === true);

async function load() {
  const res = await api<{ team: { name: string; description: string }; stats: Stats }>("GET", "/team");
  form.value = { ...res.team };
  stats.value = res.stats;
}

async function save() {
  error.value = "";
  saved.value = false;
  try {
    const res = await api<{ team: { name: string; description: string } }>("PATCH", "/team", form.value);
    form.value = { ...res.team };
    ui.teamName = res.team.name;
    saved.value = true;
  } catch (e) {
    error.value = (e as Error).message;
  }
}

onMounted(() => void load().catch((e) => (error.value = (e as Error).message)));
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>团队管理</h1>
        <div class="sub">{{ form.name }} · 管理团队信息，成员与权限在「人员管理」</div>
      </div>
    </div>
    <div class="settings-grid">
      <form class="card pad" @submit.prevent="save">
        <h3>团队信息</h3>
        <label class="field">团队名称<input v-model="form.name" maxlength="50" required :disabled="!isAdmin" /></label>
        <label class="field">团队简介<input v-model="form.description" maxlength="200" placeholder="一句话介绍团队" :disabled="!isAdmin" /></label>
        <p v-if="error" class="error">{{ error }}</p>
        <p v-if="saved" style="color: var(--ok); margin: 0 0 10px">已保存</p>
        <button v-if="isAdmin" class="primary">保存修改</button>
        <p v-else class="muted" style="margin: 0; font-size: 12px">只有管理员可以修改团队信息。</p>
      </form>
      <div class="card pad">
        <h3>概况</h3>
        <div v-if="stats" class="stats">
          <RouterLink to="/members" class="stat"><b>{{ stats.members }}</b><span>名成员</span></RouterLink>
          <RouterLink to="/members" class="stat"><b>{{ stats.admins }}</b><span>名管理员</span></RouterLink>
          <RouterLink to="/" class="stat"><b>{{ stats.projects }}</b><span>个项目</span></RouterLink>
          <RouterLink to="/" class="stat"><b>{{ stats.designs }}</b><span>个设计稿</span></RouterLink>
        </div>
        <p class="muted" style="font-size: 12px; margin-bottom: 0">
          团队角色：<b>管理员</b>管理成员与项目；<b>编辑者</b>可新建项目、上传和更新设计稿；<b>查看者</b>可查看和评论。
          每个项目里还可以单独调整某个人的权限（项目页「成员权限」）。
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pad {
  padding: 20px;
}
.stats {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  margin-bottom: 14px;
}
.stat {
  display: flex;
  flex-direction: column;
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--text-2);
  font-size: 12px;
}
.stat b {
  font-size: 22px;
  color: var(--text);
}
input:disabled {
  background: var(--bg);
}
</style>
