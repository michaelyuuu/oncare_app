import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { Intent } from "@oncare/contracts";
import type { TaskProposal } from "@oncare/core";

export const facility = sqliteTable("facility", {
  id: text("id").primaryKey(), name: text("name").notNull(), timezone: text("timezone").notNull(),
});
export const resident = sqliteTable("resident", {
  id: text("id").primaryKey(), facilityId: text("facility_id").notNull().references(() => facility.id),
  displayName: text("display_name").notNull(), roomLocationId: text("room_location_id").notNull(),
  availability: text("availability", { enum: ["available", "in_activity", "resting", "not_available"] }).notNull().default("available"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});
export const user = sqliteTable("user", {
  id: text("id").primaryKey(), role: text("role", { enum: ["family", "staff", "admin"] }).notNull(),
  username: text("username").notNull().unique(), displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(), pinHash: text("pin_hash"),
  /** Required for staff and admin (enforced in services); null for family. */
  facilityId: text("facility_id").references(() => facility.id),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});
export const familyRelationship = sqliteTable("family_relationship", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(() => user.id),
  residentId: text("resident_id").notNull().references(() => resident.id), label: text("label").notNull(),
  consentVideo: integer("consent_video", { mode: "boolean" }).notNull().default(false),
  consentRobotVisit: integer("consent_robot_visit", { mode: "boolean" }).notNull().default(false),
  consentItemDelivery: integer("consent_item_delivery", { mode: "boolean" }).notNull().default(false),
});
export const robot = sqliteTable("robot", {
  id: text("id").primaryKey(), facilityId: text("facility_id").notNull().references(() => facility.id),
  name: text("name").notNull(), tokenHash: text("token_hash").notNull(),
});
/** A resident's iPad. A robot is optional: most rooms have an iPad and no robot. */
export const device = sqliteTable("device", {
  id: text("id").primaryKey(), facilityId: text("facility_id").notNull().references(() => facility.id),
  robotId: text("robot_id").references(() => robot.id),
  kind: text("kind", { enum: ["ipad"] }).notNull(), residentId: text("resident_id").notNull().references(() => resident.id),
  deviceTokenHash: text("device_token_hash").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  /** Incremented on every reassignment; a device JWT carrying an older value is rejected. */
  assignmentVersion: integer("assignment_version").notNull().default(1),
});
export const staffAssignment = sqliteTable("staff_assignment", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(() => user.id),
  residentId: text("resident_id").notNull().references(() => resident.id),
  active: integer("active", { mode: "boolean" }).notNull().default(true), createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("staff_assignment_user_resident").on(table.userId, table.residentId)]);
export const pendingAction = sqliteTable("pending_action", {
  id: text("id").primaryKey(), principalKind: text("principal_kind", { enum: ["user", "device"] }).notNull(),
  principalId: text("principal_id").notNull(), tool: text("tool").notNull(),
  input: text("input", { mode: "json" }).notNull(), summary: text("summary").notNull(),
  createdAt: text("created_at").notNull(), expiresAt: text("expires_at").notNull(),
  status: text("status", { enum: ["pending", "confirmed", "cancelled", "expired"] }).notNull(),
});
export const assistanceRequest = sqliteTable("assistance_request", {
  id: text("id").primaryKey(),
  residentId: text("resident_id").notNull().references(() => resident.id),
  deviceId: text("device_id").notNull().references(() => device.id),
  facilityId: text("facility_id").notNull().references(() => facility.id),
  category: text("category", { enum: ["general_assistance", "communication_support", "other"] }).notNull(),
  note: text("note"),
  idempotencyKey: text("idempotency_key").notNull(),
  persistenceState: text("persistence_state", { enum: ["recorded", "failed"] }).notNull().default("recorded"),
  deliveryState: text("delivery_state", { enum: ["pending", "delivered", "failed", "unknown"] }).notNull().default("pending"),
  handlingState: text("handling_state", { enum: ["open", "acknowledged", "in_progress", "resolved", "cancelled"] }).notNull().default("open"),
  withdrawalState: text("withdrawal_state", { enum: ["none", "requested", "confirmed", "rejected"] }).notNull().default("none"),
  escalationState: text("escalation_state", { enum: ["none", "due", "attempting", "delivered", "failed"] }).notNull().default("none"),
  version: integer("version").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  deliveryAt: text("delivery_at"),
  acknowledgedAt: text("acknowledged_at"),
  resolvedAt: text("resolved_at"),
  withdrawalAt: text("withdrawal_at"),
}, (table) => [uniqueIndex("assistance_request_device_idempotency").on(table.deviceId, table.idempotencyKey)]);
export const location = sqliteTable("location", {
  id: text("id").primaryKey(), facilityId: text("facility_id").notNull().references(() => facility.id),
  name: text("name").notNull(), kind: text("kind", { enum: ["resident_room", "pickup_station", "standby"] }).notNull(),
  x: real("x").notNull(), y: real("y").notNull(), yaw: real("yaw").notNull(),
  approved: integer("approved", { mode: "boolean" }).notNull().default(false),
});
export const item = sqliteTable("item", {
  id: text("id").primaryKey(), label: text("label").notNull(),
  approved: integer("approved", { mode: "boolean" }).notNull().default(false),
  prohibited: integer("prohibited", { mode: "boolean" }).notNull().default(false),
});
export const visitSession = sqliteTable("visit_session", {
  id: text("id").primaryKey(), residentId: text("resident_id").notNull().references(() => resident.id),
  requesterId: text("requester_id").notNull().references(() => user.id), robotId: text("robot_id").references(() => robot.id),
  state: text("state").notNull(), livekitRoom: text("livekit_room"),
  requestedAt: text("requested_at").notNull(), connectedAt: text("connected_at"), endedAt: text("ended_at"),
});
export const taskRequest = sqliteTable("task_request", {
  id: text("id").primaryKey(), visitId: text("visit_id").references(() => visitSession.id),
  requesterId: text("requester_id").notNull().references(() => user.id), residentId: text("resident_id").notNull().references(() => resident.id),
  proposal: text("proposal", { mode: "json" }).$type<TaskProposal>().notNull(), state: text("state").notNull(),
  mode: text("mode", { enum: ["tray", "manipulation", "mock"] }).notNull(), correlationId: text("correlation_id").notNull().unique(),
  createdAt: text("created_at").notNull(),
});
export const taskApproval = sqliteTable("task_approval", {
  id: text("id").primaryKey(), taskId: text("task_id").notNull().references(() => taskRequest.id),
  actorId: text("actor_id").notNull(), decision: text("decision", { enum: ["confirmed", "approved", "denied", "cancelled"] }).notNull(),
  reason: text("reason"), at: text("at").notNull(),
});
export const robotCommand = sqliteTable("robot_command", {
  id: text("id").primaryKey(), robotId: text("robot_id").notNull().references(() => robot.id),
  taskId: text("task_id").references(() => taskRequest.id), visitId: text("visit_id").references(() => visitSession.id),
  correlationId: text("correlation_id").notNull(),
  intent: text("intent", { mode: "json" }).$type<Intent>().notNull(), issuedAt: text("issued_at").notNull(), expiresAt: text("expires_at").notNull(),
  ackedAt: text("acked_at"), result: text("result"),
});
export const auditEvent = sqliteTable("audit_event", {
  id: text("id").primaryKey(), at: text("at").notNull(), actorType: text("actor_type").notNull(), actorId: text("actor_id").notNull(),
  entityType: text("entity_type").notNull(), entityId: text("entity_id").notNull(),
  fromState: text("from_state"), toState: text("to_state"), reason: text("reason"), correlationId: text("correlation_id").notNull(),
});
export const benchmarkRun = sqliteTable("benchmark_run", {
  id: text("id").primaryKey(), kind: text("kind", { enum: ["visit", "task"] }).notNull(), entityId: text("entity_id").notNull(),
  startedAt: text("started_at").notNull(), metrics: text("metrics", { mode: "json" }).notNull(),
});
export const benchmarkTrial = sqliteTable("benchmark_trial", {
  id: text("id").primaryKey(), runId: text("run_id").notNull().references(() => benchmarkRun.id),
  name: text("name").notNull(), value: real("value"), unit: text("unit"), at: text("at").notNull(),
});
