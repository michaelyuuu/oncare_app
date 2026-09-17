import { eq } from "drizzle-orm";
import {
  REASON_CODE, TASK_STATES, VISIT_STATES, makeTransitionEvent, transitionTask, transitionVisit,
  type ActorType, type AuditEvent, type TaskState, type VisitState,
} from "@oncare/core";
import type { Db } from "../db/client";
import * as t from "../db/schema";

export class TransitionError extends Error {
  readonly status = 409;
  constructor(public readonly reason: string) { super(reason); }
}

/** Visit columns that may be written in the same transaction as the state. */
export type VisitPatch = Partial<Pick<typeof t.visitSession.$inferSelect, "connectedAt" | "endedAt" | "livekitRoom" | "robotId">>;
/** Task columns that may be written in the same transaction as the state. */
export type TaskPatch = Partial<Pick<typeof t.taskRequest.$inferSelect, "visitId" | "mode">>;

export interface TransitionInput {
  entityType: "visit" | "task";
  entityId: string;
  to: VisitState | TaskState;
  actorType: ActorType;
  actorId: string;
  reason?: string;
  /** Sibling columns written in the SAME transaction as the state change. */
  patch?: VisitPatch | TaskPatch;
}

export type Listener = (ev: AuditEvent) => void;

export interface CreateTransitionServiceOptions {
  now?: () => Date;
  /** Audit event id generator. Default: a random `evt_` id. Override only for tests. */
  id?: () => string;
  /** Called when a subscribed listener throws. Default: logs event/entity ids only, never event contents. */
  onListenerError?: (err: unknown, ev: AuditEvent) => void;
}

export function createTransitionService(db: Db, opts: CreateTransitionServiceOptions = {}) {
  const now = opts.now ?? (() => new Date());
  const id = opts.id;
  const onListenerError = opts.onListenerError ?? ((err: unknown, ev: AuditEvent) => {
    console.error(`[transitions] listener error for event ${ev.id} (entity ${ev.entityId})`, err);
  });
  const listeners = new Set<Listener>();

  function load(input: TransitionInput): { from: string; correlationId: string } {
    if (input.entityType === "visit") {
      const row = db.select().from(t.visitSession).where(eq(t.visitSession.id, input.entityId)).get();
      if (!row) throw new TransitionError(`visit "${input.entityId}" not found`);
      // A stored state outside the machine is corrupt data, not a programming
      // error: report it as a 409 rather than letting the table lookup crash.
      if (!(VISIT_STATES as readonly string[]).includes(row.state)) {
        throw new TransitionError(`visit "${input.entityId}" has an unknown state "${row.state}"`);
      }
      return { from: row.state, correlationId: row.id };
    }
    const row = db.select().from(t.taskRequest).where(eq(t.taskRequest.id, input.entityId)).get();
    if (!row) throw new TransitionError(`task "${input.entityId}" not found`);
    if (!(TASK_STATES as readonly string[]).includes(row.state)) {
      throw new TransitionError(`task "${input.entityId}" has an unknown state "${row.state}"`);
    }
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

    const base = {
      actorType: input.actorType, actorId: input.actorId, entityType: input.entityType, entityId: input.entityId,
      fromState: from, toState: input.to, correlationId, now, ...(id !== undefined ? { id } : {}),
    } as const;

    if (!result.ok) {
      writeAudit(makeTransitionEvent({ ...base, reason: "rejected_transition" }));
      throw new TransitionError(result.error);
    }

    const ev = makeTransitionEvent({ ...base, ...(input.reason !== undefined ? { reason: input.reason } : {}) });
    db.transaction((tx) => {
      if (input.entityType === "visit") {
        const patch = (input.patch ?? {}) as VisitPatch;
        tx.update(t.visitSession).set({ state: input.to, ...patch }).where(eq(t.visitSession.id, input.entityId)).run();
      } else {
        const patch = (input.patch ?? {}) as TaskPatch;
        tx.update(t.taskRequest).set({ state: input.to, ...patch }).where(eq(t.taskRequest.id, input.entityId)).run();
      }
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
