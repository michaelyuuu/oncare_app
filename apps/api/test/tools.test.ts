import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { makeTestApp } from "./helpers";
import * as t from "../src/db/schema";
import { SEED_IDS } from "../src/db/seed";
import { BUILTIN_TOOLS } from "../src/tools/builtin";
import { defineTool, ToolForbidden } from "../src/tools/registry";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

function writeTools(calls: string[]) {
  return [
    ...BUILTIN_TOOLS,
    defineTool({
      name: "test_write", description: "Records a note for a resident.", roles: ["family"], effect: "write",
      input: z.object({ residentId: z.string(), note: z.string() }).strict(),
      summarize: (ctx, input) => {
        if (!ctx.access.canAccessResident(ctx.principal, input.residentId)) throw new ToolForbidden();
        return `Send "${input.note}"?`;
      },
      run: (ctx, input) => {
        if (!ctx.access.canAccessResident(ctx.principal, input.residentId)) throw new ToolForbidden();
        calls.push(input.note);
        return { sent: true };
      },
    }),
    defineTool({
      name: "test_urgent", description: "Runs without confirmation.", roles: ["device"], effect: "write", confirm: false,
      input: z.object({}).strict(),
      run: () => { calls.push("urgent"); return { sent: true }; },
    }),
  ];
}

async function setup(now?: () => Date) {
  const calls: string[] = [];
  const ctx = await makeTestApp({ tools: writeTools(calls), ...(now ? { now } : {}) });
  const invoke = (token: string, name: string, payload: unknown = {}) =>
    ctx.app.inject({ method: "POST", url: `/tools/${name}/invoke`, headers: auth(token), payload: payload as object });
  const post = (token: string, url: string) => ctx.app.inject({ method: "POST", url, headers: auth(token) });
  return { ...ctx, calls, invoke, post };
}

describe("tool registry", () => {
  test("listing is filtered by role and carries JSON Schemas", async () => {
    const { app, tokens } = await setup();
    const names = async (token: string) => (await app.inject({ method: "GET", url: "/tools", headers: auth(token) })).json().tools.map((x: { name: string }) => x.name).sort();
    expect(await names(tokens.family)).toEqual(["get_resident_status", "list_my_residents_or_contacts", "test_write"]);
    expect(await names(tokens.device)).toEqual([
      "get_approved_contacts", "get_my_request_status", "get_resident_status", "get_service_status", "get_visit_schedule",
      "get_visit_slots", "list_my_residents_or_contacts", "propose_visit_time", "request_staff_help", "request_withdrawal", "test_urgent",
    ]);
    const tool = (await app.inject({ method: "GET", url: "/tools", headers: auth(tokens.family) })).json().tools.find((x: { name: string }) => x.name === "test_write");
    expect(tool).toMatchObject({ effect: "write", confirm: true, inputSchema: { type: "object", properties: { residentId: { type: "string" }, note: { type: "string" } } } });
  });

  test("read tools run directly and respect resident scope", async () => {
    const { tokens, invoke } = await setup();
    expect((await invoke(tokens.device, "list_my_residents_or_contacts")).json().result).toEqual({
      contacts: [{ userId: SEED_IDS.familyUser, displayName: "Demo Daughter", label: "daughter", canVideoCall: true }],
    });
    expect((await invoke(tokens.staff, "list_my_residents_or_contacts")).json().result.residents).toEqual([
      { id: SEED_IDS.resident, displayName: "Demo Resident", availability: "available", room: "Demo room" },
    ]);
    expect((await invoke(tokens.device, "get_resident_status")).json().result.resident.id).toBe(SEED_IDS.resident);
    expect((await invoke(tokens.family, "get_resident_status", { residentId: "someone_else" })).statusCode).toBe(403);
    expect((await invoke(tokens.family, "get_resident_status")).json()).toMatchObject({ error: "bad_input" });
  });

  test("resident communication tools create, read, and withdraw a scoped request", async () => {
    const { app, db, tokens, invoke } = await setup();
    const help = await invoke(tokens.device, "request_staff_help", { category: "general_assistance", note: "Please help me." });
    expect(help.statusCode).toBe(200);
    const requestId = help.json().result.requestId as string;
    expect(db.select().from(t.assistanceRequest).all()).toHaveLength(1);
    expect(help.json().result).toMatchObject({ requestId, request: { id: requestId, persistenceState: "recorded", deliveryState: "pending", handlingState: "open" } });

    const status = await invoke(tokens.device, "get_my_request_status", { requestId });
    expect(status.statusCode).toBe(200);
    expect(status.json().result.request).toMatchObject({ id: requestId, version: 1, handlingState: "open" });

    const withdrawal = await invoke(tokens.device, "request_withdrawal", { requestId });
    expect(withdrawal.statusCode).toBe(200);
    expect(withdrawal.json().result.request).toMatchObject({ id: requestId, withdrawalState: "requested", handlingState: "open" });
  });

  test("communication tools reject a request owned by another device", async () => {
    const { app, tokens, invoke } = await setup();
    const help = await invoke(tokens.device, "request_staff_help", { category: "other" });
    const requestId = help.json().result.requestId as string;
    const foreign = { kind: "device" as const, id: "other_device", residentId: SEED_IDS.resident, facilityId: SEED_IDS.facility, robotId: null, assignmentVersion: 1 };
    expect(await app.tools.invoke(foreign, "get_my_request_status", { requestId })).toMatchObject({ ok: false, status: 403, error: "forbidden" });
    expect(await app.tools.invoke(foreign, "request_withdrawal", { requestId })).toMatchObject({ ok: false, status: 403, error: "forbidden" });
  });

  test("device scheduling tools return reservation evidence and insert only after confirmation", async () => {
    const { db, tokens, invoke, post } = await setup(() => new Date("2026-09-21T00:00:00.000Z"));

    const slots = await invoke(tokens.device, "get_visit_slots", { from: "2026-09-22" });
    expect(slots.statusCode).toBe(200);
    expect(slots.json().result).toMatchObject({
      timeZone: "Asia/Taipei",
      slots: expect.arrayContaining([
        expect.objectContaining({ localDate: "2026-09-22", startMinute: 540, endMinute: 600, state: "available" }),
      ]),
    });
    expect((await invoke(tokens.device, "get_visit_schedule")).json().result).toEqual({ reservations: [] });

    const proposed = await invoke(tokens.device, "propose_visit_time", {
      contactUserId: SEED_IDS.familyUser,
      localDate: "2026-09-22",
      startMinute: 540,
    });
    expect(proposed.statusCode).toBe(200);
    expect(proposed.json()).toMatchObject({
      needsConfirmation: true,
      actionId: expect.any(String),
      expiresAt: expect.any(String),
      summary: expect.stringMatching(/Demo Daughter.*9:00 AM.*one-hour ON 0 visit/i),
    });
    expect(db.select().from(t.visitReservation).all()).toEqual([]);

    const confirmed = await post(tokens.device, `/tools/actions/${proposed.json().actionId}/confirm`);
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({
      result: {
        reservation: {
          residentId: SEED_IDS.resident,
          familyUserId: SEED_IDS.familyUser,
          status: "pending",
          startAt: "2026-09-22T01:00:00.000Z",
          endAt: "2026-09-22T02:00:00.000Z",
        },
      },
    });
    expect(db.select().from(t.visitReservation).all()).toHaveLength(1);
    expect((await invoke(tokens.device, "get_visit_schedule")).json().result).toMatchObject({
      reservations: [expect.objectContaining({ familyDisplayName: "Demo Daughter", status: "pending" })],
    });
  });

  test("cancelling a scheduling action leaves reservations empty and scheduling tools are device-only", async () => {
    const { db, tokens, invoke, post } = await setup(() => new Date("2026-09-21T00:00:00.000Z"));
    const proposed = await invoke(tokens.device, "propose_visit_time", {
      contactUserId: SEED_IDS.familyUser,
      localDate: "2026-09-22",
      startMinute: 600,
    });
    expect((await post(tokens.device, `/tools/actions/${proposed.json().actionId}/cancel`)).statusCode).toBe(200);
    expect(db.select().from(t.visitReservation).all()).toEqual([]);
    expect((await invoke(tokens.family, "get_visit_schedule")).statusCode).toBe(404);
    expect((await invoke(tokens.family, "get_visit_slots", { from: "2026-09-22" })).statusCode).toBe(404);
    expect((await invoke(tokens.family, "propose_visit_time", {
      contactUserId: SEED_IDS.familyUser,
      localDate: "2026-09-22",
      startMinute: 600,
    })).statusCode).toBe(404);
  });

  test("scheduling rejects an impossible localDate as controlled bad input", async () => {
    const { db, tokens, invoke } = await setup(() => new Date("2026-09-21T00:00:00.000Z"));
    const response = await invoke(tokens.device, "propose_visit_time", {
      contactUserId: SEED_IDS.familyUser,
      localDate: "2026-13-01",
      startMinute: 540,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "bad_input", detail: expect.stringContaining("localDate") });
    expect(db.select().from(t.pendingAction).all()).toEqual([]);
    expect(db.select().from(t.visitReservation).all()).toEqual([]);
  });

  test("unknown tools, tools of another role and bad input are rejected", async () => {
    const { tokens, invoke } = await setup();
    expect((await invoke(tokens.family, "nope")).statusCode).toBe(404);
    expect((await invoke(tokens.staff, "test_write", { residentId: SEED_IDS.resident, note: "x" })).statusCode).toBe(404);
    const bad = await invoke(tokens.family, "test_write", { residentId: 5 });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "bad_input", detail: expect.stringContaining("residentId") });
  });

  test("a write needs confirmation by the same principal, once", async () => {
    const { tokens, invoke, post, calls } = await setup();
    const proposed = await invoke(tokens.family, "test_write", { residentId: SEED_IDS.resident, note: "hello" });
    expect(proposed.json()).toMatchObject({ needsConfirmation: true, summary: 'Send "hello"?', actionId: expect.any(String) });
    expect(calls).toEqual([]);
    const id = proposed.json().actionId as string;
    expect((await post(tokens.staff, `/tools/actions/${id}/confirm`)).statusCode).toBe(403);
    const confirmed = await post(tokens.family, `/tools/actions/${id}/confirm`);
    expect(confirmed.json()).toMatchObject({ result: { sent: true } });
    expect(calls).toEqual(["hello"]);
    expect((await post(tokens.family, `/tools/actions/${id}/confirm`)).statusCode).toBe(409);
    expect((await post(tokens.family, "/tools/actions/missing/confirm")).statusCode).toBe(404);
  });

  test("an expired proposal cannot be confirmed", async () => {
    let clock = new Date("2030-01-01T00:00:00Z");
    const { tokens, invoke, post, calls } = await setup(() => clock);
    const id = (await invoke(tokens.family, "test_write", { residentId: SEED_IDS.resident, note: "late" })).json().actionId;
    clock = new Date("2030-01-01T00:02:00.001Z");
    expect((await post(tokens.family, `/tools/actions/${id}/confirm`)).statusCode).toBe(410);
    expect(calls).toEqual([]);
  });

  test("access revoked between proposal and confirmation blocks the write", async () => {
    const { db, tokens, invoke, post, calls } = await setup();
    const id = (await invoke(tokens.family, "test_write", { residentId: SEED_IDS.resident, note: "x" })).json().actionId;
    db.delete(t.familyRelationship).run();
    expect((await post(tokens.family, `/tools/actions/${id}/confirm`)).statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  test("a role no longer allowed at confirm time cancels the proposal and audits tool_denied", async () => {
    const { db, tokens, invoke, post, calls } = await setup();
    const id = (await invoke(tokens.family, "test_write", { residentId: SEED_IDS.resident, note: "x" })).json().actionId;
    db.update(t.user).set({ role: "staff", facilityId: SEED_IDS.facility }).where(eq(t.user.id, SEED_IDS.familyUser)).run();
    expect((await post(tokens.family, `/tools/actions/${id}/confirm`)).statusCode).toBe(403);
    expect(calls).toEqual([]);
    expect(db.select().from(t.pendingAction).where(eq(t.pendingAction.id, id)).get()).toMatchObject({ status: "cancelled" });
    const denied = db.select().from(t.auditEvent).where(eq(t.auditEvent.reason, "tool_denied")).all();
    expect(denied).toEqual([expect.objectContaining({ actorType: "ai", actorId: SEED_IDS.familyUser, entityType: "tool", entityId: id })]);
  });

  test("stored input failing re-parse at confirm time cancels the proposal and audits tool_cancelled", async () => {
    const { app, db } = await setup();
    const principal = { kind: "user" as const, id: SEED_IDS.familyUser, role: "family" as const, facilityId: null };
    const actionId = "act_bad_stored_input";
    // Missing "note" — the stored input no longer satisfies test_write's schema.
    db.insert(t.pendingAction).values({
      id: actionId, principalKind: "user", principalId: SEED_IDS.familyUser, tool: "test_write",
      input: { residentId: SEED_IDS.resident }, summary: "Send?",
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), status: "pending",
    }).run();
    const outcome = await app.tools.confirm(principal, actionId);
    expect(outcome).toMatchObject({ ok: false, status: 400, error: "bad_input" });
    expect(db.select().from(t.pendingAction).where(eq(t.pendingAction.id, actionId)).get()).toMatchObject({ status: "cancelled" });
    const cancelled = db.select().from(t.auditEvent).where(eq(t.auditEvent.reason, "tool_cancelled")).all();
    expect(cancelled).toEqual([expect.objectContaining({ actorType: "ai", actorId: SEED_IDS.familyUser, entityType: "tool", entityId: actionId })]);
  });

  test("cancel, confirm:false writes, and the audit trail", async () => {
    const { db, tokens, invoke, post, calls } = await setup();
    const id = (await invoke(tokens.family, "test_write", { residentId: SEED_IDS.resident, note: "never" })).json().actionId;
    expect((await post(tokens.family, `/tools/actions/${id}/cancel`)).statusCode).toBe(200);
    expect((await post(tokens.family, `/tools/actions/${id}/confirm`)).statusCode).toBe(409);
    expect((await invoke(tokens.device, "test_urgent")).json()).toMatchObject({ result: { sent: true } });
    expect(calls).toEqual(["urgent"]);
    const rows = db.select().from(t.auditEvent).where(eq(t.auditEvent.actorType, "ai")).all();
    expect(rows.map((r) => r.reason)).toEqual(["tool_proposed", "tool_cancelled", "tool_invoked"]);
    expect(rows.every((r) => r.entityType === "tool")).toBe(true);
    expect(rows[2]).toMatchObject({ actorId: SEED_IDS.device, entityId: "test_urgent", correlationId: SEED_IDS.facility });
  });

  test("a confirm-by-default write without a summarize function is a programming error", () => {
    expect(() => defineTool({ name: "x", description: "x", roles: ["family"], effect: "write", input: z.object({}), run: () => null })).toThrow();
  });
});
