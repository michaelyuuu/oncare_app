import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

const reuseExistingServer = process.env.ONCARE_E2E_REUSE_SERVER === "1";
const gatewayFreeSpecs = ["laundry-ai.spec.ts", "staff-console.spec.ts", "unified-entrance.spec.ts"];
const selectedSpecs = process.argv.map((value) => value.replaceAll("\\", "/"))
  .filter((value) => value.endsWith(".spec.ts"));
const focusedGatewayFreeRun = selectedSpecs.length > 0
  && selectedSpecs.every((value) => gatewayFreeSpecs.some((spec) => value.endsWith(spec)));
const stationConfig = JSON.stringify([{
  stationId: "11111111-1111-4111-8111-111111111111",
  facilityId: "facility_demo",
  baseUrl: "http://127.0.0.1:3101",
  token: "e2e-station-token",
}]);
const gatewayServer = {
  command: "node e2e/start-gateway.mjs",
  url: "http://127.0.0.1:3031/health",
  reuseExistingServer: false,
  timeout: 120_000,
  cwd: "..",
};

const clockFile = process.env.ONCARE_TEST_CLOCK_FILE ?? join(tmpdir(), `oncare-e2e-clock-${process.pid}.txt`);
process.env.ONCARE_TEST_CLOCK_FILE = clockFile;
writeFileSync(clockFile, new Date().toISOString());

export default defineConfig({
  testDir: ".",
  testIgnore: ["**/*.test.ts"],
  timeout: 120_000,
  retries: 0,
  // The demo stories share one in-memory API, mock robot, and synthetic clock.
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
  },
  webServer: [
    {
      command: "node e2e/fake-rfid-ledger.mjs",
      url: "http://127.0.0.1:3101/health",
      reuseExistingServer: false,
      timeout: 120_000,
      cwd: "..",
    },
    {
      command: "npm run dev",
      url: "http://127.0.0.1:3000/health",
      reuseExistingServer,
      timeout: 120_000,
      cwd: "..",
      env: {
        ...process.env,
        ONCARE_VIDEO_PROVIDER: "fake",
        DATABASE_PATH: process.env.DATABASE_PATH ?? ":memory:",
        ONCARE_TEST_CLOCK_FILE: process.env.ONCARE_TEST_CLOCK_FILE ?? join(tmpdir(), "oncare-e2e-clock.txt"),
        JWT_SECRET: "e2e-only-jwt-secret",
        OPENAI_API_KEY: "",
        ONCARE_RFID_STATIONS: stationConfig,
        ONCARE_RFID_POLL_INTERVAL_MS: "250",
        VITE_ONCARE_DEMO: "1",
      },
    },
    ...focusedGatewayFreeRun ? [] : [gatewayServer],
  ],
});
