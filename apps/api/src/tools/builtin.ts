import { randomUUID } from "node:crypto";
import { z } from "zod";
import { defineTool, ToolConflict, ToolForbidden, ToolInputError, ToolNotFound, type ToolDef } from "./registry";
import { buildCapabilities } from "../services/capabilities";
import type { AssistanceRequest } from "../services/assistance";
import type { LaundryWarning } from "../services/laundry-repository";

const MAX_PUBLIC_WARNING_COUNT = 10_000;

type PublicLaundryWarning = {
  kind: "wash_history_unavailable" | "station_unavailable" | "invalid_data" | "station_identity_mismatch" | "laundry_data_warning";
  message: string;
  count?: number;
};

function sanitizeLaundryWarning(warning: unknown): PublicLaundryWarning {
  const source = typeof warning === "object" && warning !== null
    ? warning as { kind?: unknown; count?: unknown }
    : {};
  let safe: Omit<PublicLaundryWarning, "count">;
  switch (source.kind) {
    case "missing_scan_log":
      safe = { kind: "wash_history_unavailable", message: "Laundry wash history is temporarily unavailable." };
      break;
    case "station_unavailable":
      safe = { kind: "station_unavailable", message: "Laundry station data is temporarily unavailable." };
      break;
    case "invalid_payload":
      safe = { kind: "invalid_data", message: "Laundry station data could not be verified." };
      break;
    case "station_identity_mismatch":
      safe = { kind: "station_identity_mismatch", message: "Laundry station identity could not be verified." };
      break;
    default:
      safe = { kind: "laundry_data_warning", message: "Some laundry data may be incomplete." };
  }
  const count = source.count;
  return {
    ...safe,
    ...(typeof count === "number" && Number.isFinite(count) && Number.isInteger(count) && count >= 0
      ? { count: Math.min(count, MAX_PUBLIC_WARNING_COUNT) }
      : {}),
  };
}

function sanitizeLaundryWarnings(warnings: LaundryWarning[]): PublicLaundryWarning[] {
  return warnings.map(sanitizeLaundryWarning);
}

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isCalendarDate(value: string): boolean {
  const match = LOCAL_DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

const localDateInput = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isCalendarDate, "Invalid calendar date");

function requireDevice(ctx: Parameters<NonNullable<ToolDef["run"]>>[0]) {
  if (ctx.principal.kind !== "device") throw new ToolForbidden();
  return ctx.principal;
}

function requireAdminFacility(
  ctx: Parameters<NonNullable<ToolDef["run"]>>[0],
  residentId?: string,
): string {
  if (ctx.principal.kind !== "user" || ctx.principal.role !== "admin" || ctx.principal.facilityId === null) {
    throw new ToolForbidden();
  }
  if (residentId !== undefined && !ctx.access.canAccessResident(ctx.principal, residentId)) {
    throw new ToolForbidden();
  }
  return ctx.principal.facilityId;
}

function throwAssistanceFailure(error: string): never {
  if (error === "forbidden") throw new ToolForbidden();
  if (error === "not_found") throw new ToolNotFound();
  if (error === "version_conflict" || error === "invalid_transition" || error === "idempotency_conflict") throw new ToolConflict(error);
  throw new ToolInputError(error);
}

function throwReservationFailure(error: string): never {
  if (error === "forbidden" || error === "consent_missing") throw new ToolForbidden();
  if (error === "not_found") throw new ToolNotFound();
  if (error === "conflict" || error === "expired" || error === "invalid_action") throw new ToolConflict(error);
  throw new ToolInputError(error);
}

function localVisitLabel(localDate: string, startMinute: number): string {
  const date = new Date(localDate + "T00:00:00.000Z");
  const time = new Date(Date.UTC(2000, 0, 1, 0, startMinute));
  const dateLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
  const timeLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    hour: "numeric",
    minute: "2-digit",
  }).format(time);
  return dateLabel + " at " + timeLabel + " local time";
}

function requestStatus(request: AssistanceRequest) {
  return {
    id: request.id,
    residentId: request.residentId,
    category: request.category,
    note: request.note,
    persistenceState: request.persistenceState,
    deliveryState: request.deliveryState,
    handlingState: request.handlingState,
    withdrawalState: request.withdrawalState,
    escalationState: request.escalationState,
    version: request.version,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}

export const listMyResidentsOrContacts = defineTool({
  name: "list_my_residents_or_contacts",
  description: "On a resident's iPad: the family members this resident can contact. For family, staff and managers: the residents this user may see, with availability and room.",
  roles: ["device", "family", "staff", "admin"],
  effect: "read",
  input: z.object({}).strict(),
  run: (ctx) => ctx.principal.kind === "device"
    ? { contacts: ctx.directory.familyContacts(ctx.principal.residentId) }
    : { residents: ctx.directory.residentSummaries(ctx.access.residentIdsVisibleTo(ctx.principal)) },
});

export const getResidentStatus = defineTool({
  name: "get_resident_status",
  description: "Current availability and room of one resident. On a resident's iPad the resident is implied; everyone else must pass residentId.",
  roles: ["device", "family", "staff", "admin"],
  effect: "read",
  input: z.object({ residentId: z.string().min(1).optional() }).strict(),
  run: (ctx, input) => {
    const residentId = input.residentId ?? (ctx.principal.kind === "device" ? ctx.principal.residentId : undefined);
    if (!residentId) throw new ToolInputError("residentId: Required");
    if (!ctx.access.canAccessResident(ctx.principal, residentId)) throw new ToolForbidden();
    return { resident: ctx.directory.residentSummaries([residentId])[0] ?? null };
  },
});

export const getApprovedContacts = defineTool({
  name: "get_approved_contacts",
  description: "List the resident's server-approved family contacts.",
  roles: ["device"],
  effect: "read",
  input: z.object({}).strict(),
  run: (ctx) => {
    const principal = requireDevice(ctx);
    return { contacts: ctx.directory.familyContacts(principal.residentId) };
  },
});

export const getVisitSchedule = defineTool({
  name: "get_visit_schedule",
  description: "Read this resident's evidence-based upcoming and recent ON 0 visit reservations.",
  roles: ["device"],
  effect: "read",
  input: z.object({}).strict(),
  run: (ctx) => {
    requireDevice(ctx);
    return { reservations: ctx.reservations.list(ctx.principal) };
  },
});

export const getVisitSlots = defineTool({
  name: "get_visit_slots",
  description: "Read authoritative ON 0 visit slot availability for this resident, starting on one facility-local date.",
  roles: ["device"],
  effect: "read",
  input: z.object({
    from: localDateInput,
  }).strict(),
  run: (ctx, input) => {
    const principal = requireDevice(ctx);
    const result = ctx.reservations.slots({
      principal,
      residentId: principal.residentId,
      from: input.from,
    });
    if (!result.ok) throwReservationFailure(result.error);
    return result.value;
  },
});

export const proposeVisitTime = defineTool({
  name: "propose_visit_time",
  description: "Prepare a one-hour ON 0 robot visit proposal with one approved contact. The resident must confirm it on screen before it is created.",
  roles: ["device"],
  effect: "write",
  input: z.object({
    contactUserId: z.string().min(1),
    localDate: localDateInput,
    startMinute: z.number().int().min(0).max(1439),
  }).strict(),
  summarize: (ctx, input) => {
    requireDevice(ctx);
    const contacts = ctx.reservations.contacts(ctx.principal);
    if (!contacts.ok) throwReservationFailure(contacts.error);
    const contact = contacts.value.find((candidate) => candidate.userId === input.contactUserId);
    if (!contact) throw new ToolForbidden();
    return "Propose a visit with " + contact.displayName + " on " + localVisitLabel(input.localDate, input.startMinute)
      + " for a one-hour ON 0 visit?";
  },
  run: (ctx, input) => {
    const principal = requireDevice(ctx);
    const result = ctx.reservations.createProposal({
      principal,
      familyUserId: input.contactUserId,
      localDate: input.localDate,
      startMinute: input.startMinute,
    });
    if (!result.ok) throwReservationFailure(result.error);
    return { reservation: result.value };
  },
});

export const requestStaffHelp = defineTool({
  name: "request_staff_help",
  description: "Create a staff assistance request when the resident asks for a person or help.",
  roles: ["device"],
  effect: "write",
  confirm: false,
  input: z.object({
    category: z.enum(["general_assistance", "communication_support", "other"]),
    note: z.string().trim().min(1).max(500).optional(),
  }).strict(),
  run: (ctx, input) => {
    const principal = requireDevice(ctx);
    const result = ctx.assistance.create({
      principal,
      category: input.category,
      note: input.note ?? null,
      idempotencyKey: "assistant-" + randomUUID(),
    });
    if (!result.ok) throwAssistanceFailure(result.error);
    return { requestId: result.request.id, duplicate: result.duplicate, request: requestStatus(result.request) };
  },
});

export const getMyRequestStatus = defineTool({
  name: "get_my_request_status",
  description: "Read the current evidence-based status of one assistance request owned by this resident device.",
  roles: ["device"],
  effect: "read",
  input: z.object({ requestId: z.string().regex(/^help_[a-f0-9]{32}$/) }).strict(),
  run: (ctx, input) => {
    const principal = requireDevice(ctx);
    const request = ctx.assistance.get(input.requestId);
    if (!request) throw new ToolNotFound();
    if (!ctx.assistance.canView(principal, request)) throw new ToolForbidden();
    return { request: requestStatus(request) };
  },
});

export const requestWithdrawal = defineTool({
  name: "request_withdrawal",
  description: "Request withdrawal of one assistance request when the resident asks to cancel it.",
  roles: ["device"],
  effect: "write",
  confirm: false,
  input: z.object({ requestId: z.string().regex(/^help_[a-f0-9]{32}$/) }).strict(),
  run: (ctx, input) => {
    const principal = requireDevice(ctx);
    const result = ctx.assistance.requestWithdrawal({ requestId: input.requestId, principal });
    if (!result.ok) throwAssistanceFailure(result.error);
    return { request: requestStatus(result.request) };
  },
});

export const getServiceStatus = defineTool({
  name: "get_service_status",
  description: "Explain the current assistant, family-call, staff-assistance, and robot capability states.",
  roles: ["device"],
  effect: "read",
  input: z.object({}).strict(),
  run: (ctx) => {
    requireDevice(ctx);
    return buildCapabilities(ctx.principal);
  },
});

const overviewInput = z.object({ residentId: z.string().min(1).optional() }).strict();

export const getLaundryOverview = defineTool({
  name: "get_laundry_overview",
  description: "Summarize laundry garment totals and synchronization status for this facility or one accessible resident.",
  roles: ["admin"],
  effect: "read",
  input: overviewInput,
  run: (ctx, input) => {
    const facilityId = requireAdminFacility(ctx, input.residentId);
    const overview = ctx.laundry.overview(facilityId, input.residentId);
    return { ...overview, warnings: sanitizeLaundryWarnings(overview.warnings) };
  },
});

const findInput = z.object({
  residentId: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(100).optional(),
  category: z.string().trim().min(1).max(50).optional(),
  color: z.string().trim().min(1).max(50).optional(),
  status: z.enum(["active", "lost", "discarded"]).optional(),
}).strict();

export const findGarments = defineTool({
  name: "find_garments",
  description: "Find up to 20 facility-scoped garments by accessible resident, name, category, color, or status.",
  roles: ["admin"],
  effect: "read",
  input: findInput,
  run: (ctx, input) => {
    const facilityId = requireAdminFacility(ctx, input.residentId);
    const overview = ctx.laundry.overview(facilityId, input.residentId);
    return {
      availability: overview.availability,
      syncedAt: overview.syncedAt,
      stale: overview.stale,
      warnings: sanitizeLaundryWarnings(overview.warnings),
      garments: ctx.laundry.find(facilityId, {
        ...(input.residentId !== undefined ? { residentId: input.residentId } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      }),
    };
  },
});

export const BUILTIN_TOOLS: ToolDef[] = [
  listMyResidentsOrContacts,
  getResidentStatus,
  getApprovedContacts,
  getVisitSchedule,
  getVisitSlots,
  proposeVisitTime,
  requestStaffHelp,
  getMyRequestStatus,
  requestWithdrawal,
  getServiceStatus,
  getLaundryOverview,
  findGarments,
];
