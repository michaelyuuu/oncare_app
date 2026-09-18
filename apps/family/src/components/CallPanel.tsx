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
  const [present, setPresent] = useState(false);
  const [localState, setLocalState] = useState({ camera: false, mic: false });
  const [controlError, setControlError] = useState<string | null>(null);

  callbacksRef.current = { onConnected, onLost };

  useEffect(() => {
    let cancelled = false;
    let generationHandle: CallHandle | null = null;
    let connectedOnce = false;
    let lostOnce = false;
    let left = false;

    const leaveOnce = (handle = generationHandle) => {
      if (!handle || left) return;
      left = true;
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
      if (cancelled || lostOnce) return;
      lostOnce = true;
      leaveOnce();
      callbacksRef.current.onLost();
    };

    void (async () => {
      try {
        const { url, token } = await api.post<{ url: string; token: string; room: string }>(`/visits/${visitId}/token`);
        if (cancelled) return;
        const handle = await createCall(url, token, {
          onRemoteVideo: (element) => {
            if (!cancelled) replaceMedia(remoteRef.current, element);
          },
          onRemoteAudio: (element) => {
            if (!cancelled) replaceMedia(audioRef.current, element);
          },
          onRemoteParticipant: (nextPresent) => {
            if (cancelled) return;
            setPresent(nextPresent);
            if (nextPresent && !connectedOnce) {
              connectedOnce = true;
              callbacksRef.current.onConnected();
            }
          },
          onLocalState: (nextState) => {
            if (cancelled) return;
            setLocalState(nextState);
            if (generationHandle) attachLocalPreview(generationHandle);
          },
          onLost: reportLost,
        }, { publish: true });
        if (cancelled) {
          await handle.leave();
          return;
        }
        generationHandle = handle;
        handleRef.current = handle;
        attachLocalPreview(handle);
      } catch (error) {
        if (!cancelled && !(error instanceof ApiError && error.status === 409)) reportLost();
      }
    })();

    return () => {
      cancelled = true;
      leaveOnce();
      if (handleRef.current === generationHandle) handleRef.current = null;
    };
  }, [api, visitId]);

  async function updateControl(operation: (handle: CallHandle) => Promise<void>) {
    const handle = handleRef.current;
    if (!handle) return;
    setControlError(null);
    try {
      await operation(handle);
    } catch {
      setControlError(t("family.call.control_error"));
    }
  }

  const status = present ? t("family.call.connected") : t("family.call.waiting", { name: residentName });
  return <section className="call-panel" aria-label={t("family.call.region")}>
    <div ref={remoteRef} className="call-remote" aria-label={status} />
    <div ref={localRef} className="call-local" aria-hidden="true" />
    <div ref={audioRef} className="call-media-audio" aria-hidden="true" />
    <p className="call-status" aria-live="polite">{status}</p>
    {controlError && <p className="error" role="alert">{controlError}</p>}
    <div className="call-controls">
      <button type="button" onClick={() => void updateControl((handle) => handle.setMic(!localState.mic))}>{t(localState.mic ? "family.call.mute" : "family.call.unmute")}</button>
      <button type="button" onClick={() => void updateControl((handle) => handle.setCamera(!localState.camera))}>{t(localState.camera ? "family.call.camera_off" : "family.call.camera_on")}</button>
    </div>
  </section>;
}
