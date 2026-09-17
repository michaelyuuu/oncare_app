import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import type { GatewayDown } from "@oncare/contracts";
import { makeTestApp } from "./helpers";
import * as t from "../src/db/schema";
import { SEED_IDS } from "../src/db/seed";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

function fakeLink() {
  const sent: GatewayDown[] = [];
  return { sent, link: { send: (m: GatewayDown) => { sent.push(m); } } };
}

async function acceptedVisit(connect = true) {
  const ctx = await makeTestApp();
  const { sent, link } = fakeLink();
  if (connect) ctx.app.hub.attach(SEED_IDS.robot, link);
  const res = await ctx.app.inject({ method: "POST", url: "/visits", headers: auth(ctx.tokens.family), payload: { residentId: SEED_IDS.resident } });
  const visitId = res.json().visit.id as string;
  const state = () => ctx.db.select().from(t.visitSession).where(eq(t.visitSession.id, visitId)).get()!.state;
  return { ...ctx, sent, link, visitId, state };
}

describe("dispatch service", () => {
  test("visit accepted -> robot_command row + request_visit intent sent to the connected robot", async () => {
    const { db, sent, visitId } = await acceptedVisit();
    const cmd = db.select().from(t.robotCommand).where(eq(t.robotCommand.visitId, visitId)).get();
    expect(cmd).toBeTruthy();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "intent", intent: "request_visit", correlationId: visitId, payload: { locationId: SEED_IDS.roomLocation } });
    expect(new Date((sent[0] as any).expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  test("robot not connected: command is stored and flushed on attach", async () => {
    const { app, sent, link, visitId, state } = await acceptedVisit(false);
    expect(sent).toHaveLength(0);
    expect(state()).toBe("accepted");
    app.hub.attach(SEED_IDS.robot, link);
    expect(app.dispatch.flushPending(SEED_IDS.robot)).toBe(1);
    expect(sent[0]).toMatchObject({ type: "intent", correlationId: visitId });
  });

  test("ack accepted -> robot_en_route; state_event arrived -> awaiting_resident_consent", async () => {
    const { app, db, visitId, state } = await acceptedVisit();
    app.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: visitId, result: "accepted" });
    expect(state()).toBe("robot_en_route");
    expect(db.select().from(t.robotCommand).where(eq(t.robotCommand.visitId, visitId)).get()?.result).toBe("accepted");
    app.hub.receive(SEED_IDS.robot, { type: "state_event", correlationId: visitId, at: new Date().toISOString(), event: "arrived" });
    expect(state()).toBe("awaiting_resident_consent");
    const last = db.select().from(t.auditEvent).where(eq(t.auditEvent.entityId, visitId)).all().at(-1);
    expect(last).toMatchObject({ actorType: "robot", actorId: SEED_IDS.robot });
  });

  test("ack expired or busy -> robot_unavailable with the ack result as reason", async () => {
    const { app, db, visitId, state } = await acceptedVisit();
    app.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: visitId, result: "busy" });
    expect(state()).toBe("robot_unavailable");
    expect(db.select().from(t.auditEvent).where(eq(t.auditEvent.entityId, visitId)).all().at(-1)?.reason).toBe("busy");
  });

  test("navigation_failed and safety_stopped map to their visit states", async () => {
    const a = await acceptedVisit();
    a.app.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: a.visitId, result: "accepted" });
    a.app.hub.receive(SEED_IDS.robot, { type: "state_event", correlationId: a.visitId, at: new Date().toISOString(), event: "navigation_failed" });
    expect(a.state()).toBe("navigation_failed");
    const b = await acceptedVisit();
    b.app.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: b.visitId, result: "accepted" });
    b.app.hub.receive(SEED_IDS.robot, { type: "state_event", correlationId: b.visitId, at: new Date().toISOString(), event: "safety_stopped" });
    expect(b.state()).toBe("safety_stopped");
  });

  test("family cancel while the robot is en route sends a cancel message", async () => {
    const { app, tokens, sent, visitId, state } = await acceptedVisit();
    app.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: visitId, result: "accepted" });
    await app.inject({ method: "POST", url: `/visits/${visitId}/cancel`, headers: auth(tokens.family) });
    expect(state()).toBe("cancelled");
    expect(sent.at(-1)).toEqual({ type: "cancel", correlationId: visitId });
    // the robot's own cancelled event afterwards does not throw or double-transition
    app.hub.receive(SEED_IDS.robot, { type: "state_event", correlationId: visitId, at: new Date().toISOString(), event: "cancelled" });
    expect(state()).toBe("cancelled");
  });

  test("a second ack never overwrites the recorded result", async () => {
    const { app, db, visitId, state } = await acceptedVisit();
    const cmd = () => db.select().from(t.robotCommand).where(eq(t.robotCommand.visitId, visitId)).get()!;
    app.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: visitId, result: "accepted" });
    const ackedAt = cmd().ackedAt;
    expect(cmd().result).toBe("accepted");
    app.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: visitId, result: "duplicate" });
    expect(cmd().result).toBe("accepted");
    expect(cmd().ackedAt).toBe(ackedAt);
    expect(state()).toBe("robot_en_route");
  });

  test("a robot message with an unknown correlation id is ignored without throwing", async () => {
    const { app, state } = await acceptedVisit();
    expect(() => app.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: "nope", result: "accepted" })).not.toThrow();
    expect(state()).toBe("accepted");
  });

  test("an ack reason code from the robot survives into the audit trail", async () => {
    const { app, db, visitId, state } = await acceptedVisit();
    app.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: visitId, result: "rejected", reason: "robot_not_ready" });
    expect(state()).toBe("robot_unavailable");
    expect(db.select().from(t.auditEvent).where(eq(t.auditEvent.entityId, visitId)).all().at(-1)?.reason).toBe("robot_not_ready");
  });

  test("an ack reason that is not a snake_case code falls back to the ack result", async () => {
    const { app, db, visitId, state } = await acceptedVisit();
    app.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: visitId, result: "rejected", reason: "Nav stack is down!" });
    expect(state()).toBe("robot_unavailable");
    expect(db.select().from(t.auditEvent).where(eq(t.auditEvent.entityId, visitId)).all().at(-1)?.reason).toBe("rejected");
  });

  test("a state_event detail reason code survives into the audit trail", async () => {
    const { app, db, visitId, state } = await acceptedVisit();
    app.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: visitId, result: "accepted" });
    app.hub.receive(SEED_IDS.robot, { type: "state_event", correlationId: visitId, at: new Date().toISOString(), event: "navigation_failed", detail: { reason: "path_blocked" } });
    expect(state()).toBe("navigation_failed");
    expect(db.select().from(t.auditEvent).where(eq(t.auditEvent.entityId, visitId)).all().at(-1)?.reason).toBe("path_blocked");
  });

  test("a state_event detail reason that is not a code falls back to the event name", async () => {
    const { app, db, visitId } = await acceptedVisit();
    app.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: visitId, result: "accepted" });
    app.hub.receive(SEED_IDS.robot, { type: "state_event", correlationId: visitId, at: new Date().toISOString(), event: "navigation_failed", detail: { reason: 42 } });
    expect(db.select().from(t.auditEvent).where(eq(t.auditEvent.entityId, visitId)).all().at(-1)?.reason).toBe("navigation_failed");
  });

  test("a message for an unknown correlation id is audited against the robot", async () => {
    const { app, db, state } = await acceptedVisit();
    app.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: "visit_gone", result: "accepted" });
    expect(state()).toBe("accepted");
    const rows = db.select().from(t.auditEvent).where(eq(t.auditEvent.entityType, "robot")).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: "robot", actorId: SEED_IDS.robot, entityType: "robot", entityId: SEED_IDS.robot,
      fromState: null, toState: null, reason: "unknown_correlation", correlationId: "visit_gone",
    });
  });

  test("heartbeat is recorded on the hub status", async () => {
    const { app } = await acceptedVisit();
    app.hub.receive(SEED_IDS.robot, { type: "heartbeat", at: "2026-09-17T00:00:00.000Z", robotReady: true, adapter: "mock", pose: { x: 0, y: 0, yaw: 0 }, navState: "idle", estop: false, lift: "rest", battery: "unknown", activeCorrelationId: null, gatewayVersion: "0.0.1" });
    expect(app.hub.status(SEED_IDS.robot)).toMatchObject({ connected: true, lastHeartbeat: { robotReady: true } });
  });
});
