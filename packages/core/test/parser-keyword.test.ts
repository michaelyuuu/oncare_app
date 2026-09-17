import { describe, expect, test } from "vitest";
import { KeywordParser } from "../src/parser/keyword";
import type { ParseContext } from "../src/parser/types";
import { DEMO_CATALOGUE } from "../src/policy";

const ctx: ParseContext = {
  recipientId: "resident_demo_01",
  defaultDestinationId: "bedside_table_demo",
  catalogue: DEMO_CATALOGUE,
};
const parser = new KeywordParser();

describe("KeywordParser", () => {
  test("turns the handover sentence into the handover proposal", () => {
    const out = parser.parse("Could you bring Mom the water bottle?", ctx);
    expect(out).toEqual({
      kind: "proposal",
      proposal: {
        task_type: "deliver_item",
        item: "water_bottle",
        recipient: "resident_demo_01",
        destination: "bedside_table_demo",
        requires_confirmation: true,
      },
    });
  });

  test("matches the bare synonym 'water' and Chinese 水瓶", () => {
    expect(parser.parse("some water please", ctx).kind).toBe("proposal");
    expect(parser.parse("幫媽媽拿水瓶", ctx).kind).toBe("proposal");
  });

  test("is case-insensitive and ignores punctuation", () => {
    const out = parser.parse("WATER   BOTTLE!!!", ctx);
    expect(out.kind).toBe("proposal");
  });

  test("asks for clarification when no approved item is mentioned", () => {
    const out = parser.parse("can you help her?", ctx);
    expect(out.kind).toBe("clarification");
    if (out.kind === "clarification") {
      expect(out.options).toEqual([...DEMO_CATALOGUE.approvedItems]);
    }
  });

  test("asks for clarification when two approved items are mentioned", () => {
    const out = parser.parse("bring the water bottle and the tissue box", ctx);
    expect(out.kind).toBe("clarification");
    if (out.kind === "clarification") {
      expect(out.options.sort()).toEqual(["tissue_box", "water_bottle"]);
    }
  });

  test("a prohibited item still becomes a proposal so policy can reject it with the right code", () => {
    const out = parser.parse("bring her medication", ctx);
    expect(out.kind).toBe("proposal");
    if (out.kind === "proposal") expect(out.proposal.item).toBe("medication");
  });

  test("empty input asks for clarification", () => {
    expect(parser.parse("   ", ctx).kind).toBe("clarification");
  });
});
