import { eq } from "drizzle-orm";
import {
  makeTransitionEvent, transitionTask, transitionVisit,
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

export function createTransitionService(db: Db, opts: { now?: () => Date } = {}) {
  const now = opts.now ?? (() => new Date());
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
    for (const l of listeners) l(ev);
    return ev;
  }

  function subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  return { apply, subscribe };
}
