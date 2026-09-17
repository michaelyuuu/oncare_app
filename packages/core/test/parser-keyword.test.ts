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
      expect(out.code).toBe("clarify_no_item");
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
    const out = parser.parse("   ", ctx);
    expect(out.kind).toBe("clarification");
    if (out.kind === "clarification") {
      expect(out.options).toEqual([...DEMO_CATALOGUE.approvedItems]);
      expect(out.code).toBe("clarify_unparseable");
    }
  });

  test('Chinese "剪刀" (scissors) → proposal not conflicted by substring "刀" (knife)', () => {
    const out = parser.parse("剪刀", ctx);
    expect(out.kind).toBe("proposal");
    if (out.kind === "proposal") expect(out.proposal.item).toBe("scissors");
  });

  test('Chinese "拿剪刀給她" (bring scissors) → proposal not conflicted by substring', () => {
    const out = parser.parse("拿剪刀給她", ctx);
    expect(out.kind).toBe("proposal");
    if (out.kind === "proposal") expect(out.proposal.item).toBe("scissors");
  });

  test('Chinese "刀" (knife) alone → proposal', () => {
    const out = parser.parse("刀", ctx);
    expect(out.kind).toBe("proposal");
    if (out.kind === "proposal") expect(out.proposal.item).toBe("knife");
  });

  test("multiple approved items still asks for clarification with sorted options", () => {
    const out = parser.parse("water bottle and tissues", ctx);
    expect(out.kind).toBe("clarification");
    if (out.kind === "clarification") {
      expect(out.options.sort()).toEqual(["tissue_box", "water_bottle"]);
    }
  });

  test("longer synonym consumes text so shorter cannot double-count", () => {
    const out = parser.parse("bottle of water", ctx);
    expect(out.kind).toBe("proposal");
    if (out.kind === "proposal") expect(out.proposal.item).toBe("water_bottle");
  });

  test('Chinese "剪刀 剪刀" (scissors twice) → proposal, all occurrences consumed', () => {
    const out = parser.parse("剪刀 剪刀", ctx);
    expect(out.kind).toBe("proposal");
    if (out.kind === "proposal") expect(out.proposal.item).toBe("scissors");
  });

  test('Chinese "剪刀在桌上，媽媽要剪刀" (scissors in sentence, twice) → proposal', () => {
    const out = parser.parse("剪刀在桌上，媽媽要剪刀", ctx);
    expect(out.kind).toBe("proposal");
    if (out.kind === "proposal") expect(out.proposal.item).toBe("scissors");
  });

  test('"water water bottle water" → proposal water_bottle (all occurrences consumed)', () => {
    const out = parser.parse("water water bottle water", ctx);
    expect(out.kind).toBe("proposal");
    if (out.kind === "proposal") expect(out.proposal.item).toBe("water_bottle");
  });

  test('"tissue box, tissue box, and a knife" → clarification offering only the approved item', () => {
    const out = parser.parse("tissue box, tissue box, and a knife", ctx);
    expect(out.kind).toBe("clarification");
    if (out.kind === "clarification") {
      expect(out.options).toEqual(["tissue_box"]);
      expect(out.code).toBe("clarify_multiple");
    }
  });

  test('"knife and scissors" (both prohibited) → clarification with the full approved list', () => {
    const out = parser.parse("knife and scissors", ctx);
    expect(out.kind).toBe("clarification");
    if (out.kind === "clarification") {
      expect(out.options).toEqual([...DEMO_CATALOGUE.approvedItems]);
      expect(out.options).not.toContain("knife");
      expect(out.options).not.toContain("scissors");
      expect(out.code).toBe("clarify_multiple");
    }
  });

  test("Latin lookahead: back-to-back repeats with custom synonyms", () => {
    const customParser = new KeywordParser({
      red_apple: ["red apple"],
      apple: ["apple"],
    });
    const customCtx: ParseContext = {
      recipientId: "resident_demo_01",
      defaultDestinationId: "bedside_table_demo",
      catalogue: {
        approvedItems: ["red_apple", "apple"],
        prohibitedItems: [],
        approvedDestinations: [
          { id: "bedside_table_demo", kind: "surface", label: "Bedside table" },
        ],
      },
    };
    const out = customParser.parse("red apple red apple", customCtx);
    expect(out.kind).toBe("proposal");
    if (out.kind === "proposal") expect(out.proposal.item).toBe("red_apple");
  });

  test("Latin lookahead: genuine overlap after full consumption", () => {
    const customParser = new KeywordParser({
      red_apple: ["red apple"],
      apple: ["apple"],
    });
    const customCtx: ParseContext = {
      recipientId: "resident_demo_01",
      defaultDestinationId: "bedside_table_demo",
      catalogue: {
        approvedItems: ["red_apple", "apple"],
        prohibitedItems: [],
        approvedDestinations: [
          { id: "bedside_table_demo", kind: "surface", label: "Bedside table" },
        ],
      },
    };
    const out = customParser.parse("apple red apple apple", customCtx);
    expect(out.kind).toBe("clarification");
    if (out.kind === "clarification") {
      expect(out.options.sort()).toEqual(["apple", "red_apple"]);
    }
  });

  test("normalisation strips punctuation: \"c++ book\" still matches its synonym", () => {
    const customParser = new KeywordParser({
      cpp_book: ["c++ book"],
    });
    const customCtx: ParseContext = {
      recipientId: "resident_demo_01",
      defaultDestinationId: "bedside_table_demo",
      catalogue: {
        approvedItems: ["cpp_book"],
        prohibitedItems: [],
        approvedDestinations: [
          { id: "bedside_table_demo", kind: "surface", label: "Bedside table" },
        ],
      },
    };
    const out = customParser.parse("the c++ book please", customCtx);
    expect(out.kind).toBe("proposal");
    if (out.kind === "proposal") expect(out.proposal.item).toBe("cpp_book");
  });
});
