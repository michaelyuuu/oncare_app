import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp } from "./helpers";
import * as t from "../src/db/schema";
import { SEED_IDS, SEED_SECRETS } from "../src/db/seed";
import { screenForVisitState } from "../src/routes/device";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("screenForVisitState", () => {
  test("maps visit states to kiosk screens", () => {
    expect(screenForVisitState(null)).toBe("home");
    expect(screenForVisitState("accepted")).toBe("home");
    expect(screenForVisitState("robot_en_route")).toBe("home");
    expect(screenForVisitState("awaiting_resident_consent")).toBe("incoming");
    for (const s of ["connecting", "active", "ending"]) expect(screenForVisitState(s)).toBe("in_call");
    expect(screenForVisitState("completed")).toBe("home");
  });
});

describe("GET /device/state", () => {
  test("home when there is no visit", async () => {
    const { app, tokens } = await makeTestApp();
    const res = await app.inject({ method: "GET", url: "/device/state", headers: auth(tokens.device) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ resident: { id: SEED_IDS.resident, displayName: "Demo Resident" }, screen: "home", visit: null, caller: null, task: null, robot: { adapter: null, connected: false } });
  });

  test("incoming with caller name when a visit awaits resident consent", async () => {
    const { app, db, tokens } = await makeTestApp();
    const created = await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } });
    const id = created.json().visit.id;
    db.update(t.visitSession).set({ state: "awaiting_resident_consent" }).where(eq(t.visitSession.id, id)).run();
    const res = await app.inject({ method: "GET", url: "/device/state", headers: auth(tokens.device) });
    expect(res.json()).toMatchObject({ screen: "incoming", visit: { id, state: "awaiting_resident_consent" }, caller: { displayName: "Demo Daughter" } });
  });

  test("terminal visits do not affect the screen", async () => {
    const { app, db, tokens } = await makeTestApp();
    const id = (await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } })).json().visit.id;
    db.update(t.visitSession).set({ state: "completed" }).where(eq(t.visitSession.id, id)).run();
    expect((await app.inject({ method: "GET", url: "/device/state", headers: auth(tokens.device) })).json()).toMatchObject({ screen: "home", visit: null });
  });

  test("robot block reflects the hub heartbeat", async () => {
    const { app, tokens } = await makeTestApp();
    app.hub.attach(SEED_IDS.robot, { send() {} });
    app.hub.receive(SEED_IDS.robot, { type: "heartbeat", at: new Date().toISOString(), robotReady: true, adapter: "mock", pose: null, navState: "idle", estop: false, lift: "unknown", battery: "unknown", activeCorrelationId: null, gatewayVersion: "0.0.1" });
    expect((await app.inject({ method: "GET", url: "/device/state", headers: auth(tokens.device) })).json().robot).toEqual({ adapter: "mock", connected: true });
  });

  test("family token is 403", async () => {
    const { app, tokens } = await makeTestApp();
    expect((await app.inject({ method: "GET", url: "/device/state", headers: auth(tokens.family) })).statusCode).toBe(403);
  });
});

describe("GET /device/state with tasks", () => {
  async function taskIn(state: string) {
    const ctx = await makeTestApp();
    const id = (await ctx.app.inject({
      method: "POST",
      url: "/tasks",
      headers: auth(ctx.tokens.family),
      payload: { residentId: SEED_IDS.resident, text: "water bottle" },
    })).json().task.id as string;
    ctx.db.update(t.taskRequest).set({ state }).where(eq(t.taskRequest.id, id)).run();
    return { ...ctx, id };
  }

  test("placing shows delivery_arrived with the item label", async () => {
    const { app, tokens, id } = await taskIn("placing");
    const res = await app.inject({ method: "GET", url: "/device/state", headers: auth(tokens.device) });
    expect(res.json()).toMatchObject({
      screen: "delivery_arrived",
      task: { id, state: "placing", item: { id: "water_bottle", label: "water bottle" } },
    });
  });

  test.each(["awaiting_user_confirmation", "awaiting_policy_or_staff"])("older placing delivery stays receivable ahead of newer %s proposal and still yields to calls", async (state) => {
    const { app, db, tokens, id } = await taskIn("placing");
    db.update(t.taskRequest).set({ createdAt: "2026-01-01T00:00:00Z" }).where(eq(t.taskRequest.id, id)).run();
    const newer = (await app.inject({ method: "POST", url: "/tasks", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident, text: "tissues" } })).json().task;
    db.update(t.taskRequest).set({ state, createdAt: "2026-01-02T00:00:00Z" }).where(eq(t.taskRequest.id, newer.id)).run();
    const get = async () => (await app.inject({ method: "GET", url: "/device/state", headers: auth(tokens.device) })).json();
    expect(await get()).toMatchObject({ screen: "delivery_arrived", task: { id, state: "placing", item: { id: "water_bottle" } } });
    const visitId = (await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } })).json().visit.id;
    for (const [callState, screen] of [["awaiting_resident_consent", "incoming"], ["active", "in_call"], ["completed", "delivery_arrived"]]) {
      db.update(t.visitSession).set({ state: callState }).where(eq(t.visitSession.id, visitId)).run();
      expect(await get()).toMatchObject({ screen, task: { id, state: "placing" } });
    }
    expect((await app.inject({ method: "POST", url: `/tasks/${id}/received`, headers: auth(tokens.device) })).json().task.state).toBe("verifying_delivery");
  });

  test("an in-progress task that is not yet placing keeps the home screen", async () => {
    const { app, tokens, id } = await taskIn("navigating_to_delivery");
    expect((await app.inject({ method: "GET", url: "/device/state", headers: auth(tokens.device) })).json()).toMatchObject({
      screen: "home",
      task: { id, state: "navigating_to_delivery" },
    });
  });

  test("a call wins while retaining the delivery, then the notice appears after the call", async () => {
    const { app, db, tokens, id } = await taskIn("placing");
    const visitId = (await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } })).json().visit.id;
    db.update(t.visitSession).set({ state: "active" }).where(eq(t.visitSession.id, visitId)).run();

    const duringCall = (await app.inject({ method: "GET", url: "/device/state", headers: auth(tokens.device) })).json();
    expect(duringCall).toMatchObject({ screen: "in_call", task: { id, state: "placing" } });

    db.update(t.visitSession).set({ state: "completed" }).where(eq(t.visitSession.id, visitId)).run();
    expect((await app.inject({ method: "GET", url: "/device/state", headers: auth(tokens.device) })).json()).toMatchObject({
      screen: "delivery_arrived",
      task: { id, state: "placing" },
    });
  });

  test("device receipt advances to verification and keeps the task until standby", async () => {
    const { app, tokens, id } = await taskIn("placing");
    expect((await app.inject({ method: "POST", url: `/tasks/${id}/received`, headers: auth(tokens.device) })).json().task.state).toBe("verifying_delivery");
    expect((await app.inject({ method: "GET", url: "/device/state", headers: auth(tokens.device) })).json()).toMatchObject({
      screen: "home",
      task: { id, state: "verifying_delivery" },
    });
  });
});

describe("POST /device/call-caregiver and /device/unlock", () => {
  test("call-caregiver writes an audit row with reason call_caregiver", async () => {
    const { app, db, tokens } = await makeTestApp();
    expect((await app.inject({ method: "POST", url: "/device/call-caregiver", headers: auth(tokens.device) })).json()).toEqual({ ok: true });
    const row = db.select().from(t.auditEvent).all().at(-1);
    expect(row).toMatchObject({ actorType: "device", actorId: SEED_IDS.device, entityType: "robot", entityId: SEED_IDS.robot, reason: "call_caregiver", correlationId: SEED_IDS.device });
  });

  test("unlock accepts the staff PIN and rejects a wrong one, auditing both", async () => {
    const { app, db, tokens } = await makeTestApp();
    expect((await app.inject({ method: "POST", url: "/device/unlock", headers: auth(tokens.device), payload: { pin: "0000" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/device/unlock", headers: auth(tokens.device), payload: { pin: SEED_SECRETS.staffPin } })).json()).toEqual({ ok: true });
    const reasons = db.select().from(t.auditEvent).all().map((e) => e.reason);
    expect(reasons.slice(-2)).toEqual(["device_unlock_failed", "device_unlock"]);
  });
});
