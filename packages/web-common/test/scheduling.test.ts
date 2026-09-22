import { describe, expect, test } from "vitest";
import { RESERVATION_STATUSES, VISIT_SLOT_STATES } from "../src";

describe("shared scheduling contracts", () => {
  test("exports each reservation status once", () => {
    expect(RESERVATION_STATUSES).toEqual(["pending", "confirmed", "expired", "cancelled"]);
    expect(new Set(RESERVATION_STATUSES).size).toBe(RESERVATION_STATUSES.length);
  });

  test("exports each rendered slot state once", () => {
    expect(VISIT_SLOT_STATES).toEqual(["available", "blocked", "pending", "confirmed"]);
    expect(new Set(VISIT_SLOT_STATES).size).toBe(VISIT_SLOT_STATES.length);
  });
});
