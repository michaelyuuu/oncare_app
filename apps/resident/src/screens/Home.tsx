import { t } from "@oncare/web-common";
import { BigButton } from "../components/BigButton";
export function Home({ name, now, onOpenAssistant, onCallCaregiver, onHelpStaff, helpStatus = "idle", disabled = false }: {
  name: string;
  now: number;
  onOpenAssistant?: () => void;
  onCallCaregiver: () => void;
  onHelpStaff?: () => void;
  helpStatus?: "idle" | "sending" | "recorded" | "error";
  disabled?: boolean;
}) {
  const time = new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return <section className="screen screen--home">
    <h1>{t("resident.home.greeting", { name })}</h1>
    <p className="clock">{t("resident.home.time", { time })}</p>
    <div className="photo-wall" aria-hidden="true">{["#89734e", "#52796e", "#84718d"].map((color) => <svg viewBox="0 0 120 128" className="portrait" key={color}><circle cx="60" cy="44" r="25" fill={color}/><path d="M12 128v-12a48 48 0 0 1 96 0v12" fill={color}/></svg>)}</div>
    {onOpenAssistant && <BigButton onClick={onOpenAssistant} disabled={disabled}>{t("resident.assistant.open")}</BigButton>}
    <BigButton tone="secondary" onClick={onCallCaregiver} disabled={disabled}>{t("resident.caregiver.button")}</BigButton>
    {onHelpStaff && <button type="button" className="quiet-button home-help-button" onClick={onHelpStaff} disabled={disabled || helpStatus === "sending"}>{t("resident.assistant.help_staff")}</button>}
    {helpStatus === "sending" && <p role="status">{t("resident.assistant.help_sending")}</p>}
    {helpStatus === "recorded" && <p role="status">{t("resident.assistant.recorded")}</p>}
    {helpStatus === "error" && <p role="status">{t("resident.assistant.help_error")}</p>}
  </section>;
}
