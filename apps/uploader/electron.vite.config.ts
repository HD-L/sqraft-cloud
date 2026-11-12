import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import vue from "@vitejs/plugin-vue";

/**
 * 主进程、preload、渲染层三个入口各自构建；都压缩、不出 sourcemap。
 * 主进程用到的拆页代码（@sqraft-cloud/shared）与 zip 读取（yauzl）直接打进包里，安装包不需要额外的 node_modules。
 */
const build = { minify: "esbuild", sourcemap: false } as const;

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin({ exclude: ["@sqraft-cloud/shared", "yauzl"] })], build },
  preload: { plugins: [externalizeDepsPlugin()], build },
  renderer: { plugins: [vue()], build },
});
