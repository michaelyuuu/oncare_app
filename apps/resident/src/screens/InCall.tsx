import { useState } from "react";
import { t } from "@oncare/web-common";
import { BigButton } from "../components/BigButton";
export function InCall({ callerName, active, onEnd, disabled = false }: { callerName: string; active: boolean; onEnd: () => void; disabled?: boolean }) {
  const [volume, setVolume] = useState(70);
  const caption = active ? t("resident.incall.connected", { name: callerName }) : t("resident.incall.connecting");
  return <section className="screen screen--incall">
    <div className="video-stage" data-testid="video-stage" aria-label={caption}><p>{caption}</p></div>
    <div className="call-controls">
      <button type="button" className="quiet-button" onClick={() => setVolume((value) => Math.max(0, value - 10))}>{t("resident.incall.quieter")}</button>
      <span aria-live="polite">{t("resident.incall.volume", { volume })}</span>
      <button type="button" className="quiet-button" onClick={() => setVolume((value) => Math.min(100, value + 10))}>{t("resident.incall.louder")}</button>
    </div>
    <BigButton tone="danger" disabled={disabled} onClick={onEnd}>{t("resident.incall.end")}</BigButton>
  </section>;
}
