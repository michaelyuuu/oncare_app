import { useEffect, useMemo, useState } from "react";
import { DEMO_VISIT_POLICY } from "@oncare/core/scheduling";
import { ApiError, type Api, type VisitContact, type VisitReservationView, type VisitSlot, t } from "@oncare/web-common";
import { VisitContactPicker, type ResidentVisitContact } from "../components/VisitContactPicker";
import { VisitReservationCard } from "../components/VisitReservationCard";

type SlotResponse = { timeZone?: string; slots?: VisitSlot[] };

function validTimeZone(value: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return value;
  } catch {
    return DEMO_VISIT_POLICY.timeZone;
  }
}

export function localDateAt(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: validTimeZone(timeZone),
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const fields = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function addDays(localDate: string, amount: number): string {
  const value = new Date(`${localDate}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function dateLabel(localDate: string): string {
  const value = new Date(`${localDate}T00:00:00.000Z`);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(value);
}

function minuteLabel(startMinute: number): string {
  const hour = Math.floor(startMinute / 60);
  const minute = startMinute % 60;
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${minute.toString().padStart(2, "0")} ${suffix}`;
}

function slotReason(reason: VisitSlot["reason"]): string {
  return reason ? t(`resident.visit.blocked.${reason}`) : t("resident.visit.unavailable");
}

function reservationForDate(reservation: VisitReservationView, localDate: string, timeZone: string): boolean {
  return localDateAt(new Date(reservation.startAt), timeZone) === localDate;
}

export function VisitCalendar({
  api,
  residentId,
  timeZone: initialTimeZone,
  contacts,
  reservations,
  onClose,
  onChanged,
  selectedContactId,
  onSelectContact,
}: {
  api: Api;
  residentId: string;
  timeZone: string;
  contacts: ResidentVisitContact[] | VisitContact[];
  reservations: VisitReservationView[];
  onClose: () => void;
  onChanged: () => void;
  selectedContactId?: string | null;
  onSelectContact?: (contactUserId: string) => void;
}) {
  const startingTimeZone = validTimeZone(initialTimeZone || DEMO_VISIT_POLICY.timeZone);
  const [timeZone, setTimeZone] = useState(startingTimeZone);
  const [windowStartDate] = useState(() => localDateAt(new Date(), startingTimeZone));
  const [selectedDate, setSelectedDate] = useState(windowStartDate);
  const [slots, setSlots] = useState<VisitSlot[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<VisitSlot | null>(null);
  const [localContactId, setLocalContactId] = useState<string | null>(selectedContactId ?? null);
  const [loading, setLoading] = useState(true);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const [slotRefresh, setSlotRefresh] = useState(0);

  const contactId = selectedContactId === undefined ? localContactId : selectedContactId;
  const approvedContacts = contacts as ResidentVisitContact[];

  useEffect(() => {
    if (selectedContactId !== undefined) setLocalContactId(selectedContactId);
  }, [selectedContactId]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api.get<SlotResponse>(`/visit-reservations/slots?residentId=${encodeURIComponent(residentId)}&from=${encodeURIComponent(windowStartDate)}`)
      .then((body) => {
        if (cancelled) return;
        setSlots(Array.isArray(body.slots) ? body.slots : []);
        if (body.timeZone) setTimeZone(validTimeZone(body.timeZone));
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        setSlots([]);
        setError(failure instanceof ApiError && failure.status === 409 ? t("resident.visit.unavailable") : t("resident.visit.offline"));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api, residentId, windowStartDate, slotRefresh]);

  const dates = useMemo(() => {
    const fromSlots = [...new Set(slots.map((slot) => slot.localDate))];
    if (fromSlots.length > 0) return fromSlots;
    return Array.from({ length: DEMO_VISIT_POLICY.windowDays }, (_, index) => addDays(windowStartDate, index));
  }, [windowStartDate, slots]);
  const dateSlots = slots.filter((slot) => slot.localDate === selectedDate);
  const activeReservations = reservations.filter((reservation) => reservation.residentId === residentId && reservation.status !== "cancelled");
  const dateReservations = activeReservations.filter((reservation) => reservationForDate(reservation, selectedDate, timeZone));
  const selectedContact = approvedContacts.find((contact) => contact.userId === contactId);
  const notifyChanged = () => {
    setSlotRefresh((value) => value + 1);
    onChanged();
  };

  useEffect(() => {
    setSlotRefresh((value) => value + 1);
  }, [reservations]);

  const selectContact = (nextId: string) => {
    setLocalContactId(nextId);
    onSelectContact?.(nextId);
    setNotice(null);
  };

  const reserve = async () => {
    if (!contactId || !selectedSlot || selectedSlot.state !== "available" || requesting) return;
    setRequesting(true);
    setError(null);
    setNotice(null);
    try {
      await api.post("/visit-reservations", {
        contactUserId: contactId,
        localDate: selectedSlot.localDate,
        startMinute: selectedSlot.startMinute,
      });
      setSelectedSlot(null);
      setNotice(t("resident.visit.request_sent"));
      notifyChanged();
    } catch (failure) {
      setError(failure instanceof ApiError && failure.status === 409 ? t("resident.visit.conflict") : t("resident.visit.action_error"));
      notifyChanged();
    } finally {
      setRequesting(false);
    }
  };

  return <section className="visit-calendar" aria-label={t("resident.visit.calendar_aria")} data-testid="resident-visit-calendar">
    <header className="visit-calendar__header">
      <div>
        <p className="visit-calendar__eyebrow">{t("resident.visit.brand")}</p>
        <h1>{t("resident.visit.title")}</h1>
        <p className="visit-calendar__local-time">{t("resident.visit.local_time", { timeZone })}</p>
      </div>
      <button type="button" className="communication-ghost visit-calendar__close" onClick={onClose}>{t("resident.visit.close")}</button>
    </header>

    <div className="visit-calendar__body">
      <aside className="visit-calendar__rail">
        <VisitContactPicker contacts={approvedContacts} selectedContactId={contactId} onSelect={selectContact} />
        <nav className="visit-date-rail" aria-label={t("resident.visit.dates")}>
          {dates.map((date) => <button
            type="button"
            className={`visit-date-rail__day${date === selectedDate ? " visit-date-rail__day--selected" : ""}`}
            aria-pressed={date === selectedDate}
            key={date}
            data-testid={`resident-date-${date}`}
            onClick={() => { setSelectedDate(date); setSelectedSlot(null); setError(null); }}
          >
            <span>{dateLabel(date)}</span>
            {date === localDateAt(new Date(), timeZone) && <small>{t("resident.visit.today")}</small>}
          </button>)}
        </nav>
      </aside>

      <div className="visit-calendar__content">
        <div className="visit-calendar__content-heading">
          <div>
            <p className="visit-calendar__eyebrow">{t("resident.visit.choose_time")}</p>
            <h2>{dateLabel(selectedDate)}</h2>
          </div>
          <p className="visit-calendar__policy">{t("resident.visit.duration")}</p>
        </div>
        {loading && <p className="visit-calendar__message" role="status">{t("resident.visit.loading")}</p>}
        {error && <p className="visit-calendar__error" role="alert">{error}</p>}
        {!loading && dateSlots.length === 0 && !error && <p className="visit-calendar__message" role="status">{t("resident.visit.no_slots")}</p>}
        <div className="visit-slot-grid" aria-label={t("resident.visit.slot_grid")}>
          {dateSlots.map((slot) => {
            const isSelected = selectedSlot?.localDate === slot.localDate && selectedSlot.startMinute === slot.startMinute;
            const blocked = slot.state !== "available";
            return <button
              type="button"
              className={`visit-slot${blocked ? " visit-slot--blocked" : ""}${isSelected ? " visit-slot--selected" : ""}`}
              key={`${slot.localDate}-${slot.startMinute}`}
              data-testid={`resident-slot-${slot.localDate}-${slot.startMinute}`}
              disabled={blocked || requesting}
              aria-pressed={isSelected}
              aria-label={blocked ? `${minuteLabel(slot.startMinute)}, ${slotReason(slot.reason)}` : minuteLabel(slot.startMinute)}
              onClick={() => { setSelectedSlot(slot); setError(null); setNotice(null); }}
            >
              <strong>{minuteLabel(slot.startMinute)}</strong>
              <small>{blocked ? slotReason(slot.reason) : t("resident.visit.available")}</small>
            </button>;
          })}
        </div>

        {selectedSlot && <div className="visit-calendar__summary" aria-live="polite">
          <div>
            <p className="visit-calendar__eyebrow">{t("resident.visit.selected_time")}</p>
            <p className="visit-calendar__summary-text">{dateLabel(selectedSlot.localDate)} · {minuteLabel(selectedSlot.startMinute)}–{minuteLabel(selectedSlot.endMinute)}</p>
            <p className="visit-calendar__summary-contact">{selectedContact ? t("resident.visit.with_contact", { name: selectedContact.displayName }) : t("resident.visit.choose_contact")}</p>
          </div>
          <button type="button" data-testid="resident-request-visit" className="communication-solid visit-calendar__request" onClick={() => void reserve()} disabled={!contactId || requesting}>
            {requesting ? t("resident.visit.requesting") : t("resident.visit.request")}
          </button>
        </div>}

        {notice && <p className="visit-calendar__notice" role="status">{notice}</p>}
        <p className="visit-calendar__hint">{t("resident.visit.blocked_hint")}</p>

        {dateReservations.length > 0 && <div className="visit-calendar__reservations">
          <h2>{t("resident.visit.your_visits")}</h2>
          {dateReservations.map((reservation) => <VisitReservationCard
            api={api}
            key={reservation.id}
            reservation={reservation}
            now={now}
            suggestion={selectedSlot}
            disabled={requesting}
            onChanged={notifyChanged}
          />)}
        </div>}
      </div>
    </div>
  </section>;
}
