import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import type { AuditEvent } from "@oncare/core";
import type { Principal } from "../auth/plugin";
import type { Db } from "../db/client";
import * as t from "../db/schema";

export async function eventsRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  function visibleTo(p: Principal, ev: AuditEvent): boolean {
    if (p.kind === "user" && p.role === "staff") return true;
    if (ev.entityType === "visit") {
      const v = db.select().from(t.visitSession).where(eq(t.visitSession.id, ev.entityId)).get();
      if (!v) return false;
      return p.kind === "device" ? v.residentId === p.residentId : v.requesterId === p.id;
    }
    if (ev.entityType === "task") {
      const task = db.select().from(t.taskRequest).where(eq(t.taskRequest.id, ev.entityId)).get();
      if (!task) return false;
      return p.kind === "device" ? task.residentId === p.residentId : task.requesterId === p.id;
    }
    return false;
  }

  app.get("/events", { websocket: true }, (socket, req) => {
    const { token } = req.query as { token?: string };
    let principal: Principal;
    try { principal = app.jwt.verify<Principal>(token ?? ""); } catch { socket.close(4401, "unauthorized"); return; }

    socket.send(JSON.stringify({ type: "hello", principal }));
    const unsubscribe = app.transitions.subscribe((ev) => {
      if (socket.readyState !== socket.OPEN) return;
      if (visibleTo(principal, ev)) socket.send(JSON.stringify(ev));
    });
    socket.on("close", unsubscribe);
    socket.on("error", unsubscribe);
  });
}
