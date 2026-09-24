import { useEffect, useState } from "react";
import { ApiError, type Api, t } from "@oncare/web-common";

export function IncomingVisit({
  api,
  visitId,
  residentName,
  onAnswered,
  onDeclined,
}: {
  api: Api;
  visitId: string;
  residentName?: string;
  onAnswered: (visitId: string) => void;
  onDeclined: () => void;
}) {
  const [name, setName] = useState(residentName ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (residentName) return;
    let active = true;
    void api.get<{ visit?: { residentId?: string } }>(`/visits/${encodeURIComponent(visitId)}`).then(async (response) => {
      if (!active || !response.visit?.residentId) return;
      try {
        const residents = await api.get<{ residents?: Array<{ id: string; displayName: string }> }>("/me/residents");
        const match = residents.residents?.find((resident) => resident.id === response.visit?.residentId);
        if (active) setName(match?.displayName ?? t("family.incoming.resident_fallback"));
      } catch {
        if (active) setName(t("family.incoming.resident_fallback"));
      }
    }).catch(() => { if (active) setName(t("family.incoming.resident_fallback")); });
    return () => { active = false; };
  }, [api, visitId, residentName]);

  const act = async (action: "answer_family" | "cancel") => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/visits/${encodeURIComponent(visitId)}/${action}`, {});
      if (action === "answer_family") onAnswered(visitId);
      else onDeclined();
    } catch (failure) {
      setError(failure instanceof ApiError && failure.status === 409 ? t("family.incoming.expired") : t("family.incoming.error"));
    } finally { setBusy(false); }
  };

  const display = name || t("family.incoming.resident_fallback");
  return <main className="page page--incoming" aria-label={t("family.incoming.aria")}>
    <p className="wordmark">{t("family.wordmark")}</p>
    <section className="incoming-visit">
      <p className="incoming-visit__eyebrow">{t("family.incoming.brand")}</p>
      <h1>{t("family.incoming.title", { name: display })}</h1>
      <p>{t("family.incoming.body")}</p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="incoming-visit__actions">
        <button type="button" className="primary" onClick={() => void act("answer_family")} disabled={busy}>{t("family.incoming.answer")}</button>
        <button type="button" onClick={() => void act("cancel")} disabled={busy}>{t("family.incoming.decline")}</button>
      </div>
    </section>
  </main>;
}
