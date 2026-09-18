import { describe, expect, test } from "vitest";
import { KeywordParser } from "../src/parser/keyword";
import { DEMO_CATALOGUE } from "../src/policy";

const ctx = { recipientId: "resident_demo_01", defaultDestinationId: "bedside_table_demo", catalogue: DEMO_CATALOGUE };
const parser = new KeywordParser();

const CLEAR: Array<[string, string]> = [
  ["Could you bring Mom the water bottle?", "water_bottle"], ["water please", "water_bottle"], ["she needs some water", "water_bottle"], ["bring the bottle of water", "water_bottle"],
  ["can you get the tissue box", "tissue_box"], ["tissues please", "tissue_box"], ["mom needs a tissue", "tissue_box"], ["bring her the tissue box from the table", "tissue_box"],
  ["bring the tv remote", "tv_remote"], ["she lost the remote", "tv_remote"], ["can you bring the remote control", "tv_remote"], ["the TV remote please", "tv_remote"],
  ["幫媽媽拿水瓶", "water_bottle"], ["拿面紙給她", "tissue_box"], ["遙控器", "tv_remote"], ["請拿水", "water_bottle"],
  ["WATER BOTTLE", "water_bottle"], ["tissue-box", "tissue_box"], ["remote!", "tv_remote"], ["bring   water   now", "water_bottle"],
];

const AMBIGUOUS = [
  "can you help her?", "bring her something to drink", "she needs her things", "get the stuff on the table", "please come", "bring it", "the thing", "help",
  "water and tissues", "tissue box or remote", "bring the water bottle and the tv remote", "water, tissues, remote",
  "", "   ", "???", "hello", "how is she today", "is the robot free", "can she call me back", "thanks",
];

describe("parser corpus (handover section 11: speech parsing accuracy)", () => {
  test("every clear request parses to the right item", () => {
    const failures = CLEAR.filter(([text, item]) => {
      const outcome = parser.parse(text, ctx);
      return !(outcome.kind === "proposal" && outcome.proposal.item === item);
    });
    expect(failures, JSON.stringify(failures)).toEqual([]);
  });

  test("at least 90% of ambiguous requests trigger clarification instead of a proposal", () => {
    const clarified = AMBIGUOUS.filter((text) => parser.parse(text, ctx).kind === "clarification");
    const rate = clarified.length / AMBIGUOUS.length;
    expect(rate, `clarified ${clarified.length}/${AMBIGUOUS.length}`).toBeGreaterThanOrEqual(0.9);
  });

  test("no ambiguous request ever produces an executable proposal for a multi-item sentence", () => {
    for (const text of ["water and tissues", "tissue box or remote", "bring the water bottle and the tv remote", "water, tissues, remote"]) {
      expect(parser.parse(text, ctx).kind, text).toBe("clarification");
    }
  });
});
