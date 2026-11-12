import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // bcrypt cost 12 每次哈希约 0.3 秒，建用户、登录多的用例要放宽
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
