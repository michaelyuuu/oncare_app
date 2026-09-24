export type Screen = "home" | "visit_calendar" | "incoming" | "in_call" | "delivery_arrived" | "caregiver_called" | "settings" | "disconnected";
export interface DeviceState {
  resident: { id: string; displayName: string };
  screen: "home" | "incoming" | "in_call" | "delivery_arrived";
  visit: { id: string; state: string } | null;
  caller: { displayName: string } | null;
  task: { id: string; state: string; item: { id: string; label: string } } | null;
  robot: { adapter: "mock" | "navweb" | null; connected: boolean };
}
export interface UiOverrides { caregiverCalledUntil: number | null; settingsOpen: boolean; apiReachable: boolean }
export function isCommunicationScreen(screen: Screen): boolean {
  return screen === "home" || screen === "visit_calendar" || screen === "disconnected";
}
export function selectScreen(server: DeviceState | null, ui: UiOverrides, now: number): Screen {
  if (ui.settingsOpen) return "settings";
  if (!ui.apiReachable || !server) return "disconnected";
  if (server.screen !== "home") return server.screen;
  if (ui.caregiverCalledUntil !== null && ui.caregiverCalledUntil > now) return "caregiver_called";
  return server.screen;
}
