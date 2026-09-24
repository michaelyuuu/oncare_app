import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  DEFAULT_IDENTITY,
  SAFETY_RULES,
  buildAssistantInstructions,
  loadAssistantProfile,
  parseAssistantProfile,
} from "../src/services/assistant-profile";

describe("assistant profile", () => {
  test("uses the default identity and keeps fixed safety rules last", () => {
    const instructions = buildAssistantInstructions(null);
    expect(instructions).toContain(DEFAULT_IDENTITY);
    expect(instructions.endsWith(SAFETY_RULES)).toBe(true);
  });

  test("loads the active ON 0 mobile-robot profile", () => {
    const profile = loadAssistantProfile();
    expect(profile?.identity).toBe("Ontaru is the calm AI assistant and laundry-robot operator speaking through the chest display of ON 0.");
    expect(profile?.robot).toContain("wheels");
    expect(profile?.robot).toContain("adjustable-height");
    expect(profile?.robot).toContain("two arms");
    expect(profile?.robot).toContain("chest display");
    const restrictions = profile?.cannotDo.join(" ") ?? "";
    expect(restrictions).toContain("do not move it");
    expect(restrictions).toContain("use its arms");
    expect(restrictions).toContain("adjust its height");
    expect(restrictions).toContain("access its camera");
    expect(restrictions).toContain("offer to contact staff");
    expect(buildAssistantInstructions(profile)).toContain("About the robot:");
  });

  test("loads the default profile from the API workspace working directory", () => {
    const cwd = resolve(process.cwd(), "apps", "api");
    const output = execFileSync(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      "import { loadAssistantProfile } from './src/services/assistant-profile.ts'; process.stdout.write(JSON.stringify(loadAssistantProfile()));",
    ], { cwd, encoding: "utf8" });
    const profile = JSON.parse(output) as { identity?: string } | null;
    expect(profile?.identity).toBe("Ontaru is the calm AI assistant and laundry-robot operator speaking through the chest display of ON 0.");
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
