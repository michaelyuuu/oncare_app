import { useState, type FormEvent } from "react";
import { t } from "@oncare/web-common";
import type { SectionProps } from "./types";

export function People({ data, run }: SectionProps) {
  const [form, setForm] = useState({ role: "staff" as "staff" | "family", username: "", displayName: "", password: "", pin: "" });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
  async function add(event: FormEvent) {
    event.preventDefault();
    const { pin, ...rest } = form;
    await run((api) => api.post("/admin/users", form.role === "staff" && pin ? { ...rest, pin } : rest));
    setForm({ ...form, username: "", displayName: "", password: "", pin: "" });
  }
  return <section aria-labelledby="admin-people"><h2 id="admin-people">{t("admin.people.title")}</h2>
    <table><tbody>{data.people.map((p) => <tr key={p.id}>
      <td>{p.displayName}{!p.active && ` (${t("admin.inactive")})`}</td><td>{p.username}</td><td>{t(`admin.people.role.${p.role}`)}</td>
      <td>{p.active && p.role !== "admin" && <button onClick={() => run((api) => api.post(`/admin/users/${p.id}/deactivate`))}>{t("admin.deactivate")}</button>}</td>
    </tr>)}</tbody></table>
    <form onSubmit={add}>
      <label htmlFor="person-role">{t("admin.people.role")}</label>
      <select id="person-role" value={form.role} onChange={set("role")}>
        <option value="staff">{t("admin.people.role.staff")}</option><option value="family">{t("admin.people.role.family")}</option>
      </select>
      <label htmlFor="person-username">{t("admin.people.username")}</label><input id="person-username" required value={form.username} onChange={set("username")}/>
      <label htmlFor="person-name">{t("admin.people.display_name")}</label><input id="person-name" required value={form.displayName} onChange={set("displayName")}/>
      <label htmlFor="person-password">{t("admin.people.password")}</label><input id="person-password" type="password" required minLength={6} value={form.password} onChange={set("password")}/>
      {form.role === "staff" && <><label htmlFor="person-pin">{t("admin.people.pin")}</label><input id="person-pin" inputMode="numeric" pattern="\d{4,8}" value={form.pin} onChange={set("pin")}/></>}
      <button>{t("admin.people.add")}</button>
    </form>
  </section>;
}
