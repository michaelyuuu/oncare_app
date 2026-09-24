import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { makeTransitionEvent } from "@oncare/core";
import { requireRole } from "../auth/plugin";
import type { Db } from "../db/client";
import * as t from "../db/schema";

export function approvedLocations(db: Db) {
  return db.select().from(t.location).where(eq(t.location.approved, true)).all()
    .map(({ id, name, kind, x, y, yaw, approved }) => ({ id, name, kind, x, y, yaw, approved }));
}

const patchSchema = z.object({
  x: z.number().finite().optional(), y: z.number().finite().optional(),
  yaw: z.number().finite().optional(), approved: z.boolean().optional(),
}).strict().refine(value => Object.keys(value).length > 0);

export async function locationRoutes(app: FastifyInstance, opts: { db: Db; now?: () => Date }) {
  const { db } = opts;
  app.get("/locations", { preHandler: requireRole("staff", "admin") }, async (req) => ({
    locations: db.select().from(t.location).all().filter(l => app.access.sameFacility(req.principal, l.facilityId)),
  }));
  app.patch("/locations/:id", { preHandler: requireRole("staff", "admin") }, async (req, reply) => {
    const body = patchSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const principal = req.principal;
    if (principal.kind !== "user") return reply.code(403).send({ error: "forbidden" });
    const { id } = req.params as { id: string };
    const location = db.transaction(tx => {
      const existing = tx.select().from(t.location).where(eq(t.location.id, id)).get();
      if (!existing || !app.access.sameFacility(principal, existing.facilityId)) return null;
      const robot = tx.select().from(t.robot).where(eq(t.robot.facilityId, existing.facilityId)).get();
      tx.update(t.location).set(body.data).where(eq(t.location.id, id)).run();
      tx.insert(t.auditEvent).values(makeTransitionEvent({
        actorType: principal.role === "admin" ? "admin" : "staff", actorId: principal.id, entityType: "robot", entityId: robot?.id ?? "robot",
        fromState: null, toState: null, reason: "location_updated", correlationId: id,
        ...(opts.now ? { now: opts.now } : {}),
      })).run();
      return tx.select().from(t.location).where(eq(t.location.id, id)).get();
    });
    if (!location) return reply.code(404).send({ error: "not_found" });
    app.hub.broadcast({ type: "locations", locations: approvedLocations(db) });
    return { location };
  });
}
