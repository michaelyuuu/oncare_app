import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  DEMO_CATALOGUE,
  KeywordParser,
  evaluateProposal,
  parseTaskProposal,
  type IntentParser,
  type ItemCatalogue,
  type PolicyCode,
  type TaskState,
} from "@oncare/core";
import type { Principal } from "../auth/plugin";
import type { Db } from "../db/client";
import * as t from "../db/schema";
import type { TransitionService } from "./visits";

export type TaskRow = typeof t.taskRequest.$inferSelect;
export type CreateOutcome =
  | { kind: "clarification"; question: string; options: string[] }
  | { kind: "rejected"; task: TaskRow; code: PolicyCode; reason: string }
  | { kind: "proposal"; task: TaskRow };
export type CreateError = "no_relationship" | "consent_missing" | "visit_mismatch";

export interface TaskService {
  create(input: { requesterId: string; residentId: string; text: string; visitId?: string }):
    | { ok: true; outcome: CreateOutcome }
    | { ok: false; error: CreateError };
  get(id: string): TaskRow | undefined;
  canView(principal: Principal, task: TaskRow): boolean;
}

export function createTaskService(
  db: Db,
  transitions: TransitionService,
  opts: { now?: () => Date; id?: () => string; parser?: IntentParser } = {},
): TaskService {
  const now = opts.now ?? (() => new Date());
  const id = opts.id ?? (() => `task_${randomUUID()}`);
  const parser = opts.parser ?? new KeywordParser();

  function catalogue(): ItemCatalogue {
    const items = db.select().from(t.item).all();
    return {
      approvedItems: items.filter((item) => item.approved).map((item) => item.id),
      prohibitedItems: items.filter((item) => item.prohibited).map((item) => item.id),
      // Ruling: catalogue destinations are approved placement surfaces, not
      // navigation room ids. The demo therefore uses its approved surfaces.
      approvedDestinations: DEMO_CATALOGUE.approvedDestinations,
    };
  }

  function get(taskId: string): TaskRow | undefined {
    return db.select().from(t.taskRequest).where(eq(t.taskRequest.id, taskId)).get();
  }

  function apply(taskId: string, to: TaskState, reason?: string): void {
    transitions.apply({
      entityType: "task",
      entityId: taskId,
      to,
      actorType: "system",
      actorId: "api",
      ...(reason ? { reason } : {}),
    });
  }

  function create(input: { requesterId: string; residentId: string; text: string; visitId?: string }) {
    const relationship = db.select().from(t.familyRelationship).where(and(
      eq(t.familyRelationship.userId, input.requesterId),
      eq(t.familyRelationship.residentId, input.residentId),
    )).get();
    if (!relationship) return { ok: false as const, error: "no_relationship" as const };
    if (!relationship.consentItemDelivery) return { ok: false as const, error: "consent_missing" as const };

    if (input.visitId) {
      const visit = db.select().from(t.visitSession).where(eq(t.visitSession.id, input.visitId)).get();
      if (!visit || visit.requesterId !== input.requesterId || visit.residentId !== input.residentId) {
        return { ok: false as const, error: "visit_mismatch" as const };
      }
    }

    const cat = catalogue();
    const parsed = parser.parse(input.text, {
      recipientId: input.residentId,
      defaultDestinationId: cat.approvedDestinations[0]!.id,
      catalogue: cat,
    });
    if (parsed.kind === "clarification") return { ok: true as const, outcome: parsed };

    // Validate every parser implementation at its boundary, including injected
    // parsers. Invalid structured output is never persisted or audited.
    const validated = parseTaskProposal(parsed.proposal);
    if (!validated.ok) {
      return {
        ok: true as const,
        outcome: {
          kind: "clarification" as const,
          question: "What would you like the robot to bring?",
          options: [...cat.approvedItems],
        },
      };
    }

    const taskId = id();
    const correlationId = taskId.startsWith("task_") ? taskId : `task_${taskId}`;
    db.insert(t.taskRequest).values({
      id: taskId,
      visitId: input.visitId ?? null,
      requesterId: input.requesterId,
      residentId: input.residentId,
      proposal: validated.proposal,
      state: "draft",
      mode: "tray",
      correlationId,
      createdAt: now().toISOString(),
    }).run();
    apply(taskId, "parsed");

    const authorizedRecipients = db.select().from(t.familyRelationship).where(and(
      eq(t.familyRelationship.userId, input.requesterId),
      eq(t.familyRelationship.consentItemDelivery, true),
    )).all().map((row) => row.residentId);
    const verdict = evaluateProposal(validated.proposal, { catalogue: cat, authorizedRecipients });
    if (!verdict.allowed) {
      // Preserve the established task state machine: rejection is reachable
      // only after the confirmation gate, never directly from parsed.
      apply(taskId, "awaiting_user_confirmation");
      apply(taskId, "rejected", verdict.code);
      return {
        ok: true as const,
        outcome: { kind: "rejected" as const, task: get(taskId)!, code: verdict.code, reason: verdict.reason },
      };
    }

    apply(taskId, "awaiting_user_confirmation");
    return { ok: true as const, outcome: { kind: "proposal" as const, task: get(taskId)! } };
  }

  function canView(principal: Principal, task: TaskRow): boolean {
    if (principal.kind === "device") return principal.residentId === task.residentId;
    if (principal.role === "staff") return true;
    return principal.id === task.requesterId;
  }

  return { create, get, canView };
}
