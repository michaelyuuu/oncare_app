import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { makeTransitionEvent } from "@oncare/core";
import type { Principal } from "../auth/plugin";
import type { Db } from "../db/client";
import * as t from "../db/schema";
import type { Access } from "./access";
import type { TransitionService } from "./visits";

export const ASSISTANCE_CATEGORIES = ["general_assistance", "communication_support", "other"] as const;
export type AssistanceCategory = (typeof ASSISTANCE_CATEGORIES)[number];

export const STAFF_ASSISTANCE_ACTIONS = ["acknowledge", "in_progress", "resolve", "reject", "fail_delivery", "confirm_withdrawal"] as const;
export type StaffAssistanceAction = (typeof STAFF_ASSISTANCE_ACTIONS)[number];

export type AssistanceRequest = typeof t.assistanceRequest.$inferSelect;
type Failure = { ok: false; error: string; detail?: string };
type Success<T extends object> = { ok: true } & T;
export type AssistanceResult<T extends object> = Success<T> | Failure;

class AssistanceCommandError extends Error {
  constructor(public readonly reason: string) { super(reason); }
}

export function createAssistanceService(
  db: Db,
  access: Access,
  transitions: TransitionService,
  opts: { now?: () => Date; id?: () => string } = {},
) {
  const now = opts.now ?? (() => new Date());
  const makeId = opts.id ?? (() => `help_${randomUUID().replace(/-/g, "")}`);

  function actorType(principal: Principal): "device" | "staff" | "admin" {
    if (principal.kind === "device") return "device";
    return principal.role === "admin" ? "admin" : "staff";
  }

  function stateLabel(row: Pick<AssistanceRequest, "handlingState" | "deliveryState" | "withdrawalState">): string {
    return `${row.handlingState}:${row.deliveryState}:${row.withdrawalState}`;
  }

  function canView(principal: Principal, row: AssistanceRequest): boolean {
    if (principal.kind === "device") {
      return principal.id === row.deviceId && principal.residentId === row.residentId;
    }
    if (principal.role === "family") return false;
    return access.canAccessResident(principal, row.residentId);
  }

  function get(id: string): AssistanceRequest | undefined {
    return db.select().from(t.assistanceRequest).where(eq(t.assistanceRequest.id, id)).get();
  }

  function create(input: {
    principal: Principal;
    category: AssistanceCategory;
    note: string | null;
    idempotencyKey: string;
  }): AssistanceResult<{ request: AssistanceRequest; duplicate: boolean }> {
    if (input.principal.kind !== "device") return { ok: false, error: "forbidden" };
    const existing = db.select().from(t.assistanceRequest).where(and(
      eq(t.assistanceRequest.deviceId, input.principal.id),
      eq(t.assistanceRequest.idempotencyKey, input.idempotencyKey),
    )).get();
    if (existing) {
      if (existing.category !== input.category || (existing.note ?? null) !== input.note) {
        return { ok: false, error: "idempotency_conflict" };
      }
      return { ok: true, request: existing, duplicate: true };
    }

    const at = now().toISOString();
    const request: AssistanceRequest = {
      id: makeId(),
      residentId: input.principal.residentId,
      deviceId: input.principal.id,
      facilityId: input.principal.facilityId,
      category: input.category,
      note: input.note,
      idempotencyKey: input.idempotencyKey,
      persistenceState: "recorded",
      deliveryState: "pending",
      handlingState: "open",
      withdrawalState: "none",
      escalationState: "none",
      version: 1,
      createdAt: at,
      updatedAt: at,
      deliveryAt: null,
      acknowledgedAt: null,
      resolvedAt: null,
      withdrawalAt: null,
    };
    const event = makeTransitionEvent({
      actorType: "device",
      actorId: input.principal.id,
      entityType: "assistance_request",
      entityId: request.id,
      fromState: null,
      toState: stateLabel(request),
      reason: "assistance_recorded",
      correlationId: request.id,
      now,
    });
    db.transaction((tx) => {
      tx.insert(t.assistanceRequest).values(request).run();
      tx.insert(t.auditEvent).values(event).run();
    });
    transitions.emit(event);
    return { ok: true, request, duplicate: false };
  }

  function listForStaff(principal: Principal, opts: { residentId?: string } = {}): AssistanceResult<{ requests: AssistanceRequest[] }> {
    if (principal.kind !== "user" || (principal.role !== "staff" && principal.role !== "admin")) {
      return { ok: false, error: "forbidden" };
    }
    const visible = new Set(access.residentIdsVisibleTo(principal));
    if (opts.residentId && !visible.has(opts.residentId)) return { ok: false, error: "forbidden" };
    let requests = db.select().from(t.assistanceRequest).orderBy(desc(t.assistanceRequest.createdAt), desc(t.assistanceRequest.id)).all()
      .filter((request) => visible.has(request.residentId));
    if (opts.residentId) requests = requests.filter((request) => request.residentId === opts.residentId);
    return { ok: true, requests };
  }

  function commit(
    principal: Principal,
    row: AssistanceRequest,
    patch: Partial<AssistanceRequest>,
    reason: string,
  ): AssistanceResult<{ request: AssistanceRequest }> {
    const at = now().toISOString();
    const next = { ...row, ...patch, version: row.version + 1, updatedAt: at } as AssistanceRequest;
    const event = makeTransitionEvent({
      actorType: actorType(principal),
      actorId: principal.id,
      entityType: "assistance_request",
      entityId: row.id,
      fromState: stateLabel(row),
      toState: stateLabel(next),
      reason,
      correlationId: row.id,
      now,
    });
    let updated: AssistanceRequest | undefined;
    try {
      db.transaction((tx) => {
        const result = tx.update(t.assistanceRequest).set({
          ...patch,
          version: next.version,
          updatedAt: next.updatedAt,
        }).where(and(
          eq(t.assistanceRequest.id, row.id),
          eq(t.assistanceRequest.version, row.version),
        )).run();
        if (result.changes !== 1) throw new AssistanceCommandError("version_conflict");
        updated = tx.select().from(t.assistanceRequest).where(eq(t.assistanceRequest.id, row.id)).get();
        if (!updated) throw new AssistanceCommandError("not_found");
        tx.insert(t.auditEvent).values(event).run();
      });
    } catch (error) {
      if (error instanceof AssistanceCommandError) return { ok: false, error: error.reason };
      throw error;
    }
    transitions.emit(event);
    return { ok: true, request: updated! };
  }

  function requestWithdrawal(input: {
    requestId: string;
    principal: Principal;
    version: number;
  }): AssistanceResult<{ request: AssistanceRequest }> {
    const row = get(input.requestId);
    if (!row) return { ok: false, error: "not_found" };
    if (input.principal.kind !== "device" || !canView(input.principal, row)) return { ok: false, error: "forbidden" };
    if (row.version !== input.version) return { ok: false, error: "version_conflict" };
    if (row.withdrawalState !== "none" || row.handlingState === "resolved" || row.handlingState === "cancelled") {
      return { ok: false, error: "invalid_transition" };
    }
    return commit(input.principal, row, {
      withdrawalState: "requested",
      withdrawalAt: now().toISOString(),
    }, "withdrawal_requested");
  }

  function act(input: {
    requestId: string;
    principal: Principal;
    action: StaffAssistanceAction;
    version: number;
  }): AssistanceResult<{ request: AssistanceRequest }> {
    const row = get(input.requestId);
    if (!row) return { ok: false, error: "not_found" };
    if (input.principal.kind !== "user" || (input.principal.role !== "staff" && input.principal.role !== "admin")) {
      return { ok: false, error: "forbidden" };
    }
    if (!canView(input.principal, row)) return { ok: false, error: "forbidden" };
    if (row.version !== input.version) return { ok: false, error: "version_conflict" };

    const patch: Partial<AssistanceRequest> = {};
    let reason: string;
    switch (input.action) {
      case "acknowledge":
        if (row.handlingState !== "open" || row.withdrawalState !== "none") return { ok: false, error: "invalid_transition" };
        patch.deliveryState = "delivered";
        patch.handlingState = "acknowledged";
        patch.deliveryAt = now().toISOString();
        patch.acknowledgedAt = now().toISOString();
        reason = "assistance_acknowledged";
        break;
      case "in_progress":
        if (row.handlingState !== "acknowledged") return { ok: false, error: "invalid_transition" };
        patch.handlingState = "in_progress";
        reason = "assistance_started";
        break;
      case "resolve":
        if (row.handlingState !== "in_progress") return { ok: false, error: "invalid_transition" };
        patch.handlingState = "resolved";
        patch.resolvedAt = now().toISOString();
        reason = "assistance_resolved";
        break;
      case "reject":
        if (row.handlingState === "resolved" || row.handlingState === "cancelled") return { ok: false, error: "invalid_transition" };
        patch.handlingState = "cancelled";
        if (row.withdrawalState === "requested") patch.withdrawalState = "rejected";
        reason = "assistance_rejected";
        break;
      case "fail_delivery":
        if (row.deliveryState !== "pending" && row.deliveryState !== "unknown") return { ok: false, error: "invalid_transition" };
        patch.deliveryState = "failed";
        patch.escalationState = "due";
        reason = "assistance_delivery_failed";
        break;
      case "confirm_withdrawal":
        if (row.withdrawalState !== "requested") return { ok: false, error: "invalid_transition" };
        patch.withdrawalState = "confirmed";
        patch.handlingState = "cancelled";
        patch.withdrawalAt = now().toISOString();
        reason = "withdrawal_confirmed";
        break;
    }
    return commit(input.principal, row, patch, reason);
  }

  return { canView, get, create, listForStaff, requestWithdrawal, act };
}

export type AssistanceService = ReturnType<typeof createAssistanceService>;
