import type { FastifyInstance } from "fastify";
import { requireRole } from "../auth/plugin";
import { buildCapabilities } from "../services/capabilities";

export async function capabilitiesRoutes(app: FastifyInstance) {
  app.get("/capabilities", { preHandler: requireRole("family", "staff", "admin", "device") }, async (req) => {
    return buildCapabilities(req.principal);
  });
}
