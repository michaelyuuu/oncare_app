import { and, eq, getTableColumns, inArray } from "drizzle-orm";
import type { AuditEvent } from "@oncare/core";
import type { Principal } from "../auth/plugin";
import type { Db } from "../db/client";
import * as t from "../db/schema";

export type FamilyLink = typeof t.familyRelationship.$inferSelect;
export type ManagedUser = typeof t.user.$inferSelect;

export type ActionRole = "family" | "staff" | "device";

/** Visit and task action tables know three roles. An admin acts with staff powers inside its facility. */
export function actionRole(p: Principal): ActionRole {
  if (p.kind === "device") return "device";
  return p.role === "admin" ? "staff" : p.role;
}

/**
 * The single answer to "may this principal touch this resident / see this audit event?".
 * Routes, the events WebSocket and AI tools all go through here.
 */
export function createAccess(db: Db) {
  function resolvePrincipal(claims: Principal): Principal | null {
    if (claims.kind === "user") {
      const u = db.select().from(t.user).where(eq(t.user.id, claims.id)).get();
      if (!u || !u.active) return null;
      return { kind: "user", id: u.id, role: u.role, facilityId: u.facilityId ?? null };
    }
    const d = db.select().from(t.device).where(eq(t.device.id, claims.id)).get();
    if (!d || !d.active || d.residentId !== claims.residentId || d.assignmentVersion !== claims.assignmentVersion) return null;
    return { kind: "device", id: d.id, residentId: d.residentId, facilityId: d.facilityId, robotId: d.robotId ?? null, assignmentVersion: d.assignmentVersion };
  }

  function residentIdsVisibleTo(p: Principal): string[] {
    if (p.kind === "device") {
      const r = db.select().from(t.resident).where(and(eq(t.resident.id, p.residentId), eq(t.resident.active, true))).get();
      return r ? [r.id] : [];
    }
    if (p.role === "admin") {
      if (!p.facilityId) return [];
      return db.select({ id: t.resident.id }).from(t.resident)
        .where(and(eq(t.resident.facilityId, p.facilityId), eq(t.resident.active, true))).all().map((r) => r.id);
    }
    if (p.role === "staff") {
      if (!p.facilityId) return [];
      return db.select({ id: t.resident.id }).from(t.staffAssignment)
        .innerJoin(t.resident, eq(t.resident.id, t.staffAssignment.residentId))
        .where(and(
          eq(t.staffAssignment.userId, p.id), eq(t.staffAssignment.active, true),
          eq(t.resident.facilityId, p.facilityId), eq(t.resident.active, true),
        )).all().map((r) => r.id);
    }
    return db.select({ id: t.resident.id }).from(t.familyRelationship)
      .innerJoin(t.resident, eq(t.resident.id, t.familyRelationship.residentId))
      .where(and(eq(t.familyRelationship.userId, p.id), eq(t.resident.active, true))).all().map((r) => r.id);
  }

  function canAccessResident(p: Principal, residentId: string): boolean {
    return residentIdsVisibleTo(p).includes(residentId);
  }

  function sameFacility(p: Principal, facilityId: string): boolean {
    return p.facilityId !== null && p.facilityId === facilityId;
  }

  // A family relationship to a resident who has since been deactivated grants nothing: this is the
  // one place that rule lives, so visit and task creation (and anything else keyed off a family
  // link) never need their own `resident.active` check.
  function familyLink(userId: string, residentId: string): FamilyLink | undefined {
    return db.select(getTableColumns(t.familyRelationship)).from(t.familyRelationship)
      .innerJoin(t.resident, eq(t.resident.id, t.familyRelationship.residentId))
      .where(and(
        eq(t.familyRelationship.userId, userId), eq(t.familyRelationship.residentId, residentId), eq(t.resident.active, true),
      )).get();
  }

  function familyLinks(userId: string): FamilyLink[] {
    return db.select(getTableColumns(t.familyRelationship)).from(t.familyRelationship)
      .innerJoin(t.resident, eq(t.resident.id, t.familyRelationship.residentId))
      .where(and(eq(t.familyRelationship.userId, userId), eq(t.resident.active, true))).all();
  }

  /**
   * The single answer to "may an admin of facility f manage this user?" (spec §3: authorization
   * decisions go through this file, never a direct family_relationship / staff_assignment query
   * elsewhere). Staff and admins belong to the facility they carry on their user row. A family
   * user's scope is fixed to a single facility: they are in facility f's scope only if
   * (a) none of their family_relationship rows point at a resident of a *different* facility, and
   * (b) they hold at least one link to a resident of f, or an admin of f created their account
   * (an audit_event row: entity_type "user", reason "user_created", correlation_id f). This lets a
   * freshly created, still-unlinked family user be found long enough to receive their first link,
   * without ever letting an admin reach a family user who is (even partly) another facility's.
   * Cross-facility family linking is not supported in this sub-project.
   */
  function userManagedBy(facilityId: string, userId: string): ManagedUser | undefined {
    const u = db.select().from(t.user).where(eq(t.user.id, userId)).get();
    if (!u) return undefined;
    if (u.facilityId === facilityId) return u;
    if (u.role !== "family") return undefined;
    const links = db.select({ residentId: t.familyRelationship.residentId }).from(t.familyRelationship).where(eq(t.familyRelationship.userId, u.id)).all();
    if (links.length > 0) {
      const facilities = db.select({ facilityId: t.resident.facilityId }).from(t.resident).where(inArray(t.resident.id, links.map((l) => l.residentId))).all();
      if (facilities.some((r) => r.facilityId !== facilityId)) return undefined;
      if (facilities.some((r) => r.facilityId === facilityId)) return u;
    }
    const created = db.select().from(t.auditEvent).where(and(
      eq(t.auditEvent.entityType, "user"), eq(t.auditEvent.entityId, u.id),
      eq(t.auditEvent.reason, "user_created"), eq(t.auditEvent.correlationId, facilityId),
    )).get();
    return created ? u : undefined;
  }

  function robotFacility(robotId: string): string | null {
    return db.select({ f: t.robot.facilityId }).from(t.robot).where(eq(t.robot.id, robotId)).get()?.f ?? null;
  }

  /**
   * Resident-bound events follow resident scope (family and devices only for their own visits/tasks);
   * robot and command events are facility-level for staff and admins; admin-managed records and tool
   * calls carry the facility id as correlation id and are visible to that facility's admins.
   */
  function auditVisibleTo(p: Principal, ev: AuditEvent, visible: Set<string> = new Set(residentIdsVisibleTo(p))): boolean {
    const isStaffLike = p.kind === "user" && (p.role === "staff" || p.role === "admin");
    switch (ev.entityType) {
      case "resident":
        return isStaffLike && visible.has(ev.entityId);
      case "visit": {
        const v = db.select().from(t.visitSession).where(eq(t.visitSession.id, ev.entityId)).get();
        if (!v || !visible.has(v.residentId)) return false;
        return p.kind === "device" || isStaffLike || v.requesterId === p.id;
      }
      case "task": {
        const k = db.select().from(t.taskRequest).where(eq(t.taskRequest.id, ev.entityId)).get();
        if (!k || !visible.has(k.residentId)) return false;
        return p.kind === "device" || isStaffLike || k.requesterId === p.id;
      }
      case "assistance_request": {
        const request = db.select().from(t.assistanceRequest).where(eq(t.assistanceRequest.id, ev.entityId)).get();
        return request !== undefined && visible.has(request.residentId);
      }
      case "robot": {
        const f = robotFacility(ev.entityId);
        return isStaffLike && f !== null && sameFacility(p, f);
      }
      case "command": {
        const c = db.select().from(t.robotCommand).where(eq(t.robotCommand.id, ev.entityId)).get();
        const f = c ? robotFacility(c.robotId) : null;
        return isStaffLike && f !== null && sameFacility(p, f);
      }
      default:
        return p.kind === "user" && p.role === "admin" && p.facilityId !== null && ev.correlationId === p.facilityId;
    }
  }

  return { resolvePrincipal, residentIdsVisibleTo, canAccessResident, sameFacility, familyLink, familyLinks, userManagedBy, auditVisibleTo };
}

export type Access = ReturnType<typeof createAccess>;
