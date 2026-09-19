import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import type { Access } from "../services/access";

export type UserRole = "family" | "staff" | "admin";
export type Principal =
  | { kind: "user"; id: string; role: UserRole; facilityId: string | null }
  | { kind: "device"; id: string; residentId: string; facilityId: string; robotId: string | null; assignmentVersion: number };

declare module "fastify" {
  interface FastifyRequest { principal: Principal }
  interface FastifyInstance { access: Access }
}
declare module "@fastify/jwt" {
  interface FastifyJWT { payload: Principal; user: Principal }
}

export const authPlugin = fp(async (app: FastifyInstance, opts: { secret: string }) => {
  await app.register(fastifyJwt, { secret: opts.secret, sign: { expiresIn: "12h" } });
  // Matches the fastify `(property, value: null | undefined, dependencies)` overload,
  // avoiding generic inference issues when the decorated type is itself a union.
  app.decorateRequest("principal", null, []);
});

export function requireRole(...roles: Array<UserRole | "device">): preHandlerHookHandler {
  return async (req, reply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: "unauthorized" });
    }
    // JWT claims only say who the caller was at login. Authority is re-read on every request so that
    // disabling a user, disabling an iPad or moving it to another resident takes effect immediately.
    const p = req.server.access.resolvePrincipal(req.user);
    if (!p) return reply.code(401).send({ error: "unauthorized" });
    const role = p.kind === "device" ? "device" : p.role;
    if (!roles.includes(role)) return reply.code(403).send({ error: "forbidden" });
    req.principal = p;
  };
}
