import { useRef, useState, type FormEvent } from "react";
import { ApiError, t, type Api } from "@oncare/web-common";
import type { Session } from "../App";
export function Login({ api, onLoggedIn }: {
    api: Api;
    onLoggedIn: (session: Session) => void;
}) {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const pending = useRef(false);
    async function submit(event: FormEvent) {
        event.preventDefault();
        if (pending.current)
            return;
        pending.current = true;
        setBusy(true);
        setError("");
        try {
            const result = await api.post<{
                token: string;
                principal: {
                    role: string;
                    displayName?: string;
                };
            }>("/auth/login", { username, password });
            const role = result.principal.role;
            if (role !== "staff" && role !== "admin") {
                setError(t("staff.login.not_staff_or_admin"));
                return;
            }
            onLoggedIn({ token: result.token, displayName: result.principal.displayName ?? username, role });
        }
        catch (error) {
            setError(t(error instanceof ApiError && error.status === 401 ? "family.login.failed" : "family.error.login"));
        }
        finally {
            pending.current = false;
            setBusy(false);
            setPassword("");
        }
    }
    return <main className="login"><h1>{t("staff.login.title")}</h1><form onSubmit={submit}>
    <label htmlFor="username">{t("family.login.username")}</label><input id="username" autoComplete="username" required value={username} onChange={e => setUsername(e.target.value)}/>
    <label htmlFor="password">{t("family.login.password")}</label><input id="password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)}/>
    {error && <p role="alert">{error}</p>}<button disabled={busy}>{t("family.login.submit")}</button>
  </form></main>;
}
