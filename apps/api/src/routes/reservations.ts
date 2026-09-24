import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth/plugin";
import type { ReservationServiceError } from "../services/reservations";

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const slotBody = { localDate, startMinute: z.number().int().min(0).max(1439) };
const createBody = z.union([
  z.object({ residentId: z.string().min(1), ...slotBody }).strict(),
  z.object({ contactUserId: z.string().min(1), ...slotBody }).strict(),
]);
const suggestionBody = z.object(slotBody).strict();
const slotsQuery = z.object({ residentId: z.string().min(1), from: localDate }).strict();

function sendError(reply: FastifyReply, error: ReservationServiceError) {
  const status = error === "not_found" ? 404 : error === "forbidden" ? 403 : 409;
  return reply.code(status).send({ error });
}

export async function reservationRoutes(app: FastifyInstance) {
  app.get("/visit-reservations/contacts", { preHandler: requireRole("device") }, async (req, reply) => {
    const result = app.reservations.contacts(req.principal);
    if (!result.ok) return sendError(reply, result.error);
    return {
      contacts: result.value.map(({ userId, displayName, label }) => ({ userId, displayName, label })),
    };
  });

  app.get("/visit-reservations/slots", {
    preHandler: requireRole("family", "staff", "admin", "device"),
  }, async (req, reply) => {
    const query = slotsQuery.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: "bad_request" });
    const result = app.reservations.slots({ principal: req.principal, ...query.data });
    if (!result.ok) return sendError(reply, result.error);
    return result.value;
  });

  app.get("/visit-reservations", {
    preHandler: requireRole("family", "staff", "admin", "device"),
  }, async (req) => ({ reservations: app.reservations.list(req.principal) }));

  app.post("/visit-reservations", { preHandler: requireRole("family", "device") }, async (req, reply) => {
    const body = createBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const principal = req.principal;
    if ((principal.kind === "device" && "residentId" in body.data)
      || (principal.kind === "user" && "contactUserId" in body.data)) {
      return reply.code(400).send({ error: "bad_request" });
    }
    const result = "residentId" in body.data
      ? app.reservations.createProposal({ principal, ...body.data })
      : app.reservations.createProposal({
        principal,
        localDate: body.data.localDate,
        startMinute: body.data.startMinute,
        familyUserId: body.data.contactUserId,
      });
    if (!result.ok) return sendError(reply, result.error);
    return reply.code(201).send({ reservation: result.value });
  });

  app.post("/visit-reservations/:id/confirm", {
    preHandler: requireRole("family", "device"),
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = app.reservations.confirm({ principal: req.principal, reservationId: id });
    if (!result.ok) return sendError(reply, result.error);
    return { reservation: result.value };
  });

  app.post("/visit-reservations/:id/suggest", {
    preHandler: requireRole("family", "device"),
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = suggestionBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const result = app.reservations.suggest({
      principal: req.principal,
      reservationId: id,
      ...body.data,
    });
    if (!result.ok) return sendError(reply, result.error);
    return { reservation: result.value };
  });

  app.post("/visit-reservations/:id/cancel", {
    preHandler: requireRole("family", "staff", "admin", "device"),
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = app.reservations.cancel({ principal: req.principal, reservationId: id });
    if (!result.ok) return sendError(reply, result.error);
    return { reservation: result.value };
  });
}
