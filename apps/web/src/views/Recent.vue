<script setup lang="ts">
/** 最近浏览（B5）：自己在网页上打开过的设计稿，最近的在前。 */
import { onMounted, ref } from "vue";
import { api, colorOf, relativeTime, STATUS_LABEL, STATUS_TAG, type DesignStatus } from "../api";

interface Item {
  id: string;
  name: string;
  status: DesignStatus;
  projectId: string;
  projectName: string;
  currentVersion: number | null;
  pageCount: number;
  viewedAt: number;
}

const items = ref<Item[]>([]);
const loaded = ref(false);
const error = ref("");

onMounted(async () => {
  try {
    items.value = (await api<{ designs: Item[] }>("GET", "/me/recent")).designs;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loaded.value = true;
  }
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>最近浏览</h1>
        <div class="sub">你最近打开过的设计稿</div>
      </div>
    </div>
    <p v-if="error" class="error">{{ error }}</p>
    <div v-else-if="loaded && !items.length" class="empty"><div class="big">🕘</div>还没有浏览记录，打开任意设计稿后会出现在这里</div>
    <div class="grid">
      <RouterLink v-for="d in items" :key="d.id" :to="`/designs/${d.id}`" class="rcard">
        <div class="thumb" :style="{ background: `linear-gradient(135deg, ${colorOf(d.projectId)}22, ${colorOf(d.projectId)}0d)` }">
          <span class="tag" :class="STATUS_TAG[d.status]">{{ STATUS_LABEL[d.status] }}</span>
          <span class="art">🎨</span>
        </div>
        <div class="body">
          <div class="title">{{ d.name }}</div>
          <div class="meta">{{ d.projectName }} · {{ d.currentVersion ? `v${d.currentVersion} · ${d.pageCount} 页` : "未上传" }}</div>
          <div class="meta">{{ relativeTime(d.viewedAt) }}看过</div>
        </div>
      </RouterLink>
    </div>
  </div>
</template>

<style scoped>
.rcard {
  display: block;
  color: inherit;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  overflow: hidden;
  transition: transform 0.15s, box-shadow 0.15s;
}
.rcard:hover {
  transform: translateY(-3px);
  box-shadow: var(--shadow-lg);
}
.thumb {
  height: 100px;
  position: relative;
  display: grid;
  place-items: center;
}
.thumb .tag {
  position: absolute;
  top: 10px;
  left: 10px;
}
.art {
  font-size: 32px;
}
.body {
  padding: 12px 16px 14px;
}
.title {
  font-weight: 650;
  font-size: 15px;
  margin-bottom: 2px;
}
.meta {
  color: var(--muted);
  font-size: 12px;
}
</style>
