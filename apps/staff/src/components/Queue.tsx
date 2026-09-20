import { t } from "@oncare/web-common";
import type { Action, QueueData } from "../types";
export function Queue({ queue, onAction, pending }: {
    queue: QueueData;
    onAction: Action;
    pending: string[];
}) {
    const assistanceRequests = queue.assistanceRequests ?? [];
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
    if (!rows.length && !queue.caregiverCalls.length && !assistanceRequests.length)
        return <p>{t("staff.queue.empty")}</p>;
    return <ul className="rows">
      {assistanceRequests.map(row => {
        const rowKey = `/staff/assistance-requests/${row.id}`;
        const actions: string[] = [];
        if (row.handlingState === "open" && row.withdrawalState === "none") actions.push("acknowledge");
        if (row.handlingState === "acknowledged") actions.push("in_progress");
        if (row.handlingState === "in_progress") actions.push("resolve");
        if ((row.deliveryState === "pending" || row.deliveryState === "unknown") && row.withdrawalState === "none") actions.push("fail_delivery");
        if (row.withdrawalState === "requested") actions.push("confirm_withdrawal");
        if (row.handlingState !== "resolved" && row.handlingState !== "cancelled") actions.push("reject");
        const status = row.handlingState === "resolved"
          ? t("staff.assistance.resolved")
          : row.handlingState === "cancelled"
            ? t("staff.assistance.cancelled")
          : row.handlingState === "in_progress"
            ? t("staff.assistance.in_progress")
            : row.handlingState === "acknowledged"
              ? t("staff.assistance.acknowledged")
              : row.deliveryState === "delivered"
                ? t("staff.assistance.reached_queue")
              : row.deliveryState === "failed"
                ? t("staff.assistance.delivery_failed")
                : t("staff.assistance.recorded");
        return <li key={rowKey} className="assistance-row">
          <strong>{t("staff.queue.assistance")}</strong>
          <p>{t("staff.resident", { id: row.residentId })}</p>
          <p className="assistance-status">{status}</p>
          {row.note && <p>{row.note}</p>}
          <time dateTime={row.createdAt}>{new Date(row.createdAt).toLocaleString()}</time>
          <div className="actions">{actions.map(action => <button key={action} disabled={pending.includes(rowKey)} onClick={() => void onAction(`/staff/assistance-requests/${row.id}/${action}`, { version: row.version })}>{t(`staff.assistance.action_${action}`)}</button>)}</div>
        </li>;
      })}
      {rows.map(row => <li key={row.key}><strong>{t(`staff.queue.${row.label}`)}</strong><p>{t("staff.resident", { id: row.resident })}</p>{row.item && <p>{t(["water_bottle", "tissue_box", "tv_remote"].includes(row.item) ? `item.${row.item}` : "item.unknown")}</p>}<div className="actions">{row.actions.map(action => <button key={action} disabled={pending.includes(row.key)} onClick={() => void onAction(`${row.key}/${action}`)}>{t(`staff.queue.${action}`)}</button>)}</div></li>)}
      {queue.caregiverCalls.map(row => <li key={row.id}><strong>{t("staff.queue.caregiver")}</strong><p>{row.residentId ? t("staff.resident", { id: row.residentId }) : t("staff.queue.resident_unknown")}</p><time dateTime={row.at}>{new Date(row.at).toLocaleString()}</time></li>)}
    </ul>;
}
