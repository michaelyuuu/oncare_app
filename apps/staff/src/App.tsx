import { useMemo, useState } from "react";
import { createApi, t } from "@oncare/web-common";
import { Login } from "./pages/Login";
import { Console } from "./pages/Console";
export interface Session {
    token: string;
    displayName: string;
}
function readSession(): Session | null {
    try {
        const value: unknown = JSON.parse(sessionStorage.getItem("oncare.staff") ?? "null");
        if (value && typeof value === "object" && "token" in value && typeof value.token === "string" && value.token && "displayName" in value && typeof value.displayName === "string")
            return { token: value.token, displayName: value.displayName };
    }
    catch { /* A blocked storage or invalid session falls back to login. */ }
    return null;
}
export function App({ apiBase }: {
    apiBase: string;
}) {
    const [session, setSession] = useState(readSession);
    const api = useMemo(() => createApi(apiBase, () => session?.token ?? null), [apiBase, session]);
    function save(next: Session | null) {
        try {
            if (next)
                sessionStorage.setItem("oncare.staff", JSON.stringify(next));
            else
                sessionStorage.removeItem("oncare.staff");
        }
        catch { /* In-memory session remains usable. */ }
        setSession(next);
    }
    if (!session)
        return <Login api={api} onLoggedIn={save}/>;
    return <><header className="masthead"><h1>{t("staff.title")}</h1><span>{session.displayName}</span><button onClick={() => save(null)}>{t("staff.logout")}</button></header><Console api={api} apiBase={apiBase} token={session.token}/></>;
}
