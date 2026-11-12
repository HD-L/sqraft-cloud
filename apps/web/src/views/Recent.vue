<script setup lang="ts">
/** 最近浏览（B5）：自己在网页上打开过的设计稿，最近的在前，按「今天 / 最近 7 天 / 更早」分组。 */
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { Clock, Folder, FolderOpen, RotateCw } from "lucide-vue-next";
import { api, formatTime, relativeTime, STATUS_LABEL, STATUS_TAG, type DesignStatus } from "../api";
import EmptyState from "../components/EmptyState.vue";
import DesignCover from "../components/DesignCover.vue";

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

const router = useRouter();
const items = ref<Item[]>([]);
const loaded = ref(false);
const loading = ref(false);
const error = ref("");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    items.value = (await api<{ designs: Item[] }>("GET", "/me/recent")).designs;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loaded.value = true;
    loading.value = false;
  }
}

const groups = computed(() => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const t0 = today.getTime();
  const week = t0 - 6 * 86_400_000;
  const out: Array<{ label: string; items: Item[] }> = [
    { label: "今天", items: [] },
    { label: "最近 7 天", items: [] },
    { label: "更早", items: [] },
  ];
  for (const d of items.value) out[d.viewedAt >= t0 ? 0 : d.viewedAt >= week ? 1 : 2].items.push(d);
  return out.filter((g) => g.items.length);
});

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>最近浏览</h1>
        <div class="sub">你最近在网页上打开过的设计稿</div>
      </div>
    </div>

    <div class="tabs">
      <button class="tab" @click="router.push('/')">全部项目</button>
      <button class="tab active">最近浏览 <span v-if="loaded && !error" class="count">{{ items.length }}</span></button>
    </div>

    <div v-if="error" class="error-box card">
      <div>
        <div class="error-title">浏览记录加载失败</div>
        <div class="error">{{ error }}</div>
      </div>
      <button :disabled="loading" @click="load"><RotateCw :size="15" />重试</button>
    </div>

    <div v-else-if="!loaded || (loading && !items.length)" class="grid">
      <div v-for="i in 8" :key="i" class="rcard">
        <div class="skeleton thumb" />
        <div class="body">
          <div class="skeleton" style="height: 14px; width: 65%" />
          <div class="skeleton" style="height: 12px; width: 45%; margin-top: 8px" />
          <div class="skeleton" style="height: 12px; width: 35%; margin-top: 12px" />
        </div>
      </div>
    </div>

    <EmptyState v-else-if="!items.length" :icon="Clock" title="还没有浏览记录" hint="在网页上打开任意设计稿后，它会出现在这里，方便下次快速回来。">
      <button @click="router.push('/')"><FolderOpen :size="15" />浏览项目</button>
    </EmptyState>

    <template v-else>
      <section v-for="g in groups" :key="g.label" class="group">
        <h2 class="group-title">{{ g.label }}</h2>
        <div class="grid">
          <RouterLink v-for="d in g.items" :key="d.id" :to="`/designs/${d.id}`" class="rcard">
            <div class="thumb">
              <DesignCover :design-id="d.id" :version="d.currentVersion" class="cover" />
              <span class="tag dot" :class="STATUS_TAG[d.status]">{{ STATUS_LABEL[d.status] }}</span>
            </div>
            <div class="body">
              <div class="title truncate" :title="d.name">{{ d.name }}</div>
              <div class="project" :title="d.projectName"><Folder :size="13" /><span class="truncate">{{ d.projectName }}</span></div>
              <div class="meta">
                <template v-if="d.currentVersion">
                  <span class="num">v{{ d.currentVersion }}</span>
                  <span class="sep" />
                  <span class="num">{{ d.pageCount }} 页</span>
                </template>
                <span v-else>未上传</span>
                <span class="spacer" />
                <span :title="formatTime(d.viewedAt)">{{ relativeTime(d.viewedAt) }}看过</span>
              </div>
            </div>
          </RouterLink>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.error-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px;
}
.error-title {
  font-weight: 600;
  margin-bottom: 4px;
}
.error-box .error {
  margin: 0;
}

.group + .group {
  margin-top: 32px;
}
.group-title {
  margin: 0 0 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
}

.rcard {
  display: flex;
  flex-direction: column;
  min-width: 0;
  color: inherit;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-xs);
  overflow: hidden;
  transition:
    transform 0.16s var(--ease),
    box-shadow 0.16s var(--ease),
    border-color 0.16s var(--ease);
}
a.rcard:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
  border-color: var(--border-strong);
}
.thumb {
  position: relative;
  aspect-ratio: 16 / 10;
  border-bottom: 1px solid var(--border);
  overflow: hidden;
}
.skeleton.thumb {
  border-radius: 0;
  border-bottom: none;
}
.cover {
  width: 100%;
  height: 100%;
}
.cover :deep(img) {
  transition: transform 0.3s var(--ease);
}
a.rcard:hover .cover :deep(img) {
  transform: scale(1.02);
}
.thumb .tag {
  position: absolute;
  top: 8px;
  left: 8px;
  box-shadow: var(--shadow-xs);
}
.body {
  padding: 12px 16px 16px;
  min-width: 0;
}
.title {
  font-weight: 600;
  font-size: 14px;
}
.project {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
  color: var(--text-2);
  font-size: 12px;
}
.project svg {
  flex-shrink: 0;
  color: var(--muted);
}
.meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
}
.num {
  font-variant-numeric: tabular-nums;
}
.sep {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--faint);
}
</style>
