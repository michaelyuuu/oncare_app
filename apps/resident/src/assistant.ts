import type { Api } from "@oncare/web-common";
import { RealtimeVoiceClient, type LiveVoiceClientOptions } from "./realtime";

export interface AssistantSession {
  sessionId: string;
  state: string;
  mode: string;
  provider: string;
  lastRequestId?: string | null;
}

export interface AssistantClient {
  startFakeSession(): Promise<AssistantSession>;
  startRealtime(options?: AssistantRealtimeOptions): Promise<AssistantSession>;
  sendText(text: string): Promise<unknown>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  reset(): void;
}

export type AssistantRealtimeOptions = Pick<LiveVoiceClientOptions, "onState" | "onToolResult" | "onClosed">;

export function createAssistantClient(api: Api): AssistantClient {
  let session: AssistantSession | null = null;
  let realtime: RealtimeVoiceClient | null = null;

  async function startFakeSession(): Promise<AssistantSession> {
    if (realtime) {
      const active = realtime;
      realtime = null;
      await active.close();
    }
    const result = await api.post<{ session: AssistantSession }>("/assistant/sessions", {});
    session = result.session;
    return session;
  }

  async function startRealtime(options: AssistantRealtimeOptions = {}): Promise<AssistantSession> {
    const started = await api.post<{ session: AssistantSession }>("/assistant/sessions", { mode: "live" });
    session = started.session;
    const voiceOptions: LiveVoiceClientOptions = { sessionId: session.sessionId };
    if (options.onState) voiceOptions.onState = options.onState;
    if (options.onToolResult) voiceOptions.onToolResult = options.onToolResult;
    if (options.onClosed) voiceOptions.onClosed = options.onClosed;
    const voice = new RealtimeVoiceClient(api, voiceOptions);
    realtime = voice;
    try {
      await voice.connect();
      return session;
    } catch (error) {
      realtime = null;
      await voice.close();
      session = null;
      throw error;
    }
  }

  async function sendText(text: string): Promise<unknown> {
    if (!session) throw new Error("assistant_session_missing");
    if (realtime) throw new Error("text_fallback_unavailable_for_live_session");
    return api.post("/assistant/sessions/" + encodeURIComponent(session.sessionId) + "/input", { text });
  }

  async function interrupt(): Promise<void> {
    if (!session) return;
    if (realtime) {
      realtime.interrupt();
      await api.post("/assistant/sessions/" + encodeURIComponent(session.sessionId) + "/interrupt", {});
      return;
    }
    await api.post("/assistant/sessions/" + encodeURIComponent(session.sessionId) + "/interrupt", {});
  }

  async function close(): Promise<void> {
    if (!session) return;
    if (realtime) {
      const active = realtime;
      realtime = null;
      await active.close();
      session = null;
      return;
    }
    await api.post("/assistant/sessions/" + encodeURIComponent(session.sessionId) + "/close", {});
  }

  return {
    startFakeSession,
    startRealtime,
    sendText,
    interrupt,
    close,
    reset: () => {
      if (realtime) {
        const active = realtime;
        realtime = null;
        void active.close();
      }
      session = null;
    },
  };
}

export async function requestStaffHelp(api: Api, idempotencyKey: string): Promise<unknown> {
  const created = await api.post<{ request?: { id?: string } }>("/assistance-requests", { category: "general_assistance" }, {
    headers: { "Idempotency-Key": idempotencyKey },
  });
  const requestId = created.request?.id;
  if (!requestId) throw new Error("assistance_request_missing");
  return api.get("/assistance-requests/" + encodeURIComponent(requestId));
}
