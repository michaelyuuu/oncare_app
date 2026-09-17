import type { TaskProposal } from "./intent";

/**
 * Deterministic policy applied AFTER schema validation and BEFORE anything is
 * queued for the robot. No language model is involved here.
 */

export type DestinationKind = "surface";

export interface ApprovedDestination {
  id: string;
  kind: DestinationKind;
  label: string;
}

export interface ItemCatalogue {
  /** Items the robot may pick up and place. */
  approvedItems: readonly string[];
  /** Items that must never be handled (handover rule 8). */
  prohibitedItems: readonly string[];
  /** Places an item may be set down. Never a person. */
  approvedDestinations: readonly ApprovedDestination[];
}

export interface PolicyContext {
  catalogue: ItemCatalogue;
  /** Resident IDs the requesting user is authorized to act for. */
  authorizedRecipients: readonly string[];
}

export type PolicyCode =
  | "prohibited_item"
  | "unknown_item"
  | "unapproved_destination"
  | "unauthorized_recipient";

export type PolicyVerdict =
  | { allowed: true }
  | { allowed: false; code: PolicyCode; reason: string };

/** Synthetic demo catalogue. No real facility data. */
export const DEMO_CATALOGUE: ItemCatalogue = {
  approvedItems: ["water_bottle", "tissue_box", "tv_remote"],
  prohibitedItems: [
    "medication",
    "pills",
    "hot_liquid",
    "hot_tea",
    "coffee",
    "knife",
    "scissors",
    "glass",
    "unidentified_item",
  ],
  approvedDestinations: [
    { id: "bedside_table_demo", kind: "surface", label: "Bedside table" },
    { id: "delivery_tray_demo", kind: "surface", label: "Delivery tray" },
  ],
};

/** Checks run in order of severity; the first failure is reported. */
export function evaluateProposal(proposal: TaskProposal, ctx: PolicyContext): PolicyVerdict {
  const { catalogue, authorizedRecipients } = ctx;

  if (catalogue.prohibitedItems.includes(proposal.item)) {
    return {
      allowed: false,
      code: "prohibited_item",
      reason: `"${proposal.item}" is on the prohibited item list`,
    };
  }
  if (!authorizedRecipients.includes(proposal.recipient)) {
    return {
      allowed: false,
      code: "unauthorized_recipient",
      reason: `requester is not authorized to act for "${proposal.recipient}"`,
    };
  }
  if (!catalogue.approvedItems.includes(proposal.item)) {
    return {
      allowed: false,
      code: "unknown_item",
      reason: `"${proposal.item}" is not in the approved item catalogue`,
    };
  }
  const destination = catalogue.approvedDestinations.find((d) => d.id === proposal.destination);
  if (!destination || destination.kind !== "surface") {
    return {
      allowed: false,
      code: "unapproved_destination",
      reason: `"${proposal.destination}" is not an approved delivery surface`,
    };
  }
  return { allowed: true };
}
