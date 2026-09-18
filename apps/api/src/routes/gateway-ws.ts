import type { FastifyInstance } from "fastify";
import { GatewayUpSchema, type GatewayDown } from "@oncare/contracts";
import { verifySecret } from "../auth/password";
import type { Db } from "../db/client";
import * as t from "../db/schema";
import { approvedLocations } from "./locations";

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
    // Track what (if anything) actually got attached to the hub so the close
    // handler -- registered below, before verification even starts -- knows
    // whether, and which link, to detach. Registering "close" this early (and
    // unconditionally) means a disconnect that races token verification is
    // never lost: EventEmitter.emit with no listener drops the event outright,
    // so a "close" that fired before this listener existed would otherwise
    // leave a socket attached forever, or never detached, with nothing left
    // to close it.
    let attached = false;
    let attachedRobotId: string | null = null;
    let attachedLink: { send: (msg: GatewayDown) => void } | null = null;
    socket.on("close", () => {
      if (attached && attachedRobotId && attachedLink) app.hub.detach(attachedRobotId, attachedLink);
    });

    // Hold off reading any inbound frames until the token is verified and our
    // "message" listener is attached -- verifySecret is async (scrypt), and
    // without this the client's first message can arrive and be dropped
    // before we're listening for it.
    socket.pause();
    const { token } = req.query as { token?: string };
    let robotId: string | null;
    try {
      robotId = await robotIdForToken(token);
    } catch {
      robotId = null;
    }
    if (!robotId) {
      socket.close(4401, "unauthorized");
      socket.resume(); // let the closing handshake drain so the socket can actually terminate
      return;
    }
    if (socket.readyState !== socket.OPEN) {
      // The client disconnected while we were verifying the token: the "close"
      // listener above has already run (or will, harmlessly, with nothing
      // attached). Don't attach a dead socket to the hub.
      socket.resume();
      return;
    }

    const link = {
      send: (msg: GatewayDown) => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg)); },
      close: (code: number, reason: string) => { if (socket.readyState === socket.OPEN) socket.close(code, reason); },
    };
    attached = true;
    attachedRobotId = robotId;
    attachedLink = link;
    app.hub.attach(robotId, link);
    // The gateway only accepts location IDs it has been told about: send the approved table first, then any pending intents.
    const locations = approvedLocations(db);
    link.send({ type: "locations", locations });
    app.dispatch.flushPending(robotId);

    socket.on("message", (raw) => {
      let parsed: unknown;
      try { parsed = JSON.parse(raw.toString()); } catch { socket.send(JSON.stringify({ type: "error", reason: "invalid_message" })); return; }
      const result = GatewayUpSchema.safeParse(parsed);
      if (!result.success) { socket.send(JSON.stringify({ type: "error", reason: "invalid_message" })); return; }
      app.hub.receive(robotId, result.data);
    });
    socket.resume();
  });
}
