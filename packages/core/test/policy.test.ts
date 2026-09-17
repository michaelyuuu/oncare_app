import { describe, expect, test } from "vitest";
import { DEMO_CATALOGUE, evaluateProposal, type PolicyContext } from "../src/policy";
import type { TaskProposal } from "../src/intent";

const base: TaskProposal = {
  task_type: "deliver_item",
  item: "water_bottle",
  recipient: "resident_demo_01",
  destination: "bedside_table_demo",
  requires_confirmation: true,
};

const ctx: PolicyContext = {
  catalogue: DEMO_CATALOGUE,
  authorizedRecipients: ["resident_demo_01"],
};

describe("deterministic task policy", () => {
  test("allows an approved item to an approved surface for an authorized recipient", () => {
    expect(evaluateProposal(base, ctx)).toEqual({ allowed: true });
  });

  test("rejects every prohibited item with code prohibited_item", () => {
    for (const item of DEMO_CATALOGUE.prohibitedItems) {
      const verdict = evaluateProposal({ ...base, item }, ctx);
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) expect(verdict.code).toBe("prohibited_item");
    }
  });

  test("requires clarification for an item that is neither approved nor prohibited", () => {
    const verdict = evaluateProposal({ ...base, item: "purple_thing" }, ctx);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.code).toBe("unknown_item");
  });

  test("rejects a destination that is not an approved surface", () => {
    const verdict = evaluateProposal({ ...base, destination: "resident_hand" }, ctx);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.code).toBe("unapproved_destination");
  });

  test("rejects a recipient the requester is not authorized for", () => {
    const verdict = evaluateProposal({ ...base, recipient: "resident_demo_02" }, ctx);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.code).toBe("unauthorized_recipient");
  });

  test("prohibited item wins over unknown destination so the reason is the most serious one", () => {
    const verdict = evaluateProposal({ ...base, item: "medication", destination: "nowhere" }, ctx);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.code).toBe("prohibited_item");
  });

  test("demo catalogue never lists an item as both approved and prohibited", () => {
    for (const item of DEMO_CATALOGUE.approvedItems) {
      expect(DEMO_CATALOGUE.prohibitedItems).not.toContain(item);
    }
  });

  test("demo catalogue destinations are all surfaces, never a person", () => {
    for (const dest of DEMO_CATALOGUE.approvedDestinations) {
      expect(dest.kind).toBe("surface");
    }
  });
});
