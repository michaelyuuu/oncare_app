import { useCallback, useEffect, useRef, useState } from "react";
import { connectEvents, t, type Api } from "@oncare/web-common";
import { TASK_STEPS, taskProgress } from "../task-progress";
import { dictationAvailable, startDictation } from "../speech-input";

interface Task {
  id: string;
  state: string;
  correlationId: string;
  proposal: { item: string; destination: string };
}
type Phase =
  | { kind: "idle" }
  | { kind: "clarifying"; options: string[] }
  | { kind: "confirming"; task: Task }
  | { kind: "tracking"; task: Task }
  | { kind: "rejected"; code: string };
type RetryAction = { kind: "submit"; utterance: string } | { kind: "confirm"; task: Task } | { kind: "cancel"; task: Task } | null;

const STEP_KEY: Record<(typeof TASK_STEPS)[number], string> = {
  confirm: "family.task.step.confirm",
  approval: "family.task.step.approval",
  pickup: "family.task.step.pickup",
  loading: "family.task.step.loading",
  delivery: "family.task.step.delivery",
  handoff: "family.task.step.handoff",
  done: "family.task.step.done",
};
const KNOWN_REJECTIONS = new Set(["prohibited_item", "unknown_item", "unapproved_destination", "unauthorized_recipient", "staff_denied"]);
const KNOWN_FAILURES = new Set(["item_not_found", "grasp_failed", "navigation_failed", "operator_required", "cancelled", "safety_stopped"]);

function itemLabel(id: string): string {
  const key = `item.${id}`;
  const translated = t(key);
  return translated === key ? t("item.unknown") : translated;
}

function destinationLabel(id: string, name: string): string {
  const key = `destination.${id}`;
  const translated = t(key, { name });
  return translated === key ? t("destination.unknown", { name }) : translated;
}

function failureKey(code: string): string {
  if (code === "rejected") return "family.task.rejected.staff_denied";
  return KNOWN_FAILURES.has(code) ? `family.task.failed.${code}` : "family.task.failed.unknown";
}

export function AskRobot({ api, apiBase, token, residentId, visitId, residentName }: {
  api: Api;
  apiBase: string;
  token: string;
  residentId: string;
  visitId: string;
  residentName: string;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [text, setText] = useState("");
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [retryAction, setRetryAction] = useState<RetryAction>(null);
  const requestSequence = useRef(0);
  const dictation = useRef<{ stop(): void } | null>(null);

  const clearError = () => { setErrorKey(null); setRetryAction(null); };

  const submit = useCallback(async (utterance: string) => {
    if (!utterance.trim()) return;
    const request = ++requestSequence.current;
    setBusy(true);
    clearError();
    try {
      const response = await api.post<any>("/tasks", { residentId, text: utterance.trim(), visitId });
      if (request !== requestSequence.current) return;
      if (response.kind === "clarification") setPhase({ kind: "clarifying", options: response.options ?? [] });
      else if (response.kind === "rejected") setPhase({ kind: "rejected", code: response.code });
      else setPhase({ kind: "confirming", task: response.task });
    } catch {
      if (request === requestSequence.current) {
        setErrorKey("family.task.error.request");
        setRetryAction({ kind: "submit", utterance: utterance.trim() });
      }
    } finally {
      if (request === requestSequence.current) setBusy(false);
    }
  }, [api, residentId, visitId]);

  const confirm = useCallback(async (task: Task) => {
    const request = ++requestSequence.current;
    setBusy(true);
    clearError();
    try {
      const response = await api.post<{ task: Task }>(`/tasks/${task.id}/confirm`);
      if (request === requestSequence.current) setPhase({ kind: "tracking", task: response.task });
    } catch {
      if (request === requestSequence.current) {
        setErrorKey("family.task.error.confirm");
        setRetryAction({ kind: "confirm", task });
      }
    } finally {
      if (request === requestSequence.current) setBusy(false);
    }
  }, [api]);

  const cancel = useCallback(async (task: Task) => {
    const request = ++requestSequence.current;
    setBusy(true);
    clearError();
    try {
      await api.post(`/tasks/${task.id}/cancel`);
      if (request === requestSequence.current) { setText(""); setPhase({ kind: "idle" }); }
    } catch {
      if (request === requestSequence.current) {
        setErrorKey("family.task.error.cancel");
        setRetryAction({ kind: "cancel", task });
      }
    } finally {
      if (request === requestSequence.current) setBusy(false);
    }
  }, [api]);

  const retry = () => {
    if (retryAction?.kind === "submit") void submit(retryAction.utterance);
    else if (retryAction?.kind === "confirm") void confirm(retryAction.task);
    else if (retryAction?.kind === "cancel") void cancel(retryAction.task);
  };

  const stopListening = useCallback(() => {
    dictation.current?.stop();
    dictation.current = null;
    setListening(false);
  }, []);
  const startListening = () => {
    if (dictation.current || busy) return;
    const handle = startDictation("en-US", (spoken) => { setText(spoken); void submit(spoken); }, () => {
      dictation.current = null;
      setListening(false);
    });
    if (handle) { dictation.current = handle; setListening(true); }
  };

  useEffect(() => () => {
    requestSequence.current += 1;
    dictation.current?.stop();
    dictation.current = null;
  }, []);

  useEffect(() => {
    if (phase.kind !== "tracking") return;
    const taskId = phase.task.id;
    let refreshSequence = 0;
    let active = true;
    const refresh = async () => {
      const request = ++refreshSequence;
      try {
        const response = await api.get<{ task: Task }>(`/tasks/${taskId}`);
        if (active && request === refreshSequence) {
          setPhase((current) => current.kind === "tracking" && current.task.id === taskId ? { kind: "tracking", task: response.task } : current);
          setErrorKey(null);
        }
      } catch {
        if (active && request === refreshSequence) setErrorKey("family.task.error.progress");
      }
    };
    const interval = setInterval(() => void refresh(), 3000);
    const events = connectEvents(apiBase, token, (event) => { if (event.entityId === taskId) void refresh(); });
    return () => { active = false; refreshSequence += 1; clearInterval(interval); events.close(); };
  }, [api, apiBase, phase.kind === "tracking" ? phase.task.id : null, token]);

  const feedback = errorKey && <div className="ask-feedback"><p role="alert" className="error">{t(errorKey)}</p>{retryAction && <button type="button" onClick={retry} disabled={busy}>{t("family.ask.tryagain")}</button>}</div>;

  if (phase.kind === "idle") return <form className="ask ask--idle" onSubmit={(event) => { event.preventDefault(); void submit(text); }}>
    <label htmlFor="ask-robot-text">{t("family.ask.label")}</label>
    <input id="ask-robot-text" value={text} onChange={(event) => setText(event.target.value)} placeholder={t("family.ask.placeholder")} />
    <div className="ask-actions">
      <button type="submit" className="primary" disabled={busy || !text.trim()}>{t("family.ask.send")}</button>
      {dictationAvailable() && <button type="button" className="speak" aria-pressed={listening} disabled={busy}
        onPointerDown={startListening} onPointerUp={stopListening} onPointerCancel={stopListening} onPointerLeave={() => { if (listening) stopListening(); }}>
        {listening ? t("family.ask.listening") : t("family.ask.speak")}
      </button>}
    </div>
    {feedback}
  </form>;

  if (phase.kind === "clarifying") return <section className="ask ask--clarify">
    <h3>{t("family.ask.clarify.title")}</h3>
    <p>{t("family.ask.clarify.question")}</p>
    <div className="chips">{phase.options.map((option) => <button key={option} type="button" disabled={busy} onClick={() => void submit(itemLabel(option))}>{itemLabel(option)}</button>)}</div>
    <button type="button" className="link" onClick={() => { requestSequence.current += 1; clearError(); setPhase({ kind: "idle" }); }}>{t("family.ask.confirm.no")}</button>
    {feedback}
  </section>;

  if (phase.kind === "confirming") return <section className="ask ask--confirm" role="dialog" aria-labelledby="ask-confirm-title">
    <h3 id="ask-confirm-title">{t("family.ask.confirm.title", { item: itemLabel(phase.task.proposal.item), destination: destinationLabel(phase.task.proposal.destination, residentName) })}</h3>
    <div className="ask-actions"><button type="button" className="primary" disabled={busy} onClick={() => void confirm(phase.task)}>{t("family.ask.confirm.yes")}</button>
      <button type="button" disabled={busy} onClick={() => void cancel(phase.task)}>{t("family.ask.confirm.no")}</button></div>
    {feedback}
  </section>;

  if (phase.kind === "rejected") return <section className="ask ask--rejected">
    <p role="alert" className="error">{t(KNOWN_REJECTIONS.has(phase.code) ? `family.task.rejected.${phase.code}` : "family.task.rejected.unknown")}</p>
    <button type="button" onClick={() => { setText(""); clearError(); setPhase({ kind: "idle" }); }}>{t("family.ask.tryagain")}</button>
  </section>;

  const progress = taskProgress(phase.task.state);
  return <section className="ask ask--tracking" aria-label={t("family.task.progress")}>{feedback}
    <ol className="stepper task-stepper">{TASK_STEPS.map((step, index) => {
      const status = index < progress.currentIndex ? "done" : index === progress.currentIndex ? (progress.failed ? "failed" : "current") : "todo";
      return <li key={step} className={`step step--${status}`}>
        <span className="step-marker" aria-hidden="true">{index < progress.currentIndex ? "✓" : ""}</span>
        <div aria-current={index === progress.currentIndex ? "step" : undefined}>{t(STEP_KEY[step], { name: residentName })}
          {index === progress.currentIndex && progress.failed && <p className="failed-reason">{t(failureKey(progress.failed))}</p>}
        </div>
      </li>;
    })}</ol>
    {!progress.terminal && progress.currentIndex < 2 && <button type="button" disabled={busy} onClick={() => void cancel(phase.task)}>{t("family.task.cancel")}</button>}
    {progress.terminal && <button type="button" onClick={() => { setText(""); clearError(); setPhase({ kind: "idle" }); }}>{t("family.ask.tryagain")}</button>}
  </section>;
}
