import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import * as t from "../db/schema";
import type { TransitionService } from "./visits";

export interface VisitMetrics {
  visitId: string; requestedAt: string; incomingShownAt: string | null; answeredAt: string | null;
  connectedAt: string | null; endedAt: string | null; finalState: string; commandAckMs: number | null;
  notifyMs: number | null; residentActions: number;
}
export interface TaskMetrics {
  taskId: string; createdAt: string; confirmedAt: string | null; approvedAt: string | null;
  pickupArrivedAt: string | null; loadedAt: string | null; deliveryArrivedAt: string | null;
  receivedAt: string | null; finalState: string; totalMs: number | null;
}

type Metrics = VisitMetrics | TaskMetrics;

function elapsed(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const value = Date.parse(to) - Date.parse(from);
  return Number.isFinite(value) ? value : null;
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function createBenchmarkService(db: Db, transitions: TransitionService, opts: { now?: () => Date } = {}) {
  const now = opts.now ?? (() => new Date());
  function audit(entityType: string, entityId: string) {
    return db.select().from(t.auditEvent).where(and(eq(t.auditEvent.entityType, entityType), eq(t.auditEvent.entityId, entityId))).all();
  }

  function visit(visitId: string): VisitMetrics | null {
    const row = db.select().from(t.visitSession).where(eq(t.visitSession.id, visitId)).get();
    if (!row) return null;
    const events = audit("visit", visitId);
    const at = (toState: string) => events.find((event) => event.toState === toState)?.at ?? null;
    const incomingShownAt = db.select().from(t.benchmarkTrial)
      .where(and(eq(t.benchmarkTrial.runId, `bench_${visitId}`), eq(t.benchmarkTrial.name, "screen_shown:incoming"))).get()?.at ?? null;
    const command = db.select().from(t.robotCommand).where(eq(t.robotCommand.visitId, visitId)).all()
      .find((candidate) => candidate.ackedAt !== null);
    const commandAckMs = command?.ackedAt ? elapsed(command.issuedAt, command.ackedAt) : null;
    return {
      visitId, requestedAt: row.requestedAt, incomingShownAt, answeredAt: at("connecting"), connectedAt: row.connectedAt ?? at("active"),
      endedAt: row.endedAt ?? at("ending") ?? at("completed"), finalState: row.state,
      commandAckMs, notifyMs: elapsed(row.requestedAt, incomingShownAt), residentActions: events.filter((event) => event.actorType === "device").length,
    };
  }

  function task(taskId: string): TaskMetrics | null {
    const row = db.select().from(t.taskRequest).where(eq(t.taskRequest.id, taskId)).get();
    if (!row) return null;
    const events = audit("task", taskId);
    const at = (toState: string) => events.find((event) => event.toState === toState)?.at ?? null;
    const receivedAt = at("verifying_delivery");
    return {
      taskId, createdAt: row.createdAt, confirmedAt: at("awaiting_policy_or_staff"), approvedAt: at("queued"),
      pickupArrivedAt: at("locating_item"), loadedAt: at("navigating_to_delivery"), deliveryArrivedAt: at("placing"), receivedAt,
      finalState: row.state, totalMs: elapsed(row.createdAt, receivedAt),
    };
  }

  function metrics(kind: "visit" | "task", entityId: string): Metrics | null {
    return kind === "visit" ? visit(entityId) : task(entityId);
  }

  function upsert(kind: "visit" | "task", entityId: string) {
    const computed = metrics(kind, entityId);
    if (!computed) return;
    const startedAt = kind === "visit" ? (computed as VisitMetrics).requestedAt : (computed as TaskMetrics).createdAt;
    const existing = db.select().from(t.benchmarkRun).where(eq(t.benchmarkRun.id, `bench_${entityId}`)).get();
    if (existing) {
      db.update(t.benchmarkRun).set({ kind, entityId, startedAt, metrics: computed }).where(eq(t.benchmarkRun.id, existing.id)).run();
    } else {
      db.insert(t.benchmarkRun).values({ id: `bench_${entityId}`, kind, entityId, startedAt, metrics: computed }).run();
    }
  }

  const unsubscribe = transitions.subscribe((event) => {
    if (event.entityType === "visit" || event.entityType === "task") upsert(event.entityType, event.entityId);
  });

  function recordScreenShown(deviceId: string, screen: string, entityId: string, at: string): boolean {
    const device = db.select().from(t.robotDevice).where(eq(t.robotDevice.id, deviceId)).get();
    if (!device) return false;
    const visitRow = db.select().from(t.visitSession).where(eq(t.visitSession.id, entityId)).get();
    const taskRow = db.select().from(t.taskRequest).where(eq(t.taskRequest.id, entityId)).get();
    const kind = visitRow ? "visit" : taskRow ? "task" : null;
    if (!kind) return false;
    if (kind === "visit" && (screen !== "incoming" || visitRow!.residentId !== device.residentId || visitRow!.robotId !== device.robotId)) return false;
    if (kind === "task" && (screen !== "delivery_arrived" || taskRow!.residentId !== device.residentId)) return false;
    const runId = `bench_${entityId}`;
    upsert(kind, entityId);
    const name = `screen_shown:${screen}`;
    if (db.select().from(t.benchmarkTrial).where(and(eq(t.benchmarkTrial.runId, runId), eq(t.benchmarkTrial.name, name))).get()) return true;
    db.insert(t.benchmarkTrial).values({ id: `trial_${randomUUID()}`, runId, name, value: null, unit: null, at: at || now().toISOString() }).run();
    upsert(kind, entityId);
    return true;
  }

  function toCsv(): string {
    const header = ["kind", "entityId", "finalState", "requestedAt", "incomingShownAt", "answeredAt", "connectedAt", "endedAt", "notifyMs", "commandAckMs", "residentActions", "confirmedAt", "approvedAt", "pickupArrivedAt", "loadedAt", "deliveryArrivedAt", "receivedAt", "totalMs"];
    const rows = db.select().from(t.benchmarkRun).all().map((run) => {
      const value = metrics(run.kind, run.entityId);
      if (!value) return null;
      const visitValue = run.kind === "visit" ? value as VisitMetrics : null;
      const taskValue = run.kind === "task" ? value as TaskMetrics : null;
      return [run.kind, run.entityId, value.finalState, visitValue?.requestedAt ?? taskValue?.createdAt, visitValue?.incomingShownAt,
        visitValue?.answeredAt, visitValue?.connectedAt, visitValue?.endedAt, visitValue?.notifyMs, visitValue?.commandAckMs,
        visitValue?.residentActions, taskValue?.confirmedAt, taskValue?.approvedAt, taskValue?.pickupArrivedAt, taskValue?.loadedAt,
        taskValue?.deliveryArrivedAt, taskValue?.receivedAt, taskValue?.totalMs].map(csvCell).join(",");
    }).filter((row): row is string => row !== null);
    return [header.join(","), ...rows].join("\n") + "\n";
  }

  return { visit, task, recordScreenShown, toCsv, stop() { unsubscribe(); } };
}
