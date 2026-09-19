import { useCallback, useEffect, useState } from "react";
import { t, type Api } from "@oncare/web-common";
import type { AdminData, Assignment, Device, FamilyLink, Person, Resident, Room } from "./types";
import { Residents } from "./Residents";
import { People } from "./People";
import { Links } from "./Links";
import { Devices } from "./Devices";

async function load(api: Api): Promise<AdminData> {
  const [residents, people, links, assignments, devices, rooms] = await Promise.all([
    api.get<{ residents: Resident[] }>("/admin/residents"),
    api.get<{ users: Person[] }>("/admin/users"),
    api.get<{ links: FamilyLink[] }>("/admin/family-links"),
    api.get<{ assignments: Assignment[] }>("/admin/staff-assignments"),
    api.get<{ devices: Device[] }>("/admin/devices"),
    api.get<{ locations: Room[] }>("/locations"),
  ]);
  return {
    residents: residents.residents, people: people.users, links: links.links,
    assignments: assignments.assignments.filter((a) => a.active), devices: devices.devices,
    rooms: rooms.locations.filter((l) => l.kind === "resident_room"),
  };
}

export function AdminPanel({ api }: { api: Api }) {
  const [data, setData] = useState<AdminData | null>(null);
  const [error, setError] = useState(false);
  // Reloading after a change must never clear a mutation error: it only reports its own failures.
  const reload = useCallback(async () => {
    try { setData(await load(api)); } catch { setError(true); }
  }, [api]);
  useEffect(() => { void reload(); }, [reload]);

  const run = useCallback(async (change: (api: Api) => Promise<unknown>) => {
    setError(false);
    try { return await change(api); }
    catch { setError(true); return null; }
    finally { await reload(); }
  }, [api, reload]);

  if (!data) return <main className="admin">{error ? <p role="alert">{t("admin.error")}</p> : <p role="status">{t("admin.loading")}</p>}</main>;
  return <main className="admin">
    {error && <p role="alert">{t("admin.error")}</p>}
    <Residents data={data} run={run}/>
    <People data={data} run={run}/>
    <Links data={data} run={run}/>
    <Devices data={data} run={run}/>
  </main>;
}
