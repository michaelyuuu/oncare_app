import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { VISIT_TERMINAL_STATES, type ActorType, type VisitState } from "@oncare/core";
import type { Principal } from "../auth/plugin";
import type { Db } from "../db/client";
import * as t from "../db/schema";
import { TransitionError, type createTransitionService } from "./transitions";
import type { VideoProvider } from "./video";

export type TransitionService = ReturnType<typeof createTransitionService>;
export type VisitRow = typeof t.visitSession.$inferSelect;
export type CreateVisitError = "no_relationship" | "consent_missing" | "resident_unavailable";
export type VisitAction = "approve" | "deny" | "answer" | "decline" | "connected" | "connection_lost" | "end" | "cancel";
export type ActError = "not_found" | "forbidden" | "illegal_transition";

const ACTIONS: Record<VisitAction, { roles: Array<"family" | "staff" | "device">; to: VisitState[] }> = {
  approve:   { roles: ["staff"],                     to: ["accepted"] },
  deny:      { roles: ["staff"],                     to: ["denied"] },
  answer:    { roles: ["device"],                    to: ["connecting"] },
  decline:   { roles: ["device"],                    to: ["resident_unavailable"] },
  connected: { roles: ["family", "device"],          to: ["active"] },
  connection_lost: { roles: ["family", "device"],   to: ["connection_failed"] },
  end:       { roles: ["family", "device", "staff"], to: ["ending", "completed"] },
  cancel:    { roles: ["family", "staff"],           to: ["cancelled"] },
};

export const VISIT_ACTIONS = Object.keys(ACTIONS) as VisitAction[];

function roleOf(p: Principal): "family" | "staff" | "device" { return p.kind === "device" ? "device" : p.role; }
function actorTypeOf(p: Principal): ActorType { return p.kind === "device" ? "device" : p.role; }

export interface VisitService {
  stop(): void;
  create(input: { requesterId: string; residentId: string }): { ok: true; visit: VisitRow } | { ok: false; error: CreateVisitError };
  get(id: string): VisitRow | undefined;
  canView(principal: Principal, visit: VisitRow): boolean;
  act(input: { visitId: string; action: VisitAction; principal: Principal }): { ok: true; visit: VisitRow } | { ok: false; error: ActError; detail?: string };
}

export function createVisitService(
  db: Db,
  transitions: TransitionService,
  video: VideoProvider,
  opts: { now?: () => Date; id?: () => string; onVideoCloseError?: (visitId: string) => void } = {},
): VisitService {
  const now = opts.now ?? (() => new Date());
  const id = opts.id ?? (() => `visit_${randomUUID()}`);

  function get(visitId: string): VisitRow | undefined {
    return db.select().from(t.visitSession).where(eq(t.visitSession.id, visitId)).get();
  }

  // Remember only rooms closed at ending until their terminal transition.
  // All writers (including dispatch) share this successful-transition stream.
  const closedAtEnding = new Set<string>();
  const unsubscribe = transitions.subscribe((event) => {
    if (event.entityType !== "visit") return;
    const terminal = (VISIT_TERMINAL_STATES as readonly string[]).includes(event.toState ?? "");
    if (event.toState !== "ending" && !terminal) return;
    const alreadyClosed = closedAtEnding.has(event.entityId);
    if (terminal) closedAtEnding.delete(event.entityId);
    if (alreadyClosed) return;
    const visit = get(event.entityId);
    const tokenEligibleBefore = ["awaiting_resident_consent", "connecting", "active", "ending"].includes(event.fromState ?? "")
      || visit?.connectedAt != null;
    if (!tokenEligibleBefore) return;
    if (event.toState === "ending") closedAtEnding.add(event.entityId);
    void video.closeRoom(event.entityId).catch(() => opts.onVideoCloseError?.(event.entityId));
  });

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

  function act(input: { visitId: string; action: VisitAction; principal: Principal }): { ok: true; visit: VisitRow } | { ok: false; error: ActError; detail?: string } {
    const visit = get(input.visitId);
    if (!visit) return { ok: false as const, error: "not_found" as const };
    const spec = ACTIONS[input.action];
    if (!spec.roles.includes(roleOf(input.principal)) || !canView(input.principal, visit)) return { ok: false as const, error: "forbidden" as const };
    try {
      const last = spec.to.length - 1;
      spec.to.forEach((to, i) => {
        // A multi-step action (end: active -> ending -> completed) may be
        // asked of a visit that is already part-way through it -- a retried
        // tap, or a client that reported `ending` itself. A step whose state
        // the visit already holds is satisfied, so skip it rather than
        // failing the whole action on an illegal ending -> ending.
        if (get(visit.id)?.state === to) return;
        const isFinal = i === last;
        const patch = isFinal
          ? input.action === "connected" ? { connectedAt: now().toISOString() }
          : input.action === "end" ? { endedAt: now().toISOString() }
          : undefined
          : undefined;
        transitions.apply({
          entityType: "visit", entityId: visit.id, to, actorType: actorTypeOf(input.principal), actorId: input.principal.id,
          ...(patch ? { patch } : {}),
        });
      });
    } catch (e) {
      if (e instanceof TransitionError) return { ok: false as const, error: "illegal_transition" as const, detail: e.reason };
      throw e;
    }
    const updated = get(visit.id)!;
    return { ok: true as const, visit: updated };
  }

  return { create, get, canView, act, stop() { unsubscribe(); closedAtEnding.clear(); } };
}
