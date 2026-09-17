import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { requireRole } from "../auth/plugin";
import type { Db } from "../db/client";
import * as t from "../db/schema";

export async function meRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  app.get("/me/residents", { preHandler: requireRole("family") }, async (req) => {
    const p = req.principal;
    if (p.kind !== "user") return { residents: [] };
    const rows = db
      .select({
        id: t.resident.id, displayName: t.resident.displayName, availability: t.resident.availability,
        label: t.familyRelationship.label, consentVideo: t.familyRelationship.consentVideo,
        consentRobotVisit: t.familyRelationship.consentRobotVisit, consentItemDelivery: t.familyRelationship.consentItemDelivery,
      })
      .from(t.familyRelationship)
      .innerJoin(t.resident, eq(t.resident.id, t.familyRelationship.residentId))
      .where(eq(t.familyRelationship.userId, p.id))
      .all();
    return {
      residents: rows.map((r) => ({
        id: r.id, displayName: r.displayName, availability: r.availability,
        relationship: { label: r.label, consentVideo: r.consentVideo, consentRobotVisit: r.consentRobotVisit, consentItemDelivery: r.consentItemDelivery },
      })),
    };
  });
}
