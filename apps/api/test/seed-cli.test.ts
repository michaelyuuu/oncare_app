import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { expect, test } from "vitest";

test("the seed CLI refuses to install demo credentials in production", () => {
  const directory = mkdtempSync(join(tmpdir(), "oncare-seed-cli-"));
  const databasePath = join(directory, "oncare.db");
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/seed-cli.ts"], {
      cwd: resolve(process.cwd(), "apps", "api"),
      env: { ...process.env, NODE_ENV: "production", ONCARE_SEED_DEMO: "1", DATABASE_PATH: databasePath },
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("demo seed is disabled for this environment");
    const sqlite = new Database(databasePath, { readonly: true });
    try {
      const row = sqlite.prepare("select count(*) as count from user").get() as { count: number };
      expect(row.count).toBe(0);
    } finally {
      sqlite.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
