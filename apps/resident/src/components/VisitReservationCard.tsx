import { useEffect, useState } from "react";
import { ApiError, type Api, type VisitReservationView, type VisitSlot, t } from "@oncare/web-common";

function timeLabel(value: string, timeZone: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return t("resident.visit.time_unknown");
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(parsed));
}

function countdownLabel(expiresAt: string, now: number): string {
  const remaining = Date.parse(expiresAt) - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return t("resident.visit.expired");
  const totalSeconds = Math.ceil(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return t("resident.visit.pending_countdown", { time: `${minutes}:${seconds}` });
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) return t("resident.visit.conflict");
  if (error instanceof ApiError && error.status === 410) return t("resident.visit.expired");
  return t("resident.visit.action_error");
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
  const pendingExpired = reservation.status === "pending" && Date.parse(reservation.expiresAt) <= now;
  const status = pendingExpired ? "expired" : reservation.status;

  useEffect(() => {
    if (nowProp !== undefined) return;
    const timer = setInterval(() => setInternalNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [nowProp]);

  const act = async (action: "confirm" | "cancel" | "suggest") => {
    if (busy || disabled || status === "expired") return;
    if (action === "suggest" && !suggestion) {
      setNotice(t("resident.visit.choose_suggestion"));
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const path = `/visit-reservations/${encodeURIComponent(reservation.id)}/${action}`;
      const body = action === "suggest" && suggestion
        ? { localDate: suggestion.localDate, startMinute: suggestion.startMinute }
        : {};
      await api.post(path, body);
      onChanged();
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return <article className={`visit-reservation-card visit-reservation-card--${status}`} data-testid={`reservation-card-${reservation.id}`}>
    <div className="visit-reservation-card__heading">
      <div>
        <p className="visit-reservation-card__eyebrow">{t(`resident.visit.status.${status}`)}</p>
        <h3>{reservation.familyDisplayName}</h3>
      </div>
      <p className="visit-reservation-card__time">
        {timeLabel(reservation.startAt, reservation.timeZone)}–{timeLabel(reservation.endAt, reservation.timeZone)}
      </p>
    </div>
    {status === "pending" && <p className="visit-reservation-card__countdown" role="status" aria-live="polite">{countdownLabel(reservation.expiresAt, now)}</p>}
    {status === "confirmed" && <p className="visit-reservation-card__reminder" role="status">{t("resident.visit.confirmed_reminder", { time: timeLabel(reservation.startAt, reservation.timeZone) })}</p>}
    {status === "expired" && <p className="visit-reservation-card__message" role="status">{t("resident.visit.expired_message")}</p>}
    {status === "cancelled" && <p className="visit-reservation-card__message" role="status">{t("resident.visit.cancelled_message")}</p>}
    {notice && <p className="visit-reservation-card__error" role="alert">{notice}</p>}
    {(status === "pending" || status === "confirmed") && <div className="visit-reservation-card__actions">
      {status === "pending" && <>
        <button type="button" className="communication-solid" onClick={() => void act("confirm")} disabled={busy || disabled}>{t("resident.visit.confirm")}</button>
        <button type="button" className="communication-ghost" onClick={() => void act("suggest")} disabled={busy || disabled}>{t("resident.visit.suggest")}</button>
      </>}
      <button type="button" className="communication-ghost" onClick={() => void act("cancel")} disabled={busy || disabled}>{t("resident.visit.cancel")}</button>
    </div>}
  </article>;
}
