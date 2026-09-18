import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import type { GatewayDown } from "@oncare/contracts";
import { makeTestApp } from "./helpers";
import * as t from "../src/db/schema";
import { SEED_IDS } from "../src/db/seed";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function proposal(connect = true, now?: () => Date) {
  const ctx = await makeTestApp(now ? { now } : {});
  const sent: GatewayDown[] = [];
  const link = { send: (message: GatewayDown) => { sent.push(message); } };
  if (connect) ctx.app.hub.attach(SEED_IDS.robot, link);
  const response = await ctx.app.inject({ method: "POST", url: "/tasks", headers: auth(ctx.tokens.family), payload: { residentId: SEED_IDS.resident, text: "water bottle" } });
  const task = response.json().task;
  const act = (action: string, token: string) => ctx.app.inject({ method: "POST", url: `/tasks/${task.id}/${action}`, headers: auth(token) });
  const state = () => ctx.db.select().from(t.taskRequest).where(eq(t.taskRequest.id, task.id)).get()!.state;
  const robot = (message: any) => ctx.app.hub.receive(SEED_IDS.robot, message);
  const event = (name: string) => robot({ type: "state_event", correlationId: task.correlationId, at: new Date().toISOString(), event: name });
  return { ...ctx, sent, link, task, act, state, robot, event };
}

async function queued(connect = true, now?: () => Date) {
  const ctx = await proposal(connect, now);
  await ctx.act("confirm", ctx.tokens.family);
  await ctx.act("approve", ctx.tokens.staff);
  return ctx;
}

describe("task actions and dispatch", () => {
  test("requires family confirmation and staff approval before dispatch", async () => {
    const ctx = await proposal();
    expect(ctx.sent).toHaveLength(0);
    expect((await ctx.act("approve", ctx.tokens.staff)).statusCode).toBe(409);
    expect((await ctx.act("confirm", ctx.tokens.family)).json().task.state).toBe("awaiting_policy_or_staff");
    expect(ctx.sent).toHaveLength(0);
    expect((await ctx.act("loaded", ctx.tokens.staff)).statusCode).toBe(409);
    expect((await ctx.act("approve", ctx.tokens.staff)).json().task.state).toBe("queued");
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]).toMatchObject({ type: "intent", intent: "deliver_item", correlationId: ctx.task.correlationId, payload: { itemId: "water_bottle", pickupLocationId: SEED_IDS.pickupLocation, destinationLocationId: SEED_IDS.roomLocation, standbyLocationId: SEED_IDS.standbyLocation, mode: "tray" } });
  });

  test("an approval insert failure rolls back queued state and cannot dispatch", async () => {
    const ctx = await proposal();
    await ctx.act("confirm", ctx.tokens.family);
    const auditBefore = ctx.db.select().from(t.auditEvent).where(eq(t.auditEvent.entityId, ctx.task.id)).all().length;
    (ctx.db as any).$client.exec(`CREATE TRIGGER fail_task_approval BEFORE INSERT ON task_approval BEGIN SELECT RAISE(ABORT, 'approval insert failed'); END`);

    const response = await ctx.act("approve", ctx.tokens.staff);

    expect(response.statusCode).toBe(500);
    expect(ctx.state()).toBe("awaiting_policy_or_staff");
    expect(ctx.db.select().from(t.auditEvent).where(eq(t.auditEvent.entityId, ctx.task.id)).all()).toHaveLength(auditBefore);
    expect(ctx.db.select().from(t.taskApproval).where(eq(t.taskApproval.taskId, ctx.task.id)).all().map((row) => row.decision)).toEqual(["confirmed"]);
    expect(ctx.db.select().from(t.robotCommand).where(eq(t.robotCommand.taskId, ctx.task.id)).all()).toHaveLength(0);
    expect(ctx.sent).toHaveLength(0);
  });

  test("records confirmation and approval actors", async () => {
    const ctx = await queued();
    expect(ctx.db.select().from(t.taskApproval).where(eq(t.taskApproval.taskId, ctx.task.id)).all().map((row) => [row.decision, row.actorId])).toEqual([["confirmed", SEED_IDS.familyUser], ["approved", SEED_IDS.staffUser]]);
  });

  test("tray delivery completes only when the robot reaches standby", async () => {
    const ctx = await queued();
    ctx.robot({ type: "ack", correlationId: ctx.task.correlationId, result: "accepted" });
    ctx.event("arrived_pickup");
    expect((await ctx.act("loaded", ctx.tokens.staff)).json().task.state).toBe("navigating_to_delivery");
    expect(ctx.sent.at(-1)).toEqual({ type: "staff_event", correlationId: ctx.task.correlationId, event: "staff_loaded" });
    ctx.event("arrived_delivery");
    expect((await ctx.act("received", ctx.tokens.device)).json().task.state).toBe("verifying_delivery");
    expect(ctx.sent.at(-1)).toEqual({ type: "staff_event", correlationId: ctx.task.correlationId, event: "received" });
    ctx.event("completed_leg");
    expect(ctx.state()).toBe("completed");
    expect(ctx.db.select().from(t.robotCommand).where(eq(t.robotCommand.taskId, ctx.task.id)).get()?.result).toBe("completed");
    const trail = ctx.db.select().from(t.auditEvent).where(eq(t.auditEvent.entityId, ctx.task.id)).all();
    expect(trail.map((row) => row.toState)).toEqual(["parsed", "awaiting_user_confirmation", "awaiting_policy_or_staff", "queued", "navigating_to_pickup", "locating_item", "grasping", "verifying_grasp", "navigating_to_delivery", "placing", "verifying_delivery", "completed"]);
    expect(trail.at(-1)).toMatchObject({ actorType: "robot", actorId: SEED_IDS.robot });
  });

  test("enforces roles, source states, and physical-only stop", async () => {
    const ctx = await proposal();
    expect((await ctx.act("approve", ctx.tokens.device)).statusCode).toBe(403);
    expect((await ctx.act("loaded", ctx.tokens.family)).statusCode).toBe(403);
    expect((await ctx.act("stop", ctx.tokens.staff)).statusCode).toBe(409);
    await ctx.act("confirm", ctx.tokens.family);
    expect((await ctx.act("confirm", ctx.tokens.family)).statusCode).toBe(409);
    expect((await ctx.act("deny", ctx.tokens.staff)).json().task.state).toBe("rejected");
  });

  test("stop from queued or a physical state stops the task and robot", async () => {
    const a = await queued();
    expect((await a.act("stop", a.tokens.staff)).json().task.state).toBe("safety_stopped");
    expect(a.sent.at(-1)).toEqual({ type: "stop", reason: "staff_stop" });
    const b = await queued();
    b.robot({ type: "ack", correlationId: b.task.correlationId, result: "accepted" });
    expect((await b.act("stop", b.tokens.staff)).json().task.state).toBe("safety_stopped");
  });

  test("the existing robot stop control safety-stops its accepted task command", async () => {
    const ctx = await queued();
    ctx.robot({ type: "ack", correlationId: ctx.task.correlationId, result: "accepted" });
    const response = await ctx.app.inject({ method: "POST", url: `/robots/${SEED_IDS.robot}/stop`, headers: auth(ctx.tokens.staff), payload: {} });
    expect(response.json()).toEqual({ ok: true, delivered: true });
    expect(ctx.state()).toBe("safety_stopped");
    const robotAudit = ctx.db.select().from(t.auditEvent).where(eq(t.auditEvent.entityType, "robot")).all().at(-1);
    expect(robotAudit).toMatchObject({ reason: "staff_stop", correlationId: ctx.task.correlationId });
  });

  test("cancel sends only for an unfinished command", async () => {
    const ctx = await queued();
    expect((await ctx.act("cancel", ctx.tokens.family)).json().task.state).toBe("cancelled");
    expect(ctx.sent.at(-1)).toEqual({ type: "cancel", correlationId: ctx.task.correlationId });
    const rejected = await proposal();
    await rejected.act("confirm", rejected.tokens.family);
    await rejected.act("deny", rejected.tokens.staff);
    expect((await rejected.act("cancel", rejected.tokens.staff)).statusCode).toBe(409);
    expect(rejected.sent).toHaveLength(0);
  });

  test("maps ack and navigation failures to task failure states", async () => {
    const busy = await queued();
    busy.robot({ type: "ack", correlationId: busy.task.correlationId, result: "busy" });
    expect(busy.state()).toBe("operator_required");
    const pickup = await queued();
    pickup.robot({ type: "ack", correlationId: pickup.task.correlationId, result: "accepted" });
    pickup.event("navigation_failed");
    expect(pickup.state()).toBe("navigation_failed");
    const standby = await queued();
    standby.robot({ type: "ack", correlationId: standby.task.correlationId, result: "accepted" });
    standby.event("arrived_pickup"); await standby.act("loaded", standby.tokens.staff); standby.event("arrived_delivery"); await standby.act("received", standby.tokens.device);
    standby.event("navigation_failed");
    expect(standby.state()).toBe("navigation_failed");
  });

  test("offline cancellation and stale task commands are never resent", async () => {
    const cancelled = await queued(false);
    await cancelled.act("cancel", cancelled.tokens.family);
    cancelled.app.hub.attach(SEED_IDS.robot, cancelled.link);
    expect(cancelled.app.dispatch.flushPending(SEED_IDS.robot)).toBe(0);
    expect(cancelled.sent).toHaveLength(0);
    const stale = await queued(false);
    stale.app.transitions.apply({ entityType: "task", entityId: stale.task.id, to: "operator_required", actorType: "system", actorId: "api", reason: "expired" });
    stale.app.hub.attach(SEED_IDS.robot, stale.link);
    expect(stale.app.dispatch.flushPending(SEED_IDS.robot)).toBe(0);
    expect(stale.db.select().from(t.robotCommand).where(eq(t.robotCommand.taskId, stale.task.id)).get()?.result).toBe("stale");
  });

  test("unready robots and expired task commands fail safely", async () => {
    const unready = await proposal();
    unready.robot({ type: "heartbeat", at: "2026-09-17T00:00:00.000Z", robotReady: false, adapter: "mock", pose: null, navState: "idle", estop: true, lift: "rest", battery: "unknown", activeCorrelationId: null, gatewayVersion: "0.0.1" });
    await unready.act("confirm", unready.tokens.family); await unready.act("approve", unready.tokens.staff);
    expect(unready.state()).toBe("operator_required"); expect(unready.sent).toHaveLength(0);
    const clock = new Date("2026-09-17T00:00:00.000Z");
    const expired = await queued(true, () => clock);
    expect(expired.app.dispatch.sweepExpired(new Date("2026-09-17T00:05:00.000Z"))).toBe(1);
    expect(expired.state()).toBe("operator_required");
  });

  test("visit dispatch still works with command correlation ids", async () => {
    const ctx = await proposal();
    const visitId = (await ctx.app.inject({ method: "POST", url: "/visits", headers: auth(ctx.tokens.family), payload: { residentId: SEED_IDS.resident } })).json().visit.id;
    expect(ctx.sent.at(-1)).toMatchObject({ type: "intent", intent: "request_visit", correlationId: visitId });
    ctx.app.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: visitId, result: "accepted" });
    expect(ctx.db.select().from(t.visitSession).where(eq(t.visitSession.id, visitId)).get()?.state).toBe("robot_en_route");
  });
});
