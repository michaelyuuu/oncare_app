import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { buildApp } from "../src/app";
import { openDb } from "../src/db/client";
import { SEED_IDS, SEED_SECRETS, seed } from "../src/db/seed";
import * as t from "../src/db/schema";
import { FakeVideoProvider } from "../src/services/video";

type ProviderRequest = {
  model: string;
  input: unknown;
  tools: Array<{ type: "function"; name: string; strict: true; parameters: Record<string, unknown> }>;
  previous_response_id?: string;
};

type ProviderResponse = {
  id: string;
  output_text: string;
  output: Array<{
    type: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  }>;
};

class FakeManagerClient {
  readonly requests: ProviderRequest[] = [];
  readonly responses = {
    create: async (request: ProviderRequest): Promise<ProviderResponse> => {
      this.requests.push(request);
      const next = this.queue.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error("unexpected_provider_turn");
      return next;
    },
  };

  constructor(private readonly queue: Array<ProviderResponse | Error>) {}
}

const finalResponse = (answer = "Laundry data is unavailable until the first station sync."): ProviderResponse => ({
  id: "resp_final",
  output_text: answer,
  output: [{ type: "message" }],
});

const toolResponse = (name: string, callId: string, args: Record<string, unknown>): ProviderResponse => ({
  id: `resp_${callId}`,
  output_text: "",
  output: [{ type: "function_call", call_id: callId, name, arguments: JSON.stringify(args) }],
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function setup(opts: { client?: FakeManagerClient; apiKey?: string; model?: string } = {}) {
  const db = openDb(":memory:");
  await seed(db);
  const app = buildApp({
    db,
    jwtSecret: "test-secret",
    video: new FakeVideoProvider(),
    managerApiKey: opts.apiKey ?? "",
    ...(opts.client ? { managerAssistantClient: opts.client } : {}),
    ...(opts.model ? { managerModel: opts.model } : {}),
  });
  await app.ready();
  const login = async (username: string, password: string) =>
    (await app.inject({ method: "POST", url: "/auth/login", payload: { username, password } })).json().token as string;
  return {
    app,
    db,
    tokens: {
      admin: await login("admin", SEED_SECRETS.adminPassword),
      staff: await login("staff", SEED_SECRETS.staffPassword),
    },
  };
}

describe("manager laundry assistant", () => {
  test("returns assistant_unavailable when no server API key or injected client exists", async () => {
    const { app, tokens } = await setup();

    const response = await app.inject({
      method: "POST",
      url: "/admin/laundry/ask",
      headers: auth(tokens.admin),
      payload: { question: "How many garments are active?" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "assistant_unavailable" });
    await app.close();
  });

  test("allows only a resolved admin principal", async () => {
    const client = new FakeManagerClient([finalResponse()]);
    const { app, tokens } = await setup({ client });

    const response = await app.inject({
      method: "POST",
      url: "/admin/laundry/ask",
      headers: auth(tokens.staff),
      payload: { question: "Show facility laundry." },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "forbidden" });
    expect(client.requests).toHaveLength(0);
    await app.close();
  });

  test("requires a strict question with trimmed length from 1 through 500", async () => {
    const client = new FakeManagerClient([finalResponse("Accepted")]);
    const { app, tokens } = await setup({ client });

    for (const payload of [
      {},
      { question: "" },
      { question: "   " },
      { question: "x".repeat(501) },
      { question: "valid", model: "gpt-unsafe" },
      { question: "valid", apiKey: "browser-secret" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/admin/laundry/ask",
        headers: auth(tokens.admin),
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "bad_input" });
    }

    const accepted = await app.inject({
      method: "POST",
      url: "/admin/laundry/ask",
      headers: auth(tokens.admin),
      payload: { question: `  ${"x".repeat(500)}  ` },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ answer: "Accepted", toolResults: [] });
    await app.close();
  });

  test("exposes only strict laundry tools and returns structured registry results", async () => {
    const client = new FakeManagerClient([
      toolResponse("get_laundry_overview", "call_overview", { residentId: null }),
      finalResponse(),
    ]);
    const { app, db, tokens } = await setup({ client });

    const response = await app.inject({
      method: "POST",
      url: "/admin/laundry/ask",
      headers: auth(tokens.admin),
      payload: { question: "How many garments are active?" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      answer: "Laundry data is unavailable until the first station sync.",
      toolResults: [{
        name: "get_laundry_overview",
        result: {
          ok: true,
          result: {
            availability: "never_synced",
            total: 0,
            active: 0,
            lostOrDiscarded: 0,
            recentlyWashed: 0,
            syncedAt: null,
            stale: false,
            warnings: [],
          },
        },
      }],
    });
    expect(client.requests).toHaveLength(2);
    expect(client.requests[0]!.model).toBe("gpt-5.4");
    expect(client.requests[0]!.tools.map((tool) => tool.name)).toEqual(["get_laundry_overview", "find_garments"]);
    for (const tool of client.requests[0]!.tools) {
      expect(tool.strict).toBe(true);
      expect(tool.parameters.additionalProperties).toBe(false);
      expect(tool.parameters.required).toEqual(Object.keys(tool.parameters.properties as object));
    }
    expect(client.requests[1]).toMatchObject({
      model: "gpt-5.4",
      previous_response_id: "resp_call_overview",
      input: [{
        type: "function_call_output",
        call_id: "call_overview",
        output: JSON.stringify({
          ok: true,
          result: {
            availability: "never_synced",
            total: 0,
            active: 0,
            lostOrDiscarded: 0,
            recentlyWashed: 0,
            syncedAt: null,
            stale: false,
            warnings: [],
          },
        }),
      }],
    });
    expect(db.select().from(t.auditEvent).where(eq(t.auditEvent.actorType, "ai")).all()).toEqual([
      expect.objectContaining({
        actorId: SEED_IDS.adminUser,
        entityId: "get_laundry_overview",
        reason: "tool_invoked",
        correlationId: SEED_IDS.facility,
      }),
    ]);
    await app.close();
  });

  test.each(["request_staff_help", "unknown_tool"])("fails closed before invoking disallowed tool %s", async (name) => {
    const client = new FakeManagerClient([toolResponse(name, "call_denied", {})]);
    const { app, db, tokens } = await setup({ client });

    const response = await app.inject({
      method: "POST",
      url: "/admin/laundry/ask",
      headers: auth(tokens.admin),
      payload: { question: "Please run an unrelated tool." },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "assistant_unavailable" });
    expect(client.requests).toHaveLength(1);
    expect(db.select().from(t.auditEvent).where(eq(t.auditEvent.actorType, "ai")).all()).toEqual([]);
    expect(db.select().from(t.assistanceRequest).all()).toEqual([]);
    await app.close();
  });

  test("rejects a mixed tool-call batch before invoking any registry tool", async () => {
    const mixed = toolResponse("get_laundry_overview", "call_allowed", { residentId: null });
    mixed.output.push({
      type: "function_call",
      call_id: "call_denied",
      name: "request_staff_help",
      arguments: "{}",
    });
    const client = new FakeManagerClient([mixed]);
    const { app, db, tokens } = await setup({ client });

    const response = await app.inject({
      method: "POST",
      url: "/admin/laundry/ask",
      headers: auth(tokens.admin),
      payload: { question: "Run this mixed batch." },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "assistant_unavailable" });
    expect(db.select().from(t.auditEvent).where(eq(t.auditEvent.actorType, "ai")).all()).toEqual([]);
    await app.close();
  });

  test("stops after four provider responses without returning an unfinished answer", async () => {
    const client = new FakeManagerClient(Array.from({ length: 5 }, (_, index) =>
      toolResponse("get_laundry_overview", `call_${index + 1}`, { residentId: null })));
    const { app, tokens } = await setup({ client });

    const response = await app.inject({
      method: "POST",
      url: "/admin/laundry/ask",
      headers: auth(tokens.admin),
      payload: { question: "Keep checking forever." },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "assistant_unavailable" });
    expect(client.requests).toHaveLength(4);
    await app.close();
  });

  test("maps provider failures to assistant_unavailable without exposing details", async () => {
    const client = new FakeManagerClient([new Error("provider leaked detail")]);
    const { app, tokens } = await setup({ client });

    const response = await app.inject({
      method: "POST",
      url: "/admin/laundry/ask",
      headers: auth(tokens.admin),
      payload: { question: "Find blue garments." },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "assistant_unavailable" });
    expect(response.body).not.toContain("provider leaked detail");
    await app.close();
  });

  test("uses only the server-supplied model override", async () => {
    const client = new FakeManagerClient([finalResponse("Configured")]);
    const { app, tokens } = await setup({ client, model: "server-approved-model" });

    const response = await app.inject({
      method: "POST",
      url: "/admin/laundry/ask",
      headers: auth(tokens.admin),
      payload: { question: "Give me an overview." },
    });

    expect(response.statusCode).toBe(200);
    expect(client.requests[0]!.model).toBe("server-approved-model");
    await app.close();
  });
});
