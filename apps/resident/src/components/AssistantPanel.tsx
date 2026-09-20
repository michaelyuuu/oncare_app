import { useEffect, useMemo, useState, type FormEvent } from "react";
import { type Api, t } from "@oncare/web-common";
import { createAssistantClient } from "../assistant";
import { speak, stopSpeaking } from "../speech";

type PanelState = "starting" | "ready" | "error";

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

export function AssistantPanel({ api, onClose, disabled, residentName }: {
  api: Api;
  onClose: () => void;
  disabled: boolean;
  residentName: string;
}) {
  const client = useMemo(() => createAssistantClient(api), [api]);
  const [state, setState] = useState<PanelState>("starting");
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([client.startFakeSession(), api.get<{ voice_conversation?: { state?: string } }>("/capabilities")])
      .then(() => { if (!cancelled) setState("ready"); })
      .catch(() => { if (!cancelled) { client.reset(); setState("error"); } });
    return () => { cancelled = true; client.reset(); };
  }, [api, client]);

  const close = async () => {
    stopSpeaking();
    try { await client.interrupt(); await client.close(); } catch { /* session cleanup is best effort */ }
    client.reset();
    onClose();
  };

  const stop = async () => {
    stopSpeaking();
    try { await client.interrupt(); } catch { /* provider interruption is best effort */ }
    setSending(false);
    setNotice(t("resident.assistant.stopped"));
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || sending || state !== "ready" || disabled) return;
    setSending(true);
    setNotice(null);
    try {
      const result = await client.sendText(value);
      const message = evidenceMessage(result);
      if (message) { setNotice(message); speak(message); }
      else if (typeof result === "object" && result !== null && "result" in result && (result as { result?: { kind?: string } }).result?.kind === "clarification") {
        setNotice(t("resident.assistant.clarify"));
      }
      setText("");
    } catch {
      client.reset();
      setState("error");
    } finally {
      setSending(false);
    }
  };

  return <section className="assistant-panel screen" role="dialog" aria-labelledby="assistant-title">
    <div className="assistant-panel__top">
      <button type="button" className="quiet-button" onClick={() => void close()} disabled={sending}>{t("resident.assistant.close")}</button>
      <span className="assistant-panel__resident">{residentName}</span>
    </div>
    <div className="assistant-orb" data-orb={state === "ready" ? "listening" : state} aria-hidden="true"><span /></div>
    <h1 id="assistant-title">{t("resident.assistant.title")}</h1>
    <p className="assistant-panel__status" role="status">
      {state === "starting" && t("resident.assistant.starting")}
      {state === "ready" && !notice && t("resident.assistant.prompt")}
      {notice}
      {state === "error" && t("resident.assistant.unavailable")}
    </p>
    <form className="assistant-panel__form" onSubmit={(event) => void send(event)}>
      <label htmlFor="assistant-message">{t("resident.assistant.input_label")}</label>
      <input id="assistant-message" aria-label={t("resident.assistant.input_label")} value={text} onChange={(event) => setText(event.target.value)} disabled={disabled || sending || state !== "ready"} autoComplete="off" />
      <div className="assistant-panel__actions">
        <button type="submit" className="big-button big-button--primary" disabled={disabled || sending || state !== "ready" || !text.trim()}>{t("resident.assistant.send")}</button>
        <button type="button" className="quiet-button" onClick={() => void stop()} disabled={disabled || state !== "ready"}>{t("resident.assistant.stop")}</button>
      </div>
    </form>
  </section>;
}
