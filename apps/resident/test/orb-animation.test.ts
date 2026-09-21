import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "apps/resident/src/styles.css"), "utf8");

test("communication orb keeps the original layered motion recipe", () => {
  expect(styles).toContain("animation: communication-orb-breathe 6s ease-in-out infinite");
  expect(styles).toContain("animation: communication-orb-drift 16s ease-in-out infinite alternate");
  expect(styles).toContain("animation: communication-orb-current 14s ease-in-out infinite alternate");
  expect(styles).toContain("animation: communication-orb-swirl 7s linear infinite");
});
