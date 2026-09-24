import { randomUUID } from "node:crypto";
import { z } from "zod";

export const ACTOR_TYPES = ["family", "staff", "admin", "device", "robot", "system", "ai"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/** Audit reasons are fixed snake_case codes, never free text. */
export const REASON_CODE = /^[a-z][a-z0-9_]*$/;

export const ENTITY_TYPES = ["visit", "task", "assistance_request", "robot", "command", "resident", "user", "device", "family_link", "staff_assignment", "tool"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const AuditEventSchema = z
  .object({
    id: z.string().min(1),
    at: z.string().datetime(),
    actorType: z.enum(ACTOR_TYPES),
    actorId: z.string().min(1),
    entityType: z.enum(ENTITY_TYPES),
    entityId: z.string().min(1),
    fromState: z.string().nullable(),
    toState: z.string().nullable(),
    reason: z.string().regex(REASON_CODE).nullable(),
    correlationId: z.string().min(1),
  })
  .strict();

export type AuditEvent = z.infer<typeof AuditEventSchema>;

export interface TransitionEventInput {
  actorType: ActorType;
  actorId: string;
  entityType: EntityType;
  entityId: string;
  /** null for events that are not a state change (e.g. a robot-entity note). */
  fromState: string | null;
  toState: string | null;
  reason?: string;
  correlationId: string;
  now?: () => Date;
  id?: () => string;
}

export function makeTransitionEvent(input: TransitionEventInput): AuditEvent {
  const now = input.now ?? (() => new Date());
  const id = input.id ?? (() => `evt_${randomUUID()}`);
  if (input.reason !== undefined && !REASON_CODE.test(input.reason)) {
    throw new TypeError("reason must be a fixed snake_case code");
  }
  return {
    id: id(),
    at: now().toISOString(),
    actorType: input.actorType,
    actorId: input.actorId,
    entityType: input.entityType,
    entityId: input.entityId,
    fromState: input.fromState,
    toState: input.toState,
    reason: input.reason ?? null,
    correlationId: input.correlationId,
  };
}
