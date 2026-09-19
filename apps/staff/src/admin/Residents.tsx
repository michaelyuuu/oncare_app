import { useState, type FormEvent } from "react";
import { t } from "@oncare/web-common";
import type { SectionProps } from "./types";

export function Residents({ data, run }: SectionProps) {
  const [name, setName] = useState("");
  const [room, setRoom] = useState("");
  const roomName = (id: string) => data.rooms.find((r) => r.id === id)?.name ?? id;
  async function add(event: FormEvent) {
    event.preventDefault();
    await run((api) => api.post("/admin/residents", { displayName: name, roomLocationId: room }));
    setName("");
  }
  return <section aria-labelledby="admin-residents"><h2 id="admin-residents">{t("admin.residents.title")}</h2>
    <table><tbody>{data.residents.map((r) => <tr key={r.id}>
      <td>{r.displayName}{!r.active && ` (${t("admin.inactive")})`}</td><td>{roomName(r.roomLocationId)}</td>
      <td>{r.active && <button onClick={() => run((api) => api.post(`/admin/residents/${r.id}/deactivate`))}>{t("admin.deactivate")}</button>}</td>
    </tr>)}</tbody></table>
    <form onSubmit={add}>
      <label htmlFor="resident-name">{t("admin.residents.name")}</label><input id="resident-name" required value={name} onChange={(e) => setName(e.target.value)}/>
      <label htmlFor="resident-room">{t("admin.residents.room")}</label>
      <select id="resident-room" required value={room} onChange={(e) => setRoom(e.target.value)}>
        <option value=""/>{data.rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
      <button>{t("admin.residents.add")}</button>
    </form>
  </section>;
}
