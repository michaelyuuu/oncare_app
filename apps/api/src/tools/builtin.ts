import { randomUUID } from "node:crypto";
import { z } from "zod";
import { defineTool, ToolConflict, ToolForbidden, ToolInputError, ToolNotFound, type ToolDef } from "./registry";
import { buildCapabilities } from "../services/capabilities";
import type { AssistanceRequest } from "../services/assistance";

function requireDevice(ctx: Parameters<NonNullable<ToolDef["run"]>>[0]) {
  if (ctx.principal.kind !== "device") throw new ToolForbidden();
  return ctx.principal;
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
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
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
    localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
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
];
