import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { makeTransitionEvent, type EntityType } from "@oncare/core";
import { requireRole } from "../auth/plugin";
import { hashSecret } from "../auth/password";
import type { Db } from "../db/client";
import * as t from "../db/schema";

type Admin = { id: string; facilityId: string };
type UserRow = typeof t.user.$inferSelect;
type DeviceRow = typeof t.device.$inferSelect;

const publicUser = ({ id, role, username, displayName, facilityId, active }: UserRow) => ({ id, role, username, displayName, facilityId: facilityId ?? null, active });
const publicDevice = ({ deviceTokenHash: _hash, ...rest }: DeviceRow) => rest;

const residentCreate = z.object({ displayName: z.string().trim().min(1).max(80), roomLocationId: z.string().min(1) }).strict();
const residentPatch = residentCreate.partial().strict().refine((v) => Object.keys(v).length > 0);
const userCreate = z.object({
  role: z.enum(["staff", "family"]), username: z.string().trim().min(1).max(64), displayName: z.string().trim().min(1).max(80),
  password: z.string().min(6), pin: z.string().regex(/^\d{4,8}$/).optional(),
}).strict();
const linkCreate = z.object({
  userId: z.string().min(1), residentId: z.string().min(1), label: z.string().trim().min(1).max(40),
  consentVideo: z.boolean().optional(), consentRobotVisit: z.boolean().optional(), consentItemDelivery: z.boolean().optional(),
}).strict();
const linkPatch = linkCreate.omit({ userId: true, residentId: true }).partial().strict().refine((v) => Object.keys(v).length > 0);
const assignmentCreate = z.object({ userId: z.string().min(1), residentId: z.string().min(1) }).strict();
const deviceCreate = z.object({ residentId: z.string().min(1), robotId: z.string().min(1).optional() }).strict();

export async function adminRoutes(app: FastifyInstance, opts: { db: Db; now?: () => Date }) {
  const { db } = opts;
  const now = opts.now ?? (() => new Date());
  const adminOnly = { preHandler: requireRole("admin") };

  /** The calling admin. An admin without a facility manages nothing. */
  function adminOf(req: FastifyRequest): Admin | null {
    const p = req.principal;
    return p.kind === "user" && p.role === "admin" && p.facilityId ? { id: p.id, facilityId: p.facilityId } : null;
  }
  function audit(admin: Admin, entityType: EntityType, entityId: string, reason: string) {
    const ev = makeTransitionEvent({ actorType: "admin", actorId: admin.id, entityType, entityId, fromState: null, toState: null, reason, correlationId: admin.facilityId, now });
    db.insert(t.auditEvent).values(ev).run();
    app.transitions.emit(ev);
  }
  const forbidden = (reply: FastifyReply) => reply.code(403).send({ error: "forbidden" });
  const bad = (reply: FastifyReply, error = "bad_request") => reply.code(400).send({ error });

  const residentIn = (id: string, f: string) => db.select().from(t.resident).where(and(eq(t.resident.id, id), eq(t.resident.facilityId, f))).get();
  const roomIn = (id: string, f: string) => db.select().from(t.location).where(and(eq(t.location.id, id), eq(t.location.facilityId, f), eq(t.location.kind, "resident_room"))).get();
  const facilityResidentIds = (f: string) => db.select({ id: t.resident.id }).from(t.resident).where(eq(t.resident.facilityId, f)).all().map((r) => r.id);
  const linkIn = (id: string, f: string) => {
    const link = db.select().from(t.familyRelationship).where(eq(t.familyRelationship.id, id)).get();
    return link && residentIn(link.residentId, f) ? link : undefined;
  };
  const deviceIn = (id: string, f: string) => db.select().from(t.device).where(and(eq(t.device.id, id), eq(t.device.facilityId, f))).get();

  // ---- residents
  app.get("/admin/residents", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    return { residents: db.select().from(t.resident).where(eq(t.resident.facilityId, admin.facilityId)).all() };
  });
  app.post("/admin/residents", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const body = residentCreate.safeParse(req.body); if (!body.success) return bad(reply);
    if (!roomIn(body.data.roomLocationId, admin.facilityId)) return bad(reply, "bad_location");
    const id = `resident_${randomUUID()}`;
    db.insert(t.resident).values({ id, facilityId: admin.facilityId, ...body.data }).run();
    audit(admin, "resident", id, "resident_created");
    return reply.code(201).send({ resident: residentIn(id, admin.facilityId) });
  });
  app.patch("/admin/residents/:id", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const { id } = req.params as { id: string };
    if (!residentIn(id, admin.facilityId)) return forbidden(reply);
    const body = residentPatch.safeParse(req.body); if (!body.success) return bad(reply);
    if (body.data.roomLocationId && !roomIn(body.data.roomLocationId, admin.facilityId)) return bad(reply, "bad_location");
    db.update(t.resident).set(body.data).where(eq(t.resident.id, id)).run();
    audit(admin, "resident", id, "resident_updated");
    return { resident: residentIn(id, admin.facilityId) };
  });
  app.post("/admin/residents/:id/deactivate", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const { id } = req.params as { id: string };
    if (!residentIn(id, admin.facilityId)) return forbidden(reply);
    db.update(t.resident).set({ active: false }).where(eq(t.resident.id, id)).run();
    audit(admin, "resident", id, "resident_deactivated");
    return { resident: residentIn(id, admin.facilityId) };
  });

  // ---- users
  app.get("/admin/users", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const users = db.select().from(t.user).all().filter((u) => app.access.userManagedBy(admin.facilityId, u.id));
    return { users: users.map(publicUser) };
  });
  app.post("/admin/users", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const body = userCreate.safeParse(req.body); if (!body.success) return bad(reply);
    if (db.select().from(t.user).where(eq(t.user.username, body.data.username)).get()) return reply.code(409).send({ error: "username_taken" });
    const id = `user_${randomUUID()}`;
    db.insert(t.user).values({
      id, role: body.data.role, username: body.data.username, displayName: body.data.displayName,
      passwordHash: await hashSecret(body.data.password),
      pinHash: body.data.role === "staff" && body.data.pin ? await hashSecret(body.data.pin) : null,
      facilityId: body.data.role === "staff" ? admin.facilityId : null,
    }).run();
    audit(admin, "user", id, "user_created");
    return reply.code(201).send({ user: publicUser(db.select().from(t.user).where(eq(t.user.id, id)).get()!) });
  });
  app.post("/admin/users/:id/deactivate", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const { id } = req.params as { id: string };
    if (id === admin.id) return reply.code(409).send({ error: "cannot_deactivate_self" });
    if (!app.access.userManagedBy(admin.facilityId, id)) return forbidden(reply);
    db.update(t.user).set({ active: false }).where(eq(t.user.id, id)).run();
    audit(admin, "user", id, "user_deactivated");
    return { user: publicUser(db.select().from(t.user).where(eq(t.user.id, id)).get()!) };
  });
  app.post("/admin/users/:id/reset-password", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const { id } = req.params as { id: string };
    if (!app.access.userManagedBy(admin.facilityId, id)) return forbidden(reply);
    const body = z.object({ password: z.string().min(6) }).strict().safeParse(req.body); if (!body.success) return bad(reply);
    db.update(t.user).set({ passwordHash: await hashSecret(body.data.password) }).where(eq(t.user.id, id)).run();
    audit(admin, "user", id, "password_reset");
    return { ok: true };
  });
  app.post("/admin/users/:id/reset-pin", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const { id } = req.params as { id: string };
    const u = app.access.userManagedBy(admin.facilityId, id); if (!u) return forbidden(reply);
    if (u.role === "family") return bad(reply, "bad_role");
    const body = z.object({ pin: z.string().regex(/^\d{4,8}$/) }).strict().safeParse(req.body); if (!body.success) return bad(reply);
    db.update(t.user).set({ pinHash: await hashSecret(body.data.pin) }).where(eq(t.user.id, id)).run();
    audit(admin, "user", id, "pin_reset");
    return { ok: true };
  });

  // ---- family links
  app.get("/admin/family-links", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const ids = facilityResidentIds(admin.facilityId);
    return { links: ids.length ? db.select().from(t.familyRelationship).where(inArray(t.familyRelationship.residentId, ids)).all() : [] };
  });
  app.post("/admin/family-links", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const body = linkCreate.safeParse(req.body); if (!body.success) return bad(reply);
    if (!residentIn(body.data.residentId, admin.facilityId)) return forbidden(reply);
    // Scope-checked before the role check so an out-of-facility id never reveals its existence or role.
    const u = app.access.userManagedBy(admin.facilityId, body.data.userId);
    if (!u) return forbidden(reply);
    if (u.role !== "family") return bad(reply, "bad_role");
    if (db.select().from(t.familyRelationship).where(and(eq(t.familyRelationship.userId, u.id), eq(t.familyRelationship.residentId, body.data.residentId))).get()) {
      return reply.code(409).send({ error: "duplicate" });
    }
    const id = `rel_${randomUUID()}`;
    db.insert(t.familyRelationship).values({ id, ...body.data }).run();
    audit(admin, "family_link", id, "family_link_created");
    return reply.code(201).send({ link: db.select().from(t.familyRelationship).where(eq(t.familyRelationship.id, id)).get() });
  });
  app.patch("/admin/family-links/:id", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const { id } = req.params as { id: string };
    if (!linkIn(id, admin.facilityId)) return forbidden(reply);
    const body = linkPatch.safeParse(req.body); if (!body.success) return bad(reply);
    db.update(t.familyRelationship).set(body.data).where(eq(t.familyRelationship.id, id)).run();
    audit(admin, "family_link", id, "family_link_updated");
    return { link: db.select().from(t.familyRelationship).where(eq(t.familyRelationship.id, id)).get() };
  });
  app.delete("/admin/family-links/:id", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const { id } = req.params as { id: string };
    if (!linkIn(id, admin.facilityId)) return forbidden(reply);
    db.delete(t.familyRelationship).where(eq(t.familyRelationship.id, id)).run();
    audit(admin, "family_link", id, "family_link_removed");
    return { ok: true };
  });

  // ---- staff assignments
  app.get("/admin/staff-assignments", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const ids = facilityResidentIds(admin.facilityId);
    return { assignments: ids.length ? db.select().from(t.staffAssignment).where(inArray(t.staffAssignment.residentId, ids)).all() : [] };
  });
  app.post("/admin/staff-assignments", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const body = assignmentCreate.safeParse(req.body); if (!body.success) return bad(reply);
    if (!residentIn(body.data.residentId, admin.facilityId)) return forbidden(reply);
    const u = app.access.userManagedBy(admin.facilityId, body.data.userId); if (!u) return forbidden(reply);
    if (u.role !== "staff") return bad(reply, "bad_role");
    const existing = db.select().from(t.staffAssignment).where(and(eq(t.staffAssignment.userId, u.id), eq(t.staffAssignment.residentId, body.data.residentId))).get();
    if (existing?.active) return reply.code(409).send({ error: "duplicate" });
    const id = existing?.id ?? `sa_${randomUUID()}`;
    if (existing) db.update(t.staffAssignment).set({ active: true }).where(eq(t.staffAssignment.id, id)).run();
    else db.insert(t.staffAssignment).values({ id, ...body.data, createdAt: now().toISOString() }).run();
    audit(admin, "staff_assignment", id, "staff_assigned");
    return reply.code(201).send({ assignment: db.select().from(t.staffAssignment).where(eq(t.staffAssignment.id, id)).get() });
  });
  app.delete("/admin/staff-assignments/:id", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const { id } = req.params as { id: string };
    const a = db.select().from(t.staffAssignment).where(eq(t.staffAssignment.id, id)).get();
    if (!a || !residentIn(a.residentId, admin.facilityId)) return forbidden(reply);
    db.update(t.staffAssignment).set({ active: false }).where(eq(t.staffAssignment.id, id)).run();
    audit(admin, "staff_assignment", id, "staff_unassigned");
    return { ok: true };
  });

  // ---- devices
  app.get("/admin/devices", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    return { devices: db.select().from(t.device).where(eq(t.device.facilityId, admin.facilityId)).all().map(publicDevice) };
  });
  app.post("/admin/devices", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const body = deviceCreate.safeParse(req.body); if (!body.success) return bad(reply);
    if (!residentIn(body.data.residentId, admin.facilityId)) return forbidden(reply);
    if (body.data.robotId && !db.select().from(t.robot).where(and(eq(t.robot.id, body.data.robotId), eq(t.robot.facilityId, admin.facilityId))).get()) return forbidden(reply);
    const id = `device_${randomUUID()}`;
    const deviceToken = randomBytes(24).toString("base64url");
    db.insert(t.device).values({
      id, facilityId: admin.facilityId, robotId: body.data.robotId ?? null, kind: "ipad",
      residentId: body.data.residentId, deviceTokenHash: await hashSecret(deviceToken),
    }).run();
    audit(admin, "device", id, "device_registered");
    // The only time the token leaves the server. It is not stored in clear anywhere.
    return reply.code(201).send({ device: publicDevice(deviceIn(id, admin.facilityId)!), deviceToken });
  });
  app.post("/admin/devices/:id/assign", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const { id } = req.params as { id: string };
    const d = deviceIn(id, admin.facilityId); if (!d) return forbidden(reply);
    const body = z.object({ residentId: z.string().min(1) }).strict().safeParse(req.body); if (!body.success) return bad(reply);
    if (!residentIn(body.data.residentId, admin.facilityId)) return forbidden(reply);
    db.update(t.device).set({ residentId: body.data.residentId, assignmentVersion: d.assignmentVersion + 1 }).where(eq(t.device.id, id)).run();
    audit(admin, "device", id, "device_reassigned");
    return { device: publicDevice(deviceIn(id, admin.facilityId)!) };
  });
  app.post("/admin/devices/:id/deactivate", adminOnly, async (req, reply) => {
    const admin = adminOf(req); if (!admin) return forbidden(reply);
    const { id } = req.params as { id: string };
    if (!deviceIn(id, admin.facilityId)) return forbidden(reply);
    db.update(t.device).set({ active: false }).where(eq(t.device.id, id)).run();
    audit(admin, "device", id, "device_deactivated");
    return { device: publicDevice(deviceIn(id, admin.facilityId)!) };
  });
}
