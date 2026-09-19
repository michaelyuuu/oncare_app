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
    expect(await names(tokens.device)).toEqual(["get_resident_status", "list_my_residents_or_contacts", "test_urgent"]);
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
