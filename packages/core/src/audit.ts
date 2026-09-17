import { randomUUID } from "node:crypto";
import { z } from "zod";

export const ACTOR_TYPES = ["family", "staff", "device", "robot", "system"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const ENTITY_TYPES = ["visit", "task", "robot", "command"] as const;
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
    reason: z.string().nullable(),
    correlationId: z.string().min(1),
  })
  .strict();

export type AuditEvent = z.infer<typeof AuditEventSchema>;

export interface TransitionEventInput {
  actorType: ActorType;
  actorId: string;
  entityType: EntityType;
  entityId: string;
  fromState: string;
  toState: string;
  reason?: string;
  correlationId: string;
  now?: () => Date;
  id?: () => string;
}

export function makeTransitionEvent(input: TransitionEventInput): AuditEvent {
  const now = input.now ?? (() => new Date());
  const id = input.id ?? (() => `evt_${randomUUID()}`);
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
