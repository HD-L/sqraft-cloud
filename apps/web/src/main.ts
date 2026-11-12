import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import { loadSession, session } from "./api";
import "./styles.css";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", component: () => import("./views/Login.vue"), meta: { public: true } },
    { path: "/password", component: () => import("./views/Password.vue") },
    { path: "/", component: () => import("./views/Projects.vue") },
    { path: "/projects/:id", component: () => import("./views/Project.vue"), props: true },
    { path: "/designs/:id", component: () => import("./views/Design.vue"), props: true },
    { path: "/tokens", component: () => import("./views/Tokens.vue") },
    { path: "/oauth/authorize", component: () => import("./views/Authorize.vue"), meta: { bare: true } },
    { path: "/admin/users", component: () => import("./views/admin/Users.vue"), meta: { admin: true } },
    { path: "/admin/projects", component: () => import("./views/admin/Projects.vue"), meta: { admin: true } },
    { path: "/admin/audit", component: () => import("./views/admin/Audit.vue"), meta: { admin: true } },
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
