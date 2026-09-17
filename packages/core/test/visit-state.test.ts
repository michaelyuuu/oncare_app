import { describe, expect, test } from "vitest";
import {
  VISIT_STATES,
  VISIT_TERMINAL_STATES,
  isVisitTransitionAllowed,
  transitionVisit,
} from "../src/visit-state";

describe("visit state machine", () => {
  test("follows the happy path from requested to completed", () => {
    const path = [
      "requested",
      "awaiting_policy_or_staff",
      "accepted",
      "robot_en_route",
      "awaiting_resident_consent",
      "connecting",
      "active",
      "ending",
      "completed",
    ] as const;
    for (let i = 0; i < path.length - 1; i++) {
      expect(isVisitTransitionAllowed(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  test("rejects skipping straight from requested to active", () => {
    expect(isVisitTransitionAllowed("requested", "active")).toBe(false);
  });

  test("rejects any transition out of a terminal state", () => {
    for (const terminal of VISIT_TERMINAL_STATES) {
      for (const next of VISIT_STATES) {
        expect(isVisitTransitionAllowed(terminal, next)).toBe(false);
      }
    }
  });

  test("allows safety_stopped from any non-terminal state", () => {
    for (const state of VISIT_STATES) {
      if (VISIT_TERMINAL_STATES.includes(state)) continue;
      expect(isVisitTransitionAllowed(state, "safety_stopped")).toBe(true);
    }
  });

  test("allows cancelled from any non-terminal state", () => {
    for (const state of VISIT_STATES) {
      if (VISIT_TERMINAL_STATES.includes(state)) continue;
      expect(isVisitTransitionAllowed(state, "cancelled")).toBe(true);
    }
  });

  test("denied is only reachable from awaiting_policy_or_staff", () => {
    expect(isVisitTransitionAllowed("awaiting_policy_or_staff", "denied")).toBe(true);
    expect(isVisitTransitionAllowed("active", "denied")).toBe(false);
  });

  test("resident_unavailable is only reachable from awaiting_resident_consent", () => {
    expect(isVisitTransitionAllowed("awaiting_resident_consent", "resident_unavailable")).toBe(true);
    expect(isVisitTransitionAllowed("connecting", "resident_unavailable")).toBe(false);
  });

  test("navigation_failed is only reachable from robot_en_route", () => {
    expect(isVisitTransitionAllowed("robot_en_route", "navigation_failed")).toBe(true);
    expect(isVisitTransitionAllowed("accepted", "navigation_failed")).toBe(false);
  });

  test("connection_failed is reachable from connecting and active", () => {
    expect(isVisitTransitionAllowed("connecting", "connection_failed")).toBe(true);
    expect(isVisitTransitionAllowed("active", "connection_failed")).toBe(true);
    expect(isVisitTransitionAllowed("requested", "connection_failed")).toBe(false);
  });

  test("transitionVisit returns the new state on a legal transition", () => {
    const result = transitionVisit("requested", "awaiting_policy_or_staff");
    expect(result).toEqual({ ok: true, state: "awaiting_policy_or_staff" });
  });

  test("transitionVisit returns a descriptive error on an illegal transition", () => {
    const result = transitionVisit("completed", "active");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/completed.*active/);
    }
  });
});
