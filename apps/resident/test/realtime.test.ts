import { describe, expect, test, vi } from "vitest";
import type { Api } from "@oncare/web-common";
import { buildFunctionCallOutput, extractFunctionCall, getLiveVoiceEventState, normalizeSdp, RealtimeVoiceClient } from "../src/realtime";

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

  test("aborting a pending connection stops the microphone immediately", async () => {
    let finishCall: ((value: { session: { sessionId: string }; sdp: string }) => void) | undefined;
    const post = vi.fn((path: string) => path === "/assistant/realtime/calls"
      ? new Promise<{ session: { sessionId: string }; sdp: string }>((resolve) => { finishCall = resolve; })
      : Promise.resolve({}));
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    class Peer {
      localDescription: RTCSessionDescriptionInit | null = null;
      connectionState: RTCPeerConnectionState = "new";
      ontrack: ((event: RTCTrackEvent) => void) | null = null;
      onconnectionstatechange: (() => void) | null = null;
      addTrack() {}
      createDataChannel() { return { readyState: "open", send: vi.fn() } as unknown as RTCDataChannel; }
      async createOffer() { return { type: "offer" as const, sdp: "v=0\r\n" }; }
      async setLocalDescription(description: RTCSessionDescriptionInit) { this.localDescription = description; }
      async setRemoteDescription() {}
      close() {}
    }
    const controller = new AbortController();
    const client = new RealtimeVoiceClient({ post } as unknown as Api, {
      sessionId: "conv_test",
      peerConnectionFactory: Peer as unknown as typeof RTCPeerConnection,
      mediaDevices: { getUserMedia: vi.fn(async () => stream) } as unknown as MediaDevices,
      secureContext: true,
      signal: controller.signal,
    });

    const connecting = client.connect();
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith("/assistant/realtime/calls", expect.anything()));
    controller.abort();
    const stoppedImmediately = track.stop.mock.calls.length;
    finishCall?.({ session: { sessionId: "conv_test" }, sdp: "v=0\r\n" });

    await expect(connecting).rejects.toThrow("cancelled");
    expect(stoppedImmediately).toBe(1);
  });
});
