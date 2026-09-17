import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { GatewayUpSchema, type GatewayDown } from "@oncare/contracts";
import { requireRole } from "../auth/plugin";
import { verifySecret } from "../auth/password";
import type { Db } from "../db/client";
import * as t from "../db/schema";

export async function gatewayRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  async function robotIdForToken(token: string | undefined): Promise<string | null> {
    if (!token) return null;
    for (const r of db.select().from(t.robot).all()) {
      if (await verifySecret(token, r.tokenHash)) return r.id;
    }
    return null;
  }

  app.get("/gateway", { websocket: true }, async (socket, req) => {
    // Hold off reading any inbound frames until the token is verified and our
    // "message"/"close" listeners are attached -- verifySecret is async (scrypt),
    // and without this the client's first message can arrive and be dropped
    // before we're listening for it.
    socket.pause();
    const { token } = req.query as { token?: string };
    const robotId = await robotIdForToken(token);
    if (!robotId) {
      socket.close(4401, "unauthorized");
      socket.resume(); // let the closing handshake drain so the socket can actually terminate
      return;
    }

    const link = { send: (msg: GatewayDown) => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg)); } };
    app.hub.attach(robotId, link);
    // The gateway only accepts location IDs it has been told about: send the approved table first, then any pending intents.
    const locations = db.select().from(t.location).where(eq(t.location.approved, true)).all()
      .map((l) => ({ id: l.id, name: l.name, kind: l.kind, x: l.x, y: l.y, yaw: l.yaw, approved: l.approved }));
    link.send({ type: "locations", locations });
    app.dispatch.flushPending(robotId);

    socket.on("message", (raw) => {
      let parsed: unknown;
      try { parsed = JSON.parse(raw.toString()); } catch { socket.send(JSON.stringify({ type: "error", reason: "invalid_message" })); return; }
      const result = GatewayUpSchema.safeParse(parsed);
      if (!result.success) { socket.send(JSON.stringify({ type: "error", reason: "invalid_message" })); return; }
      app.hub.receive(robotId, result.data);
    });
    socket.on("close", () => { app.hub.detach(robotId); });
    socket.resume();
  });

  app.get("/robots/:id/status", { preHandler: requireRole("staff") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const robot = db.select().from(t.robot).where(eq(t.robot.id, id)).get();
    if (!robot) return reply.code(404).send({ error: "not_found" });
    return { robotId: id, ...app.hub.status(id) };
  });
}
