import { describe, expect, test } from "vitest";
import { buildFunctionCallOutput, extractFunctionCall, getLiveVoiceEventState, normalizeSdp } from "../src/realtime";

describe("resident realtime voice", () => {
  test("normalizes SDP line endings and preserves the final CRLF", () => {
    expect(normalizeSdp("\uFEFFv=0\no=ontaru 0 0 IN IP4 127.0.0.1")).toBe("v=0\r\no=ontaru 0 0 IN IP4 127.0.0.1\r\n");
  });

  test("maps microphone and response events to communication orb states", () => {
    expect(getLiveVoiceEventState({ type: "input_audio_buffer.speech_started" })).toMatchObject({ state: "listening" });
    expect(getLiveVoiceEventState({ type: "response.created" })).toMatchObject({ state: "thinking" });
    expect(getLiveVoiceEventState({ type: "output_audio_buffer.started" })).toMatchObject({ state: "speaking" });
    expect(getLiveVoiceEventState({ type: "response.done", response: { status: "completed" } })).toMatchObject({ state: "listening" });
  });

  test("relays only structured Realtime function calls with a response continuation", () => {
    const call = extractFunctionCall({
      type: "response.output_item.done",
      item: { type: "function_call", call_id: "call_123", name: "request_staff_help", arguments: "{\"category\":\"general_assistance\"}" },
    });
    expect(call).toEqual({ callId: "call_123", name: "request_staff_help", arguments: { category: "general_assistance" } });
    expect(buildFunctionCallOutput("call_123", { status: 202 })).toHaveLength(2);
  });
});
