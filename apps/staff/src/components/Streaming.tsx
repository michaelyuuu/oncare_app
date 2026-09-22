import { t } from "@oncare/web-common";
import type { Action, Visit } from "../types";
export function Streaming({ visits, onAction, pending, errors }: {
    visits: Visit[];
    onAction: Action;
    pending: string[];
    errors: Record<string, string>;
}) {
    if (!visits.length) return <p>{t("staff.streaming.none")}</p>;
    return <ul className="rows">{visits.map(v => {
        const base = `/visits/${v.id}`;
        const ending = pending.includes(`${base}/end`) || v.state === "ending";
        const error = errors[`${base}/end`] ?? errors[`${base}/camera`];
        return <li key={v.id} className="call-row">
            <strong>{t("staff.resident", { id: v.residentId })}</strong>
            <p>{t("staff.requester", { id: v.requesterId })}</p>
            <p>{t(["connecting", "active", "ending"].includes(v.state) ? `staff.call.${v.state}` : "staff.unknown")}</p>
            <p>{t(`staff.camera.${v.cameraState ?? "unknown"}`)}</p>
            <p className="hint">{t("staff.camera.audio")}</p>
            {error && <p className="row-error" role="alert">{error}</p>}
            <div className="actions">
                {(v.cameraState === "on" || v.cameraState === "paused") && <button
                    disabled={ending || pending.includes(`${base}/camera`)}
                    onClick={() => void onAction(`${base}/camera`, { paused: v.cameraState === "on" })}
                >{t(v.cameraState === "on" ? "staff.camera.pause" : "staff.camera.resume")}</button>}
                <button disabled={ending} onClick={() => void onAction(`${base}/end`)}>
                    {t("staff.streaming.end")}
                </button>
            </div>
        </li>;
    })}</ul>;
}
