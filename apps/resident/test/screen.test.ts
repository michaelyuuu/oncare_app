import { expect, test } from "vitest";
import { selectScreen, type DeviceState, type UiOverrides } from "../src/screen";
const state = (screen: DeviceState["screen"]): DeviceState => ({ resident: { id: "r", displayName: "R" }, screen, visit: null, caller: null, task: null, robot: { adapter: "mock", connected: true } });
const ui: UiOverrides = { caregiverCalledUntil: null, settingsOpen: false, apiReachable: true };
test("settings precedes disconnected, which precedes server state", () => {
  expect(selectScreen(state("incoming"), { ...ui, settingsOpen: true, apiReachable: false }, 0)).toBe("settings");
  expect(selectScreen(null, ui, 0)).toBe("disconnected");
  expect(selectScreen(state("in_call"), { ...ui, apiReachable: false }, 0)).toBe("disconnected");
});
test.each(["incoming", "in_call", "delivery_arrived"] as const)("%s precedes caregiver confirmation", (screen) => {
  expect(selectScreen(state(screen), { ...ui, caregiverCalledUntil: 8000 }, 0)).toBe(screen);
});
test("caregiver confirmation expires at exactly eight seconds", () => {
  expect(selectScreen(state("home"), { ...ui, caregiverCalledUntil: 8000 }, 7999)).toBe("caregiver_called");
  expect(selectScreen(state("home"), { ...ui, caregiverCalledUntil: 8000 }, 8000)).toBe("home");
});
