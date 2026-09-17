import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp } from "./helpers";
import * as t from "../src/db/schema";
import { SEED_IDS } from "../src/db/seed";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("POST /visits", () => {
  test("family user with consent creates a visit that is auto-accepted when the resident is available", async () => {
    const { app, db, tokens } = await makeTestApp();
    const res = await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } });
    expect(res.statusCode).toBe(201);
    const visit = res.json().visit;
    expect(visit).toMatchObject({ residentId: SEED_IDS.resident, requesterId: SEED_IDS.familyUser, state: "accepted" });
    const audit = db.select().from(t.auditEvent).where(eq(t.auditEvent.entityId, visit.id)).all().map((e) => e.toState);
    expect(audit).toEqual(["awaiting_policy_or_staff", "accepted"]);
  });

  test("resident in_activity leaves the visit awaiting staff", async () => {
    const { app, db, tokens } = await makeTestApp();
    db.update(t.resident).set({ availability: "in_activity" }).where(eq(t.resident.id, SEED_IDS.resident)).run();
    const res = await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } });
    expect(res.statusCode).toBe(201);
    expect(res.json().visit.state).toBe("awaiting_policy_or_staff");
  });

  test("resident not_available is 409 and creates nothing", async () => {
    const { app, db, tokens } = await makeTestApp();
    db.update(t.resident).set({ availability: "not_available" }).where(eq(t.resident.id, SEED_IDS.resident)).run();
    const res = await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "resident_unavailable" });
    expect(db.select().from(t.visitSession).all()).toHaveLength(0);
  });

  test("family user without a relationship to the resident is 403", async () => {
    const { app, db, tokens } = await makeTestApp();
    db.insert(t.resident).values({ id: "resident_demo_02", facilityId: SEED_IDS.facility, displayName: "Other", roomLocationId: SEED_IDS.roomLocation }).run();
    const res = await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: "resident_demo_02" } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "no_relationship" });
  });

  test("relationship without robot-visit consent is 409 consent_missing", async () => {
    const { app, db, tokens } = await makeTestApp();
    db.update(t.familyRelationship).set({ consentRobotVisit: false }).where(eq(t.familyRelationship.userId, SEED_IDS.familyUser)).run();
    const res = await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "consent_missing" });
  });

  test("staff cannot create visits", async () => {
    const { app, tokens } = await makeTestApp();
    const res = await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.staff), payload: { residentId: SEED_IDS.resident } });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /visits/:id", () => {
  async function created() {
    const ctx = await makeTestApp();
    const res = await ctx.app.inject({ method: "POST", url: "/visits", headers: auth(ctx.tokens.family), payload: { residentId: SEED_IDS.resident } });
    return { ...ctx, visitId: res.json().visit.id as string };
  }

  test("owner, staff, and the resident's device can read it", async () => {
    const { app, tokens, visitId } = await created();
    for (const tok of [tokens.family, tokens.staff, tokens.device]) {
      const res = await app.inject({ method: "GET", url: `/visits/${visitId}`, headers: auth(tok) });
      expect(res.statusCode).toBe(200);
      expect(res.json().visit.id).toBe(visitId);
    }
  });

  test("reports whether the visit robot is simulated from its latest heartbeat", async () => {
    const { app, tokens, visitId } = await created();
    const before = await app.inject({ method: "GET", url: `/visits/${visitId}`, headers: auth(tokens.family) });
    expect(before.json().visit.simulated).toBe(false);
    app.hub.receive(SEED_IDS.robot, { type: "heartbeat", at: "2026-01-01T00:00:00.000Z", robotReady: true, adapter: "mock", pose: null, navState: "idle", estop: false, lift: "down", battery: 100, activeCorrelationId: null, gatewayVersion: "test" });
    const after = await app.inject({ method: "GET", url: `/visits/${visitId}`, headers: auth(tokens.family) });
    expect(after.json().visit.simulated).toBe(true);
  });

  test("another family user is 403 and an unknown id is 404", async () => {
    const { app, db, tokens, visitId } = await created();
    const { hashSecret } = await import("../src/auth/password");
    db.insert(t.user).values({ id: "family_demo_02", role: "family", username: "family2", displayName: "Other", passwordHash: await hashSecret("pw"), pinHash: null }).run();
    const other = (await app.inject({ method: "POST", url: "/auth/login", payload: { username: "family2", password: "pw" } })).json().token;
    expect((await app.inject({ method: "GET", url: `/visits/${visitId}`, headers: auth(other) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/visits/nope`, headers: auth(tokens.family) })).statusCode).toBe(404);
  });
});
