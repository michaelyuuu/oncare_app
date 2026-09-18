export const TASK_STEPS = ["confirm", "approval", "pickup", "loading", "delivery", "handoff", "done"] as const;

export interface TaskProgress {
  steps: readonly (typeof TASK_STEPS)[number][];
  currentIndex: number;
  failed: string | null;
  terminal: boolean;
}

const HAPPY: Record<string, number> = {
  draft: 0,
  parsed: 0,
  awaiting_user_confirmation: 0,
  awaiting_policy_or_staff: 1,
  queued: 2,
  navigating_to_pickup: 2,
  locating_item: 2,
  grasping: 3,
  verifying_grasp: 3,
  navigating_to_delivery: 4,
  placing: 5,
  verifying_delivery: 5,
  completed: 6,
};

const FAILED: Record<string, number> = {
  rejected: 1,
  clarification_required: 0,
  item_not_found: 3,
  grasp_failed: 3,
  navigation_failed: 4,
  operator_required: 4,
  cancelled: 2,
  safety_stopped: 2,
};

export function taskProgress(state: string): TaskProgress {
  if (state in FAILED) {
    return { steps: TASK_STEPS, currentIndex: FAILED[state]!, failed: state, terminal: true };
  }
  return { steps: TASK_STEPS, currentIndex: HAPPY[state] ?? 0, failed: null, terminal: state === "completed" };
}
