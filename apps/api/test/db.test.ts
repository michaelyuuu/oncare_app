import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { openDb } from "../src/db/client";
import * as t from "../src/db/schema";
import { SEED_IDS, seed } from "../src/db/seed";

describe("database and seed", () => {
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
    expect(u?.passwordHash).not.toContain("family-demo-pass");
    const r = db.select().from(t.robot).get();
    expect(r?.tokenHash).not.toContain("robot-demo-token");
  });
});
