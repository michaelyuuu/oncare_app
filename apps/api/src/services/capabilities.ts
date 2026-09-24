import type { Principal } from "../auth/plugin";

export type CapabilityState = "available" | "unavailable" | "not_supported";

export function buildCapabilities(_principal: Principal) {
  return {
    environment: "customer_v0_1" as const,
    voice_conversation: {
      state: "available" as CapabilityState,
      mode: "simulated" as const,
      reasonCode: "SYNTHETIC_ONLY" as const,
    },
    family_call: {
      state: "available" as CapabilityState,
      mode: "simulated" as const,
      reasonCode: "FAKE_PROVIDER" as const,
    },
    staff_assistance: {
      state: "available" as CapabilityState,
      mode: "synthetic_queue" as const,
      reasonCode: "LOCAL_QUEUE" as const,
    },
    robot: {
      state: "not_supported" as CapabilityState,
      reasonCode: "RELEASE_SCOPE" as const,
    },
  };
}
