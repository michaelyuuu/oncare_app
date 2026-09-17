import { describe, expect, test } from "vitest";
import { AuditEventSchema, REASON_CODE, makeTransitionEvent } from "../src/audit";

describe("audit events", () => {
  test("makeTransitionEvent fills id, timestamp and copies every field", () => {
    const ev = makeTransitionEvent({
      actorType: "staff",
      actorId: "staff_demo_01",
      entityType: "visit",
      entityId: "visit_1",
      fromState: "requested",
      toState: "awaiting_policy_or_staff",
      correlationId: "corr_1",
      now: () => new Date("2026-09-17T00:00:00.000Z"),
      id: () => "evt_fixed",
    });
    expect(ev).toEqual({
      id: "evt_fixed",
      at: "2026-09-17T00:00:00.000Z",
      actorType: "staff",
      actorId: "staff_demo_01",
      entityType: "visit",
      entityId: "visit_1",
      fromState: "requested",
      toState: "awaiting_policy_or_staff",
      reason: null,
      correlationId: "corr_1",
    });
  });

  test("reason defaults to null and is kept when given", () => {
    const ev = makeTransitionEvent({
      actorType: "system", actorId: "api", entityType: "task", entityId: "t1",
      fromState: "parsed", toState: "clarification_required", reason: "two_items", correlationId: "c",
    });
    expect(ev.reason).toBe("two_items");
  });

  test("a free-text reason is rejected by makeTransitionEvent and by the schema", () => {
    expect(() =>
      makeTransitionEvent({
        actorType: "system", actorId: "api", entityType: "task", entityId: "t1",
        fromState: "parsed", toState: "clarification_required", reason: "two items", correlationId: "c",
      }),
    ).toThrow(TypeError);

    const bad = {
      id: "x", at: new Date().toISOString(), actorType: "system", actorId: "api",
      entityType: "task", entityId: "t1", fromState: "parsed", toState: "clarification_required",
      reason: "two items", correlationId: "c",
    };
    expect(AuditEventSchema.safeParse(bad).success).toBe(false);
    expect(REASON_CODE.test("two_items")).toBe(true);
    expect(REASON_CODE.test("two items")).toBe(false);
  });

  test("generated ids are unique and timestamps are ISO strings", () => {
    const a = makeTransitionEvent({ actorType: "system", actorId: "api", entityType: "task", entityId: "t", fromState: "a", toState: "b", correlationId: "c" });
    const b = makeTransitionEvent({ actorType: "system", actorId: "api", entityType: "task", entityId: "t", fromState: "a", toState: "b", correlationId: "c" });
    expect(a.id).not.toBe(b.id);
    expect(() => new Date(a.at).toISOString()).not.toThrow();
  });

  test("schema rejects an unknown actor type", () => {
    const bad = { id: "x", at: new Date().toISOString(), actorType: "hacker", actorId: "1", entityType: "visit", entityId: "v", fromState: null, toState: null, reason: null, correlationId: "c" };
    expect(AuditEventSchema.safeParse(bad).success).toBe(false);
  });
});
