import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp } from "./helpers";
import * as t from "../src/db/schema";
import { SEED_IDS } from "../src/db/seed";
import {
  FakeVoiceAdapter,
  OpenAIRealtimeProvider,
  RealtimeProviderError,
  REALTIME_TOOL_DEFINITIONS,
} from "../src/services/voice";

const auth = (token: string) => ({ authorization: "Bearer " + token });

describe("resident assistant voice adapters", () => {
  test("fake adapter recognizes the allowlisted communication intents and bounded clarification", () => {
    const adapter = new FakeVoiceAdapter();
    expect(adapter.interpret("please get staff help", null)).toMatchObject({ name: "request_staff_help" });
    expect(adapter.interpret("who are my approved family contacts", null)).toMatchObject({ name: "get_approved_contacts" });
    expect(adapter.interpret("what is the service status", null)).toMatchObject({ name: "get_service_status" });
    expect(adapter.interpret("what is the status", "help_" + "a".repeat(32))).toMatchObject({ name: "get_my_request_status" });
    expect(adapter.interpret("withdraw my request", "help_" + "a".repeat(32))).toMatchObject({ name: "request_withdrawal" });
    expect(adapter.interpret("something else", null)).toBeNull();
  });

  test("fake session routes authoritative tool results and supports interrupt/close", async () => {
    const { app, tokens, db } = await makeTestApp();
    const started = await app.inject({ method: "POST", url: "/assistant/sessions", headers: auth(tokens.device), payload: {} });
    expect(started.statusCode).toBe(201);
    const sessionId = started.json().session.sessionId as string;
    expect(started.json().session).toMatchObject({ state: "listening", mode: "simulated", provider: "fake" });

    const help = await app.inject({
      method: "POST", url: "/assistant/sessions/" + sessionId + "/input", headers: auth(tokens.device),
      payload: { text: "please get staff help" },
    });
    expect(help.statusCode).toBe(200);
    expect(help.json()).toMatchObject({ result: { kind: "tool_result", tool: "request_staff_help", status: 200 } });
    expect(db.select().from(t.assistanceRequest).all()).toHaveLength(1);
    const requestId = help.json().result.response.result.requestId as string;

    const status = await app.inject({
      method: "POST", url: "/assistant/sessions/" + sessionId + "/input", headers: auth(tokens.device),
      payload: { text: "what is the status" },
    });
    expect(status.json()).toMatchObject({ result: { tool: "get_my_request_status", status: 200 } });
    expect(status.json().result.response.result.request.id).toBe(requestId);

    const unclear1 = await app.inject({
      method: "POST", url: "/assistant/sessions/" + sessionId + "/input", headers: auth(tokens.device),
      payload: { text: "I am not sure" },
    });
    const unclear2 = await app.inject({
      method: "POST", url: "/assistant/sessions/" + sessionId + "/input", headers: auth(tokens.device),
      payload: { text: "still not sure" },
    });
    expect(unclear1.json()).toMatchObject({ result: { kind: "clarification", action: "ask_one_question" } });
    expect(unclear2.json()).toMatchObject({ result: { kind: "clarification", action: "offer_choices" } });

    expect((await app.inject({ method: "POST", url: "/assistant/sessions/" + sessionId + "/interrupt", headers: auth(tokens.device), payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/assistant/sessions/" + sessionId + "/close", headers: auth(tokens.device), payload: {} })).json().session.state).toBe("closed");
  });

  test("assignment revocation invalidates a previously opened assistant session", async () => {
    const { app, tokens, db } = await makeTestApp();
    const started = await app.inject({ method: "POST", url: "/assistant/sessions", headers: auth(tokens.device), payload: {} });
    const sessionId = started.json().session.sessionId as string;
    db.update(t.device).set({ assignmentVersion: 2 }).where(eq(t.device.id, SEED_IDS.device)).run();
    const input = await app.inject({
      method: "POST", url: "/assistant/sessions/" + sessionId + "/input", headers: auth(tokens.device),
      payload: { text: "please get staff help" },
    });
    expect(input.statusCode).toBe(401);
  });

  test("Realtime provider sends server-owned configuration and only the five tools", async () => {
    const requests: Array<{ headers: Record<string, string>; body: string }> = [];
    const provider = new OpenAIRealtimeProvider({
      apiKey: "server-secret",
      request: async (request) => {
        requests.push({ headers: request.headers, body: request.body });
        return { status: 200, body: "v=0\\r\\no=- 1 1 IN IP4 127.0.0.1\\r\\n" };
      },
    });
    const answer = await provider.createCall("v=0\r\n", { instructions: "test" });
    const captured = requests[0]!;
    expect(answer).toContain("v=0");
    expect(captured.headers.Authorization).toBe("Bearer server-secret");
    expect(captured.body).toContain("name=\"sdp\"");
    expect(captured.body).toContain("name=\"session\"");
    expect(captured.body).toContain("\"instructions\":\"test\"");
    expect(JSON.parse(captured.body.match(/\r\n\r\n({.*})\r\n--/s)![1]!).tools.map((tool: { name: string }) => tool.name))
      .toEqual(REALTIME_TOOL_DEFINITIONS.map((tool) => tool.name));
    expect(answer).not.toContain("server-secret");
  });

  test("Realtime provider classifies unavailable, quota, timeout, and malformed SDP", async () => {
    await expect(new OpenAIRealtimeProvider({ apiKey: "" }).createCall("v=0")).rejects.toMatchObject({ code: "provider_unavailable" });
    await expect(new OpenAIRealtimeProvider({
      apiKey: "x",
      request: async () => ({ status: 429, body: '{"error":{"code":"insufficient_quota"}}' }),
    }).createCall("v=0")).rejects.toMatchObject({ code: "quota_exhausted" });
    await expect(new OpenAIRealtimeProvider({
      apiKey: "x",
      request: async () => { throw new Error("timeout"); },
    }).createCall("v=0")).rejects.toMatchObject({ code: "provider_timeout" });
    await expect(new OpenAIRealtimeProvider({
      apiKey: "x",
      request: async () => ({ status: 200, body: "not-sdp" }),
    }).createCall("v=0")).rejects.toBeInstanceOf(RealtimeProviderError);
  });
});
