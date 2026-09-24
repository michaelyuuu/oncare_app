import { t } from "@oncare/web-common";
import { VisitContactPicker, type ResidentVisitContact } from "../components/VisitContactPicker";
type HelpStatus = "idle" | "sending" | "recorded" | "error";

type HomeProps = {
  name: string;
  now: number;
  onOpenAssistant?: () => void;
  contacts?: ResidentVisitContact[];
  selectedContactId?: string | null;
  onSelectContact?: (contactUserId: string) => void;
  onScheduleVisit?: () => void;
  onCallNow?: () => void;
  /** @deprecated Kept as a source-compatible no-op; the communication home has one help action. */
  onCallCaregiver?: () => void;
  onHelpStaff?: () => void;
  helpStatus?: HelpStatus;
  disabled?: boolean;
  offline?: boolean;
  error?: boolean;
};

export function Home({
  onOpenAssistant,
  contacts = [],
  selectedContactId = null,
  onSelectContact,
  onScheduleVisit,
  onCallNow,
  onHelpStaff,
  helpStatus = "idle",
  disabled = false,
  offline = false,
  error = false,
}: HomeProps) {
  const statusKey = error
    ? "resident.error.retry"
    : offline
      ? "resident.communication.offline"
      : helpStatus === "sending"
      ? "resident.communication.help_sending"
      : helpStatus === "recorded"
        ? "resident.communication.help_recorded"
        : helpStatus === "error"
          ? "resident.communication.help_error"
          : "resident.communication.idle";

  return <section
    className="communication-screen"
    aria-label={t("resident.communication.aria")}
    data-orb={offline ? "offline" : "idle"}
    data-shape="sphere"
    data-dim="off"
    data-bg="default"
    data-card="off"
  >
    <p className="communication-brand">{t("resident.communication.brand")}</p>

    {contacts.length > 0 && <div className="communication-zone-meeting">
      <VisitContactPicker
        contacts={contacts}
        selectedContactId={selectedContactId}
        onSelect={onSelectContact ?? (() => {})}
        compact
      />
      <div className="communication-meeting-actions">
        <button
          type="button"
          className="communication-ghost"
          onClick={onScheduleVisit}
          disabled={disabled || !selectedContactId || !onScheduleVisit}
        >{t("resident.visit.schedule")}</button>
        <button
          type="button"
          className="communication-ghost communication-call-now"
          onClick={onCallNow}
          disabled={disabled || !selectedContactId || !onCallNow}
        >{t("resident.visit.call_now")}</button>
      </div>
    </div>}

    <div className="communication-orb-stage" data-testid="communication-orb-stage">
      <button
        type="button"
        className="communication-orb-button"
        data-testid="communication-orb"
        aria-label={t("resident.assistant.open")}
        onClick={onOpenAssistant}
        disabled={disabled || !onOpenAssistant}
      >
        <span className="communication-orb" aria-hidden="true">
          <i /><i /><i /><i />
        </span>
      </button>
    </div>
    <p className="communication-status" role="status" aria-live="polite">{t(statusKey)}</p>
    <div className="communication-zone-bottom">
      {onHelpStaff && <button type="button" className="communication-solid" onClick={onHelpStaff} disabled={disabled || helpStatus === "sending"}>{t("resident.communication.help")}</button>}
      <span className="communication-demo">{t("resident.communication.demo")}</span>
    </div>
  </section>;
}
