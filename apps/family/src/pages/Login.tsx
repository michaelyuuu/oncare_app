import { useState, type FormEvent } from "react";
import { ApiError, t, type Api } from "@oncare/web-common";

export function Login({ api, onLoggedIn }: { api: Api; onLoggedIn: (session: { token: string; displayName: string }) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true); setError(null);
    try {
      const response = await api.post<{ token: string; principal: { displayName?: string } }>("/auth/login", { username, password });
      onLoggedIn({ token: response.token, displayName: response.principal.displayName ?? username });
    } catch (caught) {
      setError(caught instanceof ApiError && caught.status === 401 ? t("family.login.failed") : t("family.error.login"));
    } finally { setSubmitting(false); }
  }
  return <main className="page page--login"><section className="welcome"><p className="wordmark">{t("family.wordmark")}</p><h1>{t("family.login.title")}</h1><p>{t("family.login.intro")}</p></section><form onSubmit={submit} noValidate>
    <label htmlFor="username">{t("family.login.username")}</label><input id="username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} />
    <label htmlFor="password">{t("family.login.password")}</label><input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
    {error && <p role="alert" className="error">{error}</p>}
    <button type="submit" className="primary" disabled={submitting}>{t("family.login.submit")}</button>
  </form></main>;
}
