import { eq } from "drizzle-orm";
import {
  REASON_CODE, makeTransitionEvent, transitionTask, transitionVisit,
  type ActorType, type AuditEvent, type TaskState, type VisitState,
} from "@oncare/core";
import type { Db } from "../db/client";
import * as t from "../db/schema";

export class TransitionError extends Error {
  readonly status = 409;
  constructor(public readonly reason: string) { super(reason); }
}

export interface TransitionInput {
  entityType: "visit" | "task";
  entityId: string;
  to: string;
  actorType: ActorType;
  actorId: string;
  reason?: string;
}

export type Listener = (ev: AuditEvent) => void;

export interface CreateTransitionServiceOptions {
  now?: () => Date;
  /** Called when a subscribed listener throws. Default: logs event/entity ids only, never event contents. */
  onListenerError?: (err: unknown, ev: AuditEvent) => void;
}

export function createTransitionService(db: Db, opts: CreateTransitionServiceOptions = {}) {
  const now = opts.now ?? (() => new Date());
  const onListenerError = opts.onListenerError ?? ((err: unknown, ev: AuditEvent) => {
    console.error(`[transitions] listener error for event ${ev.id} (entity ${ev.entityId})`, err);
  });
  const listeners = new Set<Listener>();

  function load(input: TransitionInput): { from: string; correlationId: string } {
    if (input.entityType === "visit") {
      const row = db.select().from(t.visitSession).where(eq(t.visitSession.id, input.entityId)).get();
      if (!row) throw new TransitionError(`visit "${input.entityId}" not found`);
      return { from: row.state, correlationId: row.id };
    }
    const row = db.select().from(t.taskRequest).where(eq(t.taskRequest.id, input.entityId)).get();
    if (!row) throw new TransitionError(`task "${input.entityId}" not found`);
    return { from: row.state, correlationId: row.correlationId };
  }

  function writeAudit(ev: AuditEvent) {
    db.insert(t.auditEvent).values(ev).run();
  }

  function apply(input: TransitionInput): AuditEvent {
    if (input.reason !== undefined && !REASON_CODE.test(input.reason)) {
      throw new TypeError("reason must be a fixed snake_case code");
    }
    const { from, correlationId } = load(input);
    const result = input.entityType === "visit"
      ? transitionVisit(from as VisitState, input.to as VisitState)
      : transitionTask(from as TaskState, input.to as TaskState);

    const base = { actorType: input.actorType, actorId: input.actorId, entityType: input.entityType, entityId: input.entityId, fromState: from, toState: input.to, correlationId, now } as const;

    if (!result.ok) {
      writeAudit(makeTransitionEvent({ ...base, reason: "rejected_transition" }));
      throw new TransitionError(result.error);
    }

    const ev = makeTransitionEvent({ ...base, ...(input.reason !== undefined ? { reason: input.reason } : {}) });
    db.transaction((tx) => {
      if (input.entityType === "visit") tx.update(t.visitSession).set({ state: input.to }).where(eq(t.visitSession.id, input.entityId)).run();
      else tx.update(t.taskRequest).set({ state: input.to }).where(eq(t.taskRequest.id, input.entityId)).run();
      tx.insert(t.auditEvent).values(ev).run();
    });
    for (const l of listeners) {
      try { l(ev); } catch (err) { onListenerError(err, ev); }
    }
    return ev;
  }

  function subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  return { apply, subscribe };
}
