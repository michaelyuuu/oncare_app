const KEY = "oncare.deviceToken";
export function readDeviceToken(): string | null { try { return localStorage.getItem(KEY)?.trim() || null; } catch { return null; } }
export function writeDeviceToken(token: string): void { try { localStorage.setItem(KEY, token); } catch { /* Private browsing can deny persistence. */ } }
