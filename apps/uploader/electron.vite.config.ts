import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import vue from "@vitejs/plugin-vue";

/** 主进程、preload、渲染层三个入口各自构建；都压缩、不出 sourcemap。 */
const build = { minify: "esbuild", sourcemap: false } as const;

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], build },
  preload: { plugins: [externalizeDepsPlugin()], build },
  renderer: { plugins: [vue()], build },
});
