import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, test } from "vitest";
import * as t from "../src/db/schema";
import { SEED_IDS, SEED_SECRETS, seed } from "../src/db/seed";
import { verifySecret } from "../src/auth/password";

const real = fileURLToPath(new URL("../drizzle", import.meta.url));

/** A migrations folder holding only 0000 and 0001: the schema a deployed 0.1.0 database has. */
function legacyFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "oncare-mig-"));
  mkdirSync(join(dir, "meta"));
  const journal = JSON.parse(readFileSync(join(real, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
  journal.entries = journal.entries.slice(0, 2);
  for (const entry of journal.entries) cpSync(join(real, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify(journal));
  return dir;
}

describe("migration 0002_foundation", () => {
  test("carries 0.1.0 data forward: devices, staff facility, and staff keep today's visibility", () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: legacyFolder() });
    sqlite.exec(`
      INSERT INTO facility (id, name, timezone) VALUES ('f1', 'F', 'Asia/Taipei');
      INSERT INTO location (id, facility_id, name, kind, x, y, yaw, approved) VALUES ('l1', 'f1', 'Room', 'resident_room', 0, 0, 0, 1);
      INSERT INTO resident (id, facility_id, display_name, room_location_id) VALUES ('r1', 'f1', 'R1', 'l1'), ('r2', 'f1', 'R2', 'l1');
      INSERT INTO user (id, role, username, display_name, password_hash, pin_hash) VALUES ('s1', 'staff', 's', 'S', 'h', NULL), ('fam1', 'family', 'f', 'F', 'h', NULL);
      INSERT INTO robot (id, facility_id, name, token_hash) VALUES ('rb1', 'f1', 'Robot', 'h');
      INSERT INTO robot_device (id, robot_id, kind, resident_id, device_token_hash) VALUES ('d1', 'rb1', 'ipad', 'r1', 'dh');
    `);

    migrate(db, { migrationsFolder: real });

    expect(sqlite.prepare("SELECT * FROM device").all()).toEqual([
      { id: "d1", facility_id: "f1", robot_id: "rb1", kind: "ipad", resident_id: "r1", device_token_hash: "dh", active: 1, assignment_version: 1 },
    ]);
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'robot_device'").all()).toEqual([]);
    expect(sqlite.prepare("SELECT id, facility_id, active FROM user ORDER BY id").all()).toEqual([
      { id: "fam1", facility_id: null, active: 1 },
      { id: "s1", facility_id: "f1", active: 1 },
    ]);
    expect(sqlite.prepare("SELECT user_id, resident_id, active FROM staff_assignment ORDER BY resident_id").all()).toEqual([
      { user_id: "s1", resident_id: "r1", active: 1 },
      { user_id: "s1", resident_id: "r2", active: 1 },
    ]);
    expect(sqlite.prepare("SELECT active FROM resident ORDER BY id").all()).toEqual([{ active: 1 }, { active: 1 }]);
    expect(sqlite.prepare("SELECT count(*) AS n FROM pending_action").get()).toEqual({ n: 0 });
  });

  test("seed inserts the demo admin into an existing facility_demo database that predates it", async () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: legacyFolder() });
    sqlite.exec(`
      INSERT INTO facility (id, name, timezone) VALUES ('${SEED_IDS.facility}', 'Demo Care House', 'Asia/Taipei');
    `);

    migrate(db, { migrationsFolder: real });

    // The schema-typed db is only needed for seed()'s query-builder calls; the underlying
    // connection is the same one just migrated to head.
    const typedDb = drizzle(sqlite, { schema: t });
    await seed(typedDb);

    const admin = typedDb.select().from(t.user).where(eq(t.user.id, SEED_IDS.adminUser)).get();
    expect(admin?.active).toBe(true);
    expect(admin?.facilityId).toBe(SEED_IDS.facility);
    expect(await verifySecret(SEED_SECRETS.adminPassword, admin!.passwordHash)).toBe(true);

    // Idempotent: a second call inserts nothing new.
    const before = typedDb.select().from(t.user).all().length;
    await seed(typedDb);
    expect(typedDb.select().from(t.user).all().length).toBe(before);
  });
});
