import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createServerClock } from "../src/services/server-clock";

const directories: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true }); });

test("the nonproduction test clock reads each file update and falls back safely for a missing or invalid instant", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-21T00:00:00.000Z"));
  const directory = mkdtempSync(join(tmpdir(), "oncare-task4-clock-"));
  directories.push(directory);
  const path = join(directory, "clock.txt");
  const now = createServerClock({ NODE_ENV: "test", ONCARE_TEST_CLOCK_FILE: path });
  expect(now().toISOString()).toBe("2026-09-21T00:00:00.000Z");
  writeFileSync(path, "2026-09-22T00:55:00.000Z\n");
  expect(now().toISOString()).toBe("2026-09-22T00:55:00.000Z");
  writeFileSync(path, "2026-09-22T01:00:00.000Z");
  expect(now().toISOString()).toBe("2026-09-22T01:00:00.000Z");
  writeFileSync(path, "bad instant");
  expect(now().toISOString()).toBe("2026-09-21T00:00:00.000Z");
});

test("production and unconfigured clocks always use system time", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-21T00:00:00.000Z"));
  const directory = mkdtempSync(join(tmpdir(), "oncare-task4-clock-"));
  directories.push(directory);
  const path = join(directory, "clock.txt");
  writeFileSync(path, "2099-01-01T00:00:00.000Z");
  expect(createServerClock({ NODE_ENV: "production", ONCARE_TEST_CLOCK_FILE: path })().toISOString()).toBe("2026-09-21T00:00:00.000Z");
  expect(createServerClock({})().toISOString()).toBe("2026-09-21T00:00:00.000Z");
});
