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
  test("connects synthetic microphone audio through SDP and attaches the assistant audio track", async () => {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    const remoteStream = {} as MediaStream;
    const dataChannel = { readyState: "open", send: vi.fn(), onmessage: null } as unknown as RTCDataChannel;
    let peer: Peer | undefined;
    class Peer {
      localDescription: RTCSessionDescriptionInit | null = null;
      connectionState: RTCPeerConnectionState = "new";
      ontrack: ((event: RTCTrackEvent) => void) | null = null;
      onconnectionstatechange: (() => void) | null = null;
      addTrack = vi.fn();
      createDataChannel = vi.fn(() => dataChannel);
      createOffer = vi.fn(async () => ({ type: "offer" as const, sdp: "v=0\no=resident 1 1 IN IP4 127.0.0.1" }));
      async setLocalDescription(description: RTCSessionDescriptionInit) { this.localDescription = description; }
      setRemoteDescription = vi.fn(async () => {});
      close = vi.fn();
      constructor() { peer = this; }
    }
    const getUserMedia = vi.fn(async () => stream);
    const post = vi.fn(async (path: string) => path === "/assistant/realtime/calls"
      ? { session: { sessionId: "conv_voice" }, sdp: "v=0\no=ontaru 1 1 IN IP4 127.0.0.1" }
      : {});
    const client = new RealtimeVoiceClient({ post } as unknown as Api, {
      sessionId: "conv_voice",
      peerConnectionFactory: Peer as unknown as typeof RTCPeerConnection,
      mediaDevices: { getUserMedia } as unknown as MediaDevices,
      secureContext: true,
    });

    try {
      await client.connect();
      expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
      expect(peer?.addTrack).toHaveBeenCalledWith(track, stream);
      expect(post).toHaveBeenCalledWith("/assistant/realtime/calls", {
        sessionId: "conv_voice",
        sdp: "v=0\r\no=resident 1 1 IN IP4 127.0.0.1\r\n",
      });
      expect(peer?.setRemoteDescription).toHaveBeenCalledWith({
        type: "answer",
        sdp: "v=0\r\no=ontaru 1 1 IN IP4 127.0.0.1\r\n",
      });

      peer?.ontrack?.({ streams: [remoteStream] } as unknown as RTCTrackEvent);
      const remoteAudio = document.querySelector<HTMLAudioElement>('audio[aria-label="Ontaru voice response"]');
      expect(remoteAudio).not.toBeNull();
      expect(remoteAudio?.autoplay).toBe(true);
      expect(remoteAudio?.srcObject).toBe(remoteStream);
    } finally {
      await client.close();
      document.querySelector('audio[aria-label="Ontaru voice response"]')?.remove();
    }

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(peer?.close).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/assistant/sessions/conv_voice/close", {});
  });
});
