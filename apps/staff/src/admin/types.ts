import type { Api } from "@oncare/web-common";

export interface Resident { id: string; displayName: string; roomLocationId: string; availability: string; active: boolean }
export interface Person { id: string; role: "staff" | "family" | "admin"; username: string; displayName: string; facilityId: string | null; active: boolean }
export interface FamilyLink { id: string; userId: string; residentId: string; label: string; consentVideo: boolean }
export interface Assignment { id: string; userId: string; residentId: string; active: boolean }
export interface Device { id: string; residentId: string; robotId: string | null; active: boolean; assignmentVersion: number }
export interface Room { id: string; name: string; kind: string }

export interface AdminData { residents: Resident[]; people: Person[]; links: FamilyLink[]; assignments: Assignment[]; devices: Device[]; rooms: Room[] }

export type LoadState<T> =
  | { kind: "idle" | "loading" }
  | { kind: "ready"; value: T }
  | { kind: "error"; message: string };

export type LaundryAvailability = "available" | "never_synced";
export type GarmentStatus = "active" | "lost" | "discarded";
export interface LaundryWarning { kind: string }
export interface LaundryFreshness {
  availability: LaundryAvailability;
  syncedAt: string | null;
  stale: boolean;
  warnings: LaundryWarning[];
}
export interface LaundryOverview extends LaundryFreshness {
  total: number;
  active: number;
  lostOrDiscarded: number;
  recentlyWashed: number;
}
export interface GarmentResult {
  residentId: string;
  residentName: string;
  name: string;
  category: string;
  color: string;
  status: GarmentStatus;
  washCount: number;
  lastSeen: string | null;
  syncedAt: string;
  stale: boolean;
}
export interface LaundrySearch extends LaundryFreshness { garments: GarmentResult[] }

/** Every section gets the same two things: the data and a way to run one change and reload. */
export interface SectionProps { data: AdminData; run: (change: (api: Api) => Promise<unknown>) => Promise<unknown> }
