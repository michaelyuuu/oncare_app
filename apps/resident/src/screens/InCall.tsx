import { useEffect, useRef, useState } from "react";
import { ApiError, createCall, t, type Api, type CallHandle } from "@oncare/web-common";
import { BigButton } from "../components/BigButton";

type LocalState = { camera: boolean; mic: boolean };
type InCallProps = {
  api: Api; visitId: string; callerName: string; active: boolean;
  onConnected: () => void; onLost: () => void; onEnd: () => void;
  onLocalState: (state: LocalState) => void; disabled?: boolean;
};

export function InCall({ api, visitId, callerName, active, onConnected, onLost, onEnd, onLocalState, disabled = false }: InCallProps) {
  const stage = useRef<HTMLDivElement>(null);
  const handleRef = useRef<CallHandle | null>(null);
  const reportLostRef = useRef<() => void>(() => {});
  const endingRef = useRef(false);
  const latest = useRef({ onConnected, onLost, onEnd, onLocalState });
  latest.current = { onConnected, onLost, onEnd, onLocalState };
  const [volume, setVolume] = useState(70);
  const [ending, setEnding] = useState(false);

  useEffect(() => {
    let live = true, connectedReported = false, lostReported = false;
    const removeMedia = () => stage.current?.querySelectorAll("video, audio").forEach((element) => element.remove());
    const leave = async () => {
      const handle = handleRef.current;
      handleRef.current = null;
      if (handle) await handle.leave();
    };
    const reportLost = () => {
      if (!live || lostReported) return;
      lostReported = true; removeMedia();
      void leave().catch(() => {});
      latest.current.onLost();
    };
    reportLostRef.current = reportLost;
    void (async () => {
      try {
        const { url, token } = await api.post<{ url: string; token: string; room: string }>(`/visits/${encodeURIComponent(visitId)}/token`);
        if (!live) return;
        const handle = await createCall(url, token, {
          onRemoteVideo: (element) => {
            if (!live || !stage.current) return;
            stage.current.querySelectorAll("video").forEach((video) => video.remove());
            if (element) { element.autoplay = true; element.playsInline = true; stage.current.appendChild(element); }
          },
          onRemoteAudio: (element) => {
            if (!live || !stage.current) return;
            stage.current.querySelectorAll("audio").forEach((audio) => audio.remove());
            if (element) { element.autoplay = true; element.hidden = true; stage.current.appendChild(element); }
          },
          onRemoteParticipant: (present) => {
            if (live && present && !connectedReported) { connectedReported = true; latest.current.onConnected(); }
          },
          onLocalState: (state) => { if (live) latest.current.onLocalState(state); },
          onLost: reportLost,
        }, { publish: true });
        if (!live || lostReported) { await handle.leave(); return; }
        handleRef.current = handle;
        handle.setVolume(volume);
      } catch (error) {
        if (live && !(error instanceof ApiError && error.status === 409)) reportLost();
      }
    })();
    return () => { live = false; reportLostRef.current = () => {}; removeMedia(); void leave().catch(() => {}); };
  }, [api, visitId]);

  const changeVolume = (delta: number) => setVolume((current) => {
    const next = Math.min(100, Math.max(0, current + delta));
    try { handleRef.current?.setVolume(next); } catch { reportLostRef.current(); }
    return next;
  });
  const end = async () => {
    if (endingRef.current) return;
    endingRef.current = true;
    setEnding(true);
    const handle = handleRef.current; handleRef.current = null;
    try { await handle?.leave(); latest.current.onEnd(); }
    catch { reportLostRef.current(); }
  };
  const caption = active ? t("resident.incall.connected", { name: callerName }) : t("resident.incall.connecting");
  return <section className="screen screen--incall">
    <div ref={stage} className="video-stage" data-testid="video-stage" aria-label={caption}><p className="video-caption">{caption}</p></div>
    <div className="call-controls">
      <button type="button" className="quiet-button" onClick={() => changeVolume(-10)}>{t("resident.incall.quieter")}</button>
      <span className="volume" aria-live="polite">{t("resident.incall.volume", { volume })}</span>
      <button type="button" className="quiet-button" onClick={() => changeVolume(10)}>{t("resident.incall.louder")}</button>
    </div>
    <BigButton tone="danger" disabled={disabled || ending} onClick={() => void end()}>{t("resident.incall.end")}</BigButton>
  </section>;
}
