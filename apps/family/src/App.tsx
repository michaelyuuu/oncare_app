import { useEffect, useMemo, useRef, useState } from "react";
import { connectEvents, createApi } from "@oncare/web-common";
import { readSession, writeSession, type Session } from "./session";
import { Login } from "./pages/Login";
import { Residents } from "./pages/Residents";
import { Visit } from "./pages/Visit";
import { ScheduleVisit } from "./pages/ScheduleVisit";
import { IncomingVisit } from "./pages/IncomingVisit";

type Route = { name: "residents" } | { name: "schedule"; residentId: string; residentName: string } | { name: "visit"; id: string };
type Incoming = { id: string; residentId: string };
export function App({ apiBase, initialVisitId }: { apiBase: string; initialVisitId?: string }) {
  const [session, setSession] = useState<Session | null>(() => readSession());
  const [route, setRoute] = useState<Route>(initialVisitId ? { name: "visit", id: initialVisitId } : { name: "residents" });
  const [incomingVisit, setIncomingVisit] = useState<Incoming | null>(null);
  const promptedIncoming = useRef(new Set<string>());
  const api = useMemo(() => createApi(apiBase, () => session?.token ?? null), [apiBase, session]);

  useEffect(() => {
    if (!session) return;
    let active = true;
    const refreshIncoming = async () => {
      try {
        const response = await api.get<{ visits?: Incoming[] }>("/visits/incoming");
        const next = response.visits?.[0];
        if (!active || !next || promptedIncoming.current.has(next.id)) return;
        promptedIncoming.current.add(next.id);
        setIncomingVisit(next);
      } catch {
        // A temporary polling failure should not interrupt the current family screen.
      }
    };
    void refreshIncoming();
    const interval = setInterval(() => void refreshIncoming(), 3000);
    const events = connectEvents(apiBase, session.token, (event) => {
      if (event.entityType === "visit") void refreshIncoming();
    });
    return () => { active = false; clearInterval(interval); events.close(); };
  }, [api, apiBase, session]);

  const startImmediateVisit = async (residentId: string) => {
    const response = await api.post<{ visit: { id: string } }>("/visits/now", { residentId });
    setRoute({ name: "visit", id: response.visit.id });
  };

  if (!session) return <Login api={api} onLoggedIn={(next) => { writeSession(next); setSession(next); }} />;
  if (incomingVisit) return <IncomingVisit api={api} visitId={incomingVisit.id} onAnswered={(id) => { setIncomingVisit(null); setRoute({ name: "visit", id }); }} onDeclined={() => setIncomingVisit(null)} />;
  if (route.name === "visit") return <Visit api={api} apiBase={apiBase} token={session.token} visitId={route.id} onBack={() => setRoute({ name: "residents" })} />;
  if (route.name === "schedule") return <ScheduleVisit api={api} residentId={route.residentId} residentName={route.residentName} onBack={() => setRoute({ name: "residents" })} onCreated={() => {}} onImmediate={(id) => setRoute({ name: "visit", id })} onVisit={(id) => setRoute({ name: "visit", id })} />;
  return <Residents api={api} displayName={session.displayName} onScheduleVisit={(resident) => setRoute({ name: "schedule", residentId: resident.id, residentName: resident.displayName })} onCallNow={(resident) => startImmediateVisit(resident.id)} onLogout={() => { writeSession(null); setSession(null); }} />;
}
