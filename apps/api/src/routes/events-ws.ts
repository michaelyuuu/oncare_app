import type { FastifyInstance } from "fastify";
import type { Principal } from "../auth/plugin";
import type { Db } from "../db/client";

export async function eventsRoutes(app: FastifyInstance, _opts: { db: Db }) {
  app.get("/events", { websocket: true }, (socket, req) => {
    const { token } = req.query as { token?: string };
    let claims: Principal;
    try { claims = app.jwt.verify<Principal>(token ?? ""); } catch { socket.close(4401, "unauthorized"); return; }
    const principal = app.access.resolvePrincipal(claims);
    if (!principal) { socket.close(4401, "unauthorized"); return; }

    socket.send(JSON.stringify({ type: "hello", principal }));
    const unsubscribe = app.transitions.subscribe((ev) => {
      if (socket.readyState !== socket.OPEN) return;
      const current = app.access.resolvePrincipal(claims);
      if (!current) { unsubscribe(); socket.close(4401, "unauthorized"); return; }
      if (app.access.auditVisibleTo(current, ev)) socket.send(JSON.stringify(ev));
    });
    socket.on("close", unsubscribe);
    socket.on("error", unsubscribe);
  });
}
