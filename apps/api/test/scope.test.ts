import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp } from "./helpers";
import * as t from "../src/db/schema";
import { SEED_IDS } from "../src/db/seed";
import { hashSecret } from "../src/auth/password";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function withSecondResidentAndNurse() {
  const ctx = await makeTestApp();
  const { app, db } = ctx;
  db.insert(t.resident).values({ id: "r2", facilityId: SEED_IDS.facility, displayName: "Two", roomLocationId: SEED_IDS.roomLocation }).run();
  db.insert(t.user).values({ id: "fam2", role: "family", username: "family2", displayName: "Son", passwordHash: await hashSecret("pw"), pinHash: null, facilityId: null }).run();
  db.insert(t.familyRelationship).values({ id: "rel2", userId: "fam2", residentId: "r2", label: "son", consentVideo: true, consentRobotVisit: true, consentItemDelivery: true }).run();
  db.insert(t.user).values({ id: "nurse2", role: "staff", username: "nurse2", displayName: "Nurse Two", passwordHash: await hashSecret("pw"), pinHash: await hashSecret("1357"), facilityId: SEED_IDS.facility }).run();
  const login = async (username: string) => (await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: "pw" } })).json().token as string;
  return { ...ctx, family2: await login("family2"), nurse2: await login("nurse2") };
}

describe("staff scope", () => {
  test("audit shows only assigned residents' visits; every facility nurse still sees the robot", async () => {
    const { app, tokens, family2, nurse2 } = await withSecondResidentAndNurse();
    // Each visit writes two visit transitions (awaiting_policy_or_staff, accepted).
    await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } });
    await app.inject({ method: "POST", url: "/visits", headers: auth(family2), payload: { residentId: "r2" } });
    const visitEvents = async (token: string) => (await app.inject({ method: "GET", url: "/audit", headers: auth(token) })).json().events.filter((e: { entityType: string }) => e.entityType === "visit").length;
    expect(await visitEvents(tokens.staff)).toBe(2);
    expect(await visitEvents(nurse2)).toBe(0);
    expect(await visitEvents(tokens.admin)).toBe(4);
    expect((await app.inject({ method: "GET", url: "/audit?residentId=r2", headers: auth(tokens.staff) })).statusCode).toBe(403);
    for (const token of [tokens.staff, nurse2, tokens.admin]) {
      expect((await app.inject({ method: "GET", url: "/queue", headers: auth(token) })).json().robot).toMatchObject({ robotId: SEED_IDS.robot });
    }
  });

  test("pending approvals are filtered by assignment", async () => {
    const { app, db, tokens, family2, nurse2 } = await withSecondResidentAndNurse();
    db.update(t.resident).set({ availability: "in_activity" }).run();
    await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } });
    await app.inject({ method: "POST", url: "/visits", headers: auth(family2), payload: { residentId: "r2" } });
    const pending = async (token: string) => (await app.inject({ method: "GET", url: "/queue", headers: auth(token) })).json().visitsAwaitingApproval.map((v: { residentId: string }) => v.residentId).sort();
    expect(await pending(tokens.staff)).toEqual([SEED_IDS.resident]);
    expect(await pending(nurse2)).toEqual([]);
    expect(await pending(tokens.admin)).toEqual(["r2", SEED_IDS.resident]);
  });

  test("staff cannot act on or read visits of unassigned residents", async () => {
    const { app, db, family2, nurse2 } = await withSecondResidentAndNurse();
    db.update(t.resident).set({ availability: "in_activity" }).run();
    const visit = (await app.inject({ method: "POST", url: "/visits", headers: auth(family2), payload: { residentId: "r2" } })).json().visit;
    expect((await app.inject({ method: "GET", url: `/visits/${visit.id}`, headers: auth(nurse2) })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/visits/${visit.id}/approve`, headers: auth(nurse2) })).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: "/residents/r2/availability", headers: auth(nurse2), payload: { availability: "resting" } })).statusCode).toBe(403);
  });

  test("an unassigned nurse and an admin can still STOP the facility robot", async () => {
    const { app, tokens, nurse2 } = await withSecondResidentAndNurse();
    for (const token of [nurse2, tokens.admin]) {
      const res = await app.inject({ method: "POST", url: `/robots/${SEED_IDS.robot}/stop`, headers: auth(token) });
      expect(res.statusCode).toBe(200);
    }
  });

  test("robot and locations of another facility are invisible", async () => {
    const { app, db, tokens } = await makeTestApp();
    db.insert(t.facility).values({ id: "fb", name: "B", timezone: "Asia/Taipei" }).run();
    db.insert(t.robot).values({ id: "robot_b", facilityId: "fb", name: "B", tokenHash: "x" }).run();
    db.insert(t.location).values({ id: "loc_b", facilityId: "fb", name: "B room", kind: "resident_room", x: 0, y: 0, yaw: 0, approved: true }).run();
    expect((await app.inject({ method: "POST", url: "/robots/robot_b/stop", headers: auth(tokens.staff) })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/robots/robot_b/status", headers: auth(tokens.staff) })).statusCode).toBe(404);
    const locations = (await app.inject({ method: "GET", url: "/locations", headers: auth(tokens.staff) })).json().locations.map((l: { id: string }) => l.id);
    expect(locations).not.toContain("loc_b");
    expect((await app.inject({ method: "PATCH", url: "/locations/loc_b", headers: auth(tokens.staff), payload: { approved: false } })).statusCode).toBe(404);
  });

  test("family no longer sees a resident whose link or record is gone", async () => {
    const { app, db, tokens } = await makeTestApp();
    db.update(t.resident).set({ active: false }).where(eq(t.resident.id, SEED_IDS.resident)).run();
    expect((await app.inject({ method: "GET", url: "/me/residents", headers: auth(tokens.family) })).json().residents).toEqual([]);
    expect((await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } })).statusCode).not.toBe(201);
  });

  test("a device unlock PIN must belong to active staff or admin of the device's facility", async () => {
    const { app, db, tokens } = await makeTestApp();
    const unlock = (pin: string) => app.inject({ method: "POST", url: "/device/unlock", headers: auth(tokens.device), payload: { pin } });
    expect((await unlock("2468")).statusCode).toBe(200);
    db.update(t.user).set({ active: false }).run();
    expect((await unlock("2468")).statusCode).toBe(401);
  });
});
