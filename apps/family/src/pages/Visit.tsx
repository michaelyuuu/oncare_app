import { useCallback, useEffect, useRef, useState } from "react";
import { connectEvents, t, type Api } from "@oncare/web-common";
import { VISIT_STEPS, visitProgress } from "../progress";

interface VisitView { id: string; state: string; residentId: string; simulated?: boolean }
const STEP_KEY: Record<(typeof VISIT_STEPS)[number], string> = { requested: "family.visit.step.requested", approval: "family.visit.step.approval", robot: "family.visit.step.robot", ringing: "family.visit.step.ringing", connecting: "family.visit.step.connecting", active: "family.visit.step.active", completed: "family.visit.step.completed" };

export function Visit({ api, apiBase, token, visitId, onBack }: { api: Api; apiBase: string; token: string; visitId: string; onBack: () => void }) {
  const [visit, setVisit] = useState<VisitView | null>(null);
  const [residentName, setResidentName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [actioning, setActioning] = useState(false);
  const sequence = useRef(0); const reportedConnected = useRef(false); const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    try { const response = await api.get<{ visit: VisitView }>(`/visits/${visitId}`); if (request === sequence.current) { setVisit(response.visit); setError(null); } }
    catch { if (request === sequence.current) setError(t("family.error.progress")); }
  }, [api, visitId]);
  useEffect(() => { void refresh(); const interval = setInterval(() => void refresh(), 3000); const events = connectEvents(apiBase, token, (event) => { if (event.entityId === visitId) void refresh(); }); return () => { sequence.current += 1; clearInterval(interval); events.close(); if (retryTimer.current) clearTimeout(retryTimer.current); }; }, [apiBase, refresh, token, visitId]);
  useEffect(() => {
    if (!visit?.residentId) return;
    let active = true;
    void api.get<{ residents: Array<{ id: string; displayName: string }> }>("/me/residents").then((response) => { if (active) setResidentName(response.residents.find((resident) => resident.id === visit.residentId)?.displayName ?? ""); }).catch(() => { if (active) setError(t("family.error.load")); });
    return () => { active = false; };
  }, [api, visit?.residentId]);
  useEffect(() => {
    if (visit?.state !== "connecting" || reportedConnected.current) return;
    reportedConnected.current = true;
    void api.post(`/visits/${visitId}/connected`).then(() => void refresh()).catch(() => { setError(t("family.error.connecting")); retryTimer.current = setTimeout(() => { reportedConnected.current = false; void refresh(); }, 2000); });
  }, [api, refresh, visit?.state, visitId]);
  async function act(action: "cancel" | "end") {
    if (actioning) return;
    setActioning(true); setError(null);
    try { await api.post(`/visits/${visitId}/${action}`); await refresh(); }
    catch { setError(t("family.error.action")); }
    finally { setActioning(false); }
  }
  if (!visit) return <main className="page page--visit"><p className="loading">{t("family.visit.loading")}</p>{error && <p role="alert" className="error">{error}</p>}</main>;
  const progress = visitProgress(visit.state); const canCancel = !progress.terminal && progress.currentIndex < 4;
  return <main className="page page--visit"><button type="button" className="link back" onClick={onBack}>{t("family.visit.back")}</button><p className="wordmark">{t("family.wordmark")}</p><h1>{t("family.visit.title", { name: residentName })}</h1>{visit.simulated && <span className="badge-sim">{t("family.badge.simulated")}</span>}{error && <p role="alert" className="error">{error}</p>}
    <ol className="stepper">{VISIT_STEPS.map((step, index) => { const state = index < progress.currentIndex ? "done" : index === progress.currentIndex ? progress.failed ? "failed" : "current" : "todo"; return <li key={step} className={`step step--${state}`}><span className="step-marker" aria-hidden="true">{index < progress.currentIndex ? "✓" : ""}</span><div aria-current={index === progress.currentIndex ? "step" : undefined}>{t(STEP_KEY[step])}{index === progress.currentIndex && progress.failed && <p className="failed-reason">{t(`family.visit.failed.${progress.failed}`, { name: residentName })}</p>}</div></li>; })}</ol>
    <div className="actions">{canCancel && <button type="button" disabled={actioning} onClick={() => void act("cancel")}>{t("family.visit.cancel")}</button>}{visit.state === "active" && <button type="button" className="danger" disabled={actioning} onClick={() => void act("end")}>{t("family.visit.end")}</button>}<button type="button" className="primary" disabled title={t("family.visit.help_unavailable")}>{t("family.visit.ask_robot")}</button></div>
  </main>;
}
