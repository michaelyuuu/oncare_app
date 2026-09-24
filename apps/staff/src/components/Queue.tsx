import { useState } from "react";
import { t } from "@oncare/web-common";
import type { Action, QueueData } from "../types";

type WorkFilter = "all" | "assistance" | "visits" | "deliveries" | "caregiver";

const knownStatusKeys: Record<string, string> = {
    awaiting_policy_or_staff: "staff.queue.status_awaiting_review",
    locating_item: "staff.queue.status_locating_item",
    placing: "staff.queue.status_placing",
};

function statusLabel(state: string) {
    const key = knownStatusKeys[state];
    return key ? t(key) : state;
}

function displayTime(value: string) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value;
}

export function Queue({ queue, onAction, pending, errors }: {
    queue: QueueData;
    onAction: Action;
    pending: string[];
    errors: Record<string, string>;
}) {
    const [filter, setFilter] = useState<WorkFilter>("all");
    const [residentFilter, setResidentFilter] = useState("");
    const assistanceRequests = queue.assistanceRequests ?? [];
    const reservations = queue.reservations ?? [];
    const dispatchFailures = queue.dispatchFailures ?? [];
    const taskGroups: Array<{ tasks: QueueData["tasksAwaitingLoad"]; actions: string[] }> = [
        { tasks: queue.tasksAwaitingApproval, actions: ["approve", "deny"] },
        { tasks: queue.tasksAwaitingLoad, actions: ["loaded"] },
        { tasks: queue.tasksAwaitingHandoff, actions: ["received"] },
    ];
    const rows = [
        ...queue.visitsAwaitingApproval.map(v => ({ key: `/visits/${v.id}`, kind: "visits" as const, label: "visit", resident: v.residentId, item: null, state: v.state, createdAt: v.createdAt, actions: ["approve", "deny"] })),
        ...taskGroups.flatMap(({ tasks, actions }) => tasks.map(k => ({ key: `/tasks/${k.id}`, kind: "deliveries" as const, label: "task", resident: k.residentId, item: k.proposal?.item, state: k.state, createdAt: k.createdAt, actions }))),
    ];
    const show = (kind: Exclude<WorkFilter, "all">) => filter === "all" || filter === kind;
    const residentQuery = residentFilter.trim().toLocaleLowerCase();
    const matchesResident = (residentId?: string | null) => !residentQuery || residentId?.toLocaleLowerCase().includes(residentQuery) === true;
    const hasWork = rows.length + queue.caregiverCalls.length + assistanceRequests.length + reservations.length + dispatchFailures.length > 0;
    const hasVisibleWork = (show("assistance") && assistanceRequests.some(row => matchesResident(row.residentId)))
        || (show("visits") && rows.some(row => row.kind === "visits" && matchesResident(row.resident)))
        || (show("deliveries") && rows.some(row => row.kind === "deliveries" && matchesResident(row.resident)))
        || (show("visits") && reservations.some(row => matchesResident(row.residentDisplayName)))
        || (show("visits") && dispatchFailures.some(row => matchesResident(row.residentDisplayName)))
        || (show("caregiver") && queue.caregiverCalls.some(row => matchesResident(row.residentId)));

    return <>
      <div className="workboard-toolbar">
        <label>{t("staff.queue.filter")}
          <select value={filter} onChange={event => setFilter(event.target.value as WorkFilter)}>
            <option value="all">{t("staff.queue.filter_all")}</option>
            <option value="assistance">{t("staff.queue.filter_assistance")}</option>
            <option value="visits">{t("staff.queue.filter_visits")}</option>
            <option value="deliveries">{t("staff.queue.filter_deliveries")}</option>
            <option value="caregiver">{t("staff.queue.filter_caregiver")}</option>
          </select>
        </label>
        <label>{t("staff.queue.resident_filter")}
          <input type="search" value={residentFilter} onChange={event => setResidentFilter(event.target.value)}/>
        </label>
      </div>
      {!hasWork ? <p>{t("staff.queue.empty")}</p> : !hasVisibleWork ? <p>{t("staff.queue.no_match")}</p> : <ul className="rows work-rows">
      {show("assistance") && assistanceRequests.filter(row => matchesResident(row.residentId)).map(row => {
        const rowKey = `/staff/assistance-requests/${row.id}`;
        const actions: string[] = [];
        if (row.handlingState === "open" && row.withdrawalState === "none") actions.push("acknowledge");
        if (row.handlingState === "acknowledged") actions.push("in_progress");
        if (row.handlingState === "in_progress") actions.push("resolve");
        if ((row.deliveryState === "pending" || row.deliveryState === "unknown") && row.withdrawalState === "none") actions.push("fail_delivery");
        if (row.withdrawalState === "requested") actions.push("confirm_withdrawal");
        if (row.handlingState !== "resolved" && row.handlingState !== "cancelled") actions.push("reject");
        const status = row.handlingState === "resolved" ? t("staff.assistance.resolved")
          : row.handlingState === "cancelled" ? t("staff.assistance.cancelled")
          : row.handlingState === "in_progress" ? t("staff.assistance.in_progress")
          : row.handlingState === "acknowledged" ? t("staff.assistance.acknowledged")
          : row.deliveryState === "delivered" ? t("staff.assistance.reached_queue")
          : row.deliveryState === "failed" ? t("staff.assistance.delivery_failed")
          : t("staff.assistance.recorded");
        return <li key={rowKey} className="work-row assistance-row">
          <div className="work-row-heading"><strong>{t("staff.queue.assistance")}</strong><span className="work-status">{status}</span></div>
          <dl className="work-facts">
            <div><dt>{t("staff.queue.category")}</dt><dd>{row.category}</dd></div>
            <div><dt>{t("staff.queue.resident_id")}</dt><dd>{row.residentId}</dd></div>
            <div><dt>{t("staff.queue.created")}</dt><dd><time dateTime={row.createdAt}>{displayTime(row.createdAt)}</time></dd></div>
          </dl>
          {row.note && <p className="work-note">{row.note}</p>}
          {errors[rowKey] && <p className="row-error" role="alert">{errors[rowKey]}</p>}
          <div className="actions">{actions.map(action => <button key={action} disabled={pending.includes(rowKey)} onClick={() => void onAction(`${rowKey}/${action}`, { version: row.version })}>{t(`staff.assistance.action_${action}`)}</button>)}</div>
        </li>;
      })}
      {show("visits") && reservations.filter(row => matchesResident(row.residentDisplayName)).map(row => <li key={"/visit-reservations/" + row.id} className="work-row reservation-row" data-testid={"staff-reservation-" + row.id}>
        <div className="work-row-heading"><strong>{t("staff.queue.reservation")}</strong><span className="work-status">{t("staff.reservation.status." + row.status)}</span></div>
        <dl className="work-facts">
          <div><dt>{t("staff.queue.resident_id")}</dt><dd>{t("staff.reservation.resident", { name: row.residentDisplayName })}</dd></div>
          <div><dt>{t("staff.reservation.scheduled_for")}</dt><dd><time dateTime={row.startAt}>{new Date(row.startAt).toLocaleString([], { timeZone: row.timeZone })}</time></dd></div>
        </dl>
        <p className="work-note">{t("staff.reservation.family", { name: row.familyDisplayName })}</p>
        <div className="actions"><button disabled={pending.includes("/visit-reservations/" + row.id)} onClick={() => void onAction("/visit-reservations/" + row.id + "/cancel")}>{t("staff.reservation.cancel")}</button></div>
      </li>)}
      {show("visits") && dispatchFailures.filter(row => matchesResident(row.residentDisplayName)).map(row => <li key={row.id} className="work-row dispatch-failure-row" data-testid={"staff-dispatch-failure-" + row.id}>
        <div className="work-row-heading"><strong>{t("staff.queue.dispatch_failure")}</strong></div>
        <dl className="work-facts">
          <div><dt>{t("staff.queue.resident_id")}</dt><dd>{t("staff.reservation.resident", { name: row.residentDisplayName })}</dd></div>
          <div><dt>{t("staff.queue.created")}</dt><dd><time dateTime={row.at}>{displayTime(row.at)}</time></dd></div>
        </dl>
        <p className="work-note">{t("staff.reservation.failure_reason", { reason: row.reason })}</p>
      </li>)}
      {rows.filter(row => show(row.kind) && matchesResident(row.resident)).map(row => <li key={row.key} className="work-row">
        <div className="work-row-heading"><strong>{t(`staff.queue.${row.label}`)}</strong><span className="work-status">{statusLabel(row.state)}</span></div>
        <dl className="work-facts">
          <div><dt>{t("staff.queue.category")}</dt><dd>{t(`staff.queue.${row.label}`)}</dd></div>
          <div><dt>{t("staff.queue.resident_id")}</dt><dd>{row.resident}</dd></div>
          {row.createdAt && <div><dt>{t("staff.queue.created")}</dt><dd><time dateTime={row.createdAt}>{displayTime(row.createdAt)}</time></dd></div>}
        </dl>
        {row.item && <p className="work-note">{t(["water_bottle", "tissue_box", "tv_remote"].includes(row.item) ? `item.${row.item}` : "item.unknown")}</p>}
        {errors[row.key] && <p className="row-error" role="alert">{errors[row.key]}</p>}
        <div className="actions">{row.actions.map(action => <button key={action} disabled={pending.includes(row.key)} onClick={() => void onAction(`${row.key}/${action}`)}>{t(`staff.queue.${action}`)}</button>)}</div>
      </li>)}
      {show("caregiver") && queue.caregiverCalls.filter(row => matchesResident(row.residentId)).map(row => <li key={row.id} className="work-row">
        <div className="work-row-heading"><strong>{t("staff.queue.caregiver")}</strong></div>
        <dl className="work-facts">
          <div><dt>{t("staff.queue.category")}</dt><dd>{t("staff.queue.caregiver")}</dd></div>
          <div><dt>{t("staff.queue.resident_id")}</dt><dd>{row.residentId ?? t("staff.queue.resident_unknown")}</dd></div>
          <div><dt>{t("staff.queue.created")}</dt><dd><time dateTime={row.at}>{displayTime(row.at)}</time></dd></div>
        </dl>
      </li>)}
    </ul>}
    </>;
}
