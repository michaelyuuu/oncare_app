import { useEffect, useRef, useState } from "react";
import { ApiError, t, type Api } from "@oncare/web-common";

interface ResidentCard { id: string; displayName: string; availability: string; relationship: { consentVideo: boolean; consentRobotVisit: boolean } }
function errorMessage(error: unknown, name: string): string {
  const code = error instanceof ApiError ? error.code : "http_error";
  const key = `family.visit.failed.${code}`;
  const translated = t(key, { name });
  return translated === key ? code : translated;
}

export function Residents({ api, displayName, onScheduleVisit, onCallNow, onLogout }: { api: Api; displayName: string; onScheduleVisit: (resident: ResidentCard) => void; onCallNow: (resident: ResidentCard) => Promise<void>; onLogout: () => void }) {
  const [residents, setResidents] = useState<ResidentCard[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState<string | null>(null);
  const latestLoad = useRef(0);
  useEffect(() => {
    const request = ++latestLoad.current;
    void api.get<{ residents: ResidentCard[] }>("/me/residents").then((response) => { if (request === latestLoad.current) setResidents(response.residents); }).catch(() => { if (request === latestLoad.current) setError(t("family.error.load")); });
    return () => { latestLoad.current += 1; };
  }, [api]);
  async function callNow(resident: ResidentCard) {
    if (requesting) return;
    setRequesting(resident.id); setError(null);
    try { await onCallNow(resident); }
    catch (caught) { setError(errorMessage(caught, resident.displayName)); }
    finally { setRequesting(null); }
  }
  return <main className="page page--residents"><header className="masthead"><div><p className="wordmark">{t("family.wordmark")}</p><h1>{t("family.residents.title")}</h1></div><button type="button" className="link" onClick={onLogout}>{t("family.residents.logout", { name: displayName })}</button></header>
    {error && <p role="alert" className="error">{error}</p>}
    <ul className="cards">{residents.map((resident) => <li key={resident.id} className="card"><h2>{resident.displayName}</h2><p className={`availability availability--${resident.availability}`}>{t(`family.residents.availability.${resident.availability}`)}</p><div className="resident-card__actions"><button type="button" className="primary" disabled={resident.availability === "not_available" || !resident.relationship.consentRobotVisit || requesting !== null} onClick={() => onScheduleVisit(resident)}>{t("family.residents.schedule")}</button><button type="button" disabled={resident.availability === "not_available" || !resident.relationship.consentVideo || !resident.relationship.consentRobotVisit || requesting !== null} onClick={() => void callNow(resident)}>{t("family.residents.call_now")}</button></div></li>)}</ul>
  </main>;
}
