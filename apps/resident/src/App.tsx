import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DEMO_VISIT_POLICY } from "@oncare/core/scheduling";
import { ApiError, connectEvents, createApi, t, type VisitContact, type VisitReservationView } from "@oncare/web-common";
import { isCommunicationScreen, selectScreen, type DeviceState, type UiOverrides } from "./screen";
import { useIdleReturn } from "./idle";
import { speak } from "./speech";
import { readDeviceToken, writeDeviceToken } from "./storage";
import { StatusBar } from "./components/StatusBar";
import { HoldToUnlock } from "./components/HoldToUnlock";
import { Home } from "./screens/Home";
import { Incoming } from "./screens/Incoming";
import { InCall } from "./screens/InCall";
import { DeliveryArrived } from "./screens/DeliveryArrived";
import { CaregiverCalled } from "./screens/CaregiverCalled";
import { Settings, type PinGuard } from "./screens/Settings";
import { AssistantPanel } from "./components/AssistantPanel";
import { requestStaffHelp } from "./assistant";
import { VisitCalendar } from "./screens/VisitCalendar";

// This boundary covers screen render/lifecycle errors; async errors use returnHome.
export class ScreenBoundary extends Component<{ children: ReactNode; fallback: ReactNode; onError: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onError(); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
function stateKey(server: DeviceState | null): string {
  return server ? `${server.screen}:${server.visit?.id ?? ""}:${server.visit?.state ?? ""}:${JSON.stringify(server.task)}` : "missing";
}

export function App({ apiBase }: { apiBase: string }) {
  const [deviceToken, setDeviceToken] = useState(readDeviceToken);
  const [boot, setBoot] = useState(0);
  const [jwt, setJwt] = useState<string | null>(null);
  const [server, setServer] = useState<DeviceState | null>(null);
  const [ui, setUi] = useState<UiOverrides>({ caregiverCalledUntil: null, settingsOpen: deviceToken === null, apiReachable: false });
  const [now, setNow] = useState(Date.now);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [helpStatus, setHelpStatus] = useState<"idle" | "sending" | "recorded" | "error">("idle");
  const [contacts, setContacts] = useState<VisitContact[]>([]);
  const [reservations, setReservations] = useState<VisitReservationView[]>([]);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [local, setLocal] = useState({ camera: false, mic: false });
  const busy = useRef(false);
  const generation = useRef(0);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const refreshScheduling = useRef<() => Promise<void>>(async () => {});
  const spoken = useRef(new Set<string>());
  const screenShown = useRef(new Set<string>());
  const helpIdempotencyKey = useRef<string | null>(null);
  const pinGuard = useRef<PinGuard>({ failures: 0, lockedUntil: 0 });
  const api = useMemo(() => createApi(apiBase, () => jwt), [apiBase, jwt]);
  const key = stateKey(server);
  const keyRef = useRef(key); keyRef.current = key;

  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const epoch = ++generation.current;
    let stopped = false, request = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let events: { close(): void } | undefined;
    const current = () => !stopped && generation.current === epoch;
    setJwt(null); setServer(null); busy.current = false; setPending(false);
    setContacts([]); setReservations([]); setSelectedContactId(null); setCalendarOpen(false);
    const failed = () => {
      setDismissed(keyRef.current);
      setAssistantOpen(false);
      setUi({ settingsOpen: false, caregiverCalledUntil: null, apiReachable: false });
    };
    const authenticate = async () => {
      try {
        const auth = await createApi(apiBase, () => null).post<{ token: string }>("/auth/device", { deviceToken });
        if (!current()) return;
        if (!auth.token) throw new Error("Missing authentication token");
        setJwt(auth.token);
        const client = createApi(apiBase, () => auth.token);
        let residentId = "";
        let scheduleRequest = 0;
        const fetchScheduling = async (nextResidentId: string) => {
          const serial = ++scheduleRequest;
          try {
            const [contactResult, reservationResult] = await Promise.all([
              client.get<{ contacts?: VisitContact[] }>("/visit-reservations/contacts"),
              client.get<{ reservations?: VisitReservationView[] }>("/visit-reservations"),
            ]);
            if (!current() || serial !== scheduleRequest) return;
            residentId = nextResidentId;
            setContacts(Array.isArray(contactResult.contacts) ? contactResult.contacts : []);
            setReservations(Array.isArray(reservationResult.reservations) ? reservationResult.reservations : []);
          } catch {
            // The communication home remains usable when scheduling is offline.
          }
        };
        const fetchState = async () => {
          const serial = ++request;
          try {
            const result = await client.get<DeviceState>("/device/state");
            if (!current() || serial !== request) return;
            residentId = result.resident.id;
            setServer(result); setUi((value) => ({ ...value, apiReachable: true }));
            void fetchScheduling(result.resident.id);
          } catch (failure) {
            if (!current() || serial !== request) return;
            failed();
            if (failure instanceof ApiError && failure.status === 401) {
              generation.current++; setBoot((value) => value + 1);
            }
          }
        };
        refresh.current = fetchState;
        refreshScheduling.current = async () => { if (residentId) await fetchScheduling(residentId); };
        void fetchState();
        poll = setInterval(() => void fetchState(), 5000);
        events = connectEvents(apiBase, auth.token, () => void fetchState());
      } catch {
        if (!current()) return;
        failed(); retry = setTimeout(() => void authenticate(), 5000);
      }
    };
    if (deviceToken) void authenticate();
    return () => { stopped = true; if (generation.current === epoch) generation.current++; clearTimeout(retry); clearInterval(poll); events?.close(); refresh.current = async () => {}; refreshScheduling.current = async () => {}; };
  }, [apiBase, deviceToken, boot]);

  const returnHome = useCallback((withError = false) => {
    setDismissed(keyRef.current); setError(withError);
    setAssistantOpen(false);
    setCalendarOpen(false);
    setUi((value) => ({ ...value, settingsOpen: false, caregiverCalledUntil: null }));
  }, []);
  const selected = selectScreen(server, ui, now);
  const serverScreen = !ui.settingsOpen && dismissed === key && selected !== "disconnected" ? "home" : selected;
  const screen = calendarOpen && (serverScreen === "home" || serverScreen === "disconnected") ? "visit_calendar" : serverScreen;
  useEffect(() => {
    if (serverScreen !== "home" && serverScreen !== "disconnected") setCalendarOpen(false);
  }, [serverScreen]);
  useIdleReturn(90_000, returnHome, screen !== "home" && screen !== "disconnected" && screen !== "in_call");
  useEffect(() => {
    if (screen === "incoming" && server?.visit && !spoken.current.has(server.visit.id)) {
      spoken.current.add(server.visit.id);
      speak(t("resident.incoming.spoken", { name: server.caller?.displayName ?? "" }));
    }
  }, [screen, server]);
  useEffect(() => {
    const entityId = server?.visit?.id ?? server?.task?.id;
    if ((screen !== "incoming" && screen !== "delivery_arrived") || !entityId || !jwt || !ui.apiReachable) return;
    const key = `${screen}:${entityId}`;
    if (screenShown.current.has(key)) return;
    screenShown.current.add(key);
    void api.post("/device/screen-shown", { screen, entityId }).catch(() => { screenShown.current.delete(key); });
  }, [api, jwt, screen, server, ui.apiReachable]);

  const perform = async (path: string) => {
    if (busy.current || !jwt || !ui.apiReachable) return;
    const epoch = generation.current;
    busy.current = true; setPending(true);
    try {
      await api.post(path);
      if (epoch !== generation.current) return;
      setError(false); setDismissed(null);
       void refresh.current();
    } catch { if (epoch === generation.current) returnHome(true); }
    finally { if (epoch === generation.current) { busy.current = false; setPending(false); } }
  };
  const helpStaff = async () => {
    if (busy.current || !jwt || !ui.apiReachable) return;
    const epoch = generation.current;
    const key = helpIdempotencyKey.current ?? (
      "touch-" + (globalThis.crypto?.randomUUID?.() ?? (Date.now().toString(36) + "-" + Math.random().toString(36).slice(2)))
    );
    helpIdempotencyKey.current = key;
    busy.current = true; setPending(true); setHelpStatus("sending");
    try {
      await requestStaffHelp(api, key);
      if (epoch !== generation.current) return;
      helpIdempotencyKey.current = null;
      setHelpStatus("recorded"); setError(false);
    } catch {
      if (epoch === generation.current) setHelpStatus("error");
    } finally {
      if (epoch === generation.current) { busy.current = false; setPending(false); }
    }
  };
  const callNow = async () => {
    if (busy.current || !jwt || !ui.apiReachable || !selectedContactId) return;
    const epoch = generation.current;
    busy.current = true; setPending(true);
    try {
      await api.post("/visits/now", { contactUserId: selectedContactId });
      if (epoch !== generation.current) return;
      setCalendarOpen(false); setError(false); setDismissed(null);
      void refresh.current();
    } catch {
      if (epoch === generation.current) returnHome(true);
    } finally {
      if (epoch === generation.current) { busy.current = false; setPending(false); }
    }
  };
  const saveToken = async (token: string) => {
    if (busy.current) return;
    busy.current = true; setPending(true);
    const epoch = generation.current;
    try {
      const auth = await createApi(apiBase, () => null).post<{ token: string }>("/auth/device", { deviceToken: token });
      if (epoch !== generation.current) return;
      if (!auth.token) throw new Error("Missing authentication token");
      // Validate before persistence: a typo must not turn first setup into a PIN-locked device.
      writeDeviceToken(token); generation.current++;
      setDeviceToken(token); setBoot((value) => value + 1);
      setJwt(null); setServer(null); setDismissed(null); setError(false);
      setUi({ settingsOpen: false, caregiverCalledUntil: null, apiReachable: false });
    } catch { if (epoch === generation.current) returnHome(true); }
    finally { busy.current = false; setPending(false); }
  };
  const callerName = server?.caller?.displayName ?? "";
  const home = <Home
    name={server?.resident.displayName ?? ""}
    now={now}
    contacts={contacts}
    selectedContactId={selectedContactId}
    onSelectContact={setSelectedContactId}
    onOpenAssistant={() => setAssistantOpen(true)}
    onScheduleVisit={() => setCalendarOpen(true)}
    onCallNow={() => void callNow()}
    onHelpStaff={() => void helpStaff()}
    helpStatus={helpStatus}
    disabled={pending || !jwt || !ui.apiReachable}
    offline={!jwt || !ui.apiReachable}
    error={error}
  />;
  const calendar = <VisitCalendar
    api={api}
    residentId={server?.resident.id ?? ""}
    timeZone={DEMO_VISIT_POLICY.timeZone}
    contacts={contacts}
    reservations={reservations}
    selectedContactId={selectedContactId}
    onSelectContact={setSelectedContactId}
    onClose={() => setCalendarOpen(false)}
    onChanged={() => void refreshScheduling.current()}
  />;
  const inCall = screen === "in_call";
  const communicationSurface = isCommunicationScreen(screen);
  useEffect(() => { if (!inCall) setLocal({ camera: false, mic: false }); }, [inCall]);
  const action = (actionName: string) => { if (server?.visit) void perform(`/visits/${encodeURIComponent(server.visit.id)}/${actionName}`); };
  const reportCall = async (visitId: string, actionName: "connected" | "connection_lost") => {
    if (!jwt || !ui.apiReachable) { returnHome(true); return; }
    const epoch = generation.current;
    try {
      await api.post(`/visits/${encodeURIComponent(visitId)}/${actionName}`);
      if (epoch === generation.current) { setError(false); setDismissed(null); void refresh.current(); }
    } catch { if (epoch === generation.current) returnHome(true); }
  };
  return <div className="kiosk" data-screen={screen}>
    {!communicationSurface && <StatusBar cameraOn={inCall && local.camera} micOn={inCall && local.mic} simulated={server?.robot.adapter === "mock"} callerName={inCall && server?.visit?.state === "active" ? callerName : null}/>}
    <main className={"stage" + (communicationSurface ? " stage--communication" : "")}>
      {!communicationSurface && error && <p className="feedback" role="status">{t("resident.error.retry")}</p>}
      <ScreenBoundary key={`${screen}:${server?.visit?.id ?? ""}`} fallback={home} onError={() => returnHome(true)}>
        {(screen === "home" || screen === "disconnected") && !assistantOpen && home}
        {(screen === "home" || screen === "disconnected") && assistantOpen && <AssistantPanel api={api} residentName={server?.resident.displayName ?? ""} disabled={pending || !jwt || !ui.apiReachable} onHelpStaff={() => void helpStaff()} helpStatus={helpStatus} onClose={() => setAssistantOpen(false)} />}
        {screen === "visit_calendar" && calendar}
        {screen === "incoming" && <Incoming callerName={callerName} onAnswer={() => action("answer")} onDecline={() => action("decline")} disabled={pending}/>}
        {screen === "in_call" && server?.visit && <InCall api={api} visitId={server.visit.id} callerName={callerName} active={server.visit.state === "active"} onConnected={() => void reportCall(server.visit!.id, "connected")} onLost={() => void reportCall(server.visit!.id, "connection_lost")} onEnd={() => action("end")} onLocalState={setLocal} disabled={pending || server.visit.state !== "active"}/>}
        {screen === "delivery_arrived" && server?.task && <DeliveryArrived itemLabel={server.task.item.label} onReceived={() => void perform(`/tasks/${encodeURIComponent(server.task!.id)}/received`)}/>}
        {screen === "caregiver_called" && <CaregiverCalled/>}
        {screen === "settings" && <Settings api={api} requirePin={deviceToken !== null} currentToken={deviceToken} pinGuard={pinGuard.current} onSaveToken={(token) => void saveToken(token)} onBack={() => { setDismissed(null); setError(false); setUi((value) => ({ ...value, settingsOpen: false })); }} onError={() => returnHome(true)}/>}
      </ScreenBoundary>
    </main>
    <HoldToUnlock onUnlock={() => { setError(false); setUi((value) => ({ ...value, settingsOpen: true })); }}/>
  </div>;
}
