import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["packages/core/test/**/*.test.ts", "packages/contracts/test/**/*.test.ts", "apps/api/test/**/*.test.ts", "e2e/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "web",
          include: ["packages/web-common/test/**/*.test.ts", "apps/portal/test/**/*.test.{ts,tsx}", "apps/resident/test/**/*.test.{ts,tsx}", "apps/family/test/**/*.test.{ts,tsx}", "apps/staff/test/**/*.test.{ts,tsx}"],
          environment: "jsdom",
          css: { include: [/resident.*src.*styles\.css/] },
          setupFiles: ["./vitest.setup.web.ts"],
        },
      },
    ],
  },
});
