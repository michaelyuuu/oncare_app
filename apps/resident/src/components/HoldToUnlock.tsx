import { useEffect, useRef, type KeyboardEvent } from "react";
import { t } from "@oncare/web-common";
export function HoldToUnlock({ onHome, onUnlock, holdMs = 3000 }: { onHome: () => void; onUnlock: () => void; holdMs?: number }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggered = useRef(false);
  const stop = () => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; };
  useEffect(() => stop, []);
  const start = () => {
    stop();
    longPressTriggered.current = false;
    timer.current = setTimeout(() => { timer.current = null; longPressTriggered.current = true; onUnlock(); }, holdMs);
  };
  const goHome = () => {
    if (longPressTriggered.current) { longPressTriggered.current = false; return; }
    onHome();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if ((event.key === "Enter" || event.key === " ") && !event.repeat) start();
  };
  const handleKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    stop();
  };
  return <button type="button" className="hold-logo" aria-label={t("resident.settings.hold")} onClick={goHome} onPointerDown={start} onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop} onKeyDown={handleKeyDown} onKeyUp={handleKeyUp} onBlur={stop}>
    <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M8 23 24 9l16 14v18H8Z"/><path d="M17 29h14M24 22v14"/></svg>
  </button>;
}
