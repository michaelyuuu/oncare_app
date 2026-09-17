import { useMemo, useState } from "react";
import { createApi } from "@oncare/web-common";
import { readSession, writeSession, type Session } from "./session";
import { Login } from "./pages/Login";
import { Residents } from "./pages/Residents";
import { Visit } from "./pages/Visit";

type Route = { name: "residents" } | { name: "visit"; id: string };
export function App({ apiBase, initialVisitId }: { apiBase: string; initialVisitId?: string }) {
  const [session, setSession] = useState<Session | null>(() => readSession());
  const [route, setRoute] = useState<Route>(initialVisitId ? { name: "visit", id: initialVisitId } : { name: "residents" });
  const api = useMemo(() => createApi(apiBase, () => session?.token ?? null), [apiBase, session]);
  if (!session) return <Login api={api} onLoggedIn={(next) => { writeSession(next); setSession(next); }} />;
  if (route.name === "visit") return <Visit api={api} apiBase={apiBase} token={session.token} visitId={route.id} onBack={() => setRoute({ name: "residents" })} />;
  return <Residents api={api} displayName={session.displayName} onVisitCreated={(id) => setRoute({ name: "visit", id })} onLogout={() => { writeSession(null); setSession(null); }} />;
}
