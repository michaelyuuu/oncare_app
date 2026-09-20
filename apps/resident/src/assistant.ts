import type { Api } from "@oncare/web-common";

export interface AssistantSession {
  sessionId: string;
  state: string;
  mode: string;
  provider: string;
  lastRequestId?: string | null;
}

export interface AssistantClient {
  startFakeSession(): Promise<AssistantSession>;
  sendText(text: string): Promise<unknown>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  startRealtime?(sdp: string): Promise<unknown>;
  reset(): void;
}

export function createAssistantClient(api: Api): AssistantClient {
  let session: AssistantSession | null = null;

  async function startFakeSession(): Promise<AssistantSession> {
    const result = await api.post<{ session: AssistantSession }>("/assistant/sessions", {});
    session = result.session;
    return session;
  }

  async function sendText(text: string): Promise<unknown> {
    if (!session) throw new Error("assistant_session_missing");
    return api.post("/assistant/sessions/" + encodeURIComponent(session.sessionId) + "/input", { text });
  }

  async function interrupt(): Promise<void> {
    if (!session) return;
    await api.post("/assistant/sessions/" + encodeURIComponent(session.sessionId) + "/interrupt", {});
  }

  async function close(): Promise<void> {
    if (!session) return;
    await api.post("/assistant/sessions/" + encodeURIComponent(session.sessionId) + "/close", {});
  }

  async function startRealtime(sdp: string): Promise<unknown> {
    if (!session) throw new Error("assistant_session_missing");
    return api.post("/assistant/realtime/calls", { sessionId: session.sessionId, sdp });
  }

  return {
    startFakeSession,
    sendText,
    interrupt,
    close,
    startRealtime,
    reset: () => { session = null; },
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
