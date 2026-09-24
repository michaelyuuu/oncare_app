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
import { buildAssistantInstructions, loadAssistantProfile } from "../src/services/assistant-profile";

const auth = (token: string) => ({ authorization: "Bearer " + token });

describe("resident assistant voice adapters", () => {
  test("fake adapter recognizes the allowlisted communication intents and bounded clarification", () => {
    const adapter = new FakeVoiceAdapter();
    expect(adapter.interpret("please get staff help", null)).toMatchObject({ name: "request_staff_help" });
    expect(adapter.interpret("who are my approved family contacts", null)).toMatchObject({ name: "get_approved_contacts" });
    expect(adapter.interpret("what is the service status", null)).toMatchObject({ name: "get_service_status" });
    expect(adapter.interpret("what is the status", "help_" + "a".repeat(32))).toMatchObject({ name: "get_my_request_status" });
    expect(adapter.interpret("withdraw my request", "help_" + "a".repeat(32))).toMatchObject({ name: "request_withdrawal" });
    expect(adapter.interpret("schedule a visit with contact family_demo_01 on 2026-09-22 at 09:00", null)).toEqual({
      name: "propose_visit_time",
      arguments: { contactUserId: "family_demo_01", localDate: "2026-09-22", startMinute: 540 },
    });
    expect(adapter.interpret("schedule a visit tomorrow", null)).toBeNull();
    expect(adapter.interpret("something else", null)).toBeNull();
  });

  test("fake scheduling asks one clarification until contact and time are supplied", async () => {
    const { app, tokens, db } = await makeTestApp({ now: () => new Date("2026-09-21T00:00:00.000Z") });
    const started = await app.inject({ method: "POST", url: "/assistant/sessions", headers: auth(tokens.device), payload: {} });
    const sessionId = started.json().session.sessionId as string;

    const incomplete = await app.inject({
      method: "POST", url: "/assistant/sessions/" + sessionId + "/input", headers: auth(tokens.device),
      payload: { text: "schedule a visit tomorrow" },
    });
    expect(incomplete.json()).toMatchObject({ result: { kind: "clarification", action: "ask_one_question" } });

    const complete = await app.inject({
      method: "POST", url: "/assistant/sessions/" + sessionId + "/input", headers: auth(tokens.device),
      payload: { text: "schedule a visit with contact family_demo_01 on 2026-09-22 at 09:00" },
    });
    expect(complete.json()).toMatchObject({
      result: {
        kind: "tool_result",
        tool: "propose_visit_time",
        response: { ok: true, needsConfirmation: true, actionId: expect.any(String) },
      },
    });
    expect(db.select().from(t.visitReservation).all()).toEqual([]);
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

  test("Realtime provider sends server-owned configuration and the scheduling function schemas", async () => {
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
    expect(REALTIME_TOOL_DEFINITIONS).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function", name: "get_visit_schedule" }),
      expect.objectContaining({
        type: "function",
        name: "get_visit_slots",
        parameters: expect.objectContaining({ required: ["from"] }),
      }),
      expect.objectContaining({
        type: "function",
        name: "propose_visit_time",
        parameters: expect.objectContaining({ required: ["contactUserId", "localDate", "startMinute"] }),
      }),
    ]));
    expect(answer).not.toContain("server-secret");
  });

  test("active Realtime instructions keep the ON 0 identity and control limits explicit", () => {
    const instructions = buildAssistantInstructions(loadAssistantProfile());
    expect(instructions).toContain("ON 0");
    expect(instructions).toContain("wheels");
    expect(instructions).toContain("adjustable-height");
    expect(instructions).toContain("two arms");
    expect(instructions).toContain("chest display");
    expect(instructions).toContain("do not move it");
    expect(instructions).toContain("use its arms");
    expect(instructions).toContain("adjust its height");
    expect(instructions).toContain("access its camera");
    expect(instructions).toContain("offer to contact staff");
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
