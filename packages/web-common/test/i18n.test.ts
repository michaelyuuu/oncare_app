import { expect, test } from "vitest";
import { t } from "../src/i18n";

test("interpolates variables", () => {
  expect(t("resident.incoming.title", { name: "Amy" })).toBe("Amy is calling");
});

test("returns the key when missing so a gap is visible, not blank", () => {
  expect(t("nope.key")).toBe("nope.key");
});

test("every value in en.json is a non-empty string", async () => {
  const en = (await import("../src/i18n/en.json")).default as Record<string, string>;
  for (const [key, value] of Object.entries(en)) expect(typeof value === "string" && value.length > 0, key).toBe(true);
});
