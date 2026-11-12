import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import { loadSession, session } from "./api";
import "./styles.css";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", component: () => import("./views/Login.vue"), meta: { public: true } },
    { path: "/password", component: () => import("./views/Password.vue"), meta: { bare: true } },
    { path: "/", component: () => import("./views/Projects.vue") },
    { path: "/recent", component: () => import("./views/Recent.vue") },
    { path: "/projects/:id", component: () => import("./views/Project.vue"), props: true },
    { path: "/designs/:id", component: () => import("./views/Design.vue"), props: true },
    { path: "/team", component: () => import("./views/Team.vue") },
    { path: "/members", component: () => import("./views/Members.vue") },
    { path: "/tokens", component: () => import("./views/Tokens.vue") },
    { path: "/settings", component: () => import("./views/Settings.vue") },
    { path: "/oauth/authorize", component: () => import("./views/Authorize.vue"), meta: { bare: true } },
    { path: "/admin/audit", component: () => import("./views/admin/Audit.vue"), meta: { admin: true } },
    { path: "/admin/system", component: () => import("./views/admin/System.vue"), meta: { admin: true } },
    // 旧地址：用户管理并入人员管理，项目管理并入项目页
    { path: "/admin/users", redirect: "/members" },
    { path: "/admin/projects", redirect: "/" },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

router.beforeEach(async (to) => {
  if (!session.loaded) await loadSession();
  if (to.meta.public) return session.user && to.path === "/login" ? "/" : true;
  if (!session.user) return { path: "/login", query: { next: to.fullPath } };
  if (session.user.mustChangePassword && to.path !== "/password") return { path: "/password", query: { next: to.fullPath } };
  if (to.meta.admin && !session.user.isAdmin) return "/";
  return true;
});

createApp(App).use(router).mount("#app");
