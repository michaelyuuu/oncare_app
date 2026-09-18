import { describe, expect, test } from "vitest";
import { taskProgress } from "../src/task-progress";

describe("taskProgress", () => {
  test.each([
    ["awaiting_user_confirmation", 0],
    ["awaiting_policy_or_staff", 1],
    ["queued", 2],
    ["navigating_to_pickup", 2],
    ["locating_item", 2],
    ["grasping", 3],
    ["verifying_grasp", 3],
    ["navigating_to_delivery", 4],
    ["placing", 5],
    ["verifying_delivery", 5],
    ["completed", 6],
  ])("maps %s to step %i", (state, currentIndex) => {
    expect(taskProgress(state)).toMatchObject({ currentIndex, failed: null });
  });

  test("only a completed happy path is terminal", () => {
    expect(taskProgress("completed").terminal).toBe(true);
    expect(taskProgress("verifying_delivery").terminal).toBe(false);
  });

  test.each([
    ["rejected", 1],
    ["clarification_required", 0],
    ["item_not_found", 3],
    ["grasp_failed", 3],
    ["navigation_failed", 4],
    ["operator_required", 4],
    ["cancelled", 2],
    ["safety_stopped", 2],
  ])("maps terminal failure %s to step %i", (state, currentIndex) => {
    expect(taskProgress(state)).toMatchObject({ currentIndex, failed: state, terminal: true });
  });
});
