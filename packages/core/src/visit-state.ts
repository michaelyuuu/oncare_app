import {
  isTransitionAllowed,
  terminalStates,
  transition,
  type TransitionResult,
  type TransitionTable,
} from "./state-machine";

export const VISIT_STATES = [
  "requested",
  "awaiting_policy_or_staff",
  "accepted",
  "robot_en_route",
  "awaiting_resident_consent",
  "awaiting_family_consent",
  "connecting",
  "active",
  "ending",
  "completed",
  // failure exits
  "denied",
  "resident_unavailable",
  "robot_unavailable",
  "navigation_failed",
  "connection_failed",
  "cancelled",
  "safety_stopped",
] as const;

export type VisitState = (typeof VISIT_STATES)[number];

/** Exits that any non-terminal state may take. */
const UNIVERSAL_EXITS = ["cancelled", "safety_stopped"] as const;

export const VISIT_TRANSITIONS: TransitionTable<VisitState> = {
  requested: ["awaiting_policy_or_staff", ...UNIVERSAL_EXITS],
  awaiting_policy_or_staff: ["accepted", "denied", ...UNIVERSAL_EXITS],
  accepted: ["robot_en_route", "robot_unavailable", ...UNIVERSAL_EXITS],
  robot_en_route: ["awaiting_resident_consent", "awaiting_family_consent", "navigation_failed", "robot_unavailable", ...UNIVERSAL_EXITS],
  awaiting_resident_consent: ["connecting", "resident_unavailable", ...UNIVERSAL_EXITS],
  awaiting_family_consent: ["connecting", ...UNIVERSAL_EXITS],
  connecting: ["active", "connection_failed", ...UNIVERSAL_EXITS],
  active: ["ending", "connection_failed", ...UNIVERSAL_EXITS],
  ending: ["completed", ...UNIVERSAL_EXITS],
  completed: [],
  denied: [],
  resident_unavailable: [],
  robot_unavailable: [],
  navigation_failed: [],
  connection_failed: [],
  cancelled: [],
  safety_stopped: [],
};

export const VISIT_TERMINAL_STATES: readonly VisitState[] = terminalStates(VISIT_TRANSITIONS);

export function isVisitTransitionAllowed(from: VisitState, to: VisitState): boolean {
  return isTransitionAllowed(VISIT_TRANSITIONS, from, to);
}

export function transitionVisit(from: VisitState, to: VisitState): TransitionResult<VisitState> {
  return transition(VISIT_TRANSITIONS, "visit", from, to);
}
