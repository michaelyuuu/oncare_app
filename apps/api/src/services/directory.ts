import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import * as t from "../db/schema";

/** Read models the AI tools may show. Callers are responsible for scope (see services/access.ts). */
export function createDirectory(db: Db) {
  function residentSummaries(ids: string[]) {
    if (ids.length === 0) return [];
    return db.select({ id: t.resident.id, displayName: t.resident.displayName, availability: t.resident.availability, room: t.location.name })
      .from(t.resident).leftJoin(t.location, eq(t.location.id, t.resident.roomLocationId))
      .where(inArray(t.resident.id, ids)).all()
      .map((r) => ({ id: r.id, displayName: r.displayName, availability: r.availability, room: r.room ?? null }));
  }
  function familyContacts(residentId: string) {
    return db.select({ userId: t.user.id, displayName: t.user.displayName, label: t.familyRelationship.label, canVideoCall: t.familyRelationship.consentVideo })
      .from(t.familyRelationship).innerJoin(t.user, eq(t.user.id, t.familyRelationship.userId))
      .where(and(
        eq(t.familyRelationship.residentId, residentId),
        eq(t.familyRelationship.consentVideo, true),
        eq(t.familyRelationship.consentRobotVisit, true),
        eq(t.user.active, true),
      )).all();
  }
  return { residentSummaries, familyContacts };
}

export type Directory = ReturnType<typeof createDirectory>;
