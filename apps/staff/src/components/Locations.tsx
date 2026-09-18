import { Fragment, useEffect, useRef, useState } from "react";
import { t, type Api } from "@oncare/web-common";

type Pose = { x: number; y: number; yaw: number };
interface Location extends Pose { id: string; name: string; kind: string; approved: boolean }
const axes = ["x", "y", "yaw"] as const;
const fields = (pose: Pose) => ({ x: String(pose.x), y: String(pose.y), yaw: String(pose.yaw) });
const validPose = (pose: Pose | null): pose is Pose => pose !== null && axes.every(axis => Number.isFinite(pose[axis]));

function LocationRow({ api, location, pose }: { api: Api; location: Location; pose: Pose | null }) {
  const [draft, setDraft] = useState(() => fields(location));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  async function save(capture?: Pose) {
    if (pending.current) return;
    const next = capture ?? { x: Number(draft.x), y: Number(draft.y), yaw: Number(draft.yaw) };
    if (!validPose(next) || (!capture && axes.some(axis => draft[axis].trim() === ""))) {
      setError(t("staff.locations.invalid"));
      return;
    }
    pending.current = true;
    setBusy(true); setError(""); setSaved(false);
    if (capture) setDraft(fields(capture));
    try {
      const response = await api.patch<{ location: Location }>(`/locations/${encodeURIComponent(location.id)}`, next);
      if (alive.current) { setDraft(fields(response.location)); setSaved(true); }
    } catch {
      if (alive.current) setError(t("staff.locations.error_save"));
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }

  return <Fragment>
    <tr>
      <th scope="row">{location.name}<span className="hint location-approval">{t(location.approved ? "staff.locations.approved" : "staff.locations.unapproved")}</span></th>
      {axes.map(axis => <td key={axis}><input type="number" step="any" disabled={busy} value={draft[axis]}
        aria-label={t("staff.locations.coordinate", { name: location.name, axis: t(`staff.locations.${axis}`) })}
        onChange={event => { setDraft(old => ({ ...old, [axis]: event.target.value })); setSaved(false); }}/></td>)}
    </tr>
    <tr><td colSpan={4} className="location-actions">
      <div className="actions">
        <button disabled={busy || !validPose(pose)} onClick={() => { if (validPose(pose)) void save(pose); }}>{t("staff.locations.use_pose")}</button>
        <button disabled={busy} onClick={() => { void save(); }}>{t("staff.locations.save")}</button>
      </div>
      {busy && <p role="status">{t("staff.locations.saving")}</p>}
      {saved && <p role="status">{t("staff.locations.saved")}</p>}
      {error && <p role="alert">{error}</p>}
    </td></tr>
  </Fragment>;
}

export function Locations({ api, pose }: { api: Api; pose: Pose | null }) {
  const [data, setData] = useState<{ api: Api; rows: Location[] } | null>(null);
  const [failed, setFailed] = useState<Api | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    setData(null); setFailed(null);
    void api.get<{ locations: Location[] }>("/locations").then(response => {
      if (!Array.isArray(response.locations)) throw new Error("invalid locations response");
      if (current) setData({ api, rows: response.locations });
    }).catch(() => { if (current) setFailed(api); });
    return () => { current = false; };
  }, [api, retry]);
  return <section className="locations" aria-label={t("staff.locations.title")}>
    <h2>{t("staff.locations.title")}</h2>
    <p className="hint">{t("staff.locations.hint")}</p>
    {failed === api ? <><p role="alert">{t("staff.locations.error_load")}</p><button onClick={() => setRetry(v => v + 1)}>{t("staff.locations.retry")}</button></>
      : data?.api !== api ? <p role="status">{t("staff.locations.loading")}</p>
      : data.rows.length === 0 ? <p>{t("staff.locations.empty")}</p>
      : <div className="table-scroll"><table>
        <thead><tr><th>{t("staff.locations.name")}</th>{axes.map(axis => <th key={axis}>{t(`staff.locations.${axis}`)}</th>)}</tr></thead>
        <tbody>{data.rows.map(location => <LocationRow key={location.id} api={api} location={location} pose={pose}/>)}</tbody>
      </table></div>}
  </section>;
}
