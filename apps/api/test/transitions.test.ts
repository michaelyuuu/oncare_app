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
  db.insert(t.taskRequest).values({ id: "task_1", requesterId: SEED_IDS.familyUser, residentId: SEED_IDS.resident, proposal: {}, state: "parsed", mode: "mock", correlationId: "corr_task_1", createdAt: "2026-09-17T00:00:00.000Z" }).run();
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
});
