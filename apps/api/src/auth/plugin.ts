import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";

export type UserRole = "family" | "staff" | "admin";
export type Principal =
  | { kind: "user"; id: string; role: UserRole; facilityId: string | null }
  | { kind: "device"; id: string; residentId: string; facilityId: string; robotId: string | null; assignmentVersion: number };

declare module "fastify" {
  interface FastifyRequest { principal: Principal }
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
    const p = req.user;
    const role = p.kind === "device" ? "device" : p.role;
    if (!roles.includes(role)) return reply.code(403).send({ error: "forbidden" });
    req.principal = p;
  };
}
