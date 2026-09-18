import { t } from "@oncare/web-common";
import type { Action, Visit } from "../types";
export function Streaming({ visits, onAction, pending }: {
    visits: Visit[];
    onAction: Action;
    pending: string[];
}) {
    if (!visits.length)
        return <p>{t("staff.streaming.none")}</p>;
    return <ul className="rows">{visits.map(v => <li key={v.id}><strong>{t("staff.resident", { id: v.residentId })}</strong><p>{t("staff.requester", { id: v.requesterId })}</p><p>{t(["connecting", "active", "ending"].includes(v.state) ? `staff.call.${v.state}` : "staff.unknown")}</p><p>{t(`staff.camera.${v.cameraState ?? "unknown"}`)}</p><p className="hint">{t("staff.camera.audio")}</p><div className="actions">{(v.cameraState === "on" || v.cameraState === "paused") && <button disabled={pending.includes(`/visits/${v.id}`)} onClick={() => void onAction(`/visits/${v.id}/camera`, { paused: v.cameraState === "on" })}>{t(v.cameraState === "on" ? "staff.camera.pause" : "staff.camera.resume")}</button>}<button disabled={pending.includes(`/visits/${v.id}`) || v.state === "ending"} onClick={() => void onAction(`/visits/${v.id}/end`)}>{t("staff.streaming.end")}</button></div></li>)}</ul>;
}
