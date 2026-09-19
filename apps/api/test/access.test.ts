import { beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { makeTransitionEvent, type AuditEvent } from "@oncare/core";
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

describe("auditVisibleTo", () => {
  const residentEvent = (): AuditEvent => makeTransitionEvent({
    actorType: "staff", actorId: SEED_IDS.staffUser, entityType: "resident", entityId: R1,
    fromState: "available", toState: "resting", reason: "availability_changed", correlationId: R1,
  });

  test.each<[string, () => Principal, boolean]>([
    ["staff assigned to the resident sees it", () => staff(), true],
    ["family never sees a resident-entity event", () => family(), false],
    ["device never sees a resident-entity event", () => device(), false],
  ])("resident event: %s", (_name, principal, expected) => {
    expect(access.auditVisibleTo(principal(), residentEvent())).toBe(expected);
  });

  describe("visit event", () => {
    function visitEvent() {
      db.insert(t.visitSession).values({
        id: "visit_x", residentId: R1, requesterId: SEED_IDS.familyUser, robotId: null,
        state: "accepted", livekitRoom: null, requestedAt: new Date(0).toISOString(), connectedAt: null, endedAt: null,
      }).run();
      return makeTransitionEvent({
        actorType: "family", actorId: SEED_IDS.familyUser, entityType: "visit", entityId: "visit_x",
        fromState: null, toState: "accepted", reason: "auto_policy", correlationId: "visit_x",
      });
    }

    test("the requester sees their own visit", () => {
      expect(access.auditVisibleTo(family(SEED_IDS.familyUser), visitEvent())).toBe(true);
    });

    test("an unrelated family user does not", () => {
      db.insert(t.user).values({ id: "fam2", role: "family", username: "fam2", displayName: "Other", passwordHash: "x", pinHash: null, facilityId: null }).run();
      expect(access.auditVisibleTo(family("fam2"), visitEvent())).toBe(false);
    });

    test("the resident's own device sees it", () => {
      expect(access.auditVisibleTo(device(), visitEvent())).toBe(true);
    });

    test("staff not assigned to the resident does not", () => {
      db.insert(t.user).values({ id: "staff2", role: "staff", username: "staff2", displayName: "Other", passwordHash: "x", pinHash: null, facilityId: F }).run();
      expect(access.auditVisibleTo(staff("staff2"), visitEvent())).toBe(false);
    });
  });

  describe("robot event", () => {
    const robotEvent = (): AuditEvent => makeTransitionEvent({
      actorType: "staff", actorId: SEED_IDS.staffUser, entityType: "robot", entityId: SEED_IDS.robot,
      fromState: null, toState: null, reason: "standby", correlationId: SEED_IDS.robot,
    });

    test("staff of the robot's facility sees it", () => {
      expect(access.auditVisibleTo(staff(), robotEvent())).toBe(true);
    });

    test("admin of another facility does not", () => {
      expect(access.auditVisibleTo(admin("fb"), robotEvent())).toBe(false);
    });

    test("family never sees a robot event", () => {
      expect(access.auditVisibleTo(family(), robotEvent())).toBe(false);
    });
  });

  describe("admin-only entity (correlationId is the facility)", () => {
    const facilityEvent = (): AuditEvent => makeTransitionEvent({
      actorType: "admin", actorId: SEED_IDS.adminUser, entityType: "device", entityId: SEED_IDS.device,
      fromState: null, toState: null, reason: "device_registered", correlationId: F,
    });

    test("admin of that facility sees it", () => {
      expect(access.auditVisibleTo(admin(F), facilityEvent())).toBe(true);
    });

    test("staff does not", () => {
      expect(access.auditVisibleTo(staff(), facilityEvent())).toBe(false);
    });

    test("admin of another facility does not", () => {
      expect(access.auditVisibleTo(admin("fb"), facilityEvent())).toBe(false);
    });
  });
});
