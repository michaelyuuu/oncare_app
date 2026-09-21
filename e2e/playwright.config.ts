import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 120_000,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
  },
  webServer: [
    {
      command: "npm run dev",
      url: "http://127.0.0.1:3000/health",
      reuseExistingServer: true,
      timeout: 120_000,
      cwd: "..",
      env: { ...process.env, ONCARE_VIDEO_PROVIDER: "fake" },
    },
    { command: "node e2e/start-gateway.mjs", url: "http://127.0.0.1:3031/health", reuseExistingServer: false, timeout: 120_000, cwd: ".." },
  ],
});
