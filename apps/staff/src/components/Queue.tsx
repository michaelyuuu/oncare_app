import { t } from "@oncare/web-common";
import type { Action, QueueData } from "../types";
export function Queue({ queue, onAction, pending }: {
    queue: QueueData;
    onAction: Action;
    pending: string[];
}) {
    const taskGroups: Array<{
        tasks: QueueData["tasksAwaitingLoad"];
        actions: string[];
    }> = [
        { tasks: queue.tasksAwaitingApproval, actions: ["approve", "deny"] },
        { tasks: queue.tasksAwaitingLoad, actions: ["loaded"] },
        { tasks: queue.tasksAwaitingHandoff, actions: ["received"] },
    ];
    const rows = [
        ...queue.visitsAwaitingApproval.map(v => ({ key: `/visits/${v.id}`, label: "visit", resident: v.residentId, item: null, actions: ["approve", "deny"] })),
        ...taskGroups.flatMap(({ tasks, actions }) => tasks.map(k => ({ key: `/tasks/${k.id}`, label: "task", resident: k.residentId, item: k.proposal?.item, actions }))),
    ];
    if (!rows.length && !queue.caregiverCalls.length)
        return <p>{t("staff.queue.empty")}</p>;
    return <ul className="rows">{rows.map(row => <li key={row.key}><strong>{t(`staff.queue.${row.label}`)}</strong><p>{t("staff.resident", { id: row.resident })}</p>{row.item && <p>{t(["water_bottle", "tissue_box", "tv_remote"].includes(row.item) ? `item.${row.item}` : "item.unknown")}</p>}<div className="actions">{row.actions.map(action => <button key={action} disabled={pending.includes(row.key)} onClick={() => void onAction(`${row.key}/${action}`)}>{t(`staff.queue.${action}`)}</button>)}</div></li>)}
  {queue.caregiverCalls.map(row => <li key={row.id}><strong>{t("staff.queue.caregiver")}</strong><p>{row.residentId ? t("staff.resident", { id: row.residentId }) : t("staff.queue.resident_unknown")}</p><time dateTime={row.at}>{new Date(row.at).toLocaleString()}</time></li>)}</ul>;
}
