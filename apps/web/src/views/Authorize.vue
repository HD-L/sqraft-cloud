<script setup lang="ts">
/**
 * 上传客户端的授权确认页（U3）：客户端打开浏览器到 /oauth/authorize?…，用户确认后跳回客户端的自定义协议。
 */
import { onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { api, session } from "../api";

const route = useRoute();
const q = (k: string) => (typeof route.query[k] === "string" ? (route.query[k] as string) : "");
const clientId = q("client_id");
const redirectUri = q("redirect_uri");
const state = q("state");

const client = ref<{ name: string; tokenDays: number } | null>(null);
const error = ref("");
const done = ref(false);
const busy = ref(false);

onMounted(async () => {
  if (q("response_type") !== "code") {
    error.value = "请求参数不对：response_type 必须是 code";
    return;
  }
  try {
    client.value = await api("GET", `/oauth/client?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}`);
  } catch (e) {
    error.value = (e as Error).message;
  }
});

async function allow() {
  busy.value = true;
  try {
    const res = await api<{ redirectUrl: string }>("POST", "/oauth/authorize", {
      clientId,
      redirectUri,
      codeChallenge: q("code_challenge"),
      codeChallengeMethod: q("code_challenge_method"),
      state,
    });
    done.value = true;
    window.location.href = res.redirectUrl;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

function deny() {
  const url = new URL(redirectUri);
  url.searchParams.set("error", "access_denied");
  if (state) url.searchParams.set("state", state);
  done.value = true;
  window.location.href = url.toString();
}
</script>

<template>
  <div class="page" style="max-width: 460px; padding-top: 64px">
    <div class="card">
      <h1>授权登录</h1>
      <p v-if="error" class="error">{{ error }}</p>
      <template v-else-if="client && !done">
        <p>
          <strong>{{ client.name }}</strong> 请求以 <strong>{{ session.user?.username }}</strong> 的身份访问 Sqraft 私有云。
        </p>
        <ul class="muted">
          <li>查看你有权限的项目与设计稿</li>
          <li>在你有编辑权限的项目里新建设计稿、上传新版本</li>
          <li>授权有效期 {{ client.tokenDays }} 天，可随时在「MCP 接入」页吊销</li>
        </ul>
        <p class="muted">只有你自己刚在客户端点了「登录」时才授权。</p>
        <div class="row">
          <button class="primary" :disabled="busy" @click="allow">授权</button>
          <button :disabled="busy" @click="deny">取消</button>
        </div>
      </template>
      <p v-else-if="done" class="muted">已完成，可以回到客户端了。如果客户端没有自动切到前台，请手动切换。</p>
      <p v-else class="muted">加载中…</p>
    </div>
  </div>
</template>
