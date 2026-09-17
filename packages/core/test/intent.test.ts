import { describe, expect, test } from "vitest";
import { parseTaskProposal } from "../src/intent";

const valid = {
  task_type: "deliver_item",
  item: "water_bottle",
  recipient: "resident_demo_01",
  destination: "bedside_table_demo",
  requires_confirmation: true,
};

describe("TaskProposal schema", () => {
  test("accepts the handover example proposal", () => {
    const result = parseTaskProposal(valid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.proposal).toEqual(valid);
  });

  test("rejects requires_confirmation set to false", () => {
    const result = parseTaskProposal({ ...valid, requires_confirmation: false });
    expect(result.ok).toBe(false);
  });

  test("rejects a missing requires_confirmation", () => {
    const { requires_confirmation: _omit, ...rest } = valid;
    expect(parseTaskProposal(rest).ok).toBe(false);
  });

  test("rejects unknown task types", () => {
    expect(parseTaskProposal({ ...valid, task_type: "run_shell" }).ok).toBe(false);
  });

  test("rejects unexpected extra keys so a model cannot smuggle commands", () => {
    const result = parseTaskProposal({ ...valid, ros_topic: "/cmd_vel" });
    expect(result.ok).toBe(false);
  });

  test("rejects identifiers that are not lowercase snake_case", () => {
    expect(parseTaskProposal({ ...valid, item: "Water Bottle" }).ok).toBe(false);
    expect(parseTaskProposal({ ...valid, destination: "bedside; rm -rf /" }).ok).toBe(false);
  });

  test("rejects empty identifiers", () => {
    expect(parseTaskProposal({ ...valid, item: "" }).ok).toBe(false);
  });

  test("returns readable issues on failure", () => {
    const result = parseTaskProposal({ ...valid, item: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues[0]).toMatch(/item/);
    }
  });

  test("rejects non-object input", () => {
    expect(parseTaskProposal("deliver water").ok).toBe(false);
    expect(parseTaskProposal(null).ok).toBe(false);
  });
});
