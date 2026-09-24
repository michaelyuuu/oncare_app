import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { openDb } from "../src/db/client";
import * as t from "../src/db/schema";
import { SEED_IDS, SEED_SECRETS, seed, seedDemo, shouldSeedDemo } from "../src/db/seed";
import { hashSecret, verifySecret } from "../src/auth/password";

describe("database and seed", () => {
  test("never enables public demo credentials in production", () => {
    expect(shouldSeedDemo({ NODE_ENV: "production" })).toBe(false);
    expect(shouldSeedDemo({ NODE_ENV: "production", ONCARE_SEED_DEMO: "1" })).toBe(false);
    expect(shouldSeedDemo({ NODE_ENV: "development" })).toBe(true);
    expect(shouldSeedDemo({ NODE_ENV: "development", ONCARE_SEED_DEMO: "0" })).toBe(false);
  });

  test("the guarded seed entry point writes nothing in production", async () => {
    const db = openDb(":memory:");
    expect(await seedDemo(db, { NODE_ENV: "production", ONCARE_SEED_DEMO: "1" })).toBe(false);
    expect(db.select().from(t.user).all()).toHaveLength(0);
    expect(db.select().from(t.device).all()).toHaveLength(0);
    expect(db.select().from(t.robot).all()).toHaveLength(0);
  });

  test("seed creates one facility, resident, family + staff + admin users, robot, device, three locations and the catalogue", async () => {
    const db = openDb(":memory:");
    await seed(db);
    expect(db.select().from(t.facility).all()).toHaveLength(1);
    expect(db.select().from(t.resident).all()).toHaveLength(1);
    expect(db.select().from(t.user).all().map((u) => u.role).sort()).toEqual(["admin", "family", "staff"]);
    expect(db.select().from(t.robot).all()).toHaveLength(1);
    expect(db.select().from(t.device).all()).toHaveLength(1);
    expect(db.select().from(t.staffAssignment).all()).toEqual([expect.objectContaining({ userId: SEED_IDS.staffUser, residentId: SEED_IDS.resident, active: true })]);
    expect(db.select().from(t.location).all().map((l) => l.kind).sort()).toEqual(["pickup_station", "resident_room", "standby"]);
    expect(db.select().from(t.item).all().filter((i) => i.approved)).toHaveLength(3);
  });

  test("seed is idempotent", async () => {
    const db = openDb(":memory:");
    await seed(db);
    await seed(db);
    expect(db.select().from(t.resident).all()).toHaveLength(1);
  });

  test("seed refreshes changed demo quick-login secrets in an existing database", async () => {
    const db = openDb(":memory:");
    await seed(db);
    db.update(t.user).set({ passwordHash: await hashSecret("legacy-family") }).where(eq(t.user.id, SEED_IDS.familyUser)).run();
    db.update(t.user).set({ passwordHash: await hashSecret("legacy-staff") }).where(eq(t.user.id, SEED_IDS.staffUser)).run();
    db.update(t.device).set({ deviceTokenHash: await hashSecret("legacy-device") }).where(eq(t.device.id, SEED_IDS.device)).run();
    await seed(db);
    const family = db.select().from(t.user).where(eq(t.user.id, SEED_IDS.familyUser)).get();
    const staff = db.select().from(t.user).where(eq(t.user.id, SEED_IDS.staffUser)).get();
    const device = db.select().from(t.device).where(eq(t.device.id, SEED_IDS.device)).get();
    expect(await verifySecret(SEED_SECRETS.familyPassword, family!.passwordHash)).toBe(true);
    expect(await verifySecret(SEED_SECRETS.staffPassword, staff!.passwordHash)).toBe(true);
    expect(await verifySecret(SEED_SECRETS.deviceToken, device!.deviceTokenHash)).toBe(true);
  });

  test("family user is related to the demo resident with all consents on", async () => {
    const db = openDb(":memory:");
    await seed(db);
    const rel = db.select().from(t.familyRelationship).where(eq(t.familyRelationship.userId, SEED_IDS.familyUser)).get();
    expect(rel?.residentId).toBe(SEED_IDS.resident);
    expect(rel?.consentVideo && rel?.consentRobotVisit && rel?.consentItemDelivery).toBe(true);
  });

  test("seed stores no plaintext secrets", async () => {
    const db = openDb(":memory:");
    await seed(db);
    const u = db.select().from(t.user).where(eq(t.user.id, SEED_IDS.familyUser)).get();
    expect(u?.passwordHash).not.toContain("1234");
    const r = db.select().from(t.robot).get();
    expect(r?.tokenHash).not.toContain("robot-demo-token");
  });
});
