import { useMemo, useState } from "react";
import { createApi, t } from "@oncare/web-common";
import { Login } from "./pages/Login";
import { Console } from "./pages/Console";
import { AdminPanel } from "./admin/AdminPanel";
type Destination = "today" | "calls" | "robot" | "activity" | "laundry" | "residents" | "family_links" | "people" | "devices";
const staffDestinations: readonly Destination[] = ["today", "calls", "robot", "activity"];
const managerDestinations: readonly Destination[] = ["laundry", "residents", "family_links", "people", "devices"];
const destinationLabels: Record<Destination, string> = {
    today: "staff.workspace.today", calls: "staff.workspace.calls", robot: "staff.workspace.robot", activity: "staff.workspace.activity",
    laundry: "staff.workspace.laundry", residents: "staff.workspace.residents", family_links: "staff.workspace.family_links",
    people: "staff.workspace.people", devices: "staff.workspace.devices",
};
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
    const [destination, setDestination] = useState<Destination>("today");
    const [managerVisited, setManagerVisited] = useState(false);
    const api = useMemo(() => createApi(apiBase, () => session?.token ?? null), [apiBase, session]);
    function save(next: Session | null) {
        try {
            if (next)
                sessionStorage.setItem("oncare.staff", JSON.stringify(next));
            else
                sessionStorage.removeItem("oncare.staff");
        }
        catch { /* In-memory session remains usable. */ }
        setDestination("today");
        setManagerVisited(false);
        setSession(next);
    }
    function navigate(next: Destination) {
        setDestination(next);
        if (managerDestinations.includes(next)) setManagerVisited(true);
    }
    if (!session)
        return <Login api={api} managerMode={new URLSearchParams(window.location.search).get("mode") === "manager"} onLoggedIn={save}/>;
    const destinations = session.role === "admin" ? [...staffDestinations, ...managerDestinations] : staffDestinations;
    const managerPage = session.role === "admin" && managerDestinations.includes(destination);
    return <div className="staff-workspace">
      <aside className="workspace-rail">
        <div className="workspace-brand"><span aria-hidden="true">OC</span><strong>{t("staff.title")}</strong></div>
        <nav className="workspace-navigation" aria-label="Workspace">
          {destinations.map((item, index) => <span className={index === staffDestinations.length && session.role === "admin" ? "workspace-nav-start" : undefined} key={item}>
            <button type="button" aria-current={destination === item ? "page" : undefined} onClick={() => navigate(item)}>{t(destinationLabels[item])}</button>
          </span>)}
        </nav>
      </aside>
      <div className="workspace-frame">
        <header className="workspace-topbar">
          <div className="workspace-identity"><span className="workspace-identity-name">{session.displayName}</span><span className="workspace-role">{t(session.role === "admin" ? "staff.workspace.manager_access" : "staff.workspace.staff_access")}</span></div>
          <div className="workspace-account"><span className="workspace-session" role="status"><span aria-hidden="true"/> {t("staff.workspace.signed_in")}</span><button type="button" onClick={() => save(null)}>{t("staff.logout")}</button></div>
        </header>
        <main className="workspace-main">
          <h1 className="workspace-page-title">{t(destinationLabels[destination])}</h1>
          <Console api={api} apiBase={apiBase} token={session.token} activeDestination={destination}/>
          {session.role === "admin" && managerVisited && <div className="workspace-manager" hidden={!managerPage}><AdminPanel api={api}/></div>}
        </main>
      </div>
    </div>;
}
