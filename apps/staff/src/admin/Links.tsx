import { useState, type FormEvent } from "react";
import { t } from "@oncare/web-common";
import type { SectionProps } from "./types";

export function Links({ data, run }: SectionProps) {
  const [family, setFamily] = useState({ userId: "", residentId: "", label: "", consentVideo: true, consentRobotVisit: true, consentItemDelivery: true });
  const [nurse, setNurse] = useState({ userId: "", residentId: "" });
  const person = (id: string) => data.people.find((p) => p.id === id)?.displayName ?? id;
  const resident = (id: string) => data.residents.find((r) => r.id === id)?.displayName ?? id;
  const activeResidents = data.residents.filter((r) => r.active);
  const residentOptions = <><option value=""/>{activeResidents.map((r) => <option key={r.id} value={r.id}>{r.displayName}</option>)}</>;
  async function linkFamily(event: FormEvent) {
    event.preventDefault();
    await run((api) => api.post("/admin/family-links", family));
    setFamily({ ...family, label: "" });
  }
  async function assignNurse(event: FormEvent) {
    event.preventDefault();
    await run((api) => api.post("/admin/staff-assignments", nurse));
  }
  return <section aria-labelledby="admin-links"><h2 id="admin-links">{t("admin.links.title")}</h2>
    <ul>{data.links.map((l) => <li key={l.id}>{`${person(l.userId)} · ${l.label} · ${resident(l.residentId)}`}
      <button onClick={() => run((api) => api.del(`/admin/family-links/${l.id}`))}>{t("admin.links.remove")}</button></li>)}</ul>
    <form onSubmit={linkFamily}>
      <label htmlFor="link-family">{t("admin.links.family")}</label>
      <select id="link-family" required value={family.userId} onChange={(e) => setFamily({ ...family, userId: e.target.value })}>
        <option value=""/>{data.people.filter((p) => p.role === "family" && p.active).map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
      </select>
      <label htmlFor="link-resident">{t("admin.links.resident")}</label>
      <select id="link-resident" required value={family.residentId} onChange={(e) => setFamily({ ...family, residentId: e.target.value })}>{residentOptions}</select>
      <label htmlFor="link-label">{t("admin.links.label")}</label><input id="link-label" required value={family.label} onChange={(e) => setFamily({ ...family, label: e.target.value })}/>
      <label><input type="checkbox" checked={family.consentVideo} onChange={(e) => setFamily({ ...family, consentVideo: e.target.checked })}/>{t("admin.links.video")}</label>
      <label><input type="checkbox" checked={family.consentRobotVisit} onChange={(e) => setFamily({ ...family, consentRobotVisit: e.target.checked })}/>{t("admin.links.robot_visit")}</label>
      <label><input type="checkbox" checked={family.consentItemDelivery} onChange={(e) => setFamily({ ...family, consentItemDelivery: e.target.checked })}/>{t("admin.links.item_delivery")}</label>
      <button>{t("admin.links.add_family")}</button>
    </form>
    <ul>{data.assignments.map((a) => <li key={a.id}>{`${person(a.userId)} → ${resident(a.residentId)}`}
      <button onClick={() => run((api) => api.del(`/admin/staff-assignments/${a.id}`))}>{t("admin.links.remove")}</button></li>)}</ul>
    <form onSubmit={assignNurse}>
      <label htmlFor="assign-nurse">{t("admin.links.nurse")}</label>
      <select id="assign-nurse" required value={nurse.userId} onChange={(e) => setNurse({ ...nurse, userId: e.target.value })}>
        <option value=""/>{data.people.filter((p) => p.role === "staff" && p.active).map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
      </select>
      <label htmlFor="assign-resident">{t("admin.links.resident")}</label>
      <select id="assign-resident" required value={nurse.residentId} onChange={(e) => setNurse({ ...nurse, residentId: e.target.value })}>{residentOptions}</select>
      <button>{t("admin.links.add_nurse")}</button>
    </form>
  </section>;
}
