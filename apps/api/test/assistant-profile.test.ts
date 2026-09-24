import { describe, expect, test } from "vitest";
import {
  DEFAULT_IDENTITY,
  SAFETY_RULES,
  buildAssistantInstructions,
  parseAssistantProfile,
} from "../src/services/assistant-profile";

describe("assistant profile", () => {
  test("uses the default identity and keeps fixed safety rules last", () => {
    const instructions = buildAssistantInstructions(null);
    expect(instructions).toContain(DEFAULT_IDENTITY);
    expect(instructions.endsWith(SAFETY_RULES)).toBe(true);
  });

  test("rejects unknown fields, oversized text, invalid language, and oversized lists", () => {
    expect(() => parseAssistantProfile({ identity: "x", unexpected: "nope" })).toThrow();
    expect(() => parseAssistantProfile({ identity: "x".repeat(1001) })).toThrow();
    expect(() => parseAssistantProfile({ identity: "x", replyLanguage: "not a language" })).toThrow();
    expect(() => parseAssistantProfile({ identity: "x", canDo: Array.from({ length: 31 }, () => "x") })).toThrow();
  });

  test("renders bounded profile text before the immutable safety rules", () => {
    const profile = parseAssistantProfile({
      identity: "You are the carehouse assistant.",
      robot: "A bedside communication screen.",
      canDo: ["help contact staff"],
      cannotDo: ["operate machinery"],
      facilityKnowledge: ["The nurse station is staffed during the demo."],
      replyLanguage: "en-US",
      replyStyle: "brief and calm",
    });
    const instructions = buildAssistantInstructions(profile);
    expect(instructions).toContain("The nurse station is staffed during the demo.");
    expect(instructions.indexOf("Safety rules")).toBeGreaterThan(instructions.indexOf("brief and calm"));
    expect(instructions.endsWith(SAFETY_RULES)).toBe(true);
  });
});
