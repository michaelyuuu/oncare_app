import type { Api } from "@oncare/web-common";

const FUNCTION_CALL_EVENT = "response.output_item.done";

export type LiveVoiceState = "listening" | "thinking" | "speaking" | "tool" | "error";

export interface LiveVoiceEventState {
  state: LiveVoiceState;
  detail?: string;
  transcript?: string;
  speaker?: "you" | "ontaru";
  append?: boolean;
}

export interface FunctionCall {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AssistantActionProposal {
  actionId: string;
  summary: string;
  expiresAt: string;
}

export function extractAssistantActionProposal(value: unknown): AssistantActionProposal | null {
  let current = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return null;
    const record = current as Record<string, unknown>;
    if (
      record.needsConfirmation === true
      && typeof record.actionId === "string"
      && record.actionId.length > 0
      && typeof record.summary === "string"
      && record.summary.length > 0
      && typeof record.expiresAt === "string"
      && record.expiresAt.length > 0
    ) {
      return {
        actionId: record.actionId,
        summary: record.summary,
        expiresAt: record.expiresAt,
      };
    }
    if ("response" in record) {
      current = record.response;
      continue;
    }
    if ("result" in record) {
      current = record.result;
      continue;
    }
    return null;
  }
  return null;
}

export function normalizeSdp(value: string): string {
  const text = String(value || "").replace(/^\uFEFF/, "").trim();
  if (!text) return "";
  return text.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n") + "\r\n";
}

export function extractFunctionCall(event: unknown): FunctionCall | null {
  if (typeof event !== "object" || event === null) return null;
  const payload = event as { type?: unknown; item?: unknown };
  if (payload.type !== FUNCTION_CALL_EVENT || typeof payload.item !== "object" || payload.item === null) return null;
  const item = payload.item as { type?: unknown; call_id?: unknown; name?: unknown; arguments?: unknown };
  if (item.type !== "function_call") return null;
  let args: unknown = {};
  if (typeof item.arguments === "string" && item.arguments) {
    try { args = JSON.parse(item.arguments); } catch { throw new Error("Ontaru returned invalid tool arguments"); }
  }
  if (
    typeof item.call_id !== "string" || !item.call_id ||
    typeof item.name !== "string" || !item.name ||
    typeof args !== "object" || args === null || Array.isArray(args)
  ) throw new Error("Ontaru returned an invalid tool call");
  return { callId: item.call_id, name: item.name, arguments: args as Record<string, unknown> };
}

export function buildFunctionCallOutput(callId: string, output: unknown): Array<Record<string, unknown>> {
  return [
    {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: typeof output === "string" ? output : JSON.stringify(output),
      },
    },
    { type: "response.create" },
  ];
}

function eventObject(event: unknown): Record<string, unknown> {
  return typeof event === "object" && event !== null ? event as Record<string, unknown> : {};
}

function responseFailureMessage(event: Record<string, unknown>): string {
  const error = event.error;
  if (typeof error === "object" && error !== null) {
    const detail = error as { message?: unknown; code?: unknown };
    if (typeof detail.message === "string") return typeof detail.code === "string" ? detail.message + " (" + detail.code + ")" : detail.message;
  }
  const response = event.response;
  if (typeof response === "object" && response !== null) {
    const details = (response as { status_details?: unknown }).status_details;
    if (typeof details === "object" && details !== null && typeof (details as { reason?: unknown }).reason === "string") {
      return "The response stopped before completion: " + (details as { reason: string }).reason + ".";
    }
  }
  return "The voice response could not be completed.";
}

export function getLiveVoiceEventState(event: unknown): LiveVoiceEventState | null {
  const payload = eventObject(event);
  switch (payload.type) {
    case "session.created":
    case "input_audio_buffer.speech_started":
      return { state: "listening", detail: "I am ready. Speak naturally, then pause when you are finished." };
    case "input_audio_buffer.speech_stopped":
      return { state: "thinking", detail: "I heard you. Waiting for Ontaru to respond." };
    case "input_audio_buffer.committed":
      return { state: "thinking", detail: "Your voice is being transcribed." };
    case "input_audio_buffer.timeout_triggered":
      return { state: "listening", detail: "I did not hear speech. Speak again when you are ready." };
    case "conversation.item.input_audio_transcription.completed":
      return {
        state: "thinking",
        detail: "Your words were received. Ontaru is preparing a response.",
        ...(typeof payload.transcript === "string" ? { transcript: payload.transcript, speaker: "you" as const, append: false } : {}),
      };
    case "response.created":
      return { state: "thinking", detail: "Ontaru is preparing a response." };
    case FUNCTION_CALL_EVENT: {
      const item = payload.item;
      return typeof item === "object" && item !== null && (item as { type?: unknown }).type === "function_call"
        ? { state: "tool", detail: "Ontaru is checking the approved assistance tools." }
        : null;
    }
    case "output_audio_buffer.started":
      return { state: "speaking", detail: "Audio response is playing." };
    case "response.audio_transcript.delta":
      return {
        state: "speaking",
        detail: "Response is arriving.",
        ...(typeof payload.delta === "string" ? { transcript: payload.delta, speaker: "ontaru" as const, append: true } : {}),
      };
    case "response.audio_transcript.done":
      return {
        state: "speaking",
        detail: "Audio response is playing.",
        ...(typeof payload.transcript === "string" ? { transcript: payload.transcript, speaker: "ontaru" as const, append: false } : {}),
      };
    case "output_audio_buffer.stopped":
      return { state: "listening", detail: "You can speak again." };
    case "response.done": {
      const response = payload.response;
      const status = typeof response === "object" && response !== null ? (response as { status?: unknown }).status : undefined;
      return status === "failed" || status === "incomplete"
        ? { state: "error", detail: responseFailureMessage(payload) }
        : { state: "listening", detail: status === "cancelled" ? "Response cancelled. You can speak again." : "You can speak again." };
    }
    case "error":
      return { state: "error", detail: responseFailureMessage(payload) };
    default:
      return null;
  }
}

export function isSecureVoiceOrigin(options: { locationLike?: Location; secureContext?: boolean } = {}): boolean {
  if (typeof options.secureContext === "boolean") return options.secureContext;
  const locationLike = options.locationLike ?? globalThis.location;
  const protocol = locationLike?.protocol;
  if (!protocol) return true;
  return protocol === "https:" || locationLike.hostname === "localhost" || locationLike.hostname === "127.0.0.1";
}

export interface LiveVoiceClientOptions {
  sessionId: string;
  onState?: (state: LiveVoiceEventState) => void;
  onToolResult?: (result: unknown) => void;
  onClosed?: () => void;
  peerConnectionFactory?: typeof RTCPeerConnection;
  mediaDevices?: MediaDevices;
  secureContext?: boolean;
  signal?: AbortSignal;
}

type RealtimeCallResponse = { session: { sessionId: string }; sdp: string };

export class RealtimeVoiceClient {
  private readonly api: Api;
  private readonly options: LiveVoiceClientOptions;
  private peer: RTCPeerConnection | null = null;
  private stream: MediaStream | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private remoteAudio: HTMLAudioElement | null = null;
  private sessionId: string | null;
  private cancelled = false;
  private closedReported = false;

  constructor(api: Api, options: LiveVoiceClientOptions) {
    this.api = api;
    this.options = options;
    this.sessionId = options.sessionId;
  }

  async connect(): Promise<RealtimeCallResponse> {
    const signal = this.options.signal;
    if (signal?.aborted) {
      await this.close();
      throw new Error("Live voice was cancelled");
    }
    const abort = () => { void this.close(); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      return await this.connectActive();
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  private async connectActive(): Promise<RealtimeCallResponse> {
    const secureOptions = typeof this.options.secureContext === "boolean" ? { secureContext: this.options.secureContext } : {};
    if (!isSecureVoiceOrigin(secureOptions)) throw new Error("Microphone access requires HTTPS.");
    const Peer = this.options.peerConnectionFactory ?? globalThis.RTCPeerConnection;
    const media = this.options.mediaDevices ?? globalThis.navigator?.mediaDevices;
    if (!Peer || !media?.getUserMedia) throw new Error("This browser does not support WebRTC microphone access");
    this.stream = await media.getUserMedia({ audio: true });
    if (this.cancelled) {
      this.stopLocalMedia();
      throw new Error("Live voice was cancelled");
    }
    this.peer = new Peer();
    for (const track of this.stream.getTracks()) this.peer.addTrack(track, this.stream);
    this.peer.ontrack = (event) => {
      if (!this.remoteAudio && typeof document !== "undefined") {
        this.remoteAudio = document.createElement("audio");
        this.remoteAudio.autoplay = true;
        this.remoteAudio.setAttribute("playsinline", "");
        this.remoteAudio.setAttribute("aria-label", "Ontaru voice response");
        document.body.append(this.remoteAudio);
      }
      const remoteStream = event.streams?.[0];
      if (remoteStream && this.remoteAudio) this.remoteAudio.srcObject = remoteStream;
    };
    this.peer.onconnectionstatechange = () => {
      const status = this.peer?.connectionState;
      if (this.closedReported || !status || !["failed", "closed", "disconnected"].includes(status)) return;
      this.closedReported = true;
      this.options.onClosed?.();
    };
    this.dataChannel = this.peer.createDataChannel("oai-events");
    this.dataChannel.onmessage = (message) => {
      try {
        void this.handleEvent(JSON.parse(String(message.data)) as unknown).catch((error: unknown) => {
          this.options.onState?.({ state: "error", detail: error instanceof Error ? error.message : String(error) });
        });
      } catch (error) {
        this.options.onState?.({ state: "error", detail: error instanceof Error ? error.message : String(error) });
      }
    };
    const offer = await this.peer.createOffer();
    await this.peer.setLocalDescription(offer);
    const sdp = normalizeSdp(this.peer.localDescription?.sdp ?? offer.sdp ?? "");
    if (!sdp.trim() || !sdp.startsWith("v=0\r\n")) throw new Error("WebRTC offer was invalid");
    const response = await this.api.post<RealtimeCallResponse>("/assistant/realtime/calls", { sessionId: this.sessionId, sdp });
    if (this.cancelled) {
      await this.close();
      throw new Error("Live voice was cancelled");
    }
    const answer = normalizeSdp(response.sdp);
    if (!answer.trim() || !answer.startsWith("v=0\r\n")) throw new Error("OpenAI returned an invalid SDP answer");
    await this.peer.setRemoteDescription({ type: "answer", sdp: answer });
    this.options.onState?.({ state: "listening", detail: "You can speak naturally and interrupt the assistant." });
    return response;
  }

  private async handleEvent(event: unknown): Promise<void> {
    const state = getLiveVoiceEventState(event);
    if (state) this.options.onState?.(state);
    const call = extractFunctionCall(event);
    if (!call || !this.sessionId) return;
    const body = await this.api.post<{ result?: unknown }>("/assistant/realtime/sessions/" + encodeURIComponent(this.sessionId) + "/tool", {
      name: call.name,
      arguments: call.arguments,
    });
    this.options.onToolResult?.(body);
    for (const continuation of buildFunctionCallOutput(call.callId, body.result ?? body)) this.send(continuation);
  }

  private send(event: Record<string, unknown>): boolean {
    if (this.dataChannel?.readyState !== "open") return false;
    this.dataChannel.send(JSON.stringify(event));
    return true;
  }

  interrupt(): void {
    this.send({ type: "response.cancel" });
    this.send({ type: "output_audio_buffer.clear" });
  }

  private stopLocalMedia(): void {
    for (const track of this.stream?.getTracks?.() ?? []) track.stop();
    this.stream = null;
    this.peer?.close();
    this.peer = null;
    this.dataChannel = null;
    if (this.remoteAudio) {
      this.remoteAudio.remove();
      this.remoteAudio = null;
    }
  }

  async close(): Promise<void> {
    this.cancelled = true;
    this.closedReported = true;
    const sessionId = this.sessionId;
    this.sessionId = null;
    this.stopLocalMedia();
    if (sessionId) {
      try {
        await this.api.post("/assistant/sessions/" + encodeURIComponent(sessionId) + "/close", {});
      } catch {
        // Local media is released before the best-effort server close.
      }
    }
  }
}
