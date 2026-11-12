<script setup lang="ts">
/** 个人设置：姓名、邮箱；修改密码。 */
import { computed, ref } from "vue";
import { KeyRound, UserRound } from "lucide-vue-next";
import { api, formatTime, loadSession, relativeTime, ROLE_LABEL, ROLE_TAG, session } from "../api";
import { toast } from "../ui";
import Avatar from "../components/Avatar.vue";

const profile = ref({ displayName: session.user?.displayName ?? "", email: session.user?.email ?? "" });
const profileSaving = ref(false);
const profileError = ref("");
const profileDirty = computed(
  () => profile.value.displayName !== (session.user?.displayName ?? "") || profile.value.email !== (session.user?.email ?? ""),
);
async function saveProfile() {
  if (!profileDirty.value || profileSaving.value) return;
  profileError.value = "";
  profileSaving.value = true;
  try {
    await api("PATCH", "/me", profile.value);
    await loadSession();
    profile.value = { displayName: session.user?.displayName ?? "", email: session.user?.email ?? "" };
    toast.success("资料已保存");
  } catch (e) {
    profileError.value = (e as Error).message;
    toast.error(profileError.value);
  } finally {
    profileSaving.value = false;
  }
}
function resetProfile() {
  profile.value = { displayName: session.user?.displayName ?? "", email: session.user?.email ?? "" };
  profileError.value = "";
}

const pw = ref({ current: "", next: "", confirm: "" });
const pwSaving = ref(false);
const pwError = ref("");
const mismatch = computed(() => !!pw.value.confirm && pw.value.next !== pw.value.confirm);
async function changePassword() {
  if (pwSaving.value) return;
  pwError.value = "";
  if (pw.value.next !== pw.value.confirm) {
    pwError.value = "两次输入的新密码不一致";
    return;
  }
  pwSaving.value = true;
  try {
    await api("POST", "/me/password", { currentPassword: pw.value.current, newPassword: pw.value.next });
    pw.value = { current: "", next: "", confirm: "" };
    toast.success("密码已修改，其它设备上的登录已失效");
  } catch (e) {
    pwError.value = (e as Error).message;
    toast.error(pwError.value);
  } finally {
    pwSaving.value = false;
  }
}
</script>

<template>
  <div class="page narrow">
    <div class="page-head">
      <div>
        <h1>个人设置</h1>
        <div class="sub">管理你的资料与登录密码</div>
      </div>
    </div>

    <!-- 个人资料 -->
    <section class="card section">
      <div class="section-side">
        <div class="section-title"><UserRound :size="16" />个人资料</div>
        <div class="section-desc">显示在评论、通知与成员列表里</div>
      </div>
      <form class="section-main" @submit.prevent="saveProfile">
        <div class="identity">
          <Avatar :name="profile.displayName || session.user?.username || ''" :size="48" />
          <div class="identity-text">
            <div class="identity-name">{{ session.user?.displayName || session.user?.username }}</div>
            <div class="identity-meta">
              <span class="mono">@{{ session.user?.username }}</span>
              <span v-if="session.user" class="tag" :class="ROLE_TAG[session.user.role]">团队{{ ROLE_LABEL[session.user.role] }}</span>
              <span v-if="session.user?.isAdmin" class="tag purple">系统管理员</span>
            </div>
          </div>
        </div>
        <label class="field">
          显示名
          <input v-model="profile.displayName" maxlength="50" placeholder="你的姓名" />
        </label>
        <label class="field">
          邮箱
          <input v-model="profile.email" type="email" maxlength="200" placeholder="name@company.com" />
        </label>
        <p v-if="profileError" class="error">{{ profileError }}</p>
        <div class="section-foot">
          <span v-if="session.user" class="muted small" :title="formatTime(session.user.createdAt)">
            {{ relativeTime(session.user.createdAt) }}加入
          </span>
          <span class="spacer" />
          <button v-if="profileDirty" type="button" class="ghost" @click="resetProfile">撤销修改</button>
          <button class="primary" :disabled="!profileDirty || profileSaving">{{ profileSaving ? "保存中…" : "保存" }}</button>
        </div>
      </form>
    </section>

    <!-- 安全 -->
    <section class="card section">
      <div class="section-side">
        <div class="section-title"><KeyRound :size="16" />安全</div>
        <div class="section-desc">修改密码后，其它设备上的登录会立即失效</div>
      </div>
      <form class="section-main" @submit.prevent="changePassword">
        <label class="field">
          当前密码
          <input v-model="pw.current" type="password" autocomplete="current-password" required />
        </label>
        <label class="field">
          新密码
          <input v-model="pw.next" type="password" autocomplete="new-password" minlength="8" required />
          <span class="field-hint">至少 8 位，不能与当前密码相同</span>
        </label>
        <label class="field">
          确认新密码
          <input v-model="pw.confirm" type="password" autocomplete="new-password" required :class="{ invalid: mismatch }" />
          <span v-if="mismatch" class="field-hint warn">两次输入的新密码不一致</span>
        </label>
        <p v-if="pwError" class="error">{{ pwError }}</p>
        <div class="section-foot">
          <span class="spacer" />
          <button class="primary" :disabled="pwSaving || !pw.current || !pw.next || !pw.confirm">
            {{ pwSaving ? "修改中…" : "修改密码" }}
          </button>
        </div>
      </form>
    </section>
  </div>
</template>

<style scoped>
.small {
  font-size: 12px;
}
.section {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 32px;
  padding: 24px;
  margin-bottom: 16px;
}
.section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 650;
}
.section-title svg {
  color: var(--muted);
}
.section-desc {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--muted);
}
.section-main {
  max-width: 440px;
}
.section-main input {
  width: 100%;
}
.identity {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 20px;
  margin-bottom: 20px;
  border-bottom: 1px solid var(--border);
}
.identity-text {
  min-width: 0;
}
.identity-name {
  font-size: 14px;
  font-weight: 600;
}
.identity-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
  color: var(--muted);
}
.section-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}
input.invalid,
input.invalid:focus {
  border-color: var(--danger);
}
.field-hint.warn {
  color: var(--danger);
}
@media (max-width: 720px) {
  .section {
    grid-template-columns: 1fr;
    gap: 16px;
  }
}
</style>
