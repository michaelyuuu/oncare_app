import { readFileSync } from "node:fs";

/** Test-only clock input; no network endpoint can change the API clock. */
export function createServerClock(env: { NODE_ENV?: string; ONCARE_TEST_CLOCK_FILE?: string }): () => Date {
  const path = env.NODE_ENV !== "production" ? env.ONCARE_TEST_CLOCK_FILE : undefined;
  if (!path) return () => new Date();
  return () => {
    try {
      const value = readFileSync(path, "utf8").trim();
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
        const instant = new Date(value);
        if (Number.isFinite(instant.getTime())) return instant;
      }
    } catch {
      // The fixture may not yet exist or may be between writes.
    }
    return new Date();
  };
}
