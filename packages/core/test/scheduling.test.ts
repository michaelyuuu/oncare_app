import { describe, expect, test } from "vitest";
import {
  DEMO_VISIT_POLICY,
  buildVisitSlotDefinitions,
  isVisitDateInWindow,
  localSlotToIso,
} from "../src/scheduling";

describe("deterministic visit slot policy", () => {
  test("builds the fixed demo day with blocked periods", () => {
    expect(buildVisitSlotDefinitions("2026-09-22")).toEqual([
      expect.objectContaining({ startMinute: 540, endMinute: 600, state: "available" }),
      expect.objectContaining({ startMinute: 600, endMinute: 660, state: "available" }),
      expect.objectContaining({ startMinute: 660, endMinute: 720, state: "available" }),
      expect.objectContaining({ startMinute: 720, endMinute: 780, state: "blocked", reason: "lunch" }),
      expect.objectContaining({ startMinute: 780, endMinute: 840, state: "available" }),
      expect.objectContaining({ startMinute: 840, endMinute: 900, state: "available" }),
      expect.objectContaining({ startMinute: 900, endMinute: 960, state: "available" }),
      expect.objectContaining({ startMinute: 960, endMinute: 1020, state: "blocked", reason: "staff_handoff" }),
      expect.objectContaining({ startMinute: 1020, endMinute: 1080, state: "blocked", reason: "dinner_quiet" }),
    ]);
  });

  test("exposes the fixed demo policy constants", () => {
    expect(DEMO_VISIT_POLICY).toMatchObject({
      timeZone: "Asia/Taipei",
      windowDays: 14,
      slotDurationMinutes: 60,
      dayStartMinute: 540,
      dayEndMinute: 1080,
    });
    expect(DEMO_VISIT_POLICY.bookableStartMinutes).toEqual([540, 600, 660, 780, 840, 900]);
  });

  test("accepts exactly the 14-day inclusive local-date window", () => {
    expect(isVisitDateInWindow("2026-09-22", "2026-09-22")).toBe(true);
    expect(isVisitDateInWindow("2026-10-05", "2026-09-22")).toBe(true);
    expect(isVisitDateInWindow("2026-10-06", "2026-09-22")).toBe(false);
    expect(isVisitDateInWindow("2026-09-21", "2026-09-22")).toBe(false);
  });

  test("converts a facility-local slot boundary to an ISO instant", () => {
    expect(localSlotToIso("2026-09-22", 540, "Asia/Taipei")).toBe("2026-09-22T01:00:00.000Z");
  });
});
