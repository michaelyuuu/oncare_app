import { beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type Db } from "../src/db/client";
import * as t from "../src/db/schema";
import { SEED_IDS, seed } from "../src/db/seed";
import { actionRole, createAccess, type Access } from "../src/services/access";
import type { Principal } from "../src/auth/plugin";

const F = SEED_IDS.facility;
const R1 = SEED_IDS.resident;
let db: Db;
let access: Access;

const staff = (id: string = SEED_IDS.staffUser, facilityId: string | null = F): Principal => ({ kind: "user", id, role: "staff", facilityId });
const admin = (facilityId: string | null = F): Principal => ({ kind: "user", id: SEED_IDS.adminUser, role: "admin", facilityId });
const family = (id: string = SEED_IDS.familyUser): Principal => ({ kind: "user", id, role: "family", facilityId: null });
const device = (overrides: Partial<Extract<Principal, { kind: "device" }>> = {}): Principal => ({ kind: "device", id: SEED_IDS.device, residentId: R1, facilityId: F, robotId: SEED_IDS.robot, assignmentVersion: 1, ...overrides });

beforeEach(async () => {
  db = openDb(":memory:");
  await seed(db);
  access = createAccess(db);
  // A second resident in the same facility nobody is linked or assigned to, and a second facility.
  db.insert(t.resident).values({ id: "r2", facilityId: F, displayName: "Two", roomLocationId: SEED_IDS.roomLocation }).run();
  db.insert(t.facility).values({ id: "fb", name: "B", timezone: "Asia/Taipei" }).run();
  db.insert(t.resident).values({ id: "rb", facilityId: "fb", displayName: "B1", roomLocationId: SEED_IDS.roomLocation }).run();
});

describe("residentIdsVisibleTo / canAccessResident", () => {
  test.each<[string, () => Principal, string[]]>([
    ["admin sees every active resident of its facility", () => admin(), [R1, "r2"]],
    ["admin of another facility sees only that facility", () => admin("fb"), ["rb"]],
    ["admin with no facility sees nothing", () => admin(null), []],
    ["staff sees only assigned residents", () => staff(), [R1]],
    ["staff with no facility sees nothing", () => staff(SEED_IDS.staffUser, null), []],
    ["family sees linked residents", () => family(), [R1]],
    ["device sees only its resident", () => device(), [R1]],
  ])("%s", (_name, principal, expected) => {
    expect(access.residentIdsVisibleTo(principal()).sort()).toEqual(expected.sort());
    for (const id of [R1, "r2", "rb"]) expect(access.canAccessResident(principal(), id)).toBe(expected.includes(id));
  });

  test("an assignment to a resident of another facility grants nothing", () => {
    db.insert(t.staffAssignment).values({ id: "sa_x", userId: SEED_IDS.staffUser, residentId: "rb", createdAt: new Date(0).toISOString() }).run();
    expect(access.canAccessResident(staff(), "rb")).toBe(false);
  });

  test("inactive assignment and inactive resident grant nothing", () => {
    db.update(t.staffAssignment).set({ active: false }).run();
    expect(access.residentIdsVisibleTo(staff())).toEqual([]);
    db.update(t.resident).set({ active: false }).where(eq(t.resident.id, R1)).run();
    for (const p of [admin(), family(), device()]) expect(access.canAccessResident(p, R1)).toBe(false);
  });
});

describe("resolvePrincipal", () => {
  test("returns fresh user data and rejects missing or inactive users", () => {
    expect(access.resolvePrincipal(staff())).toEqual(staff());
    db.update(t.user).set({ role: "admin" }).where(eq(t.user.id, SEED_IDS.staffUser)).run();
    expect(access.resolvePrincipal(staff())).toMatchObject({ role: "admin" });
    db.update(t.user).set({ active: false }).where(eq(t.user.id, SEED_IDS.staffUser)).run();
    expect(access.resolvePrincipal(staff())).toBeNull();
    expect(access.resolvePrincipal(staff("nobody"))).toBeNull();
  });

  test("rejects a device that was reassigned, bumped or deactivated", () => {
    expect(access.resolvePrincipal(device())).toEqual(device());
    expect(access.resolvePrincipal(device({ residentId: "r2" }))).toBeNull();
    expect(access.resolvePrincipal(device({ assignmentVersion: 0 }))).toBeNull();
    db.update(t.device).set({ active: false }).run();
    expect(access.resolvePrincipal(device())).toBeNull();
  });

  test("rejects a 0.1.0-shaped device token with no assignment version", () => {
    const legacy = { kind: "device", id: SEED_IDS.device, residentId: R1, robotId: SEED_IDS.robot } as unknown as Principal;
    expect(access.resolvePrincipal(legacy)).toBeNull();
  });
});

describe("helpers", () => {
  test("sameFacility, familyLink and actionRole", () => {
    expect(access.sameFacility(staff(), F)).toBe(true);
    expect(access.sameFacility(family(), F)).toBe(false);
    expect(access.sameFacility(device(), F)).toBe(true);
    expect(access.familyLink(SEED_IDS.familyUser, R1)).toMatchObject({ label: "daughter" });
    expect(access.familyLink(SEED_IDS.familyUser, "r2")).toBeUndefined();
    expect(access.familyLinks(SEED_IDS.familyUser)).toHaveLength(1);
    expect([admin(), staff(), family(), device()].map(actionRole)).toEqual(["staff", "staff", "family", "device"]);
  });
});
