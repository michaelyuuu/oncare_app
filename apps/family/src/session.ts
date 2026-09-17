const KEY = "oncare.family";
export interface Session { token: string; displayName: string }

export function readSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && "token" in value && "displayName" in value && typeof value.token === "string" && typeof value.displayName === "string" ? { token: value.token, displayName: value.displayName } : null;
  } catch { return null; }
}

export function writeSession(session: Session | null): void {
  try { if (session) sessionStorage.setItem(KEY, JSON.stringify(session)); else sessionStorage.removeItem(KEY); } catch { /* storage can be unavailable */ }
}
