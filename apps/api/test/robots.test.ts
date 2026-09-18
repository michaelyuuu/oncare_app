import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import type { GatewayDown } from "@oncare/contracts";
import { makeTestApp } from "./helpers";
import * as t from "../src/db/schema";
import { SEED_IDS, SEED_SECRETS } from "../src/db/seed";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

function fakeLink() {
  const sent: GatewayDown[] = [];
  return { sent, link: { send: (m: GatewayDown) => { sent.push(m); } } };
}

/** A visit the robot has accepted and is driving: the one a staff stop must safety-stop. */
async function enRouteVisit(connect = true) {
  const ctx = await makeTestApp();
  const { sent, link } = fakeLink();
  if (connect) ctx.app.hub.attach(SEED_IDS.robot, link);
  const visitId = (await ctx.app.inject({ method: "POST", url: "/visits", headers: auth(ctx.tokens.family), payload: { residentId: SEED_IDS.resident } })).json().visit.id as string;
  ctx.app.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: visitId, result: "accepted" });
  const state = () => ctx.db.select().from(t.visitSession).where(eq(t.visitSession.id, visitId)).get()!.state;
  const robotAudit = () => ctx.db.select().from(t.auditEvent).where(eq(t.auditEvent.entityType, "robot")).all();
  return { ...ctx, sent, link, visitId, state, robotAudit };
}

describe("staff robot controls", () => {
  test("standby is staff-only, checks robot existence and records one independent intent and event", async () => {
    const { app, db, tokens } = await makeTestApp();
    const { sent, link } = fakeLink(); app.hub.attach(SEED_IDS.robot, link);
    const events: unknown[] = []; app.transitions.subscribe(e => events.push(e));
    const standby = (robot: string, token = tokens.staff) => app.inject({ method: "POST", url: `/robots/${robot}/standby`, headers: auth(token) });
    expect((await standby("missing")).statusCode).toBe(404);
    expect((await standby(SEED_IDS.robot, tokens.family)).statusCode).toBe(403);
    expect((await standby(SEED_IDS.robot, tokens.device)).statusCode).toBe(403);
    expect((await standby(SEED_IDS.robot)).json()).toEqual({ ok: true, delivered: true });
    expect(sent).toEqual([expect.objectContaining({ type: "intent", intent: "go_to_location", payload: { locationId: SEED_IDS.standbyLocation } })]);
    const cmd = db.select().from(t.robotCommand).get()!;
    expect(cmd).toMatchObject({ taskId: null, visitId: null, result: null, correlationId: expect.stringMatching(/^standby_/) });
    expect(events).toEqual([expect.objectContaining({ entityType: "robot", reason: "standby", actorId: SEED_IDS.staffUser, correlationId: cmd.correlationId })]);
    expect(app.dispatch.flushPending(SEED_IDS.robot)).toBe(0);
    expect((await standby(SEED_IDS.robot)).statusCode).toBe(409);
    app.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: cmd.correlationId, result: "accepted" });
    expect((await standby(SEED_IDS.robot)).statusCode).toBe(409);
    app.hub.receive(SEED_IDS.robot, { type: "state_event", correlationId: cmd.correlationId, at: new Date().toISOString(), event: "arrived" });
    expect((await standby(SEED_IDS.robot)).statusCode).toBe(200);
  });

  test("standby is busy while a visit awaits ack or a task is returning to standby", async () => {
    const { app, db, tokens } = await makeTestApp();
    const { link } = fakeLink(); app.hub.attach(SEED_IDS.robot, link);
    const standby = () => app.inject({ method: "POST", url: `/robots/${SEED_IDS.robot}/standby`, headers: auth(tokens.staff) });
    const visit = (await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } })).json().visit;
    expect((await standby()).statusCode).toBe(409);
    await app.inject({ method: "POST", url: `/visits/${visit.id}/cancel`, headers: auth(tokens.family) });
    const task = (await app.inject({ method: "POST", url: "/tasks", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident, text: "water" } })).json().task;
    await app.inject({ method: "POST", url: `/tasks/${task.id}/confirm`, headers: auth(tokens.family) });
    await app.inject({ method: "POST", url: `/tasks/${task.id}/approve`, headers: auth(tokens.staff) });
    expect((await standby()).statusCode).toBe(409);
    app.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: task.correlationId, result: "accepted" });
    db.update(t.taskRequest).set({ state: "verifying_delivery" }).where(eq(t.taskRequest.id, task.id)).run();
    expect((await standby()).statusCode).toBe(409);
    app.hub.receive(SEED_IDS.robot, { type: "state_event", correlationId: task.correlationId, at: new Date().toISOString(), event: "completed_leg" });
    expect((await standby()).statusCode).toBe(200);
  });

  test("STOP settles unacknowledged commands and standalone motion without replay or automatic resume", async () => {
    const { app, db, tokens } = await makeTestApp();
    const visit = (await app.inject({ method: "POST", url: "/visits", headers: auth(tokens.family), payload: { residentId: SEED_IDS.resident } })).json().visit;
    await app.inject({ method: "POST", url: `/robots/${SEED_IDS.robot}/stop`, headers: auth(tokens.staff) });
    expect(app.visits.get(visit.id)?.state).toBe("safety_stopped");
    const { sent, link } = fakeLink(); app.hub.attach(SEED_IDS.robot, link);
    expect(app.dispatch.flushPending(SEED_IDS.robot)).toBe(0);
    expect(sent).toEqual([]);
    await app.inject({ method: "POST", url: `/robots/${SEED_IDS.robot}/standby`, headers: auth(tokens.staff) });
    const cmd = db.select().from(t.robotCommand).all().at(-1)!;
    await app.inject({ method: "POST", url: `/robots/${SEED_IDS.robot}/stop`, headers: auth(tokens.staff) });
    expect(db.select().from(t.robotCommand).where(eq(t.robotCommand.id, cmd.id)).get()?.result).toBe("safety_stopped");
    expect(app.dispatch.flushPending(SEED_IDS.robot)).toBe(0);
    expect(sent.some(m => m.type === "resume")).toBe(false);
  });

  test("offline standby never queues a future physical action and expired pending standby is settled", async () => {
    let clock = new Date("2030-01-01T12:00:00Z");
    const { app, db, tokens } = await makeTestApp({ now: () => clock });
    const standby = () => app.inject({ method: "POST", url: `/robots/${SEED_IDS.robot}/standby`, headers: auth(tokens.staff) });
    expect((await standby()).json()).toEqual({ ok: true, delivered: false });
    expect(db.select().from(t.robotCommand).get()?.result).toBe("offline");
    const { sent, link } = fakeLink(); app.hub.attach(SEED_IDS.robot, link);
    expect(app.dispatch.flushPending(SEED_IDS.robot)).toBe(0);
    expect(sent).toEqual([]);
    await standby();
    clock = new Date("2030-01-01T12:03:00Z");
    expect(app.dispatch.sweepExpired()).toBe(1);
    expect(db.select().from(t.robotCommand).all().at(-1)?.result).toBe("expired");
    expect((await standby()).statusCode).toBe(200);
  });

  test("standby refuses an unapproved destination without creating a command", async () => {
    const { app, db, tokens } = await makeTestApp();
    const { sent, link } = fakeLink(); app.hub.attach(SEED_IDS.robot, link);
    db.update(t.location).set({ approved: false }).where(eq(t.location.id, SEED_IDS.standbyLocation)).run();
    const response = await app.inject({ method: "POST", url: `/robots/${SEED_IDS.robot}/standby`, headers: auth(tokens.staff) });
    expect(response.statusCode).toBe(409); expect(response.json()).toEqual({ error: "robot_unavailable" });
    expect(sent).toEqual([]); expect(db.select().from(t.robotCommand).all()).toEqual([]);
  });
  test("stop sends a staff_stop, safety-stops the active visit and audits the robot", async () => {
    const { app, db, tokens, sent, visitId, state, robotAudit } = await enRouteVisit();
    expect(state()).toBe("robot_en_route");
    const res = await app.inject({ method: "POST", url: `/robots/${SEED_IDS.robot}/stop`, headers: auth(tokens.staff), payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, delivered: true });
    expect(sent.at(-1)).toEqual({ type: "stop", reason: "staff_stop" });
    expect(state()).toBe("safety_stopped");
    const visitAudit = db.select().from(t.auditEvent).where(eq(t.auditEvent.entityId, visitId)).all().at(-1);
    expect(visitAudit).toMatchObject({ actorType: "staff", actorId: SEED_IDS.staffUser, toState: "safety_stopped", reason: "staff_stop" });
    expect(robotAudit()).toHaveLength(1);
    expect(robotAudit()[0]).toMatchObject({
      actorType: "staff", actorId: SEED_IDS.staffUser, entityType: "robot", entityId: SEED_IDS.robot,
      fromState: null, toState: null, reason: "staff_stop", correlationId: visitId,
    });
  });

  test("stop with the robot offline still stops the visit and reports delivered:false", async () => {
    const { app, tokens, state, robotAudit } = await enRouteVisit(false);
    const res = await app.inject({ method: "POST", url: `/robots/${SEED_IDS.robot}/stop`, headers: auth(tokens.staff), payload: { reason: "smoke" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, delivered: false });
    expect(state()).toBe("safety_stopped");
    expect(robotAudit()).toHaveLength(1);
  });

  test("stop leaves a terminal visit alone", async () => {
    const { app, db, tokens, visitId, state } = await enRouteVisit();
    await app.inject({ method: "POST", url: `/visits/${visitId}/cancel`, headers: auth(tokens.family) });
    expect(state()).toBe("cancelled");
    const before = db.select().from(t.auditEvent).where(eq(t.auditEvent.entityId, visitId)).all().length;
    expect((await app.inject({ method: "POST", url: `/robots/${SEED_IDS.robot}/stop`, headers: auth(tokens.staff), payload: {} })).statusCode).toBe(200);
    expect(state()).toBe("cancelled");
    expect(db.select().from(t.auditEvent).where(eq(t.auditEvent.entityId, visitId)).all()).toHaveLength(before);
  });

  test("resume with the caller's own pin sends resume and audits staff_resume", async () => {
    const { app, tokens, sent, robotAudit } = await enRouteVisit();
    const res = await app.inject({ method: "POST", url: `/robots/${SEED_IDS.robot}/resume`, headers: auth(tokens.staff), payload: { pin: SEED_SECRETS.staffPin } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, delivered: true });
    expect(sent.at(-1)).toEqual({ type: "resume" });
    expect(robotAudit().at(-1)).toMatchObject({ actorType: "staff", actorId: SEED_IDS.staffUser, entityType: "robot", reason: "staff_resume" });
  });

  test("resume with a wrong pin is 401, audits staff_resume_failed and sends nothing", async () => {
    const { app, tokens, sent, robotAudit } = await enRouteVisit();
    const before = sent.length;
    const res = await app.inject({ method: "POST", url: `/robots/${SEED_IDS.robot}/resume`, headers: auth(tokens.staff), payload: { pin: "0000" } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid_pin" });
    expect(sent).toHaveLength(before);
    expect(robotAudit().at(-1)).toMatchObject({ actorType: "staff", actorId: SEED_IDS.staffUser, entityType: "robot", reason: "staff_resume_failed" });
  });

  test("an unknown robot is 404 on status, stop and resume", async () => {
    const { app, tokens } = await makeTestApp();
    for (const [method, url, payload] of [
      ["GET", "/robots/robot_nope/status", undefined],
      ["POST", "/robots/robot_nope/stop", {}],
      ["POST", "/robots/robot_nope/resume", { pin: SEED_SECRETS.staffPin }],
    ] as const) {
      const res = await app.inject({ method, url, headers: auth(tokens.staff), ...(payload ? { payload } : {}) });
      expect([url, res.statusCode]).toEqual([url, 404]);
    }
  });

  test("family cannot read status, stop or resume a robot", async () => {
    const { app, tokens } = await makeTestApp();
    for (const [method, url, payload] of [
      ["GET", `/robots/${SEED_IDS.robot}/status`, undefined],
      ["POST", `/robots/${SEED_IDS.robot}/stop`, {}],
      ["POST", `/robots/${SEED_IDS.robot}/resume`, { pin: SEED_SECRETS.staffPin }],
    ] as const) {
      const res = await app.inject({ method, url, headers: auth(tokens.family), ...(payload ? { payload } : {}) });
      expect([url, res.statusCode]).toEqual([url, 403]);
    }
  });

  test("resume without a pin is 400", async () => {
    const { app, tokens } = await makeTestApp();
    expect((await app.inject({ method: "POST", url: `/robots/${SEED_IDS.robot}/resume`, headers: auth(tokens.staff), payload: {} })).statusCode).toBe(400);
  });
});
