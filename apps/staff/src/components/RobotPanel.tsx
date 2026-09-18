import { useState } from "react";
import { t } from "@oncare/web-common";
import type { Action, Robot } from "../types";
export function RobotPanel({ robot, onAction, pending, knownBusy, stale }: {
    robot: Robot | null;
    onAction: Action;
    pending: string[];
    knownBusy: boolean;
    stale: boolean;
}) {
    const [askPin, setAskPin] = useState(false);
    const [pin, setPin] = useState("");
    const hb = robot?.lastHeartbeat;
    const base = `/robots/${robot?.robotId}`;
    const busy = pending.includes(base);
    const unknown = t("staff.unknown");
    return <div className="robot-panel">{!robot && <p>{t("staff.robot.none")}</p>}<div className="pills"><span>{t(robot?.connected ? "staff.robot.connected" : "staff.robot.disconnected")}</span><span>{t(hb?.robotReady ? "staff.robot.ready" : "staff.robot.not_ready")}</span>{hb?.adapter === "mock" && <strong className="simulated">{t("staff.robot.simulated")}</strong>}</div>
 <button className="stop" disabled={!robot || pending.includes(`${base}/stop`)} onClick={() => void onAction(`${base}/stop`)}>{t("staff.robot.stop")}</button>
 <dl><dt>{t("staff.robot.nav")}</dt><dd>{t(["idle", "navigating", "arrived", "failed", "stopped"].includes(hb?.navState ?? "") ? `staff.nav.${hb?.navState}` : "staff.unknown")}</dd><dt>{t("staff.robot.estop")}</dt><dd>{hb?.estop === undefined ? unknown : t(hb.estop ? "staff.yes" : "staff.no")}</dd><dt>{t("staff.robot.battery")}</dt><dd>{typeof hb?.battery === "number" ? t("staff.percent", { value: hb.battery }) : unknown}</dd><dt>{t("staff.robot.pose")}</dt><dd>{hb?.pose ? t("staff.robot.coordinates", { x: hb.pose.x.toFixed(2), y: hb.pose.y.toFixed(2), yaw: hb.pose.yaw.toFixed(2) }) : unknown}</dd><dt>{t("staff.robot.correlation")}</dt><dd>{hb?.activeCorrelationId ?? t("staff.none")}</dd></dl>
 {!askPin ? <button disabled={!robot || busy} onClick={() => setAskPin(true)}>{t("staff.robot.release")}</button> : <form onSubmit={e => { e.preventDefault(); if (!pin.trim() || busy)
        return; const entered = pin; setPin(""); setAskPin(false); void onAction(`${base}/resume`, { pin: entered }); }}><label htmlFor="staff-pin">{t("staff.robot.pin")}</label><input id="staff-pin" type="password" autoComplete="off" inputMode="numeric" autoFocus value={pin} onChange={e => setPin(e.target.value)}/><button disabled={busy || !pin.trim()}>{t("staff.robot.release")}</button><button type="button" onClick={() => { setPin(""); setAskPin(false); }}>{t("staff.cancel")}</button></form>}
 <button disabled={!robot?.connected || !hb?.robotReady || !!hb?.activeCorrelationId || knownBusy || busy || stale || hb?.estop === true} onClick={() => void onAction(`${base}/standby`)}>{t("staff.robot.standby")}</button></div>;
}
