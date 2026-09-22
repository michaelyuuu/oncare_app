import { useEffect, useMemo, useState } from "react";
import { DEMO_VISIT_POLICY } from "@oncare/core/scheduling";
import { ApiError, type Api, type VisitReservationView, type VisitSlot, t } from "@oncare/web-common";
import { VisitReservationCard } from "../components/VisitReservationCard";

type SlotResponse = { timeZone?: string; slots?: VisitSlot[] };

function validTimeZone(value: string): string {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(); return value; }
  catch { return DEMO_VISIT_POLICY.timeZone; }
}

function localDateAt(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: validTimeZone(timeZone), calendar: "gregory", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const fields = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function addDays(localDate: string, amount: number): string {
  const value = new Date(`${localDate}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function dateLabel(localDate: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${localDate}T00:00:00.000Z`));
}

function minuteLabel(startMinute: number): string {
  const hour = Math.floor(startMinute / 60);
  const suffix = hour >= 12 ? "PM" : "AM";
  return `${hour % 12 || 12}:${(startMinute % 60).toString().padStart(2, "0")} ${suffix}`;
}

function reasonLabel(reason: VisitSlot["reason"]): string {
  return reason ? t(`family.schedule.blocked.${reason}`) : t("family.schedule.unavailable");
}

export function ScheduleVisit({
  api,
  residentId,
  residentName,
  onBack,
  onCreated,
  onImmediate,
  onVisit,
}: {
  api: Api;
  residentId: string;
  residentName: string;
  onBack: () => void;
  onCreated: (reservationId: string) => void;
  onImmediate: (visitId: string) => void;
  onVisit?: (visitId: string) => void;
}) {
  const startingTimeZone = DEMO_VISIT_POLICY.timeZone;
  const [timeZone, setTimeZone] = useState<string>(startingTimeZone);
  const [selectedDate, setSelectedDate] = useState(() => localDateAt(new Date(), startingTimeZone));
  const [slots, setSlots] = useState<VisitSlot[]>([]);
  const [reservations, setReservations] = useState<VisitReservationView[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<VisitSlot | null>(null);
  const [loading, setLoading] = useState(true);
  const [requesting, setRequesting] = useState(false);
  const [calling, setCalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const [slotRefresh, setSlotRefresh] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const refreshReservations = async () => {
    try {
      const response = await api.get<{ reservations?: VisitReservationView[] }>("/visit-reservations");
      setReservations(Array.isArray(response.reservations) ? response.reservations.filter((item) => item.residentId === residentId) : []);
    } catch {
      setError(t("family.schedule.offline"));
    }
  };

  useEffect(() => {
    void refreshReservations();
    const timer = setInterval(() => void refreshReservations(), 3000);
    return () => clearInterval(timer);
  }, [api, residentId]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api.get<SlotResponse>(`/visit-reservations/slots?residentId=${encodeURIComponent(residentId)}&from=${encodeURIComponent(selectedDate)}`)
      .then((response) => {
        if (cancelled) return;
        setSlots(Array.isArray(response.slots) ? response.slots : []);
        if (response.timeZone) setTimeZone(validTimeZone(response.timeZone));
      })
      .catch(() => { if (!cancelled) { setSlots([]); setError(t("family.schedule.offline")); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api, residentId, selectedDate, slotRefresh]);

  const dates = useMemo(() => {
    const fromSlots = [...new Set(slots.map((slot) => slot.localDate))];
    return fromSlots.length > 0 ? fromSlots : Array.from({ length: DEMO_VISIT_POLICY.windowDays }, (_, index) => addDays(selectedDate, index));
  }, [selectedDate, slots]);
  const dateSlots = slots.filter((slot) => slot.localDate === selectedDate);

  const propose = async () => {
    if (!selectedSlot || selectedSlot.state !== "available" || requesting) return;
    setRequesting(true); setError(null); setNotice(null);
    try {
      const response = await api.post<{ reservation: VisitReservationView }>("/visit-reservations", { residentId, localDate: selectedSlot.localDate, startMinute: selectedSlot.startMinute });
      setReservations((current) => [...current.filter((item) => item.id !== response.reservation.id), response.reservation]);
      setSelectedSlot(null);
      setNotice(t("family.schedule.request_sent"));
      onCreated(response.reservation.id);
      setSlotRefresh((value) => value + 1);
    } catch (failure) {
      setError(failure instanceof ApiError && failure.status === 409 ? t("family.schedule.conflict") : t("family.schedule.action_error"));
    } finally { setRequesting(false); }
  };

  const callNow = async () => {
    if (calling) return;
    setCalling(true); setError(null);
    try {
      const response = await api.post<{ visit: { id: string } }>("/visits/now", { residentId });
      onImmediate(response.visit.id);
    } catch (failure) {
      setError(failure instanceof ApiError && failure.status === 409 ? t("family.schedule.conflict") : t("family.schedule.action_error"));
    } finally { setCalling(false); }
  };

  const activeReservations = reservations.filter((item) => item.status !== "cancelled" && localDateAt(new Date(item.startAt), timeZone) === selectedDate);
  const today = localDateAt(new Date(), timeZone);

  return <main className="family-schedule" aria-label={t("family.schedule.aria")} data-testid="family-schedule">
    <header className="family-schedule__header">
      <div><p className="wordmark">{t("family.wordmark")}</p><p className="family-schedule__eyebrow">{t("family.schedule.brand")}</p><h1>{t("family.schedule.title", { name: residentName })}</h1><p className="family-schedule__local-time">{t("family.schedule.local_time", { timeZone })}</p></div>
      <div className="family-schedule__top-actions"><button type="button" className="link" onClick={onBack}>{t("family.schedule.back")}</button><button type="button" onClick={() => void callNow()} disabled={calling}>{calling ? t("family.schedule.calling") : t("family.schedule.call_now")}</button></div>
    </header>
    {error && <p role="alert" className="error">{error}</p>}
    <div className="family-schedule__body">
      <aside className="family-schedule__rail">
        <p className="family-schedule__eyebrow">{t("family.schedule.dates")}</p>
        <nav aria-label={t("family.schedule.dates")} className="family-date-rail">
          {dates.map((date) => <button type="button" key={date} data-testid={`family-date-${date}`} className={date === selectedDate ? "family-date-rail__day family-date-rail__day--selected" : "family-date-rail__day"} aria-pressed={date === selectedDate} onClick={() => { setSelectedDate(date); setSelectedSlot(null); }}><span>{dateLabel(date)}</span>{date === today && <small>{t("family.schedule.today")}</small>}</button>)}
        </nav>
      </aside>
      <section className="family-schedule__content">
        <div className="family-schedule__content-heading"><div><p className="family-schedule__eyebrow">{t("family.schedule.choose_time")}</p><h2>{dateLabel(selectedDate)}</h2></div><p>{t("family.schedule.duration")}</p></div>
        {loading && <p className="loading" role="status">{t("family.schedule.loading")}</p>}
        {!loading && dateSlots.length === 0 && <p className="loading" role="status">{t("family.schedule.no_slots")}</p>}
        <div className="family-slot-grid" aria-label={t("family.schedule.slot_grid")}>
          {dateSlots.map((slot) => { const blocked = slot.state !== "available"; const selected = selectedSlot?.localDate === slot.localDate && selectedSlot.startMinute === slot.startMinute; return <button type="button" key={`${slot.localDate}-${slot.startMinute}`} data-testid={`family-slot-${slot.localDate}-${slot.startMinute}`} className={`family-slot${blocked ? " family-slot--blocked" : ""}${selected ? " family-slot--selected" : ""}`} disabled={blocked || requesting} aria-pressed={selected} aria-label={blocked ? `${minuteLabel(slot.startMinute)}, ${reasonLabel(slot.reason)}` : minuteLabel(slot.startMinute)} onClick={() => { setSelectedSlot(slot); setNotice(null); }}><strong>{minuteLabel(slot.startMinute)}</strong><small>{blocked ? reasonLabel(slot.reason) : t("family.schedule.available")}</small></button>; })}
        </div>
        {selectedSlot && <div className="family-schedule__summary" aria-live="polite"><div><p className="family-schedule__eyebrow">{t("family.schedule.selected_time")}</p><p>{dateLabel(selectedSlot.localDate)} · {minuteLabel(selectedSlot.startMinute)}–{minuteLabel(selectedSlot.endMinute)}</p></div><button type="button" data-testid="family-request-visit" className="primary" onClick={() => void propose()} disabled={requesting}>{requesting ? t("family.schedule.requesting") : t("family.schedule.request")}</button></div>}
        {notice && <p className="family-schedule__notice" role="status">{notice}</p>}
        <p className="family-schedule__hint">{t("family.schedule.blocked_hint")}</p>
        {activeReservations.length > 0 && <div className="family-schedule__reservations"><h2>{t("family.schedule.your_visits")}</h2>{activeReservations.map((item) => <VisitReservationCard key={item.id} api={api} reservation={item} now={now} suggestion={selectedSlot} disabled={requesting} onChanged={() => { void refreshReservations(); setSlotRefresh((value) => value + 1); }} {...(onVisit ? { onVisit } : {})} />)}</div>}
      </section>
    </div>
  </main>;
}
