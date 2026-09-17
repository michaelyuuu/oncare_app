import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { openDb } from "../src/db/client";
import * as t from "../src/db/schema";
import { SEED_IDS, seed } from "../src/db/seed";
import { createTransitionService, TransitionError } from "../src/services/transitions";

async function setup() {
  const db = openDb(":memory:");
  await seed(db);
  db.insert(t.visitSession).values({ id: "visit_1", residentId: SEED_IDS.resident, requesterId: SEED_IDS.familyUser, robotId: SEED_IDS.robot, state: "requested", requestedAt: "2026-09-17T00:00:00.000Z" }).run();
  db.insert(t.taskRequest).values({ id: "task_1", requesterId: SEED_IDS.familyUser, residentId: SEED_IDS.resident, proposal: {
    task_type: "deliver_item", item: "water_bottle", recipient: "resident_demo_01",
    destination: "bedside_table_demo", requires_confirmation: true,
  }, state: "parsed", mode: "mock", correlationId: "corr_task_1", createdAt: "2026-09-17T00:00:00.000Z" }).run();
  return { db, svc: createTransitionService(db, { now: () => new Date("2026-09-17T00:00:01.000Z") }) };
}

describe("applyTransition", () => {
  test("legal visit transition updates state and writes one audit row", async () => {
    const { db, svc } = await setup();
    const ev = svc.apply({ entityType: "visit", entityId: "visit_1", to: "awaiting_policy_or_staff", actorType: "system", actorId: "api" });
    expect(db.select().from(t.visitSession).where(eq(t.visitSession.id, "visit_1")).get()?.state).toBe("awaiting_policy_or_staff");
    const rows = db.select().from(t.auditEvent).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityId: "visit_1", fromState: "requested", toState: "awaiting_policy_or_staff", correlationId: "visit_1" });
    expect(ev.id).toBe(rows[0]?.id);
  });

  test("illegal transition throws 409, leaves state unchanged, and records rejected_transition", async () => {
    const { db, svc } = await setup();
    expect(() => svc.apply({ entityType: "visit", entityId: "visit_1", to: "active", actorType: "family", actorId: SEED_IDS.familyUser })).toThrow(TransitionError);
    expect(db.select().from(t.visitSession).where(eq(t.visitSession.id, "visit_1")).get()?.state).toBe("requested");
    const rows = db.select().from(t.auditEvent).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe("rejected_transition");
    expect(rows[0]?.toState).toBe("active");
  });

  test("task transitions use the task machine and the task correlation id", async () => {
    const { db, svc } = await setup();
    svc.apply({ entityType: "task", entityId: "task_1", to: "awaiting_user_confirmation", actorType: "system", actorId: "api" });
    expect(db.select().from(t.auditEvent).all()[0]?.correlationId).toBe("corr_task_1");
    expect(() => svc.apply({ entityType: "task", entityId: "task_1", to: "queued", actorType: "family", actorId: SEED_IDS.familyUser })).toThrow(/awaiting_user_confirmation.*queued/);
  });

  test("unknown entity throws a 409 TransitionError", async () => {
    const { svc } = await setup();
    expect(() => svc.apply({ entityType: "visit", entityId: "nope", to: "cancelled", actorType: "system", actorId: "api" })).toThrow(TransitionError);
  });

  test("a stored state that is not a known state is a 409, not a TypeError", async () => {
    const { db, svc } = await setup();
    db.update(t.visitSession).set({ state: "garbage" }).where(eq(t.visitSession.id, "visit_1")).run();
    db.update(t.taskRequest).set({ state: "garbage" }).where(eq(t.taskRequest.id, "task_1")).run();

    expect(() => svc.apply({ entityType: "visit", entityId: "visit_1", to: "cancelled", actorType: "system", actorId: "api" }))
      .toThrow(TransitionError);
    expect(() => svc.apply({ entityType: "visit", entityId: "visit_1", to: "cancelled", actorType: "system", actorId: "api" }))
      .toThrow(/visit "visit_1" has an unknown state "garbage"/);
    expect(() => svc.apply({ entityType: "task", entityId: "task_1", to: "cancelled", actorType: "system", actorId: "api" }))
      .toThrow(/task "task_1" has an unknown state "garbage"/);

    expect(db.select().from(t.auditEvent).all()).toHaveLength(0);
    expect(db.select().from(t.visitSession).where(eq(t.visitSession.id, "visit_1")).get()?.state).toBe("garbage");
  });

  test("subscribers receive every successful event and none of the rejected ones", async () => {
    const { svc } = await setup();
    const seen: string[] = [];
    const unsubscribe = svc.subscribe((ev) => seen.push(`${ev.entityId}:${ev.toState}`));
    svc.apply({ entityType: "visit", entityId: "visit_1", to: "awaiting_policy_or_staff", actorType: "system", actorId: "api" });
    try { svc.apply({ entityType: "visit", entityId: "visit_1", to: "active", actorType: "system", actorId: "api" }); } catch {}
    unsubscribe();
    svc.apply({ entityType: "visit", entityId: "visit_1", to: "accepted", actorType: "staff", actorId: SEED_IDS.staffUser });
    expect(seen).toEqual(["visit_1:awaiting_policy_or_staff"]);
  });

  test("a throwing listener does not block other listeners or the return value", async () => {
    const db = openDb(":memory:");
    await seed(db);
    db.insert(t.visitSession).values({ id: "visit_1", residentId: SEED_IDS.resident, requesterId: SEED_IDS.familyUser, robotId: SEED_IDS.robot, state: "requested", requestedAt: "2026-09-17T00:00:00.000Z" }).run();
    const errors: unknown[] = [];
    const svc = createTransitionService(db, {
      now: () => new Date("2026-09-17T00:00:01.000Z"),
      onListenerError: (err) => { errors.push(err); },
    });
    const seenB: string[] = [];
    svc.subscribe(() => { throw new Error("boom"); });
    svc.subscribe((ev) => seenB.push(`${ev.toState}`));
    const ev = svc.apply({ entityType: "visit", entityId: "visit_1", to: "awaiting_policy_or_staff", actorType: "system", actorId: "api" });
    expect(ev.toState).toBe("awaiting_policy_or_staff");
    expect(seenB).toEqual(["awaiting_policy_or_staff"]);
    expect(errors).toHaveLength(1);
  });

  test("a patch is written together with the new state", async () => {
    const { db, svc } = await setup();
    svc.apply({
      entityType: "visit", entityId: "visit_1", to: "awaiting_policy_or_staff",
      actorType: "system", actorId: "api", patch: { connectedAt: "2026-09-17T00:00:05.000Z" },
    });
    const row = db.select().from(t.visitSession).where(eq(t.visitSession.id, "visit_1")).get();
    expect(row?.state).toBe("awaiting_policy_or_staff");
    expect(row?.connectedAt).toBe("2026-09-17T00:00:05.000Z");
  });

  test("an illegal transition with a patch writes neither the state nor the patched column", async () => {
    const { db, svc } = await setup();
    expect(() => svc.apply({
      entityType: "visit", entityId: "visit_1", to: "active",
      actorType: "system", actorId: "api", patch: { connectedAt: "2026-09-17T00:00:05.000Z" },
    })).toThrow(TransitionError);
    const row = db.select().from(t.visitSession).where(eq(t.visitSession.id, "visit_1")).get();
    expect(row?.state).toBe("requested");
    expect(row?.connectedAt).toBeNull();
  });

  test("a patch that violates a constraint rolls the whole transition back", async () => {
    const { db, svc } = await setup();
    expect(() => svc.apply({
      entityType: "visit", entityId: "visit_1", to: "awaiting_policy_or_staff",
      actorType: "system", actorId: "api", patch: { robotId: "no_such_robot" },
    })).toThrow();
    const row = db.select().from(t.visitSession).where(eq(t.visitSession.id, "visit_1")).get();
    expect(row?.state).toBe("requested");
    expect(row?.robotId).toBe(SEED_IDS.robot);
    expect(db.select().from(t.auditEvent).all()).toHaveLength(0);
  });

  test("a task patch rides along in the same transaction", async () => {
    const { db, svc } = await setup();
    svc.apply({
      entityType: "task", entityId: "task_1", to: "awaiting_user_confirmation",
      actorType: "system", actorId: "api", patch: { mode: "tray" },
    });
    const row = db.select().from(t.taskRequest).where(eq(t.taskRequest.id, "task_1")).get();
    expect(row?.state).toBe("awaiting_user_confirmation");
    expect(row?.mode).toBe("tray");
  });

  test("free-text reason is refused before anything is written", async () => {
    const { db, svc } = await setup();
    expect(() => svc.apply({ entityType: "visit", entityId: "visit_1", to: "awaiting_policy_or_staff", actorType: "system", actorId: "api", reason: "Could you bring Mom the water bottle?" })).toThrow(TypeError);
    expect(db.select().from(t.visitSession).where(eq(t.visitSession.id, "visit_1")).get()?.state).toBe("requested");
    expect(db.select().from(t.auditEvent).all()).toHaveLength(0);
  });

  test("snake_case reason is accepted and stored", async () => {
    const { db, svc } = await setup();
    svc.apply({ entityType: "visit", entityId: "visit_1", to: "awaiting_policy_or_staff", actorType: "system", actorId: "api", reason: "auto_policy" });
    const rows = db.select().from(t.auditEvent).all();
    expect(rows[0]?.reason).toBe("auto_policy");
  });

  test("a duplicate audit id fails the second apply after the state update ran, and the whole transaction rolls back", async () => {
    const db = openDb(":memory:");
    await seed(db);
    db.insert(t.visitSession).values({ id: "visit_1", residentId: SEED_IDS.resident, requesterId: SEED_IDS.familyUser, robotId: SEED_IDS.robot, state: "requested", requestedAt: "2026-09-17T00:00:00.000Z" }).run();
    const svc = createTransitionService(db, { now: () => new Date("2026-09-17T00:00:01.000Z"), id: () => "evt_fixed" });

    svc.apply({ entityType: "visit", entityId: "visit_1", to: "awaiting_policy_or_staff", actorType: "system", actorId: "api" });
    const stateBeforeSecondCall = db.select().from(t.visitSession).where(eq(t.visitSession.id, "visit_1")).get()?.state;
    expect(stateBeforeSecondCall).toBe("awaiting_policy_or_staff");

    expect(() => svc.apply({ entityType: "visit", entityId: "visit_1", to: "accepted", actorType: "system", actorId: "api", reason: "auto_policy" })).toThrow();

    expect(db.select().from(t.visitSession).where(eq(t.visitSession.id, "visit_1")).get()?.state).toBe(stateBeforeSecondCall);
    expect(db.select().from(t.auditEvent).all()).toHaveLength(1);
  });
});
