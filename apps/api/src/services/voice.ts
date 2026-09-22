import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Principal } from "../auth/plugin";
import type { Db } from "../db/client";
import * as t from "../db/schema";
import type { Access } from "./access";
import { buildAssistantInstructions, type AssistantProfile } from "./assistant-profile";
import type { ToolRegistry, ToolResult } from "../tools/registry";

export const REALTIME_TOOL_DEFINITIONS = [
  {
    type: "function",
    name: "get_approved_contacts",
    description: "List the resident's server-approved family contacts.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "get_visit_schedule",
    description: "Read this resident's evidence-based upcoming and recent ON 0 visit reservations.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "get_visit_slots",
    description: "Read authoritative ON 0 visit slot availability starting on one facility-local date.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      },
      required: ["from"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "propose_visit_time",
    description: "Prepare a one-hour ON 0 robot visit proposal with an approved contact. The resident must confirm it on screen.",
    parameters: {
      type: "object",
      properties: {
        contactUserId: { type: "string", minLength: 1 },
        localDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        startMinute: { type: "integer", minimum: 0, maximum: 1439 },
      },
      required: ["contactUserId", "localDate", "startMinute"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "request_staff_help",
    description: "Create a staff assistance request when the resident asks for a person or help.",
    parameters: {
      type: "object",
      properties: {
        category: { type: "string", enum: ["general_assistance", "communication_support", "other"] },
        note: { type: "string", maxLength: 500 },
      },
      required: ["category"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "get_my_request_status",
    description: "Read the current evidence-based status of one assistance request.",
    parameters: {
      type: "object",
      properties: { requestId: { type: "string", pattern: "^help_[a-f0-9]{32}$" } },
      required: ["requestId"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "request_withdrawal",
    description: "Request withdrawal of one assistance request when the resident asks to cancel it.",
    parameters: {
      type: "object",
      properties: { requestId: { type: "string", pattern: "^help_[a-f0-9]{32}$" } },
      required: ["requestId"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "get_service_status",
    description: "Explain the current assistant, family-call, staff-assistance, and robot capability states.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;

export const REALTIME_TOOL_NAMES = new Set<string>(REALTIME_TOOL_DEFINITIONS.map((tool) => tool.name));

export type VoiceState = "idle" | "listening" | "processing" | "responding" | "clarification_required" | "closed" | "unavailable";
export type VoiceMode = "simulated" | "live";

export interface VoiceSession {
  sessionId: string;
  deviceId: string;
  residentId: string;
  assignmentVersion: number;
  mode: VoiceMode;
  provider: "fake" | "openai_realtime";
  transport: "text" | "webrtc";
  state: VoiceState;
  clarificationAttempts: number;
  lastRequestId: string | null;
}

export interface ToolProposal {
  name: string;
  arguments: Record<string, unknown>;
}

export class RealtimeProviderError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "RealtimeProviderError";
  }
}

export interface RealtimeProviderRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export interface RealtimeProviderResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

export type RealtimeRequest = (request: RealtimeProviderRequest) => Promise<RealtimeProviderResponse>;

function defaultRealtimeRequest(request: RealtimeProviderRequest): Promise<RealtimeProviderResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  return fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: controller.signal,
  }).then(async (response) => ({
    status: response.status,
    body: await response.text(),
    headers: Object.fromEntries(response.headers.entries()),
  })).finally(() => clearTimeout(timer));
}

export class OpenAIRealtimeProvider {
  readonly provider = "openai_realtime" as const;
  readonly transport = "webrtc" as const;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly request: RealtimeRequest;
  private readonly instructions: string;

  constructor(opts: {
    apiKey?: string;
    model?: string;
    endpoint?: string;
    timeoutMs?: number;
    request?: RealtimeRequest;
    instructions?: string;
  } = {}) {
    this.apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.model = opts.model ?? process.env.ONCARE_REALTIME_MODEL ?? "gpt-realtime";
    this.endpoint = opts.endpoint ?? process.env.ONCARE_REALTIME_ENDPOINT ?? "https://api.openai.com/v1/realtime/calls";
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.request = opts.request ?? defaultRealtimeRequest;
    this.instructions = opts.instructions ?? buildAssistantInstructions(null);
  }

  get available(): boolean {
    return Boolean(this.apiKey);
  }

  sessionConfig(overrides: Record<string, unknown> = {}) {
    return {
      ...overrides,
      type: "realtime",
      model: this.model,
      output_modalities: ["audio"],
      audio: {
        input: {
          transcription: { model: process.env.ONCARE_REALTIME_TRANSCRIPTION_MODEL ?? "gpt-4o-mini-transcribe" },
          turn_detection: { type: "server_vad", interrupt_response: true, create_response: true },
        },
      },
      instructions: typeof overrides.instructions === "string" ? overrides.instructions : this.instructions,
      tools: REALTIME_TOOL_DEFINITIONS,
      tool_choice: "auto",
    };
  }

  async createCall(sdp: string, config: Record<string, unknown> = {}): Promise<string> {
    if (!this.available) throw new RealtimeProviderError("provider_unavailable", "live provider is not configured");
    if (typeof sdp !== "string" || !sdp.trim()) throw new RealtimeProviderError("invalid_offer", "WebRTC offer is empty");
    const boundary = "oncare-" + randomUUID().replace(/-/g, "");
    const session = this.sessionConfig(config);
    const body = [
      "--" + boundary + "\r\nContent-Disposition: form-data; name=\"sdp\"\r\nContent-Type: application/sdp\r\n\r\n" + sdp + "\r\n",
      "--" + boundary + "\r\nContent-Disposition: form-data; name=\"session\"\r\nContent-Type: application/json\r\n\r\n" + JSON.stringify(session) + "\r\n",
      "--" + boundary + "--\r\n",
    ].join("");
    let response: RealtimeProviderResponse;
    try {
      response = await this.request({
        url: this.endpoint,
        method: "POST",
        headers: {
          Authorization: "Bearer " + this.apiKey,
          "Content-Type": "multipart/form-data; boundary=" + boundary,
          Accept: "application/sdp, application/json",
        },
        body,
        timeoutMs: this.timeoutMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/timeout|abort/i.test(message)) throw new RealtimeProviderError("provider_timeout", "OpenAI Realtime connection timed out");
      throw new RealtimeProviderError("provider_unavailable", "OpenAI Realtime connection failed");
    }
    if (response.status === 429) {
      const lower = response.body.toLowerCase();
      throw new RealtimeProviderError(lower.includes("quota") || lower.includes("credit") ? "quota_exhausted" : "rate_limited", "OpenAI Realtime provider limit reached");
    }
    if (response.status >= 400) throw new RealtimeProviderError("provider_http_error", "OpenAI Realtime returned HTTP " + response.status);
    let answer = response.body.trim();
    if (answer.startsWith("{")) {
      try {
        const payload = JSON.parse(answer) as { sdp?: unknown };
        answer = typeof payload.sdp === "string" ? payload.sdp.trim() : "";
      } catch {
        answer = "";
      }
    }
    if (!answer.startsWith("v=")) throw new RealtimeProviderError("invalid_sdp", "OpenAI Realtime returned an invalid SDP answer");
    return answer;
  }
}

export class FakeVoiceAdapter {
  private readonly requestIdPattern = /\bhelp_[a-f0-9]{32}\b/;

  interpret(text: string, lastRequestId: string | null): ToolProposal | null {
    const normalized = text.toLocaleLowerCase();
    if (/\b(schedule|book|reserve)\b/.test(normalized) && /\bvisit\b/.test(normalized)) {
      const contactUserId = text.match(/\bcontact(?:\s+id)?\s+([a-z0-9_-]+)\b/i)?.[1];
      const localDate = text.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
      const time = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\s*(am|pm)?\b/i);
      if (!contactUserId || !localDate || !time) return null;
      let hour = Number(time[1]);
      const minute = Number(time[2]);
      const meridiem = time[3]?.toLocaleLowerCase();
      if (meridiem === "am" && hour === 12) hour = 0;
      if (meridiem === "pm" && hour < 12) hour += 12;
      return {
        name: "propose_visit_time",
        arguments: { contactUserId, localDate, startMinute: hour * 60 + minute },
      };
    }
    if ((normalized.includes("staff") && normalized.includes("help")) || ["urgent human", "human help", "a person", "someone"].some((phrase) => normalized.includes(phrase))) {
      return { name: "request_staff_help", arguments: { category: "general_assistance" } };
    }
    if ((normalized.includes("contact") || normalized.includes("family")) && (normalized.includes("approved") || normalized.includes("who") || normalized.includes("list"))) {
      return { name: "get_approved_contacts", arguments: {} };
    }
    if (["service status", "service available", "assistance service", "what can you do"].some((phrase) => normalized.includes(phrase))) {
      return { name: "get_service_status", arguments: {} };
    }
    const requestId = normalized.match(this.requestIdPattern)?.[0] ?? lastRequestId;
    if (requestId && ["status", "request update", "where is my request", "is anyone coming"].some((phrase) => normalized.includes(phrase))) {
      return { name: "get_my_request_status", arguments: { requestId } };
    }
    if (requestId && ["withdraw", "cancel my request", "take back my request"].some((phrase) => normalized.includes(phrase))) {
      return { name: "request_withdrawal", arguments: { requestId } };
    }
    return null;
  }
}

type VoiceFailure = { ok: false; status: 400 | 403 | 404 | 409 | 503; error: string };
type VoiceSuccess<T extends object> = { ok: true } & T;
type VoiceResult<T extends object> = VoiceSuccess<T> | VoiceFailure;

function publicSession(session: VoiceSession): VoiceSession {
  return { ...session };
}

function activeFamilyVisit(db: Db, residentId: string): boolean {
  return db.select().from(t.visitSession).where(eq(t.visitSession.residentId, residentId)).all()
    .some((visit) => ["connecting", "active", "ending"].includes(visit.state));
}

export function createVoiceService(opts: {
  db: Db;
  access: Access;
  tools: ToolRegistry;
  profile?: AssistantProfile | null;
  realtime?: OpenAIRealtimeProvider;
  now?: () => Date;
}) {
  const sessions = new Map<string, VoiceSession>();
  const fake = new FakeVoiceAdapter();
  const realtime = opts.realtime ?? new OpenAIRealtimeProvider({ instructions: buildAssistantInstructions(opts.profile ?? null) });

  function validate(principal: Principal, sessionId: string): VoiceResult<{ session: VoiceSession }> {
    if (principal.kind !== "device") return { ok: false, status: 403, error: "forbidden" };
    const session = sessions.get(sessionId);
    if (!session) return { ok: false, status: 404, error: "not_found" };
    if (session.deviceId !== principal.id || session.residentId !== principal.residentId) return { ok: false, status: 403, error: "forbidden" };
    if (session.assignmentVersion !== principal.assignmentVersion) {
      session.state = "closed";
      sessions.delete(sessionId);
      return { ok: false, status: 403, error: "assignment_changed" };
    }
    if (activeFamilyVisit(opts.db, principal.residentId)) return { ok: false, status: 409, error: "conversation_unavailable" };
    return { ok: true, session };
  }

  function start(principal: Principal, mode: VoiceMode = "simulated"): VoiceResult<{ session: VoiceSession }> {
    if (principal.kind !== "device") return { ok: false, status: 403, error: "forbidden" };
    if (activeFamilyVisit(opts.db, principal.residentId)) return { ok: false, status: 409, error: "conversation_unavailable" };
    if (mode === "live" && !realtime.available) return { ok: false, status: 503, error: "provider_unavailable" };
    const session: VoiceSession = {
      sessionId: "conv_" + randomUUID().replace(/-/g, ""),
      deviceId: principal.id,
      residentId: principal.residentId,
      assignmentVersion: principal.assignmentVersion,
      mode,
      provider: mode === "live" ? "openai_realtime" : "fake",
      transport: mode === "live" ? "webrtc" : "text",
      state: "listening",
      clarificationAttempts: 0,
      lastRequestId: null,
    };
    sessions.set(session.sessionId, session);
    return { ok: true, session };
  }

  async function input(principal: Principal, sessionId: string, text: string): Promise<VoiceResult<{ session: VoiceSession; result: unknown }>> {
    const found = validate(principal, sessionId);
    if (!found.ok) return found;
    if (found.session.state === "closed" || found.session.mode !== "simulated") return { ok: false, status: 409, error: "session_inactive" };
    const proposal = fake.interpret(text, found.session.lastRequestId);
    if (!proposal) {
      found.session.clarificationAttempts += 1;
      found.session.state = "clarification_required";
      const result = found.session.clarificationAttempts >= 2
        ? { kind: "clarification", action: "offer_choices", choices: ["Ask staff for help", "Repeat", "Close conversation"] }
        : { kind: "clarification", action: "ask_one_question", choices: ["Ask staff for help", "Repeat"] };
      return { ok: true, session: publicSession(found.session), result };
    }
    found.session.state = "processing";
    const response = await opts.tools.invoke(principal, proposal.name, proposal.arguments);
    const responsePayload = response.ok && "result" in response ? response.result : undefined;
    if (typeof responsePayload === "object" && responsePayload !== null && "requestId" in responsePayload && typeof responsePayload.requestId === "string") {
      found.session.lastRequestId = responsePayload.requestId;
    }
    found.session.state = "responding";
    return {
      ok: true,
      session: publicSession(found.session),
      result: { kind: "tool_result", tool: proposal.name, status: response.ok ? 200 : response.status, response },
    };
  }

  function interrupt(principal: Principal, sessionId: string): VoiceResult<{ session: VoiceSession }> {
    const found = validate(principal, sessionId);
    if (!found.ok) return found;
    if (found.session.state !== "closed") found.session.state = "listening";
    return { ok: true, session: publicSession(found.session) };
  }

  function close(principal: Principal, sessionId: string): VoiceResult<{ session: VoiceSession }> {
    const found = validate(principal, sessionId);
    if (!found.ok) return found;
    found.session.state = "closed";
    return { ok: true, session: publicSession(found.session) };
  }

  async function createRealtimeCall(principal: Principal, sdp: string, sessionId?: string): Promise<VoiceResult<{ session: VoiceSession; sdp: string }>> {
    let session: VoiceSession;
    if (sessionId) {
      const found = validate(principal, sessionId);
      if (!found.ok) return found;
      session = found.session;
      session.mode = "live";
      session.provider = "openai_realtime";
      session.transport = "webrtc";
    } else {
      const started = start(principal, "live");
      if (!started.ok) return started;
      session = started.session;
    }
    try {
      const answer = await realtime.createCall(sdp, { instructions: buildAssistantInstructions(opts.profile ?? null) });
      session.state = "responding";
      return { ok: true, session: publicSession(session), sdp: answer };
    } catch (error) {
      const providerError = error instanceof RealtimeProviderError ? error : new RealtimeProviderError("provider_unavailable", "voice provider unavailable");
      return { ok: false, status: 503, error: providerError.code };
    }
  }

  function getRealtimeSession(principal: Principal, sessionId: string): VoiceResult<{ session: VoiceSession }> {
    return validate(principal, sessionId);
  }

  async function relayTool(principal: Principal, sessionId: string, name: string, input: Record<string, unknown>): Promise<VoiceResult<{ result: ToolResult; session: VoiceSession }>> {
    const found = validate(principal, sessionId);
    if (!found.ok) return found;
    if (found.session.mode !== "live" || !REALTIME_TOOL_NAMES.has(name)) return { ok: false, status: 404, error: "unknown_tool" };
    const response = await opts.tools.invoke(principal, name, input);
    const responsePayload = response.ok && "result" in response ? response.result : undefined;
    if (typeof responsePayload === "object" && responsePayload !== null && "requestId" in responsePayload && typeof responsePayload.requestId === "string") {
      found.session.lastRequestId = responsePayload.requestId;
    }
    found.session.state = "responding";
    return { ok: true, result: response, session: publicSession(found.session) };
  }

  function stop() {
    sessions.clear();
  }

  return { start, input, interrupt, close, createRealtimeCall, getRealtimeSession, relayTool, stop };
}

export type VoiceService = ReturnType<typeof createVoiceService>;
