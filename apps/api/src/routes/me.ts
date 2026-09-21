import type { FastifyInstance } from "fastify";
import { eq, inArray } from "drizzle-orm";
import { requireRole, type Principal } from "../auth/plugin";
import type { Db } from "../db/client";
import * as t from "../db/schema";

function publicPrincipal(principal: Principal) {
  return principal.kind === "device"
    ? { kind: "device" as const }
    : { kind: "user" as const, role: principal.role };
}

export async function meRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  app.get("/me/identities", { preHandler: requireRole("device", "family", "staff", "admin") }, async (req) => {
    const visible = app.access.residentIdsVisibleTo(req.principal);
    const rows = visible.length
      ? db.select({ residentId: t.resident.id, displayName: t.resident.displayName })
          .from(t.resident).where(inArray(t.resident.id, visible)).all()
      : [];
    const relationship = req.principal.kind === "device" ? "self"
      : req.principal.role === "family" ? "family"
      : req.principal.role === "staff" ? "assignment" : "facility";
    return {
      principal: publicPrincipal(req.principal),
      identities: rows.map((row) => ({ ...row, relationship })),
    };
  });

  app.get("/me/residents", { preHandler: requireRole("family") }, async (req) => {
    const p = req.principal;
    if (p.kind !== "user") return { residents: [] };
    const visible = new Set(app.access.residentIdsVisibleTo(p));
    const rows = db
      .select({
        id: t.resident.id, displayName: t.resident.displayName, availability: t.resident.availability,
        label: t.familyRelationship.label, consentVideo: t.familyRelationship.consentVideo,
        consentRobotVisit: t.familyRelationship.consentRobotVisit, consentItemDelivery: t.familyRelationship.consentItemDelivery,
      })
      .from(t.familyRelationship)
      .innerJoin(t.resident, eq(t.resident.id, t.familyRelationship.residentId))
      .where(eq(t.familyRelationship.userId, p.id))
      .all()
      .filter((r) => visible.has(r.id));
    return {
      residents: rows.map((r) => ({
        id: r.id, displayName: r.displayName, availability: r.availability,
        relationship: { label: r.label, consentVideo: r.consentVideo, consentRobotVisit: r.consentRobotVisit, consentItemDelivery: r.consentItemDelivery },
      })),
    };
  });
}
