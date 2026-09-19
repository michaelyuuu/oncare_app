import { useMemo, useState } from "react";
import { createApi, t } from "@oncare/web-common";
import { Login } from "./pages/Login";
import { Console } from "./pages/Console";
import { AdminPanel } from "./admin/AdminPanel";
export interface Session {
    token: string;
    displayName: string;
    role: "staff" | "admin";
}
function readSession(): Session | null {
    try {
        const value: unknown = JSON.parse(sessionStorage.getItem("oncare.staff") ?? "null");
        if (value && typeof value === "object" && "token" in value && typeof value.token === "string" && value.token && "displayName" in value && typeof value.displayName === "string")
            // Sessions saved before the admin role existed have no role: they were staff sessions.
            return { token: value.token, displayName: value.displayName, role: "role" in value && value.role === "admin" ? "admin" : "staff" };
    }
    catch { /* A blocked storage or invalid session falls back to login. */ }
    return null;
}
export function App({ apiBase }: {
    apiBase: string;
}) {
    const [session, setSession] = useState(readSession);
    const [tab, setTab] = useState<"console" | "admin">("console");
    const api = useMemo(() => createApi(apiBase, () => session?.token ?? null), [apiBase, session]);
    function save(next: Session | null) {
        try {
            if (next)
                sessionStorage.setItem("oncare.staff", JSON.stringify(next));
            else
                sessionStorage.removeItem("oncare.staff");
        }
        catch { /* In-memory session remains usable. */ }
        setTab("console");
        setSession(next);
    }
    if (!session)
        return <Login api={api} onLoggedIn={save}/>;
    return <>
      <header className="masthead"><h1>{t("staff.title")}</h1>
        {session.role === "admin" && <nav role="tablist">
          <button role="tab" aria-selected={tab === "console"} onClick={() => setTab("console")}>{t("staff.tab.console")}</button>
          <button role="tab" aria-selected={tab === "admin"} onClick={() => setTab("admin")}>{t("staff.tab.admin")}</button>
        </nav>}
        <span>{session.displayName}</span><button onClick={() => save(null)}>{t("staff.logout")}</button></header>
      {tab === "admin" && session.role === "admin" ? <AdminPanel api={api}/> : <Console api={api} apiBase={apiBase} token={session.token}/>}
    </>;
}
