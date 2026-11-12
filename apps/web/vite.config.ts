import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// 开发时 API 与 MCP 转发到本机的服务端（pnpm dev:server，默认 8080）
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8080",
      "/mcp": "http://127.0.0.1:8080",
    },
  },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
});
