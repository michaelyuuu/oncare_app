import { z } from "zod";

const Id = z.string().min(1).max(64).regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
const Iso = z.string().datetime();
const Corr = z.string().min(1);

const intentBase = { type: z.literal("intent"), correlationId: Corr, expiresAt: Iso };

export const IntentRequestVisitSchema = z.object({ ...intentBase, intent: z.literal("request_visit"), payload: z.object({ locationId: Id }).strict() }).strict();
export const IntentGoToLocationSchema = z.object({ ...intentBase, intent: z.literal("go_to_location"), payload: z.object({ locationId: Id }).strict() }).strict();
export const IntentDeliverItemSchema = z.object({
  ...intentBase,
  intent: z.literal("deliver_item"),
  payload: z.object({
    itemId: Id, pickupLocationId: Id, destinationLocationId: Id, standbyLocationId: Id,
    mode: z.enum(["tray", "manipulation", "mock"]),
  }).strict(),
}).strict();
export const IntentSchema = z.discriminatedUnion("intent", [IntentRequestVisitSchema, IntentGoToLocationSchema, IntentDeliverItemSchema]);

export const CancelSchema = z.object({ type: z.literal("cancel"), correlationId: Corr }).strict();
export const StopSchema = z.object({ type: z.literal("stop"), reason: z.string().min(1) }).strict();
export const ResumeSchema = z.object({ type: z.literal("resume") }).strict();
export const StaffEventSchema = z.object({ type: z.literal("staff_event"), correlationId: Corr, event: z.enum(["staff_loaded", "received"]) }).strict();
export const LocationSchema = z.object({
  id: Id, name: z.string().min(1), kind: z.enum(["resident_room", "pickup_station", "standby"]),
  x: z.number(), y: z.number(), yaw: z.number(), approved: z.boolean(),
}).strict();
export const LocationsSchema = z.object({ type: z.literal("locations"), locations: z.array(LocationSchema) }).strict();

// `intent` messages share type:"intent"; wrap the inner union so the outer discriminator stays "type".
export const GatewayDownSchema = z.union([IntentSchema, CancelSchema, StopSchema, ResumeSchema, StaffEventSchema, LocationsSchema]);

export const HeartbeatSchema = z.object({
  type: z.literal("heartbeat"), at: Iso, robotReady: z.boolean(), adapter: z.enum(["navweb", "mock"]),
  pose: z.object({ x: z.number(), y: z.number(), yaw: z.number() }).strict().nullable(),
  navState: z.string(), estop: z.boolean(), lift: z.string(),
  battery: z.union([z.number().min(0).max(100), z.literal("unknown")]),
  activeCorrelationId: z.string().nullable(), gatewayVersion: z.string().min(1),
}).strict();
export const AckSchema = z.object({
  type: z.literal("ack"), correlationId: Corr,
  result: z.enum(["accepted", "expired", "busy", "duplicate", "rejected"]), reason: z.string().optional(),
}).strict();
export const STATE_EVENTS = ["robot_en_route", "arrived", "arrived_pickup", "arrived_delivery", "completed_leg", "navigation_failed", "cancelled", "safety_stopped", "expired"] as const;
export const StateEventSchema = z.object({
  type: z.literal("state_event"), correlationId: Corr, at: Iso, event: z.enum(STATE_EVENTS),
  detail: z.record(z.unknown()).optional(),
}).strict();
export const GatewayUpSchema = z.discriminatedUnion("type", [HeartbeatSchema, AckSchema, StateEventSchema]);

export type Intent = z.infer<typeof IntentSchema>;
export type GatewayDown = z.infer<typeof GatewayDownSchema>;
export type GatewayUp = z.infer<typeof GatewayUpSchema>;
export type Heartbeat = z.infer<typeof HeartbeatSchema>;
export type Ack = z.infer<typeof AckSchema>;
export type StateEvent = z.infer<typeof StateEventSchema>;
export type Location = z.infer<typeof LocationSchema>;
