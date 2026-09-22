import { afterEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { GatewayDown } from "@oncare/contracts";
import { SEED_IDS } from "../src/db/seed";
import { buildApp } from "../src/app";
import * as t from "../src/db/schema";
import { createReservationScheduler } from "../src/services/reservation-scheduler";
import { screenForVisitState } from "../src/routes/device";
import { makeTestApp } from "./helpers";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.useRealTimers(); });

async function fixture(confirmed = true, proposer: "family" | "device" = "family") {
  let instant = new Date("2026-09-21T00:00:00.000Z");
  const now = () => instant;
  const ctx = await makeTestApp({ now });
  cleanup.push(() => ctx.app.close());
  const sent: GatewayDown[] = [];
  ctx.app.hub.attach(SEED_IDS.robot, { send: (message) => { sent.push(message); } });
  const response = await ctx.app.inject({ method: "POST", url: "/visit-reservations", headers: auth(ctx.tokens[proposer]), payload: {
    ...(proposer === "family" ? { residentId: SEED_IDS.resident } : { contactUserId: SEED_IDS.familyUser }),
    localDate: "2026-09-22", startMinute: 540,
  } });
  expect(response.statusCode).toBe(201);
  const id = response.json().reservation.id as string;
  if (confirmed) expect((await ctx.app.inject({ method: "POST", url: `/visit-reservations/${id}/confirm`, headers: auth(ctx.tokens[proposer === "family" ? "device" : "family"]) })).statusCode).toBe(200);
  const makeScheduler = () => createReservationScheduler({ db: ctx.db, reservations: ctx.app.reservations, visits: ctx.app.visits, transitions: ctx.app.transitions, dispatch: ctx.app.dispatch, now, intervalMs: 50 });
  const scheduler = makeScheduler();
  cleanup.push(async () => scheduler.stop());
  const row = () => ctx.db.select().from(t.visitReservation).where(eq(t.visitReservation.id, id)).get()!;
  const set = (value: string) => { instant = new Date(value); };
  const tick = (value: string) => { set(value); scheduler.tick(now()); };
  const arrive = () => {
    const visitId = row().visitId!;
    ctx.app.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: visitId, result: "accepted" });
    ctx.app.hub.receive(SEED_IDS.robot, { type: "state_event", correlationId: visitId, event: "arrived", at: now().toISOString() });
    return visitId;
  };
  const linkInterruptedVisit = (state: string) => {
    const visitId = "visit_interrupted_activation";
    ctx.db.insert(t.visitSession).values({
      id: visitId, residentId: SEED_IDS.resident, requesterId: SEED_IDS.familyUser,
      robotId: SEED_IDS.robot, state, requestedAt: "2026-09-22T00:55:00.000Z",
      scheduledStartAt: row().startAt, initiatorKind: "family", initiatorId: SEED_IDS.familyUser,
    }).run();
    ctx.db.update(t.visitReservation).set({ visitId }).where(eq(t.visitReservation.id, id)).run();
    return visitId;
  };
  return { ...ctx, now, set, tick, row, id, sent, scheduler, makeScheduler, arrive, linkInterruptedVisit };
}

describe("reservation scheduler", () => {
  test.each(["requested", "awaiting_policy_or_staff", "accepted"])("recovers a linked %s visit after interrupted activation without duplicating the visit or command", async (state) => {
    const f = await fixture();
    // Persist what survives an exit after linking, during policy, or after
    // accepting but before the dispatch listener writes its command.
    const visitId = f.linkInterruptedVisit(state);
    f.scheduler.stop();
    const restarted = f.makeScheduler();
    cleanup.push(async () => restarted.stop());
    f.set("2026-09-22T00:55:01.000Z");
    restarted.tick();
    expect(f.app.visits.get(visitId)?.state).toBe("accepted");
    expect(f.sent).toEqual([expect.objectContaining({ intent: "request_visit", correlationId: visitId })]);
    restarted.tick();
    f.scheduler.tick();
    expect(f.row().visitId).toBe(visitId);
    expect(f.db.select().from(t.visitSession).all()).toHaveLength(1);
    expect(f.db.select().from(t.robotCommand).all()).toHaveLength(1);
    expect(f.sent).toHaveLength(1);
    expect(f.db.select().from(t.auditEvent).all().filter(e => e.reason === "reservation_activated")).toHaveLength(1);
    expect(f.arrive()).toBe(visitId);
    expect(f.app.visits.get(visitId)?.state).toBe("awaiting_resident_consent");
  });

  test("recovery rechecks consent before advancing a linked requested visit", async () => {
    const f = await fixture();
    const visitId = f.linkInterruptedVisit("requested");
    f.db.update(t.familyRelationship).set({ consentVideo: false }).run();
    f.tick("2026-09-22T00:55:01.000Z");
    f.scheduler.tick();
    expect(f.row()).toMatchObject({ status: "cancelled", visitId });
    expect(f.app.visits.get(visitId)?.state).toBe("safety_stopped");
    expect(f.db.select().from(t.visitSession).all()).toHaveLength(1);
    expect(f.db.select().from(t.robotCommand).all()).toHaveLength(0);
    expect(f.sent).toEqual([]);
    expect(f.db.select().from(t.auditEvent).all().filter(e => e.reason === "reservation_activation_failed")).toHaveLength(1);
  });

  test("recovery never resurrects a terminal linked visit", async () => {
    const f = await fixture();
    const visitId = f.linkInterruptedVisit("cancelled");
    f.tick("2026-09-22T00:55:01.000Z");
    f.scheduler.tick();
    expect(f.row().visitId).toBe(visitId);
    expect(f.app.visits.get(visitId)?.state).toBe("cancelled");
    expect(f.db.select().from(t.visitSession).all()).toHaveLength(1);
    expect(f.db.select().from(t.robotCommand).all()).toHaveLength(0);
    expect(f.sent).toEqual([]);
  });

  test("a completed activation waiting for staff does not become auto-approved on later ticks", async () => {
    const f = await fixture();
    f.db.update(t.resident).set({ availability: "in_activity" }).where(eq(t.resident.id, SEED_IDS.resident)).run();
    f.tick("2026-09-22T00:55:00.000Z");
    const visitId = f.row().visitId!;
    expect(f.app.visits.get(visitId)?.state).toBe("awaiting_policy_or_staff");
    f.db.update(t.resident).set({ availability: "available" }).where(eq(t.resident.id, SEED_IDS.resident)).run();
    f.scheduler.tick();
    expect(f.app.visits.get(visitId)?.state).toBe("awaiting_policy_or_staff");
    expect(f.sent).toEqual([]);
    expect((await f.app.inject({ method: "POST", url: `/visits/${visitId}/approve`, headers: auth(f.tokens.staff) })).statusCode).toBe(200);
    f.scheduler.tick();
    expect(f.sent).toHaveLength(1);
    expect(f.db.select().from(t.robotCommand).all()).toHaveLength(1);
  });

  test("an application restart replays an existing pending command without creating another command or visit", async () => {
    const f = await fixture();
    f.app.hub.detach(SEED_IDS.robot);
    f.tick("2026-09-22T00:55:00.000Z");
    const visitId = f.row().visitId!;
    const command = f.db.select().from(t.robotCommand).get()!;
    expect(f.sent).toEqual([]);
    f.scheduler.stop();
    await f.app.close();
    const restarted = buildApp({ db: f.db, jwtSecret: "test-secret", now: f.now, video: f.video });
    cleanup.push(() => restarted.close());
    await restarted.ready();
    restarted.hub.attach(SEED_IDS.robot, { send: message => f.sent.push(message) });
    restarted.reservationScheduler.tick();
    // The authenticated gateway connection flushes durable pending commands.
    expect(restarted.dispatch.flushPending(SEED_IDS.robot)).toBe(1);
    restarted.reservationScheduler.tick();
    expect(f.db.select().from(t.visitSession).all()).toHaveLength(1);
    expect(f.db.select().from(t.robotCommand).all()).toEqual([command]);
    expect(f.sent).toEqual([command.intent]);
    restarted.hub.receive(SEED_IDS.robot, { type: "ack", correlationId: visitId, result: "accepted" });
    expect(restarted.visits.get(visitId)?.state).toBe("robot_en_route");
  });

  test("an explicit tick instant drives dispatch even when the injected default clock is earlier", async () => {
    const f = await fixture();
    f.scheduler.tick(new Date("2026-09-22T00:55:00.000Z"));
    expect(f.row().visitId).toBeTruthy();
    expect(f.sent).toHaveLength(1);
  });

  test("cancellation remains safe when the robot transport fails", async () => {
    const f = await fixture();
    f.tick("2026-09-22T00:55:00.000Z");
    const id = f.arrive();
    f.app.hub.attach(SEED_IDS.robot, { send() { throw new Error("connection closed"); } });
    expect((await f.app.inject({ method: "POST", url: `/visit-reservations/${f.id}/cancel`, headers: auth(f.tokens.family) })).statusCode).toBe(200);
    expect(f.app.visits.get(id)?.state).toBe("safety_stopped");
    expect(f.db.select().from(t.robotCommand).where(eq(t.robotCommand.visitId, id)).get()?.result).toBe("cancelled");
    expect(f.app.dispatch.flushPending(SEED_IDS.robot)).toBe(0);
  });

  test("after call start only staff can cancel a reservation", async () => {
    const f = await fixture();
    f.tick("2026-09-22T00:55:00.000Z");
    const id = f.arrive();
    f.set("2026-09-22T01:00:00.000Z");
    await f.app.inject({ method: "POST", url: `/visits/${id}/answer`, headers: auth(f.tokens.device) });
    await f.app.inject({ method: "POST", url: `/visits/${id}/connected`, headers: auth(f.tokens.device) });
    const cancel = (token: string) => f.app.inject({ method: "POST", url: `/visit-reservations/${f.id}/cancel`, headers: auth(token) });
    expect((await cancel(f.tokens.family)).statusCode).toBe(409);
    expect((await cancel(f.tokens.device)).statusCode).toBe(409);
    expect(f.row().status).toBe("confirmed");
    expect((await cancel(f.tokens.staff)).statusCode).toBe(200);
    expect(f.app.visits.get(id)?.state).toBe("safety_stopped");
  });

  test("scheduled dispatch preserves robot readiness restrictions", async () => {
    const f = await fixture();
    f.app.hub.receive(SEED_IDS.robot, { type: "heartbeat", at: f.now().toISOString(), robotReady: false, adapter: "mock", pose: null, navState: "idle", estop: true, lift: "rest", battery: "unknown", activeCorrelationId: null, gatewayVersion: "test" });
    f.tick("2026-09-22T00:55:00.000Z");
    expect(f.app.visits.get(f.row().visitId!)?.state).toBe("robot_unavailable");
    expect(f.sent).toEqual([]);
    expect(f.db.select().from(t.auditEvent).all()).toContainEqual(expect.objectContaining({ entityId: f.row().visitId, reason: "robot_not_ready" }));
  });

  test("expires a pending hold exactly at five minutes, once, without dispatch", async () => {
    const f = await fixture(false);
    f.tick("2026-09-21T00:04:59.999Z");
    expect(f.row().status).toBe("pending");
    f.tick("2026-09-21T00:05:00.000Z");
    f.scheduler.tick();
    expect(f.row().status).toBe("expired");
    expect(f.db.select().from(t.auditEvent).all().filter(e => e.reason === "reservation_expired")).toHaveLength(1);
    expect(f.sent).toEqual([]);
  });

  test("reminds at T-10 once across scheduler instances and atomically links one visit at T-5 before dispatch", async () => {
    const f = await fixture();
    const events: string[] = [];
    f.app.transitions.subscribe(e => { if (e.reason) events.push(e.reason); });
    f.tick("2026-09-22T00:49:59.999Z");
    expect(events).not.toContain("reservation_reminder");
    f.tick("2026-09-22T00:50:00.000Z");
    const second = f.makeScheduler();
    second.tick();
    expect(events.filter(e => e === "reservation_reminder")).toHaveLength(1);
    expect(f.row().visitId).toBeNull();
    f.tick("2026-09-22T00:54:59.999Z");
    expect(f.sent).toEqual([]);
    f.app.hub.attach(SEED_IDS.robot, { send(message) {
      expect(f.row().visitId).toBeTruthy();
      f.sent.push(message);
      second.tick();
    } });
    f.tick("2026-09-22T00:55:00.000Z");
    second.tick();
    f.scheduler.tick();
    const visits = f.db.select().from(t.visitSession).all();
    expect(visits).toHaveLength(1);
    expect(visits[0]).toMatchObject({ id: f.row().visitId, scheduledStartAt: "2026-09-22T01:00:00.000Z", requesterId: SEED_IDS.familyUser, initiatorKind: "family", initiatorId: SEED_IDS.familyUser });
    expect(f.sent).toHaveLength(1);
    expect(f.db.select().from(t.robotCommand).all()).toHaveLength(1);
    expect(events.filter(e => e === "reservation_activated")).toHaveLength(1);
  });

  test("a device-proposed scheduled visit still waits for resident consent at start", async () => {
    const f = await fixture(true, "device");
    f.tick("2026-09-22T00:55:00.000Z");
    const id = f.arrive();
    expect(f.app.visits.get(id)?.state).toBe("awaiting_resident_consent");
    const screen = async () => (await f.app.inject({ method: "GET", url: "/device/state", headers: auth(f.tokens.device) })).json();
    expect((await screen()).screen).toBe("home");
    expect((await screen()).visit.id).toBe(id);
    expect((await f.app.inject({ method: "POST", url: `/visits/${id}/answer`, headers: auth(f.tokens.device) })).statusCode).toBe(409);
    f.tick("2026-09-22T01:00:00.000Z");
    expect((await screen()).screen).toBe("incoming");
    expect((await f.app.inject({ method: "POST", url: `/visits/${id}/answer`, headers: auth(f.tokens.device) })).json().visit.state).toBe("connecting");
  });

  test("revoked consent at dispatch cancels activation once and never moves the robot", async () => {
    const f = await fixture();
    f.db.update(t.familyRelationship).set({ consentVideo: false }).run();
    f.tick("2026-09-22T00:55:00.000Z");
    f.scheduler.tick();
    expect(f.row()).toMatchObject({ status: "cancelled", visitId: null });
    expect(f.db.select().from(t.visitSession).all()).toEqual([]);
    expect(f.sent).toEqual([]);
    expect(f.db.select().from(t.auditEvent).all().filter(e => e.reason === "reservation_activation_failed")).toHaveLength(1);
  });

  test("cancellation after dispatch safely stops and emits a staff-visible event without replay", async () => {
    const f = await fixture();
    f.tick("2026-09-22T00:55:00.000Z");
    const id = f.arrive();
    expect((await f.app.inject({ method: "POST", url: `/visit-reservations/${f.id}/cancel`, headers: auth(f.tokens.family) })).statusCode).toBe(200);
    expect(f.app.visits.get(id)?.state).toBe("safety_stopped");
    expect(f.sent).toContainEqual(expect.objectContaining({ type: "cancel", correlationId: id }));
    expect(f.app.dispatch.flushPending(SEED_IDS.robot)).toBe(0);
    f.scheduler.tick();
    expect(f.db.select().from(t.visitSession).all()).toHaveLength(1);
    const event = f.db.select().from(t.auditEvent).all().find(e => e.reason === "reservation_cancelled_after_dispatch");
    expect(event).toMatchObject({ entityType: "visit", entityId: id, toState: "safety_stopped" });
  });

  test("start is idempotent and stop prevents further timer activation", async () => {
    const f = await fixture(false);
    vi.useFakeTimers();
    f.scheduler.start();
    f.scheduler.start();
    f.set("2026-09-21T00:05:00.000Z");
    await vi.advanceTimersByTimeAsync(50);
    expect(f.row().status).toBe("expired");
    f.scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("app ready starts scheduling and close stops its timer", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const f = await fixture(false);
    expect(vi.getTimerCount()).toBe(1);
    f.set("2026-09-21T00:05:00.000Z");
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.row().status).toBe("expired");
    await f.app.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});

test("screen mapping hides scheduled rings until start and shows outgoing family wait", () => {
  expect(screenForVisitState("awaiting_resident_consent", "2026-09-22T01:00:00.000Z", new Date("2026-09-22T00:59:59.999Z"), "family")).toBe("home");
  expect(screenForVisitState("awaiting_resident_consent", "2026-09-22T01:00:00.000Z", new Date("2026-09-22T01:00:00.000Z"), "family")).toBe("incoming");
  expect(screenForVisitState("awaiting_family_consent", null, new Date(), "device")).toBe("in_call");
});
