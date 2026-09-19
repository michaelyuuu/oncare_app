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
import { actionRole } from "./access";
import type { TransitionService } from "./visits";
import type { GatewayHub } from "./gateway-hub";
import { TransitionError } from "./transitions";

export type TaskRow = typeof t.taskRequest.$inferSelect;
export type CreateOutcome =
  | { kind: "clarification"; question: string; options: string[] }
  | { kind: "rejected"; task: TaskRow; code: PolicyCode; reason: string }
  | { kind: "proposal"; task: TaskRow };
export type CreateError = "no_relationship" | "consent_missing" | "visit_mismatch";
export type TaskAction = "confirm" | "cancel" | "approve" | "deny" | "loaded" | "received" | "stop";
type ActionRole = "family" | "staff" | "device";

const ACTIONS: Record<TaskAction, { roles: ActionRole[]; from: TaskState[]; to: TaskState[]; reason?: string; approval?: "confirmed" | "approved" | "denied" | "cancelled" }> = {
  confirm: { roles: ["family"], from: ["awaiting_user_confirmation"], to: ["awaiting_policy_or_staff"], approval: "confirmed" },
  cancel: { roles: ["family", "staff"], from: [], to: ["cancelled"], approval: "cancelled" },
  approve: { roles: ["staff"], from: ["awaiting_policy_or_staff"], to: ["queued"], approval: "approved" },
  deny: { roles: ["staff"], from: ["awaiting_policy_or_staff"], to: ["rejected"], reason: "staff_denied", approval: "denied" },
  loaded: { roles: ["staff"], from: ["locating_item"], to: ["grasping", "verifying_grasp", "navigating_to_delivery"], reason: "tray_mode" },
  received: { roles: ["device", "staff"], from: ["placing"], to: ["verifying_delivery"], reason: "tray_mode" },
  stop: { roles: ["staff"], from: ["queued", "navigating_to_pickup", "locating_item", "grasping", "verifying_grasp", "navigating_to_delivery", "placing", "verifying_delivery"], to: ["safety_stopped"], reason: "staff_stop" },
};
export const TASK_ACTIONS = Object.keys(ACTIONS) as TaskAction[];

export interface TaskService {
  create(input: { requesterId: string; residentId: string; text: string; visitId?: string }):
    | { ok: true; outcome: CreateOutcome }
    | { ok: false; error: CreateError };
  get(id: string): TaskRow | undefined;
  canView(principal: Principal, task: TaskRow): boolean;
  act(input: { taskId: string; action: TaskAction; principal: Principal; reason?: string }):
    | { ok: true; task: TaskRow }
    | { ok: false; error: "not_found" | "forbidden" | "illegal_transition"; detail?: string };
}

export function createTaskService(
  db: Db,
  transitions: TransitionService,
  opts: { now?: () => Date; id?: () => string; parser?: IntentParser } = {},
  hub?: GatewayHub,
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

  function act(input: { taskId: string; action: TaskAction; principal: Principal; reason?: string }) {
    const task = get(input.taskId);
    if (!task) return { ok: false as const, error: "not_found" as const };
    const spec = ACTIONS[input.action];
    const role: ActionRole = actionRole(input.principal);
    if (!spec.roles.includes(role) || !canView(input.principal, task)) return { ok: false as const, error: "forbidden" as const };
    if (input.action !== "cancel" && !spec.from.includes(task.state as TaskState)) {
      return { ok: false as const, error: "illegal_transition" as const, detail: `${input.action} is not allowed from ${task.state}` };
    }
    try {
      const approval = spec.approval ? { id: `appr_${randomUUID()}`, taskId: task.id, actorId: input.principal.id, decision: spec.approval, reason: input.reason ?? null, at: now().toISOString() } : undefined;
      for (const [index, to] of spec.to.entries()) transitions.apply({
        entityType: "task", entityId: task.id, to, actorType: input.principal.kind === "device" ? "device" : input.principal.role, actorId: input.principal.id,
        ...(spec.reason ? { reason: spec.reason } : {}),
        ...(index === 0 && approval ? { taskApproval: approval } : {}),
      });
    } catch (error) {
      if (error instanceof TransitionError) return { ok: false as const, error: "illegal_transition" as const, detail: error.reason };
      throw error;
    }
    const command = db.select().from(t.robotCommand).where(eq(t.robotCommand.taskId, task.id)).get();
    if (command) {
      if (input.action === "loaded") hub?.send(command.robotId, { type: "staff_event", correlationId: command.correlationId, event: "staff_loaded" });
      if (input.action === "received") hub?.send(command.robotId, { type: "staff_event", correlationId: command.correlationId, event: "received" });
      if (input.action === "stop") hub?.send(command.robotId, { type: "stop", reason: "staff_stop" });
    }
    return { ok: true as const, task: get(task.id)! };
  }

  return { create, get, canView, act };
}
