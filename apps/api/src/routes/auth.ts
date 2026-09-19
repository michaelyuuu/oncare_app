import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { verifySecret } from "../auth/password";
import type { Principal } from "../auth/plugin";
import type { Db } from "../db/client";
import * as t from "../db/schema";

export async function authRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  app.post("/auth/login", async (req, reply) => {
    const body = z.object({ username: z.string().min(1), password: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const u = db.select().from(t.user).where(eq(t.user.username, body.data.username)).get();
    if (!u || !u.active || !(await verifySecret(body.data.password, u.passwordHash))) return reply.code(401).send({ error: "invalid_credentials" });
    const principal: Principal = { kind: "user", id: u.id, role: u.role, facilityId: u.facilityId ?? null };
    return { token: app.jwt.sign(principal), principal };
  });

  app.post("/auth/device", async (req, reply) => {
    const body = z.object({ deviceToken: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    for (const d of db.select().from(t.device).where(eq(t.device.active, true)).all()) {
      if (await verifySecret(body.data.deviceToken, d.deviceTokenHash)) {
        const principal: Principal = { kind: "device", id: d.id, residentId: d.residentId, facilityId: d.facilityId, robotId: d.robotId ?? null, assignmentVersion: d.assignmentVersion };
        return { token: app.jwt.sign(principal), principal };
      }
    }
    return reply.code(401).send({ error: "invalid_credentials" });
  });
}
