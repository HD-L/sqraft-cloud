<script setup lang="ts">
/**
 * 三步：配置私有云节点 → 浏览器登录 → 选文件、选项目与设计稿、上传。
 * 记住「本地文件 ↔ 云端设计稿」，同一个文件下次直接预选，一键上传新版本（U7）。
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { AppState, Design, FileMapping, LocalFile, Project, UploadProgress, UploadResult } from "../../shared/types";

const api = window.uploader;
const NEW_DESIGN = "__new__";

const st = ref<AppState | null>(null);
const error = ref("");
const busy = ref(false);

// 第一步：节点
const serverInput = ref("");
const editingServer = ref(false);

// 第二步：登录
const loggingIn = ref(false);

// 第三步：上传
const file = ref<LocalFile | null>(null);
const mapping = ref<FileMapping | null>(null);
const projects = ref<Project[]>([]);
const designs = ref<Design[]>([]);
const projectId = ref("");
const designId = ref("");
const newName = ref("");
const note = ref("");
const progress = ref<UploadProgress | null>(null);
const result = ref<UploadResult | null>(null);
const dragging = ref(false);

const stage = computed(() => (!st.value?.server || editingServer.value ? "server" : !st.value.user ? "login" : "upload"));
const selectedDesign = computed(() => designs.value.find((d) => d.id === designId.value) ?? null);
const canUpload = computed(
  () => !!file.value && !!projectId.value && (designId.value === NEW_DESIGN ? !!newName.value.trim() : !!designId.value) && !progress.value,
);

function fail(e: unknown) {
  error.value = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e);
}

async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
  error.value = "";
  busy.value = true;
  try {
    return await fn();
  } catch (e) {
    fail(e);
    return undefined;
  } finally {
    busy.value = false;
  }
}

async function refresh() {
  await run(async () => {
    st.value = await api.getState();
    if (st.value.user) projects.value = await api.listProjects();
  });
}

async function saveServer() {
  const next = await run(() => api.setServer(serverInput.value));
  if (next) {
    st.value = next;
    editingServer.value = false;
    if (next.user) projects.value = await api.listProjects();
  }
}

async function login() {
  loggingIn.value = true;
  const next = await run(() => api.login());
  loggingIn.value = false;
  if (next) {
    st.value = next;
    projects.value = await api.listProjects();
  }
}

async function logout() {
  const next = await run(() => api.logout());
  if (next) st.value = next;
  file.value = null;
  result.value = null;
}

async function useFile(f: LocalFile) {
  file.value = f;
  result.value = null;
  newName.value = f.name.replace(/\.sqraft$/i, "");
  mapping.value = await api.getMapping(f.path);
  if (mapping.value && projects.value.some((p) => p.id === mapping.value!.projectId)) {
    projectId.value = mapping.value.projectId;
    await loadDesigns();
    if (designs.value.some((d) => d.id === mapping.value!.designId)) designId.value = mapping.value.designId;
  }
}

async function pick() {
  const f = await run(() => api.pickFile());
  if (f) await useFile(f);
}

async function onDrop(e: DragEvent) {
  dragging.value = false;
  const dropped = e.dataTransfer?.files?.[0];
  if (!dropped) return;
  const f = await run(() => api.fileInfo(api.pathForFile(dropped)));
  if (f) await useFile(f);
}

async function loadDesigns() {
  designs.value = [];
  if (!projectId.value) return;
  const list = await run(() => api.listDesigns(projectId.value));
  designs.value = list ?? [];
  designId.value = designs.value.some((d) => d.id === designId.value) ? designId.value : designs.value.length ? "" : NEW_DESIGN;
}

watch(projectId, () => void loadDesigns());

async function upload() {
  if (!file.value) return;
  error.value = "";
  result.value = null;
  try {
    let target = selectedDesign.value;
    if (designId.value === NEW_DESIGN) {
      target = await api.createDesign(projectId.value, newName.value.trim());
      designs.value = [target, ...designs.value];
      designId.value = target.id;
    } else if (target && mapping.value?.designId === target.id) {
      // U7：云端已有别人发布的更新版本时提醒，避免覆盖
      const latest = await api.designLatest(target.id);
      if (latest && latest > mapping.value.version) {
        const ok = confirm(`云端已有比你上次上传（v${mapping.value.version}）更新的版本 v${latest}，可能是别人发布的。仍要上传并成为最新版本吗？`);
        if (!ok) return;
      }
    }
    progress.value = { sent: 0, total: file.value.size, phase: "uploading" };
    result.value = await api.upload({
      path: file.value.path,
      projectId: projectId.value,
      designId: target!.id,
      designName: target!.name,
      note: note.value.trim(),
    });
    note.value = "";
    mapping.value = await api.getMapping(file.value.path);
  } catch (e) {
    fail(e);
  } finally {
    progress.value = null;
  }
}

/** 「相对 v3：修改 2 页、新增 1 页」 */
function changeText(r: UploadResult): string {
  const c = r.changes;
  if (!c || c.base === null) return "";
  const p = c.pages;
  const bits = [
    p.modified && `修改 ${p.modified} 页`,
    p.added && `新增 ${p.added} 页`,
    p.removed && `删除 ${p.removed} 页`,
    p.renamed && `改名 ${p.renamed} 页`,
    p.moved && `挪动 ${p.moved} 页`,
    c.components.added + c.components.modified + c.components.removed && `组件变动 ${c.components.added + c.components.modified + c.components.removed} 个`,
    c.tokens && `Token 变动 ${c.tokens} 个`,
  ].filter(Boolean);
  return `相对 v${c.base}：${bits.length ? bits.join("、") : "页面内容没有变化"}`;
}

function size(n: number) {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : n < 1024 ** 3 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;
}

let off: (() => void) | null = null;
onMounted(() => {
  off = api.onProgress((p) => (progress.value = p));
  void refresh();
});
onUnmounted(() => off?.());
</script>

<template>
  <main @dragover.prevent="dragging = stage === 'upload'" @dragleave="dragging = false" @drop.prevent="onDrop">
    <header class="row">
      <strong>Sqraft 上传</strong>
      <span class="spacer" />
      <template v-if="st?.server && stage !== 'server'">
        <span class="muted server" :title="st.server">{{ st.server.replace(/^https?:\/\//, "") }}</span>
        <button class="link" @click="(editingServer = true), (serverInput = st.server ?? '')">更换</button>
      </template>
      <template v-if="st?.user">
        <span class="muted">· {{ st.user.username }}</span>
        <button class="link" @click="logout">退出</button>
      </template>
    </header>

    <p v-if="error" class="error">{{ error }}</p>
    <div v-if="st?.insecure && stage !== 'server'" class="warn">这个私有云不是 HTTPS 地址，令牌和设计稿会明文传输，只应在可信内网使用。</div>

    <!-- 第一步：节点 -->
    <section v-if="stage === 'server'" class="card">
      <h2>连接私有云</h2>
      <p class="muted">填写团队私有云的地址，例如 design.example.com。</p>
      <form @submit.prevent="saveServer">
        <label>私有云地址<input v-model="serverInput" placeholder="https://design.example.com" autofocus /></label>
        <div class="row">
          <button class="primary" :disabled="busy || !serverInput.trim()">{{ busy ? "检查中…" : "连接" }}</button>
          <button v-if="st?.server" type="button" @click="editingServer = false">取消</button>
        </div>
      </form>
    </section>

    <!-- 第二步：登录 -->
    <section v-else-if="stage === 'login'" class="card center">
      <h2>登录</h2>
      <template v-if="!loggingIn">
        <p class="muted">点击后会在浏览器里打开私有云，登录并确认授权后自动回到这里。客户端不会接触你的密码。</p>
        <button class="primary" @click="login">在浏览器中登录</button>
      </template>
      <template v-else>
        <p>已在浏览器打开授权页，请在浏览器里完成登录与授权…</p>
        <button @click="api.cancelLogin()">取消</button>
      </template>
    </section>

    <!-- 第三步：上传 -->
    <template v-else>
      <section class="card drop" :class="{ dragging }" @click="!progress && pick()">
        <template v-if="file">
          <strong>{{ file.name }}</strong>
          <span class="muted">{{ size(file.size) }} · 点击更换</span>
          <span v-if="mapping" class="muted">上次上传到「{{ mapping.designName }}」v{{ mapping.version }}</span>
        </template>
        <template v-else>
          <strong>拖入 .sqraft 文件，或点击选择</strong>
          <span class="muted">Sketch 稿请先用 sketch2sqraft 转换并在 Sqraft 里确认</span>
        </template>
      </section>

      <section v-if="file" class="card">
        <label>
          项目
          <select v-model="projectId" :disabled="!!progress">
            <option value="" disabled>{{ projects.length ? "选择项目" : "没有可上传的项目（需要编辑者权限）" }}</option>
            <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </label>
        <label v-if="projectId">
          设计稿
          <select v-model="designId" :disabled="!!progress">
            <option value="" disabled>选择设计稿</option>
            <option :value="NEW_DESIGN">＋ 新建设计稿</option>
            <option v-for="d in designs" :key="d.id" :value="d.id">
              {{ d.name }}{{ d.currentVersion ? `（当前 v${d.currentVersion}）` : "（未上传）" }}
            </option>
          </select>
        </label>
        <label v-if="designId === NEW_DESIGN">新设计稿名称<input v-model="newName" maxlength="200" :disabled="!!progress" /></label>
        <label>版本说明（可选）<input v-model="note" maxlength="500" placeholder="例如：首页改版、修正按钮颜色" :disabled="!!progress" /></label>

        <div v-if="progress" class="progress">
          <div class="bar"><div :style="{ width: `${(progress.sent / progress.total) * 100}%` }" /></div>
          <div class="row">
            <span class="muted">{{
              progress.phase === "analyzing"
                ? "正在分析文件，找出改动的页面…"
                : progress.phase === "verifying"
                  ? "上传完成，正在校验与建索引…"
                  : `${size(progress.sent)} / ${size(progress.total)}`
            }}</span>
            <span class="spacer" />
            <button v-if="progress.phase === 'uploading'" @click="api.cancelUpload()">取消</button>
          </div>
        </div>
        <button v-else class="primary wide" :disabled="!canUpload" @click="upload">
          {{ designId === NEW_DESIGN ? "新建并上传" : selectedDesign?.currentVersion ? `上传为 v${(selectedDesign.latestVersion ?? 0) + 1}` : "上传" }}
        </button>
      </section>

      <section v-if="result" class="card">
        <p :class="result.duplicate ? 'muted' : 'ok'">
          {{ result.duplicate ? `内容与当前版本 v${result.version} 相同，没有生成新版本` : `已发布 v${result.version}` }}
        </p>
        <p v-if="!result.duplicate && changeText(result)" class="muted">{{ changeText(result) }}</p>
        <p v-if="result.stats.mode === 'incremental'" class="muted">
          只传了改动的部分：{{ size(result.stats.sentBytes) }}（全部 {{ size(result.stats.totalBytes) }}），
          页面 {{ result.stats.sentParts }} / {{ result.stats.totalParts }}，切图 {{ result.stats.sentAssets }} / {{ result.stats.totalAssets }}
        </p>
        <div class="row link-row">
          <code>{{ result.url }}</code>
          <button @click="api.copy(result.url)">复制链接</button>
          <button @click="api.openDesign(result.designId)">在浏览器打开</button>
        </div>
      </section>
    </template>
  </main>
</template>

<style scoped>
main {
  padding: 16px 20px;
  min-height: 100vh;
}
header {
  margin-bottom: 16px;
}
.server {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
h2 {
  font-size: 16px;
  margin: 0 0 8px;
}
.center {
  text-align: center;
  padding: 32px 16px;
}
.drop {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 28px 16px;
  border-style: dashed;
  cursor: pointer;
  text-align: center;
}
.drop.dragging {
  border-color: var(--accent);
  background: var(--accent-weak);
}
.wide {
  width: 100%;
}
.progress .bar {
  height: 6px;
  background: var(--border);
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 8px;
}
.progress .bar div {
  height: 100%;
  background: var(--accent);
  transition: width 0.2s;
}
.link-row code {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: text;
  font-size: 12px;
}
</style>
