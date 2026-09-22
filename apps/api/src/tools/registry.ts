import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { makeTransitionEvent } from "@oncare/core";
import type { Principal, UserRole } from "../auth/plugin";
import type { Db } from "../db/client";
import * as t from "../db/schema";
import type { Access } from "../services/access";
import { createDirectory, type Directory } from "../services/directory";
import type { AssistanceService } from "../services/assistance";
import type { LaundryRepository } from "../services/laundry-repository";
import type { TransitionService } from "../services/visits";

export const PENDING_ACTION_TTL_MS = 120_000;

export interface ToolContext { principal: Principal; access: Access; directory: Directory; assistance: AssistanceService; laundry: LaundryRepository; now: () => Date }

export interface ToolDef<I extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  /** Shown to the LLM. */
  description: string;
  roles: Array<UserRole | "device">;
  effect: "read" | "write";
  /** Writes only. Default true; false only for the resident's help request. */
  confirm?: boolean;
  readonly input: I;
  /**
   * Human sentence shown before a confirmed write runs. Required when a write needs confirmation.
   * Declared with method-shorthand syntax (not a property function type) so that TS checks its
   * parameter bivariantly: without this, `ToolDef<Specific>` could never widen to `ToolDef` (the
   * default `ToolDef<ZodTypeAny>`), and a heterogeneous `ToolDef[]` registry would be uninhabitable.
   */
  summarize?(ctx: ToolContext, input: z.infer<I>): string;
  run(ctx: ToolContext, input: z.infer<I>): unknown | Promise<unknown>;
}

/** Thrown by a tool when the principal may not touch what it asked for. */
export class ToolForbidden extends Error {}
/** Thrown by a tool when valid-shaped input is still unusable (e.g. a required-for-this-role field is missing). */
export class ToolInputError extends Error {}
/** Thrown by a tool when a requested resource does not exist. */
export class ToolNotFound extends Error {}
/** Thrown by a tool when a current resource state rejects an otherwise valid request. */
export class ToolConflict extends Error {}

export function defineTool<I extends z.ZodTypeAny>(def: ToolDef<I>): ToolDef<I> {
  if (def.effect === "write" && def.confirm !== false && !def.summarize) {
    throw new Error(`tool ${def.name}: a write that needs confirmation must define summarize()`);
  }
  return def;
}

export type ToolResult =
  | { ok: true; result: unknown }
  | { ok: true; needsConfirmation: true; actionId: string; summary: string; expiresAt: string }
  | { ok: false; status: 400 | 403 | 404 | 409 | 410; error: string; detail?: string };

const roleKey = (p: Principal) => (p.kind === "device" ? "device" : p.role);
const needsConfirmation = (def: ToolDef) => def.effect === "write" && def.confirm !== false;

export function createToolRegistry(opts: {
  db: Db; access: Access; transitions: TransitionService; assistance: AssistanceService; laundry: LaundryRepository; tools: ToolDef[]; now?: () => Date; id?: () => string;
}) {
  const { db, access, transitions, assistance, laundry } = opts;
  const now = opts.now ?? (() => new Date());
  const id = opts.id ?? (() => `act_${randomUUID()}`);
  const directory = createDirectory(db);
  const byName = new Map(opts.tools.map((def) => [def.name, def]));
  const ctx = (principal: Principal): ToolContext => ({ principal, access, directory, assistance, laundry, now });
  const allowed = (p: Principal, def: ToolDef | undefined): def is ToolDef => def !== undefined && def.roles.includes(roleKey(p));

  function audit(p: Principal, entityId: string, reason: string) {
    const ev = makeTransitionEvent({
      actorType: "ai", actorId: p.id, entityType: "tool", entityId, fromState: null, toState: null, reason,
      correlationId: p.facilityId ?? p.id, now,
    });
    db.insert(t.auditEvent).values(ev).run();
    transitions.emit(ev);
  }

  function failure(e: unknown, p: Principal, entityId: string): ToolResult {
    if (e instanceof ToolForbidden) { audit(p, entityId, "tool_denied"); return { ok: false, status: 403, error: "forbidden" }; }
    if (e instanceof ToolNotFound) return { ok: false, status: 404, error: "not_found" };
    if (e instanceof ToolConflict) return { ok: false, status: 409, error: "conflict" };
    if (e instanceof ToolInputError) return { ok: false, status: 400, error: "bad_input", detail: e.message };
    throw e;
  }

  function parse(def: ToolDef, input: unknown): { ok: true; data: unknown } | { ok: false; result: ToolResult } {
    const parsed = def.input.safeParse(input ?? {});
    if (parsed.success) return { ok: true, data: parsed.data };
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return { ok: false, result: { ok: false, status: 400, error: "bad_input", detail } };
  }

  async function run(def: ToolDef, p: Principal, input: unknown, entityId: string): Promise<ToolResult> {
    try {
      const result = await def.run(ctx(p), input);
      audit(p, entityId, "tool_invoked");
      return { ok: true, result };
    } catch (e) {
      return failure(e, p, entityId);
    }
  }

  function list(p: Principal) {
    return opts.tools.filter((def) => allowed(p, def)).map((def) => ({
      name: def.name, description: def.description, effect: def.effect, confirm: needsConfirmation(def),
      inputSchema: zodToJsonSchema(def.input, { $refStrategy: "none" }) as object,
    }));
  }

  async function invoke(p: Principal, name: string, rawInput: unknown): Promise<ToolResult> {
    const def = byName.get(name);
    if (!allowed(p, def)) return { ok: false, status: 404, error: "unknown_tool" };
    const parsed = parse(def, rawInput);
    if (!parsed.ok) return parsed.result;
    if (!needsConfirmation(def)) return run(def, p, parsed.data, def.name);

    let summary: string;
    try { summary = def.summarize!(ctx(p), parsed.data); } catch (e) { return failure(e, p, def.name); }
    const actionId = id();
    const createdAt = now();
    const expiresAt = new Date(createdAt.getTime() + PENDING_ACTION_TTL_MS).toISOString();
    db.insert(t.pendingAction).values({
      id: actionId, principalKind: p.kind, principalId: p.id, tool: def.name, input: parsed.data, summary,
      createdAt: createdAt.toISOString(), expiresAt, status: "pending",
    }).run();
    audit(p, actionId, "tool_proposed");
    return { ok: true, needsConfirmation: true, actionId, summary, expiresAt };
  }

  function owned(p: Principal, actionId: string): { ok: true; row: typeof t.pendingAction.$inferSelect } | { ok: false; result: ToolResult } {
    const row = db.select().from(t.pendingAction).where(eq(t.pendingAction.id, actionId)).get();
    if (!row) return { ok: false, result: { ok: false, status: 404, error: "not_found" } };
    if (row.principalKind !== p.kind || row.principalId !== p.id) return { ok: false, result: { ok: false, status: 403, error: "forbidden" } };
    if (row.status !== "pending") return { ok: false, result: { ok: false, status: 409, error: row.status } };
    return { ok: true, row };
  }

  /** Move a pending row to `to` only if it is still pending, so a double confirm can never run twice. */
  function claim(actionId: string, to: "confirmed" | "cancelled" | "expired"): boolean {
    return db.update(t.pendingAction).set({ status: to })
      .where(and(eq(t.pendingAction.id, actionId), eq(t.pendingAction.status, "pending"))).run().changes === 1;
  }

  async function confirm(p: Principal, actionId: string): Promise<ToolResult> {
    const found = owned(p, actionId);
    if (!found.ok) return found.result;
    const { row } = found;
    if (now().getTime() > Date.parse(row.expiresAt)) {
      if (claim(actionId, "expired")) audit(p, actionId, "tool_expired");
      return { ok: false, status: 410, error: "expired" };
    }
    // Authority is re-checked against current data: roles, and the tool's own access checks inside run().
    const def = byName.get(row.tool);
    if (!allowed(p, def)) {
      if (claim(actionId, "cancelled")) audit(p, actionId, "tool_denied");
      return { ok: false, status: 403, error: "forbidden" };
    }
    const parsed = parse(def, row.input);
    if (!parsed.ok) {
      if (claim(actionId, "cancelled")) audit(p, actionId, "tool_cancelled");
      return parsed.result;
    }
    if (!claim(actionId, "confirmed")) return { ok: false, status: 409, error: "not_pending" };
    return run(def, p, parsed.data, actionId);
  }

  function cancel(p: Principal, actionId: string): ToolResult {
    const found = owned(p, actionId);
    if (!found.ok) return found.result;
    if (!claim(actionId, "cancelled")) return { ok: false, status: 409, error: "not_pending" };
    audit(p, actionId, "tool_cancelled");
    return { ok: true, result: { cancelled: true } };
  }

  return { list, invoke, confirm, cancel };
}

export type ToolRegistry = ReturnType<typeof createToolRegistry>;
