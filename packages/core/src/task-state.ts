import {
  isTransitionAllowed,
  terminalStates,
  transition,
  type TransitionResult,
  type TransitionTable,
} from "./state-machine";

export const TASK_STATES = [
  "draft",
  "parsed",
  "awaiting_user_confirmation",
  "awaiting_policy_or_staff",
  "queued",
  "navigating_to_pickup",
  "locating_item",
  "grasping",
  "verifying_grasp",
  "navigating_to_delivery",
  "placing",
  "verifying_delivery",
  "completed",
  // failure exits
  "rejected",
  "clarification_required",
  "item_not_found",
  "grasp_failed",
  "navigation_failed",
  "operator_required",
  "cancelled",
  "safety_stopped",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

/** States in which the robot may be moving or manipulating. */
export const TASK_PHYSICAL_STATES: readonly TaskState[] = [
  "navigating_to_pickup",
  "locating_item",
  "grasping",
  "verifying_grasp",
  "navigating_to_delivery",
  "placing",
  "verifying_delivery",
];

const UNIVERSAL_EXITS = ["cancelled", "safety_stopped"] as const;
/** Exits available from any physical execution state. */
const PHYSICAL_EXITS = ["operator_required", ...UNIVERSAL_EXITS] as const;

export const TASK_TRANSITIONS: TransitionTable<TaskState> = {
  draft: ["parsed", ...UNIVERSAL_EXITS],
  parsed: ["awaiting_user_confirmation", "clarification_required", "rejected", ...UNIVERSAL_EXITS],
  awaiting_user_confirmation: ["awaiting_policy_or_staff", "clarification_required", "rejected", ...UNIVERSAL_EXITS],
  awaiting_policy_or_staff: ["queued", "rejected", ...UNIVERSAL_EXITS],
  queued: ["navigating_to_pickup", "operator_required", ...UNIVERSAL_EXITS],
  navigating_to_pickup: ["locating_item", "navigation_failed", ...PHYSICAL_EXITS],
  locating_item: ["grasping", "item_not_found", ...PHYSICAL_EXITS],
  grasping: ["verifying_grasp", "grasp_failed", ...PHYSICAL_EXITS],
  verifying_grasp: ["navigating_to_delivery", "grasping", "grasp_failed", ...PHYSICAL_EXITS],
  navigating_to_delivery: ["placing", "navigation_failed", ...PHYSICAL_EXITS],
  placing: ["verifying_delivery", ...PHYSICAL_EXITS],
  verifying_delivery: ["completed", "navigation_failed", ...PHYSICAL_EXITS],
  completed: [],
  rejected: [],
  clarification_required: [],
  item_not_found: [],
  grasp_failed: [],
  navigation_failed: [],
  operator_required: [],
  cancelled: [],
  safety_stopped: [],
};

export const TASK_TERMINAL_STATES: readonly TaskState[] = terminalStates(TASK_TRANSITIONS);

export function isTaskTransitionAllowed(from: TaskState, to: TaskState): boolean {
  return isTransitionAllowed(TASK_TRANSITIONS, from, to);
}

export function transitionTask(from: TaskState, to: TaskState): TransitionResult<TaskState> {
  return transition(TASK_TRANSITIONS, "task", from, to);
}
