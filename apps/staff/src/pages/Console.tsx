import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, connectEvents, t, type Api } from "@oncare/web-common";
import type { QueueData } from "../types";
import { Queue } from "../components/Queue";
import { RobotPanel } from "../components/RobotPanel";
import { Streaming } from "../components/Streaming";
import { AuditTable } from "../components/AuditTable";
import { Locations } from "../components/Locations";
// Matches the source heartbeat bus STALE_SEC; scoped to pose capture only.
const POSE_CAPTURE_MAX_AGE_MS = 6000;
export function Console({ api, apiBase, token, activeDestination }: {
    api: Api;
    apiBase: string;
    token: string;
    activeDestination: string;
}) {
    const [queue, setQueue] = useState<QueueData | null>(null);
    const [freshPoseAt, setFreshPoseAt] = useState<string | null>(null);
    const lastSeenAt = queue?.robot?.lastSeenAt;
    useEffect(() => {
        setFreshPoseAt(null);
        if (!lastSeenAt) return;
        const observed = Date.parse(lastSeenAt);
        const age = Date.now() - observed;
        if (!Number.isFinite(observed) || age < 0 || age >= POSE_CAPTURE_MAX_AGE_MS) return;
        setFreshPoseAt(lastSeenAt);
        const timer = setTimeout(() => setFreshPoseAt(null), POSE_CAPTURE_MAX_AGE_MS - age);
        return () => clearTimeout(timer);
    }, [lastSeenAt, api, token]);
    const [refreshError, setRefreshError] = useState(false);
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [pending, setPending] = useState<string[]>([]);
    const inFlight = useRef(new Set<string>());
    const [revision, setRevision] = useState(0);
    const alive = useRef(true);
    const refreshQueue = useRef<() => void>(() => {});
    const refreshAll = useCallback(() => {
        refreshQueue.current();
        setRevision(v => v + 1);
    }, []);
    useEffect(() => {
        let current = true;
        let fetching = false;
        let refreshAgain = false;
        alive.current = true;
        inFlight.current = new Set();
        setPending([]);
        setErrors({});
        setQueue(null);
        setRefreshError(false);
        async function refresh() {
            if (!current) return;
            if (fetching) {
                refreshAgain = true;
                return;
            }
            fetching = true;
            try {
                const next = await api.get<QueueData>("/queue");
                if (current) {
                    setQueue(next);
                    setRefreshError(false);
                }
            } catch {
                if (current) setRefreshError(true);
            } finally {
                fetching = false;
                // Accept the completed response before running one follow-up for
                // all polls/events received while this request was pending.
                if (current && refreshAgain) {
                    refreshAgain = false;
                    void refresh();
                }
            }
        }
        refreshQueue.current = () => { void refresh(); };
        refreshAll();
        const timer = setInterval(refreshAll, 3000);
        const events = connectEvents(apiBase, token, refreshAll);
        return () => {
            current = false;
            alive.current = false;
            clearInterval(timer);
            events.close();
        };
    }, [api, apiBase, token, refreshAll]);
    async function action(path: string, body?: unknown) {
        const actions = inFlight.current;
        const base = path.substring(0, path.lastIndexOf("/"));
        const isEnd = path.startsWith("/visits/") && path.endsWith("/end");
        const isCamera = path.startsWith("/visits/") && path.endsWith("/camera");
        const key = base + (path.endsWith("/stop") ? "/stop" : isEnd ? "/end" : isCamera ? "/camera" : "");
        if (actions.has(key) || (isCamera && actions.has(`${base}/end`)))
            return;
        actions.add(key);
        setPending([...actions]);
        setErrors(old => { const next = { ...old }; delete next[key]; return next; });
        let succeeded = false;
        try {
            const result = await api.post<{
                delivered?: boolean;
            }>(path, body);
            if (result?.delivered === false)
                throw new ApiError(503, "not_delivered");
            succeeded = true;
        }
        catch (error) {
            const code = error instanceof ApiError ? error.code : "request";
            const supported = ["invalid_pin", "busy", "robot_unavailable", "not_delivered", "camera_control_failed", "camera_unavailable", "not_callable", "forbidden", "not_found", "version_conflict", "invalid_transition"];
            if (alive.current && inFlight.current === actions)
                setErrors(old => ({ ...old, [key]: t(`staff.error.${supported.includes(code) ? code : "request"}`) }));
        }
        finally {
            // A successful end is irreversible for this visit. Retain its lock
            // so stale active queue responses cannot reopen media controls.
            if (!isEnd || !succeeded) actions.delete(key);
            if (alive.current && inFlight.current === actions) {
                setPending([...actions]);
                refreshAll();
            }
        }
    }
    return <div className="console">
    <div className="notices">{refreshError && <p role="alert">{t("staff.error.refresh")}</p>}</div>
    {!queue ? <p role="status">{t("staff.loading")}</p> : <>
      <section className="console-safety robot-column" aria-label={t("staff.robot.title")}>
        <h2>{t("staff.robot.title")}</h2><RobotPanel robot={queue.robot} stale={refreshError} knownBusy={queue.activeVisits.length > 0 || queue.tasksAwaitingLoad.length > 0 || queue.tasksAwaitingHandoff.length > 0} onAction={action} pending={pending} errors={errors}/>
      </section>
      <section className="console-view workboard-view" aria-label={t("staff.workboard.aria")} hidden={activeDestination !== "today"}>
        <h2>{t("staff.queue.title")}</h2><Queue queue={queue} onAction={action} pending={pending} errors={errors}/>
      </section>
      <section className="console-view calls-view" aria-label={t("staff.calls.aria")} hidden={activeDestination !== "calls"}>
        <h2>{t("staff.streaming.title")}</h2><Streaming visits={queue.activeVisits} onAction={action} pending={pending} errors={errors}/>
      </section>
      <section className="console-view robot-view" hidden={activeDestination !== "robot"}>
        <Locations api={api} pose={!refreshError && queue.robot?.connected && freshPoseAt !== null
            && freshPoseAt === lastSeenAt && Date.now() >= Date.parse(freshPoseAt)
            && Date.now() - Date.parse(freshPoseAt) < POSE_CAPTURE_MAX_AGE_MS
            ? queue.robot.lastHeartbeat?.pose ?? null : null}/>
      </section>
    </>}
    <footer className="console-view audit" hidden={activeDestination !== "activity"}><h2>{t("staff.audit.title")}</h2><AuditTable api={api} revision={revision}/></footer>
  </div>;
}
