export const VISIT_STEPS = ["requested", "approval", "robot", "ringing", "connecting", "active", "completed"] as const;
export type VisitStep = (typeof VISIT_STEPS)[number];
export interface VisitProgress { steps: readonly VisitStep[]; currentIndex: number; failed: string | null; terminal: boolean }

const HAPPY: Record<string, number> = { requested: 0, awaiting_policy_or_staff: 1, accepted: 2, robot_en_route: 2, awaiting_resident_consent: 3, connecting: 4, active: 5, ending: 5, completed: 6 };
const FAILED: Record<string, number> = { denied: 1, resident_unavailable: 3, robot_unavailable: 2, navigation_failed: 2, connection_failed: 4, cancelled: 2, safety_stopped: 2 };

export function visitProgress(state: string): VisitProgress {
  if (state in FAILED) return { steps: VISIT_STEPS, currentIndex: FAILED[state]!, failed: state, terminal: true };
  return { steps: VISIT_STEPS, currentIndex: HAPPY[state] ?? 0, failed: null, terminal: state === "completed" };
}
