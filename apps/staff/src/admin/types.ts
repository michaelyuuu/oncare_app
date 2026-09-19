import type { Api } from "@oncare/web-common";

export interface Resident { id: string; displayName: string; roomLocationId: string; availability: string; active: boolean }
export interface Person { id: string; role: "staff" | "family" | "admin"; username: string; displayName: string; facilityId: string | null; active: boolean }
export interface FamilyLink { id: string; userId: string; residentId: string; label: string; consentVideo: boolean }
export interface Assignment { id: string; userId: string; residentId: string; active: boolean }
export interface Device { id: string; residentId: string; robotId: string | null; active: boolean; assignmentVersion: number }
export interface Room { id: string; name: string; kind: string }

export interface AdminData { residents: Resident[]; people: Person[]; links: FamilyLink[]; assignments: Assignment[]; devices: Device[]; rooms: Room[] }

/** Every section gets the same two things: the data and a way to run one change and reload. */
export interface SectionProps { data: AdminData; run: (change: (api: Api) => Promise<unknown>) => Promise<unknown> }
