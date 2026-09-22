import { useEffect, useState } from "react";
import { ApiError, type Api, type VisitReservationView, type VisitSlot, t } from "@oncare/web-common";

function timeLabel(value: string, timeZone: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return t("family.schedule.time_unknown");
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(parsed));
}

function countdownLabel(expiresAt: string, now: number): string {
  const remaining = Date.parse(expiresAt) - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return t("family.schedule.expired");
  const seconds = Math.ceil(remaining / 1000);
  return t("family.schedule.pending_countdown", {
    time: `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`,
  });
}

function actionError(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) return t("family.schedule.conflict");
  if (error instanceof ApiError && error.status === 410) return t("family.schedule.expired");
  return t("family.schedule.action_error");
}

export function VisitReservationCard({
  api,
  reservation,
  now: nowProp,
  suggestion,
  disabled = false,
  onChanged,
}: {
  api: Api;
  reservation: VisitReservationView;
  now?: number;
  suggestion?: VisitSlot | null;
  disabled?: boolean;
  onChanged: () => void;
}) {
  const [internalNow, setInternalNow] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const now = nowProp ?? internalNow;
  const expired = reservation.status === "pending" && Date.parse(reservation.expiresAt) <= now;
  const status = expired ? "expired" : reservation.status;

  useEffect(() => {
    if (nowProp !== undefined) return;
    const timer = setInterval(() => setInternalNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [nowProp]);

  const act = async (action: "confirm" | "cancel" | "suggest") => {
    if (busy || disabled || status === "expired") return;
    if (action === "suggest" && !suggestion) {
      setNotice(t("family.schedule.choose_suggestion"));
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await api.post(`/visit-reservations/${encodeURIComponent(reservation.id)}/${action}`, action === "suggest" && suggestion
        ? { localDate: suggestion.localDate, startMinute: suggestion.startMinute }
        : {});
      onChanged();
    } catch (error) {
      setNotice(actionError(error));
    } finally {
      setBusy(false);
    }
  };

  return <article className={`family-reservation-card family-reservation-card--${status}`} data-testid={`family-reservation-card-${reservation.id}`}>
    <div className="family-reservation-card__heading">
      <div>
        <p className="family-reservation-card__eyebrow">{t(`family.schedule.status.${status}`)}</p>
        <h3>{reservation.residentDisplayName}</h3>
      </div>
      <p className="family-reservation-card__time">{timeLabel(reservation.startAt, reservation.timeZone)}–{timeLabel(reservation.endAt, reservation.timeZone)}</p>
    </div>
    {status === "pending" && <p role="status" aria-live="polite">{countdownLabel(reservation.expiresAt, now)}</p>}
    {status === "confirmed" && <p role="status">{t("family.schedule.confirmed_reminder", { time: timeLabel(reservation.startAt, reservation.timeZone) })}</p>}
    {status === "expired" && <p role="status">{t("family.schedule.expired_message")}</p>}
    {status === "cancelled" && <p role="status">{t("family.schedule.cancelled_message")}</p>}
    {notice && <p className="error" role="alert">{notice}</p>}
    {(status === "pending" || status === "confirmed") && <div className="family-reservation-card__actions">
      {status === "pending" && <>
        <button type="button" className="primary" onClick={() => void act("confirm")} disabled={busy || disabled}>{t("family.schedule.confirm")}</button>
        <button type="button" onClick={() => void act("suggest")} disabled={busy || disabled}>{t("family.schedule.suggest")}</button>
      </>}
      <button type="button" onClick={() => void act("cancel")} disabled={busy || disabled}>{t("family.schedule.cancel")}</button>
    </div>}
  </article>;
}
