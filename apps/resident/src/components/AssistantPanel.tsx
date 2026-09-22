import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { ApiError, type Api, t } from "@oncare/web-common";
import { createAssistantClient } from "../assistant";
import { extractAssistantActionProposal, type AssistantActionProposal, type LiveVoiceEventState } from "../realtime";
import { speak, stopSpeaking } from "../speech";
import { AssistantActionConfirmation } from "./AssistantActionConfirmation";

type PanelState = "connecting" | "listening" | "thinking" | "speaking" | "error";
type HelpStatus = "idle" | "sending" | "recorded" | "error";
const EXPIRED_ACTION_NOTICE = "That visit confirmation has expired. Please choose a new time.";

function evidenceMessage(result: unknown): string | null {
  if (typeof result !== "object" || result === null || !("result" in result)) return null;
  const envelope = result as { result?: unknown };
  if (typeof envelope.result !== "object" || envelope.result === null || !("response" in envelope.result)) return null;
  const response = envelope.result as { response?: unknown };
  if (typeof response.response !== "object" || response.response === null || !("result" in response.response)) return null;
  const toolResult = response.response as { result?: unknown };
  if (typeof toolResult.result !== "object" || toolResult.result === null) return null;
  const payload = toolResult.result as { request?: { persistenceState?: string; deliveryState?: string; handlingState?: string } };
  const request = payload.request;
  if (!request) return null;
  if (request.persistenceState === "recorded" && request.deliveryState === "pending") return t("resident.assistant.recorded");
  if (request.handlingState === "acknowledged") return t("resident.assistant.acknowledged");
  if (request.handlingState === "in_progress") return t("resident.assistant.in_progress");
  if (request.handlingState === "resolved") return t("resident.assistant.resolved");
  return null;
}

function panelState(event: LiveVoiceEventState): PanelState {
  if (event.state === "error") return "error";
  if (event.state === "thinking" || event.state === "tool") return "thinking";
  if (event.state === "speaking") return "speaking";
  return "listening";
}

export function AssistantPanel({
  api,
  onClose,
  disabled,
  residentName: _residentName,
  onHelpStaff,
  helpStatus = "idle",
}: {
  api: Api;
  onClose: () => void;
  disabled: boolean;
  residentName: string;
  onHelpStaff?: () => void;
  helpStatus?: HelpStatus;
}) {
  const client = useMemo(() => createAssistantClient(api), [api]);
  const [state, setState] = useState<PanelState>("connecting");
  const [fallbackReady, setFallbackReady] = useState(false);
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [action, setAction] = useState<AssistantActionProposal | null>(null);

  const receiveToolResult = useCallback((result: unknown): boolean => {
    const proposal = extractAssistantActionProposal(result);
    if (proposal) {
      setAction(proposal);
      setNotice(null);
      return true;
    }
    const message = evidenceMessage(result);
    if (!message) return false;
    setNotice(message);
    speak(message);
    return true;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let started = false;
    let startTimer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const dispose = async () => {
      try {
        await client.close();
      } finally {
        client.reset();
      }
    };
    const beginFallback = async () => {
      if (cancelled) return;
      client.reset();
      try {
        await client.startFakeSession();
        if (cancelled) {
          await dispose();
          return;
        }
        setFallbackReady(true);
        setState("error");
        setNotice(t("resident.communication.voice_failed"));
      } catch {
        if (cancelled) return;
        setFallbackReady(false);
        setState("error");
        setNotice(t("resident.assistant.unavailable"));
      }
    };
    const start = async () => {
      if (cancelled) return;
      try {
        await client.startRealtime({
          signal: controller.signal,
          onState: (event) => {
            if (cancelled) return;
            setState(panelState(event));
            if (event.state === "error") setNotice(t("resident.communication.voice_failed"));
          },
          onToolResult: (result) => {
            if (!cancelled) receiveToolResult(result);
          },
          onClosed: () => { if (!cancelled) void beginFallback(); },
        });
        if (cancelled) {
          await dispose();
          return;
        }
        setState("listening");
        setNotice(null);
      } catch {
        if (cancelled) {
          await dispose();
          return;
        }
        await beginFallback();
      }
    };
    // Deferring one turn lets React StrictMode replay and cancel its probe
    // effect before any microphone or server session is opened.
    startTimer = setTimeout(() => {
      started = true;
      void start();
    }, 0);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(startTimer);
      stopSpeaking();
      if (started) void dispose();
    };
  }, [client, receiveToolResult]);

  const close = async () => {
    stopSpeaking();
    try {
      await client.interrupt();
      await client.close();
    } catch {
      // Session cleanup is best effort on a kiosk connection.
    } finally {
      client.reset();
      onClose();
    }
  };

  const stop = async () => {
    stopSpeaking();
    try { await client.interrupt(); } catch { /* provider interruption is best effort */ }
    setSending(false);
    setState("listening");
    setNotice(t("resident.assistant.stopped"));
  };

  const expireAction = useCallback(() => {
    setAction(null);
    setNotice(EXPIRED_ACTION_NOTICE);
    speak(EXPIRED_ACTION_NOTICE);
  }, []);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || sending || !fallbackReady || disabled) return;
    setSending(true);
    setNotice(null);
    try {
      const result = await client.sendText(value);
      const handled = receiveToolResult(result);
      if (!handled && typeof result === "object" && result !== null && "result" in result && (result as { result?: { kind?: string } }).result?.kind === "clarification") {
        setNotice(t("resident.assistant.clarify"));
      }
      setText("");
    } catch {
      client.reset();
      setState("error");
      setFallbackReady(false);
      setNotice(t("resident.assistant.unavailable"));
    } finally {
      setSending(false);
    }
  };

  const resolveAction = async (decision: "confirm" | "cancel") => {
    if (!action || sending || disabled) return;
    setSending(true);
    const success = decision === "confirm" ? "Visit proposal sent." : "Visit proposal cancelled.";
    try {
      await api.post("/tools/actions/" + encodeURIComponent(action.actionId) + "/" + decision, {});
      setAction(null);
      setNotice(success);
      speak(success);
    } catch (error) {
      if (error instanceof ApiError && error.status === 410) {
        expireAction();
        return;
      }
      const failure = "That visit action could not be completed. Please try again.";
      setNotice(failure);
      speak(failure);
    } finally {
      setSending(false);
    }
  };

  const statusText = notice
    ?? (state === "connecting"
      ? t("resident.communication.connecting")
      : state === "error"
        ? t("resident.communication.voice_failed")
        : state === "listening"
          ? t("resident.communication.listening")
          : state === "thinking"
            ? t("resident.communication.thinking")
            : t("resident.communication.speaking"));
  const orbState = state === "error" ? "offline" : state;
  const helpText = helpStatus === "sending"
    ? t("resident.communication.help_sending")
    : helpStatus === "recorded"
      ? t("resident.communication.help_recorded")
      : helpStatus === "error"
        ? t("resident.communication.help_error")
        : t("resident.communication.help");

  return <section
    className="communication-screen communication-talk"
    role="dialog"
    aria-label={t("resident.communication.aria")}
    data-orb={orbState}
    data-shape="sphere"
    data-dim="off"
    data-bg="default"
    data-card="off"
  >
    <p className="communication-brand">{t("resident.communication.brand")}</p>
    <div className="communication-zone-corner">
      <button type="button" className="communication-ghost" onClick={() => void stop()} disabled={disabled || sending}>
        {t("resident.communication.stop")}
      </button>
      <button type="button" className="communication-ghost" onClick={() => void close()} disabled={sending}>
        {t("resident.communication.end_call")}
      </button>
    </div>
    <div className="communication-orb-button communication-orb-button--static" aria-hidden="true">
      <span className="communication-orb">
        <i /><i /><i /><i />
      </span>
    </div>
    <p className="communication-status" role="status" aria-live="polite">{statusText}</p>
    {action && <AssistantActionConfirmation
      actionId={action.actionId}
      summary={action.summary}
      expiresAt={action.expiresAt}
      disabled={disabled || sending}
      onConfirm={() => resolveAction("confirm")}
      onCancel={() => resolveAction("cancel")}
      onExpire={expireAction}
    />}
    {fallbackReady && !action && <form className="communication-fallback" data-testid="assistant-text-fallback" onSubmit={(event) => void send(event)}>
      <label htmlFor="assistant-message">{t("resident.communication.fallback")}</label>
      <div className="communication-fallback__row">
        <input id="assistant-message" aria-label={t("resident.assistant.input_label")} value={text} onChange={(event) => setText(event.target.value)} disabled={disabled || sending} autoComplete="off" />
        <button type="submit" className="communication-solid communication-fallback__send" disabled={disabled || sending || !text.trim()}>{t("resident.assistant.send")}</button>
      </div>
    </form>}
    <div className="communication-zone-bottom">
      {onHelpStaff && <button type="button" className="communication-solid" onClick={onHelpStaff} disabled={disabled || helpStatus === "sending"}>{helpText}</button>}
      <span className="communication-demo">{t("resident.communication.demo")}</span>
    </div>
  </section>;
}
