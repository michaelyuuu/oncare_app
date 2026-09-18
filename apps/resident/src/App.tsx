import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, connectEvents, createApi, t } from "@oncare/web-common";
import { selectScreen, type DeviceState, type UiOverrides } from "./screen";
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
  const [local, setLocal] = useState({ camera: false, mic: false });
  const busy = useRef(false);
  const generation = useRef(0);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const spoken = useRef(new Set<string>());
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
    const failed = () => {
      setDismissed(keyRef.current);
      setUi({ settingsOpen: false, caregiverCalledUntil: null, apiReachable: false });
    };
    const authenticate = async () => {
      try {
        const auth = await createApi(apiBase, () => null).post<{ token: string }>("/auth/device", { deviceToken });
        if (!current()) return;
        if (!auth.token) throw new Error("Missing authentication token");
        setJwt(auth.token);
        const client = createApi(apiBase, () => auth.token);
        const fetchState = async () => {
          const serial = ++request;
          try {
            const result = await client.get<DeviceState>("/device/state");
            if (!current() || serial !== request) return;
            setServer(result); setUi((value) => ({ ...value, apiReachable: true }));
          } catch (failure) {
            if (!current() || serial !== request) return;
            failed();
            if (failure instanceof ApiError && failure.status === 401) {
              generation.current++; setBoot((value) => value + 1);
            }
          }
        };
        refresh.current = fetchState;
        void fetchState();
        poll = setInterval(() => void fetchState(), 5000);
        events = connectEvents(apiBase, auth.token, () => void fetchState());
      } catch {
        if (!current()) return;
        failed(); retry = setTimeout(() => void authenticate(), 5000);
      }
    };
    if (deviceToken) void authenticate();
    return () => { stopped = true; if (generation.current === epoch) generation.current++; clearTimeout(retry); clearInterval(poll); events?.close(); refresh.current = async () => {}; };
  }, [apiBase, deviceToken, boot]);

  const returnHome = useCallback((withError = false) => {
    setDismissed(keyRef.current); setError(withError);
    setUi((value) => ({ ...value, settingsOpen: false, caregiverCalledUntil: null }));
  }, []);
  const selected = selectScreen(server, ui, now);
  const screen = !ui.settingsOpen && dismissed === key && selected !== "disconnected" ? "home" : selected;
  useIdleReturn(90_000, returnHome, screen !== "home" && screen !== "disconnected" && screen !== "in_call");
  useEffect(() => {
    if (screen === "incoming" && server?.visit && !spoken.current.has(server.visit.id)) {
      spoken.current.add(server.visit.id);
      speak(t("resident.incoming.spoken", { name: server.caller?.displayName ?? "" }));
    }
  }, [screen, server]);

  const perform = async (path: string, caregiver = false) => {
    if (busy.current || !jwt || !ui.apiReachable) return;
    const epoch = generation.current;
    busy.current = true; setPending(true);
    try {
      await api.post(path);
      if (epoch !== generation.current) return;
      setError(false); setDismissed(null);
      if (caregiver) setUi((value) => ({ ...value, caregiverCalledUntil: Date.now() + 8000 }));
      else void refresh.current();
    } catch { if (epoch === generation.current) returnHome(true); }
    finally { if (epoch === generation.current) { busy.current = false; setPending(false); } }
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
  const home = <Home name={server?.resident.displayName ?? ""} now={now} onCallCaregiver={() => void perform("/device/call-caregiver", true)} disabled={pending || !jwt || !ui.apiReachable}/>;
  const inCall = screen === "in_call";
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
    <StatusBar cameraOn={inCall && local.camera} micOn={inCall && local.mic} simulated={server?.robot.adapter === "mock"} callerName={inCall && server?.visit?.state === "active" ? callerName : null}/>
    <main className="stage">
      {(screen === "disconnected" || error) && <p className="feedback" role="status">{t(error ? "resident.error.retry" : "resident.error.reconnecting")}</p>}
      <ScreenBoundary key={`${screen}:${server?.visit?.id ?? ""}`} fallback={home} onError={() => returnHome(true)}>
        {(screen === "home" || screen === "disconnected") && home}
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
