import { t } from "@oncare/web-common";
import { BigButton } from "../components/BigButton";
export function Home({ name, now, onCallCaregiver, disabled = false }: { name: string; now: number; onCallCaregiver: () => void; disabled?: boolean }) {
  const time = new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return <section className="screen screen--home">
    <h1>{t("resident.home.greeting", { name })}</h1>
    <p className="clock">{t("resident.home.time", { time })}</p>
    <div className="photo-wall" aria-hidden="true">{["#89734e", "#52796e", "#84718d"].map((color) => <svg viewBox="0 0 120 128" className="portrait" key={color}><circle cx="60" cy="44" r="25" fill={color}/><path d="M12 128v-12a48 48 0 0 1 96 0v12" fill={color}/></svg>)}</div>
    <BigButton tone="secondary" onClick={onCallCaregiver} disabled={disabled}>{t("resident.caregiver.button")}</BigButton>
  </section>;
}
