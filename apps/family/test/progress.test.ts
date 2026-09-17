import { describe, expect, test } from "vitest";
import { visitProgress } from "../src/progress";

describe("visitProgress", () => {
  test("happy path indices", () => {
    expect(visitProgress("requested").currentIndex).toBe(0);
    expect(visitProgress("awaiting_policy_or_staff").currentIndex).toBe(1);
    expect(visitProgress("accepted").currentIndex).toBe(2);
    expect(visitProgress("robot_en_route").currentIndex).toBe(2);
    expect(visitProgress("awaiting_resident_consent").currentIndex).toBe(3);
    expect(visitProgress("connecting").currentIndex).toBe(4);
    expect(visitProgress("active")).toMatchObject({ currentIndex: 5, failed: null, terminal: false });
    expect(visitProgress("completed")).toMatchObject({ currentIndex: 6, failed: null, terminal: true });
  });

  test("failures point at the step that failed and are terminal", () => {
    expect(visitProgress("denied")).toMatchObject({ currentIndex: 1, failed: "denied", terminal: true });
    expect(visitProgress("resident_unavailable")).toMatchObject({ currentIndex: 3, failed: "resident_unavailable" });
    expect(visitProgress("navigation_failed")).toMatchObject({ currentIndex: 2, failed: "navigation_failed" });
    expect(visitProgress("connection_failed")).toMatchObject({ currentIndex: 4, failed: "connection_failed" });
    expect(visitProgress("cancelled")).toMatchObject({ failed: "cancelled", terminal: true });
    expect(visitProgress("safety_stopped")).toMatchObject({ failed: "safety_stopped", terminal: true });
  });

  test("unknown state is treated as requested and not failed", () => {
    expect(visitProgress("???")).toMatchObject({ currentIndex: 0, failed: null, terminal: false });
  });
});
