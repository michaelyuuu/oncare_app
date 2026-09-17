import { expect, test } from "vitest";
import { hashSecret, verifySecret } from "../src/auth/password";

test("hash verifies the original and rejects a different secret", async () => {
  const stored = await hashSecret("correct horse");
  expect(stored.startsWith("scrypt$")).toBe(true);
  expect(await verifySecret("correct horse", stored)).toBe(true);
  expect(await verifySecret("wrong", stored)).toBe(false);
});

test("two hashes of the same secret differ (random salt)", async () => {
  expect(await hashSecret("x")).not.toBe(await hashSecret("x"));
});
