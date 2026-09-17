import { useEffect, useRef, useState } from "react";
import { ApiError, t, type Api } from "@oncare/web-common";
import { PinPad } from "../components/PinPad";
export interface PinGuard { failures: number; lockedUntil: number }
export function Settings({ api, requirePin, currentToken, onSaveToken, onBack, onError = onBack, pinGuard }: { api: Api; requirePin: boolean; currentToken: string | null; onSaveToken: (token: string) => void; onBack: () => void; onError?: () => void; pinGuard?: PinGuard }) {
  const ownGuard = useRef<PinGuard>({ failures: 0, lockedUntil: 0 });
  const guard = pinGuard ?? ownGuard.current;
  const [unlocked, setUnlocked] = useState(!requirePin);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [locked, setLocked] = useState(guard.lockedUntil > Date.now());
  const [shake, setShake] = useState(false);
  const [token, setToken] = useState(currentToken ?? "");
  const mounted = useRef(true);
  const shakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (shakeTimer.current) clearTimeout(shakeTimer.current); }; }, []);
  useEffect(() => {
    if (!locked) return;
    const timer = setTimeout(() => setLocked(false), Math.max(0, guard.lockedUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [locked, guard]);
  const submitPin = async (pin: string) => {
    if (busy.current || Date.now() < guard.lockedUntil) return;
    busy.current = true; setPending(true);
    try {
      await api.post("/device/unlock", { pin });
      guard.failures = 0;
      if (mounted.current) setUnlocked(true);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "invalid_pin") { if (mounted.current) onError(); return; }
      // Attempt accounting belongs to the persistent guard, even after Back unmounts this screen.
      guard.failures++;
      if (guard.failures >= 3) { guard.lockedUntil = Date.now() + 30_000; guard.failures = 0; }
      if (!mounted.current) return;
      setShake(true);
      if (shakeTimer.current) clearTimeout(shakeTimer.current);
      shakeTimer.current = setTimeout(() => setShake(false), 400);
      setLocked(guard.lockedUntil > Date.now());
    } finally { busy.current = false; if (mounted.current) setPending(false); }
  };
  return <section className={`screen screen--settings${shake ? " shake" : ""}`}>
    <h1>{t("resident.settings.title")}</h1>
    {!unlocked ? <><p>{t("resident.settings.pin")}</p><PinPad onSubmit={(pin) => void submitPin(pin)} disabled={pending || locked}/></> : <form onSubmit={(event) => { event.preventDefault(); if (token.trim()) onSaveToken(token.trim()); }}>
      <label htmlFor="device-token">{t("resident.settings.device_token")}</label>
      <input id="device-token" type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" spellCheck={false}/>
      <button type="submit" className="quiet-button" disabled={!token.trim()}>{t("resident.settings.save")}</button>
    </form>}
    <button type="button" className="quiet-button" onClick={onBack}>{t("resident.settings.back")}</button>
  </section>;
}
