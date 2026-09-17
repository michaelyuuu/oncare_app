import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Principal } from "../auth/plugin";
import type { Db } from "../db/client";
import * as t from "../db/schema";
import type { createTransitionService } from "./transitions";

export type TransitionService = ReturnType<typeof createTransitionService>;
export type VisitRow = typeof t.visitSession.$inferSelect;
export type CreateVisitError = "no_relationship" | "consent_missing" | "resident_unavailable";

export interface VisitService {
  create(input: { requesterId: string; residentId: string }): { ok: true; visit: VisitRow } | { ok: false; error: CreateVisitError };
  get(id: string): VisitRow | undefined;
  canView(principal: Principal, visit: VisitRow): boolean;
}

export function createVisitService(db: Db, transitions: TransitionService, opts: { now?: () => Date; id?: () => string } = {}): VisitService {
  const now = opts.now ?? (() => new Date());
  const id = opts.id ?? (() => `visit_${randomUUID()}`);

  function get(visitId: string): VisitRow | undefined {
    return db.select().from(t.visitSession).where(eq(t.visitSession.id, visitId)).get();
  }

  function create(input: { requesterId: string; residentId: string }) {
    const rel = db.select().from(t.familyRelationship)
      .where(and(eq(t.familyRelationship.userId, input.requesterId), eq(t.familyRelationship.residentId, input.residentId))).get();
    if (!rel) return { ok: false as const, error: "no_relationship" as const };
    if (!(rel.consentVideo && rel.consentRobotVisit)) return { ok: false as const, error: "consent_missing" as const };
    const resident = db.select().from(t.resident).where(eq(t.resident.id, input.residentId)).get();
    if (!resident || resident.availability === "not_available") return { ok: false as const, error: "resident_unavailable" as const };

    const robot = db.select().from(t.robot).where(eq(t.robot.facilityId, resident.facilityId)).get();
    const visitId = id();
    db.insert(t.visitSession).values({
      id: visitId, residentId: input.residentId, requesterId: input.requesterId, robotId: robot?.id ?? null,
      state: "requested", livekitRoom: null, requestedAt: now().toISOString(), connectedAt: null, endedAt: null,
    }).run();
    transitions.apply({ entityType: "visit", entityId: visitId, to: "awaiting_policy_or_staff", actorType: "system", actorId: "api" });
    if (resident.availability === "available") {
      transitions.apply({ entityType: "visit", entityId: visitId, to: "accepted", actorType: "system", actorId: "api", reason: "auto_policy" });
    }
    return { ok: true as const, visit: get(visitId)! };
  }

  function canView(principal: Principal, visit: VisitRow): boolean {
    if (principal.kind === "device") return principal.residentId === visit.residentId;
    if (principal.role === "staff") return true;
    return principal.id === visit.requesterId;
  }

  return { create, get, canView };
}
