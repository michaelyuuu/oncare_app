import { describe, expect, test } from "vitest";
import {
  TASK_STATES,
  TASK_TERMINAL_STATES,
  isTaskTransitionAllowed,
  transitionTask,
} from "../src/task-state";

describe("physical task state machine", () => {
  test("follows the happy path from draft to completed", () => {
    const path = [
      "draft",
      "parsed",
      "awaiting_user_confirmation",
      "awaiting_policy_or_staff",
      "queued",
      "navigating_to_pickup",
      "locating_item",
      "grasping",
      "verifying_grasp",
      "navigating_to_delivery",
      "placing",
      "verifying_delivery",
      "completed",
    ] as const;
    for (let i = 0; i < path.length - 1; i++) {
      expect(isTaskTransitionAllowed(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  test("cannot reach any physical execution state without passing confirmation", () => {
    // From parsed, the only forward step is awaiting_user_confirmation.
    expect(isTaskTransitionAllowed("parsed", "queued")).toBe(false);
    expect(isTaskTransitionAllowed("parsed", "navigating_to_pickup")).toBe(false);
    expect(isTaskTransitionAllowed("draft", "queued")).toBe(false);
    expect(isTaskTransitionAllowed("awaiting_user_confirmation", "queued")).toBe(false);
  });

  test("rejects any transition out of a terminal state", () => {
    for (const terminal of TASK_TERMINAL_STATES) {
      for (const next of TASK_STATES) {
        expect(isTaskTransitionAllowed(terminal, next)).toBe(false);
      }
    }
  });

  test("allows cancelled and safety_stopped from any non-terminal state", () => {
    for (const state of TASK_STATES) {
      if (TASK_TERMINAL_STATES.includes(state)) continue;
      expect(isTaskTransitionAllowed(state, "cancelled")).toBe(true);
      expect(isTaskTransitionAllowed(state, "safety_stopped")).toBe(true);
    }
  });

  test("clarification_required is reachable from parsed and awaiting_user_confirmation only", () => {
    expect(isTaskTransitionAllowed("parsed", "clarification_required")).toBe(true);
    expect(isTaskTransitionAllowed("awaiting_user_confirmation", "clarification_required")).toBe(true);
    expect(isTaskTransitionAllowed("queued", "clarification_required")).toBe(false);
  });

  test("rejected is reachable from parsed, confirmation and policy stages only", () => {
    expect(isTaskTransitionAllowed("parsed", "rejected")).toBe(true);
    expect(isTaskTransitionAllowed("awaiting_user_confirmation", "rejected")).toBe(true);
    expect(isTaskTransitionAllowed("awaiting_policy_or_staff", "rejected")).toBe(true);
    expect(isTaskTransitionAllowed("grasping", "rejected")).toBe(false);
  });

  test("item_not_found is only reachable from locating_item", () => {
    expect(isTaskTransitionAllowed("locating_item", "item_not_found")).toBe(true);
    expect(isTaskTransitionAllowed("grasping", "item_not_found")).toBe(false);
  });

  test("grasp_failed is reachable from grasping and verifying_grasp", () => {
    expect(isTaskTransitionAllowed("grasping", "grasp_failed")).toBe(true);
    expect(isTaskTransitionAllowed("verifying_grasp", "grasp_failed")).toBe(true);
    expect(isTaskTransitionAllowed("placing", "grasp_failed")).toBe(false);
  });

  test("verifying_grasp may retry by returning to grasping", () => {
    expect(isTaskTransitionAllowed("verifying_grasp", "grasping")).toBe(true);
  });

  test("navigation_failed is reachable from both navigation states", () => {
    expect(isTaskTransitionAllowed("navigating_to_pickup", "navigation_failed")).toBe(true);
    expect(isTaskTransitionAllowed("navigating_to_delivery", "navigation_failed")).toBe(true);
    expect(isTaskTransitionAllowed("queued", "navigation_failed")).toBe(false);
  });

  test("operator_required is reachable from every physical execution state", () => {
    const physical = [
      "navigating_to_pickup",
      "locating_item",
      "grasping",
      "verifying_grasp",
      "navigating_to_delivery",
      "placing",
      "verifying_delivery",
    ] as const;
    for (const state of physical) {
      expect(isTaskTransitionAllowed(state, "operator_required")).toBe(true);
    }
    expect(isTaskTransitionAllowed("draft", "operator_required")).toBe(false);
  });

  test("transitionTask reports illegal transitions with both state names", () => {
    const result = transitionTask("parsed", "grasping");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/parsed.*grasping/);
  });
});
