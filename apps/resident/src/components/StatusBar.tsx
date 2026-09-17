import { t } from "@oncare/web-common";
export function StatusBar({ cameraOn, micOn, simulated, callerName }: { cameraOn: boolean; micOn: boolean; simulated: boolean; callerName: string | null }) {
  return <header className="status-bar">
    <div className="privacy-status" aria-live="polite">
      <span className="status"><svg aria-hidden="true" viewBox="0 0 32 32"><rect x="3" y="8" width="17" height="16" rx="3"/><path d="m20 12 9-5v18l-9-5"/>{!cameraOn && <path d="m2 2 28 28"/>}</svg>{t(cameraOn ? "resident.home.status.camera_on" : "resident.home.status.camera_off")}</span>
      <span className="status"><svg aria-hidden="true" viewBox="0 0 32 32"><rect x="11" y="3" width="10" height="18" rx="5"/><path d="M6 15v2a10 10 0 0 0 20 0v-2M16 27v4"/>{!micOn && <path d="m2 2 28 28"/>}</svg>{t(micOn ? "resident.home.status.mic_on" : "resident.home.status.mic_off")}</span>
    </div>
    {simulated && <span className="badge-sim">{t("resident.badge.simulated")}</span>}
    {callerName && <span className="status-caller">{t("resident.incall.connected", { name: callerName })}</span>}
  </header>;
}
