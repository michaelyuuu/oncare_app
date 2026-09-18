import { useEffect, useRef, useState } from "react";
import { ApiError, createCall, t, type Api, type CallHandle } from "@oncare/web-common";

interface CallPanelProps {
  api: Api;
  visitId: string;
  residentName: string;
  onConnected: () => void;
  onLost: () => void;
}

export function CallPanel({ api, visitId, residentName, onConnected, onLost }: CallPanelProps) {
  const remoteRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLDivElement>(null);
  const localRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<CallHandle | null>(null);
  const callbacksRef = useRef({ onConnected, onLost });
  const activeRef = useRef(false);
  const connectedOnceRef = useRef(false);
  const lostOnceRef = useRef(false);
  const leftRef = useRef(false);
  const [present, setPresent] = useState(false);
  const [localState, setLocalState] = useState({ camera: false, mic: false });

  callbacksRef.current = { onConnected, onLost };

  useEffect(() => {
    let cancelled = false;
    activeRef.current = true;
    connectedOnceRef.current = false;
    lostOnceRef.current = false;
    leftRef.current = false;

    const leaveOnce = (handle = handleRef.current) => {
      if (!handle || leftRef.current) return;
      leftRef.current = true;
      void handle.leave();
    };
    const replaceMedia = (host: HTMLDivElement | null, element: HTMLMediaElement | null) => {
      if (!host) return;
      if (!element) {
        host.replaceChildren();
        return;
      }
      element.autoplay = true;
      element.setAttribute("playsinline", "");
      host.replaceChildren(element);
    };
    const attachLocalPreview = (handle: CallHandle) => {
      const element = handle.localVideoElement();
      if (!element || !localRef.current) return;
      element.muted = true;
      replaceMedia(localRef.current, element);
    };
    const reportLost = () => {
      if (!activeRef.current || lostOnceRef.current) return;
      lostOnceRef.current = true;
      leaveOnce();
      callbacksRef.current.onLost();
    };

    void (async () => {
      try {
        const { url, token } = await api.post<{ url: string; token: string; room: string }>(`/visits/${visitId}/token`);
        if (cancelled) return;
        const handle = await createCall(url, token, {
          onRemoteVideo: (element) => {
            if (activeRef.current) replaceMedia(remoteRef.current, element);
          },
          onRemoteAudio: (element) => {
            if (activeRef.current) replaceMedia(audioRef.current, element);
          },
          onRemoteParticipant: (nextPresent) => {
            if (!activeRef.current) return;
            setPresent(nextPresent);
            if (nextPresent && !connectedOnceRef.current) {
              connectedOnceRef.current = true;
              callbacksRef.current.onConnected();
            }
          },
          onLocalState: (nextState) => {
            if (!activeRef.current) return;
            setLocalState(nextState);
            if (handleRef.current) attachLocalPreview(handleRef.current);
          },
          onLost: reportLost,
        }, { publish: true });
        if (cancelled) {
          await handle.leave();
          return;
        }
        handleRef.current = handle;
        attachLocalPreview(handle);
      } catch (error) {
        if (!cancelled && !(error instanceof ApiError && error.status === 409)) reportLost();
      }
    })();

    return () => {
      cancelled = true;
      activeRef.current = false;
      leaveOnce();
      handleRef.current = null;
    };
  }, [api, visitId]);

  const status = present ? t("family.call.connected") : t("family.call.waiting", { name: residentName });
  return <section className="call-panel" aria-label={t("family.call.region")}>
    <div ref={remoteRef} className="call-remote" aria-label={status} />
    <div ref={localRef} className="call-local" aria-hidden="true" />
    <div ref={audioRef} className="call-media-audio" aria-hidden="true" />
    <p className="call-status" aria-live="polite">{status}</p>
    <div className="call-controls">
      <button type="button" onClick={() => void handleRef.current?.setMic(!localState.mic)}>{t(localState.mic ? "family.call.mute" : "family.call.unmute")}</button>
      <button type="button" onClick={() => void handleRef.current?.setCamera(!localState.camera)}>{t(localState.camera ? "family.call.camera_off" : "family.call.camera_on")}</button>
    </div>
  </section>;
}
