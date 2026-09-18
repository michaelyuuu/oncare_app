import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, connectEvents, t, type Api } from "@oncare/web-common";
import type { QueueData } from "../types";
import { Queue } from "../components/Queue";
import { RobotPanel } from "../components/RobotPanel";
import { Streaming } from "../components/Streaming";
import { AuditTable } from "../components/AuditTable";
export function Console({ api, apiBase, token }: {
    api: Api;
    apiBase: string;
    token: string;
}) {
    const [queue, setQueue] = useState<QueueData | null>(null);
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
        const key = path.substring(0, path.lastIndexOf("/")) + (path.endsWith("/stop") ? "/stop" : "");
        if (inFlight.current.has(key))
            return;
        inFlight.current.add(key);
        setPending([...inFlight.current]);
        setErrors(old => { const next = { ...old }; delete next[key]; return next; });
        try {
            const result = await api.post<{
                delivered?: boolean;
            }>(path, body);
            if (result?.delivered === false)
                throw new ApiError(503, "not_delivered");
        }
        catch (error) {
            const code = error instanceof ApiError ? error.code : "request";
            const supported = ["invalid_pin", "busy", "robot_unavailable", "not_delivered", "camera_control_failed", "camera_unavailable", "not_callable", "forbidden", "not_found"];
            if (alive.current)
                setErrors(old => ({ ...old, [key]: t(`staff.error.${supported.includes(code) ? code : "request"}`) }));
        }
        finally {
            inFlight.current.delete(key);
            if (alive.current) {
                setPending([...inFlight.current]);
                refreshAll();
            }
        }
    }
    return <main className="console">
    <div className="notices">{refreshError && <p role="alert">{t("staff.error.refresh")}</p>}{Object.entries(errors).map(([key, error]) => <p role="alert" key={key}>{error}</p>)}</div>
    {!queue ? <p role="status">{t("staff.loading")}</p> : <>
      <section className="column queue-column"><h2>{t("staff.queue.title")}</h2><Queue queue={queue} onAction={action} pending={pending}/></section>
      <section className="column robot-column"><h2>{t("staff.robot.title")}</h2><RobotPanel robot={queue.robot} stale={refreshError} knownBusy={queue.activeVisits.length > 0 || queue.tasksAwaitingLoad.length > 0 || queue.tasksAwaitingHandoff.length > 0} onAction={action} pending={pending}/></section>
      <section className="column"><h2>{t("staff.streaming.title")}</h2><Streaming visits={queue.activeVisits} onAction={action} pending={pending}/></section>
    </>}
    <footer className="audit"><h2>{t("staff.audit.title")}</h2><AuditTable api={api} revision={revision}/></footer>
  </main>;
}
