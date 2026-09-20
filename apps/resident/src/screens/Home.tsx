import { t } from "@oncare/web-common";
type HelpStatus = "idle" | "sending" | "recorded" | "error";

type HomeProps = {
  name: string;
  now: number;
  onOpenAssistant?: () => void;
  onCallCaregiver: () => void;
  onHelpStaff?: () => void;
  helpStatus?: HelpStatus;
  disabled?: boolean;
  offline?: boolean;
};

export function Home({ onOpenAssistant, onCallCaregiver, onHelpStaff, helpStatus = "idle", disabled = false, offline = false }: HomeProps) {
  const statusKey = offline
    ? "resident.communication.offline"
    : helpStatus === "sending"
      ? "resident.communication.help_sending"
      : helpStatus === "recorded"
        ? "resident.communication.help_recorded"
        : helpStatus === "error"
          ? "resident.communication.help_error"
          : "resident.communication.idle";

  return <section className="screen communication-home" aria-label={t("resident.communication.aria")} data-orb={offline ? "offline" : "ready"}>
    <p className="communication-home__brand">{t("resident.communication.brand")}</p>
    <div className="communication-home__orb-wrap">
      <button
        type="button"
        className="communication-orb"
        data-testid="communication-orb"
        aria-label={t("resident.assistant.open")}
        onClick={onOpenAssistant}
        disabled={disabled || !onOpenAssistant}
      >
        <span className="communication-orb__core" aria-hidden="true" />
        <span className="communication-orb__glint" aria-hidden="true" />
      </button>
    </div>
    <p className="communication-home__status" role="status" aria-live="polite">{t(statusKey)}</p>
    <div className="communication-home__actions">
      {onHelpStaff && <button type="button" className="communication-help" onClick={onHelpStaff} disabled={disabled || helpStatus === "sending"}>{t("resident.communication.help")}</button>}
      <button type="button" className="communication-caregiver quiet-button" onClick={onCallCaregiver} disabled={disabled}>{t("resident.communication.caregiver")}</button>
    </div>
  </section>;
}
