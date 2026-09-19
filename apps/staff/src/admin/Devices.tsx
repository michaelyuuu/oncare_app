import { useState, type FormEvent } from "react";
import { t } from "@oncare/web-common";
import type { SectionProps } from "./types";

export function Devices({ data, run }: SectionProps) {
  const [residentId, setResidentId] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const activeResidents = data.residents.filter((r) => r.active);
  const resident = (id: string) => data.residents.find((r) => r.id === id)?.displayName ?? id;
  async function register(event: FormEvent) {
    event.preventDefault();
    const result = await run((api) => api.post<{ deviceToken: string }>("/admin/devices", { residentId })) as { deviceToken?: string } | null;
    if (result?.deviceToken) setToken(result.deviceToken);
  }
  return <section aria-labelledby="admin-devices"><h2 id="admin-devices">{t("admin.devices.title")}</h2>
    <table><tbody>{data.devices.map((d) => <tr key={d.id}>
      <td>{d.id}{!d.active && ` (${t("admin.inactive")})`}</td><td>{resident(d.residentId)}</td>
      <td>{d.active && <>
        <label htmlFor={`move-${d.id}`}>{t("admin.devices.move")}</label>
        <select id={`move-${d.id}`} value="" onChange={(e) => e.target.value && run((api) => api.post(`/admin/devices/${d.id}/assign`, { residentId: e.target.value }))}>
          <option value=""/>{activeResidents.filter((r) => r.id !== d.residentId).map((r) => <option key={r.id} value={r.id}>{r.displayName}</option>)}
        </select>
        <button onClick={() => run((api) => api.post(`/admin/devices/${d.id}/deactivate`))}>{t("admin.deactivate")}</button>
      </>}</td>
    </tr>)}</tbody></table>
    <form onSubmit={register}>
      <label htmlFor="device-resident">{t("admin.devices.resident")}</label>
      <select id="device-resident" required value={residentId} onChange={(e) => setResidentId(e.target.value)}>
        <option value=""/>{activeResidents.map((r) => <option key={r.id} value={r.id}>{r.displayName}</option>)}
      </select>
      <button>{t("admin.devices.register")}</button>
    </form>
    {token && <div role="dialog" aria-labelledby="device-token-title">
      <h3 id="device-token-title">{t("admin.devices.token_title")}</h3>
      <p>{t("admin.devices.token_help")}</p>
      <code>{token}</code>
      <button onClick={() => setToken(null)}>{t("admin.devices.token_done")}</button>
    </div>}
  </section>;
}
