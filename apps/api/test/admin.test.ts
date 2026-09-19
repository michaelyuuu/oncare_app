import { describe, expect, test } from "vitest";
import { makeTestApp } from "./helpers";
import * as t from "../src/db/schema";
import { SEED_IDS } from "../src/db/seed";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function adminApp() {
  const ctx = await makeTestApp();
  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown, token = ctx.tokens.admin) =>
    ctx.app.inject({ method, url, headers: auth(token), ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { ...ctx, call };
}

describe("admin API", () => {
  test("only admins may call it", async () => {
    const { call, tokens } = await adminApp();
    for (const token of [tokens.staff, tokens.family, tokens.device]) expect((await call("GET", "/admin/residents", undefined, token)).statusCode).toBe(403);
  });

  test("residents: create, edit, deactivate, audited with the facility as correlation id", async () => {
    const { call, db } = await adminApp();
    const created = await call("POST", "/admin/residents", { displayName: "New", roomLocationId: SEED_IDS.roomLocation });
    expect(created.statusCode).toBe(201);
    const id = created.json().resident.id as string;
    expect((await call("POST", "/admin/residents", { displayName: "X", roomLocationId: SEED_IDS.pickupLocation })).json()).toEqual({ error: "bad_location" });
    expect((await call("PATCH", `/admin/residents/${id}`, { displayName: "Renamed" })).json().resident.displayName).toBe("Renamed");
    expect((await call("POST", `/admin/residents/${id}/deactivate`)).json().resident.active).toBe(false);
    const audit = db.select().from(t.auditEvent).all().filter((e) => e.actorType === "admin");
    expect(audit.map((e) => e.reason)).toEqual(["resident_created", "resident_updated", "resident_deactivated"]);
    expect(audit.every((e) => e.correlationId === SEED_IDS.facility && e.entityType === "resident")).toBe(true);
  });

  test("users: create staff and family, reject duplicates, never return hashes, cannot deactivate self", async () => {
    const { call } = await adminApp();
    const staff = await call("POST", "/admin/users", { role: "staff", username: "nurse9", displayName: "Nurse", password: "pw-long", pin: "1111" });
    expect(staff.statusCode).toBe(201);
    expect(staff.json().user).toEqual({ id: expect.any(String), role: "staff", username: "nurse9", displayName: "Nurse", facilityId: SEED_IDS.facility, active: true });
    expect((await call("POST", "/admin/users", { role: "family", username: "nurse9", displayName: "Dup", password: "pw-long" })).json()).toEqual({ error: "username_taken" });
    expect((await call("POST", "/admin/users", { role: "admin", username: "boss", displayName: "Boss", password: "pw-long" })).statusCode).toBe(400);
    const fam = (await call("POST", "/admin/users", { role: "family", username: "son9", displayName: "Son", password: "pw-long" })).json().user;
    expect(fam.facilityId).toBeNull();
    const listed = (await call("GET", "/admin/users")).json().users as Array<Record<string, unknown>>;
    expect(listed.some((u) => "passwordHash" in u || "pinHash" in u)).toBe(false);
    // A family member with no link to this facility is not listed.
    expect(listed.map((u) => u.username)).not.toContain("son9");
    expect((await call("POST", `/admin/users/${SEED_IDS.adminUser}/deactivate`)).json()).toEqual({ error: "cannot_deactivate_self" });
  });

  test("family links and staff assignments grant and revoke access", async () => {
    const { app, call, db } = await adminApp();
    const fam = (await call("POST", "/admin/users", { role: "family", username: "son9", displayName: "Son", password: "pw-long" })).json().user;
    const link = await call("POST", "/admin/family-links", { userId: fam.id, residentId: SEED_IDS.resident, label: "son", consentVideo: true });
    expect(link.statusCode).toBe(201);
    expect((await call("POST", "/admin/family-links", { userId: fam.id, residentId: SEED_IDS.resident, label: "son" })).json()).toEqual({ error: "duplicate" });
    // Checked while fam's link is still active, i.e. fam is still in scope: a family role is rejected
    // for a staff assignment on its own merits, not because fam has since dropped out of scope below.
    const nurse = (await call("POST", "/admin/users", { role: "staff", username: "nurse9", displayName: "N", password: "pw-long" })).json().user;
    expect((await call("POST", "/admin/staff-assignments", { userId: fam.id, residentId: SEED_IDS.resident })).json()).toEqual({ error: "bad_role" });
    const famToken = (await app.inject({ method: "POST", url: "/auth/login", payload: { username: "son9", password: "pw-long" } })).json().token;
    const mine = async () => (await app.inject({ method: "GET", url: "/me/residents", headers: auth(famToken) })).json().residents.length;
    expect(await mine()).toBe(1);
    expect((await call("DELETE", `/admin/family-links/${link.json().link.id}`)).statusCode).toBe(200);
    expect(await mine()).toBe(0);

    const sa = await call("POST", "/admin/staff-assignments", { userId: nurse.id, residentId: SEED_IDS.resident });
    expect(sa.statusCode).toBe(201);
    await call("DELETE", `/admin/staff-assignments/${sa.json().assignment.id}`);
    expect(db.select().from(t.staffAssignment).all().find((a) => a.userId === nurse.id)?.active).toBe(false);
    // Re-assigning reactivates the same row instead of failing on the unique index.
    expect((await call("POST", "/admin/staff-assignments", { userId: nurse.id, residentId: SEED_IDS.resident })).statusCode).toBe(201);
  });

  test("devices: token shown once, reassignment revokes the old session, deactivation blocks login", async () => {
    const { app, call, db } = await adminApp();
    const r2 = (await call("POST", "/admin/residents", { displayName: "Two", roomLocationId: SEED_IDS.roomLocation })).json().resident;
    const created = await call("POST", "/admin/devices", { residentId: SEED_IDS.resident });
    expect(created.statusCode).toBe(201);
    const { device, deviceToken } = created.json();
    expect(device).toMatchObject({ residentId: SEED_IDS.resident, robotId: null, active: true, assignmentVersion: 1 });
    expect(device).not.toHaveProperty("deviceTokenHash");
    expect((await call("GET", "/admin/devices")).json().devices.some((d: Record<string, unknown>) => "deviceToken" in d || "deviceTokenHash" in d)).toBe(false);
    expect(db.select().from(t.device).all().some((d) => d.deviceTokenHash.includes(deviceToken))).toBe(false);

    const login = await app.inject({ method: "POST", url: "/auth/device", payload: { deviceToken } });
    expect(login.json().principal).toMatchObject({ residentId: SEED_IDS.resident, robotId: null });
    const session = login.json().token as string;
    const state = () => app.inject({ method: "GET", url: "/device/state", headers: auth(session) });
    expect((await state()).statusCode).toBe(200);

    expect((await call("POST", `/admin/devices/${device.id}/assign`, { residentId: r2.id })).json().device.assignmentVersion).toBe(2);
    expect((await state()).statusCode).toBe(401);
    const relogin = await app.inject({ method: "POST", url: "/auth/device", payload: { deviceToken } });
    expect(relogin.json().principal.residentId).toBe(r2.id);

    await call("POST", `/admin/devices/${device.id}/deactivate`);
    expect((await app.inject({ method: "POST", url: "/auth/device", payload: { deviceToken } })).statusCode).toBe(401);
  });

  test("an admin cannot touch another facility", async () => {
    const { call, db } = await adminApp();
    db.insert(t.facility).values({ id: "fb", name: "B", timezone: "Asia/Taipei" }).run();
    db.insert(t.location).values({ id: "loc_b", facilityId: "fb", name: "B room", kind: "resident_room", x: 0, y: 0, yaw: 0, approved: true }).run();
    db.insert(t.resident).values({ id: "rb", facilityId: "fb", displayName: "B1", roomLocationId: "loc_b" }).run();
    expect((await call("PATCH", "/admin/residents/rb", { displayName: "Hacked" })).statusCode).toBe(403);
    expect((await call("POST", "/admin/devices", { residentId: "rb" })).statusCode).toBe(403);
    expect((await call("POST", "/admin/staff-assignments", { userId: SEED_IDS.staffUser, residentId: "rb" })).statusCode).toBe(403);
    expect((await call("POST", "/admin/residents", { displayName: "X", roomLocationId: "loc_b" })).json()).toEqual({ error: "bad_location" });
    expect((await call("GET", "/admin/residents")).json().residents.map((r: { id: string }) => r.id)).not.toContain("rb");
  });
});
