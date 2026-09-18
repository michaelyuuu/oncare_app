import { useEffect, useRef, useState } from "react";
import { t, type Api } from "@oncare/web-common";
import type { AuditRow } from "../types";
const fields = ["at", "actorType", "actorId", "entityType", "entityId", "fromState", "toState", "reason", "correlationId"] as const;
export function AuditTable({ api, revision }: {
    api: Api;
    revision: number;
}) {
    const [rows, setRows] = useState<AuditRow[]>([]);
    const [resident, setResident] = useState("");
    const [since, setSince] = useState("");
    const [error, setError] = useState(false);
    const [loading, setLoading] = useState(true);
    const [exportError, setExportError] = useState(false);
    const refreshAudit = useRef<() => void>(() => {});
    const observedRevision = useRef(revision);
    useEffect(() => {
        let current = true;
        let fetching = false;
        let refreshAgain = false;
        setRows([]);
        setLoading(true);
        setError(false);
        const q = new URLSearchParams();
        if (resident.trim())
            q.set("residentId", resident.trim());
        if (since)
            q.set("since", new Date(since).toISOString());
        async function refresh() {
            if (!current) return;
            if (fetching) {
                refreshAgain = true;
                return;
            }
            fetching = true;
            try {
                const result = await api.get<{ events: AuditRow[] }>(`/audit${q.size ? `?${q}` : ""}`);
                if (current) {
                    setRows(result.events);
                    setError(false);
                }
            } catch {
                if (current) setError(true);
            } finally {
                fetching = false;
                if (current) {
                    setLoading(false);
                    if (refreshAgain) {
                        refreshAgain = false;
                        void refresh();
                    }
                }
            }
        }
        refreshAudit.current = () => { void refresh(); };
        void refresh();
        // Only filter/session changes invalidate a request. Polling revisions
        // request one follow-up without discarding a slow successful response.
        return () => { current = false; };
    }, [api, resident, since]);
    useEffect(() => {
        if (observedRevision.current === revision) return;
        observedRevision.current = revision;
        refreshAudit.current();
    }, [revision]);
    function exportCsv() {
        setExportError(false);
        try {
            const quote = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
            const csv = [fields.map(f => quote(t(`staff.audit.${f}`))).join(","), ...rows.map(row => fields.map(f => quote(row[f])).join(","))].join("\r\n");
            const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
            try {
                const a = document.createElement("a");
                a.href = url;
                a.download = "audit.csv";
                a.click();
            }
            finally {
                setTimeout(() => URL.revokeObjectURL(url), 0);
            }
        }
        catch {
            setExportError(true);
        }
    }
    return <div><div className="audit-controls"><label>{t("staff.audit.filter")}<input value={resident} onChange={e => setResident(e.target.value)}/></label><label>{t("staff.audit.since")}<input type="datetime-local" value={since} onChange={e => setSince(e.target.value)}/></label><button disabled={loading || error} onClick={exportCsv}>{t("staff.audit.export")}</button></div>{exportError && <p role="alert">{t("staff.error.export")}</p>}{error && <p role="alert">{t("staff.error.audit")}</p>}<div className="table-scroll"><table aria-busy={loading}><thead><tr>{fields.map(f => <th key={f}>{t(`staff.audit.${f}`)}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.id}>{fields.map(f => <td key={f}>{row[f] ?? t("staff.none")}</td>)}</tr>)}</tbody></table></div>{!rows.length && !loading && <p>{t("staff.audit.empty")}</p>}</div>;
}
