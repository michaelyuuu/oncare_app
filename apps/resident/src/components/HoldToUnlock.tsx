import { useEffect, useRef } from "react";
import { t } from "@oncare/web-common";
export function HoldToUnlock({ onUnlock, holdMs = 3000 }: { onUnlock: () => void; holdMs?: number }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = () => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; };
  useEffect(() => stop, []);
  const start = () => { stop(); timer.current = setTimeout(() => { timer.current = null; onUnlock(); }, holdMs); };
  return <button type="button" className="hold-logo" aria-label={t("resident.settings.hold")} onPointerDown={start} onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onUnlock(); } }}>
    <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M8 23 24 9l16 14v18H8Z"/><path d="M17 29h14M24 22v14"/></svg>
  </button>;
}
