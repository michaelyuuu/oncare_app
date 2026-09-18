import { Room, RoomEvent, Track, type RemoteTrack } from "livekit-client";

export interface CallCallbacks {
  onRemoteVideo(el: HTMLVideoElement | null): void;
  onRemoteAudio(el: HTMLAudioElement | null): void;
  onRemoteParticipant(present: boolean): void;
  onLocalState(s: { camera: boolean; mic: boolean }): void;
  onLost(): void;
}

export interface CallHandle {
  setVolume(v0to100: number): void;
  setMic(on: boolean): Promise<void>;
  setCamera(on: boolean): Promise<void>;
  localVideoElement(): HTMLVideoElement | null;
  leave(): Promise<void>;
}

export async function createCall(
  url: string,
  token: string,
  cb: CallCallbacks,
  opts: { publish: boolean; RoomImpl?: typeof Room } = { publish: true },
): Promise<CallHandle> {
  const RoomCtor = opts.RoomImpl ?? Room;
  const room = new RoomCtor({ adaptiveStream: true, dynacast: true });
  const audioTracks = new Set<RemoteTrack>();
  const attachedTracks = new Set<RemoteTrack>();
  const local = { camera: false, mic: false };
  let remoteVideo: RemoteTrack | null = null;
  let volume = 0.7;
  let hasHadRemoteParticipant = false;
  let absenceTimer: ReturnType<typeof setTimeout> | null = null;
  let callbacksActive = true;
  let lostReported = false;
  let leavePromise: Promise<void> | null = null;

  const clearAbsenceTimer = () => {
    if (absenceTimer !== null) clearTimeout(absenceTimer);
    absenceTimer = null;
  };
  const reportLost = () => {
    if (!callbacksActive || lostReported) return;
    lostReported = true;
    clearAbsenceTimer();
    callbacksActive = false;
    cleanupMedia(true);
    leavePromise ??= room.disconnect();
    void leavePromise.catch(() => {});
    cb.onLost();
  };
  const startAbsenceTimer = () => {
    if (!callbacksActive || !hasHadRemoteParticipant || absenceTimer !== null || lostReported) return;
    absenceTimer = setTimeout(reportLost, 10_000);
  };
  const detach = (track: RemoteTrack) => {
    if (!attachedTracks.delete(track)) return;
    for (const el of track.detach()) el.remove();
  };
  const cleanupMedia = (notify: boolean) => {
    const hadVideo = remoteVideo !== null;
    const hadAudio = audioTracks.size > 0;
    for (const track of [...attachedTracks]) detach(track);
    remoteVideo = null;
    audioTracks.clear();
    if (notify && hadVideo) cb.onRemoteVideo(null);
    if (notify && hadAudio) cb.onRemoteAudio(null);
  };
  const updatePresence = () => {
    if (!callbacksActive) return;
    const present = room.remoteParticipants.size > 0;
    if (present) {
      hasHadRemoteParticipant = true;
      clearAbsenceTimer();
    } else {
      startAbsenceTimer();
    }
    cb.onRemoteParticipant(present);
  };

  room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
    if (!callbacksActive) return;
    if (track.kind === Track.Kind.Video && remoteVideo === null) {
      remoteVideo = track;
      attachedTracks.add(track);
      cb.onRemoteVideo(track.attach() as HTMLVideoElement);
    } else if (track.kind === Track.Kind.Audio) {
      audioTracks.add(track);
      attachedTracks.add(track);
      const el = track.attach() as HTMLAudioElement;
      (track as { setVolume?: (value: number) => void }).setVolume?.(volume);
      cb.onRemoteAudio(el);
    }
  });
  room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
    if (!callbacksActive) return;
    if (track === remoteVideo) {
      detach(track);
      remoteVideo = null;
      cb.onRemoteVideo(null);
    } else if (audioTracks.delete(track)) {
      detach(track);
      if (audioTracks.size === 0) cb.onRemoteAudio(null);
    }
  });
  room.on(RoomEvent.ParticipantConnected, updatePresence);
  room.on(RoomEvent.ParticipantDisconnected, updatePresence);
  room.on(RoomEvent.Reconnecting, () => {
    console.info("LiveKit room reconnecting");
    startAbsenceTimer();
  });
  room.on(RoomEvent.Reconnected, () => {
    console.info("LiveKit room reconnected");
    if (room.remoteParticipants.size > 0) clearAbsenceTimer();
    else startAbsenceTimer();
  });
  room.on(RoomEvent.Disconnected, () => {
    if (leavePromise !== null || !callbacksActive) return;
    reportLost();
  });

  try {
    await room.connect(url, token);
    if (!callbacksActive) throw new Error("Call ended during startup");
    if (opts.publish) {
      await room.localParticipant.setCameraEnabled(true);
      if (!callbacksActive) throw new Error("Call ended during startup");
      local.camera = true;
      cb.onLocalState({ ...local });
      if (!callbacksActive) throw new Error("Call ended during startup");
      await room.localParticipant.setMicrophoneEnabled(true);
      if (!callbacksActive) throw new Error("Call ended during startup");
      local.mic = true;
    }
    cb.onLocalState({ ...local });
    updatePresence();
  } catch (error) {
    callbacksActive = false;
    clearAbsenceTimer();
    cleanupMedia(false);
    await (leavePromise ??= room.disconnect());
    throw error;
  }

  return {
    setVolume(value) {
      volume = Math.min(1, Math.max(0, value / 100));
      for (const track of audioTracks) {
        (track as { setVolume?: (nextVolume: number) => void }).setVolume?.(volume);
      }
    },
    async setMic(on) {
      if (!opts.publish || !callbacksActive) return;
      await room.localParticipant.setMicrophoneEnabled(on);
      if (!callbacksActive) return;
      local.mic = on;
      cb.onLocalState({ ...local });
    },
    async setCamera(on) {
      if (!opts.publish || !callbacksActive) return;
      await room.localParticipant.setCameraEnabled(on);
      if (!callbacksActive) return;
      local.camera = on;
      cb.onLocalState({ ...local });
    },
    localVideoElement() {
      if (!callbacksActive) return null;
      for (const publication of room.localParticipant.videoTrackPublications.values()) {
        if (publication.track) return publication.track.attach() as HTMLVideoElement;
      }
      return null;
    },
    leave() {
      if (leavePromise !== null) return leavePromise;
      callbacksActive = false;
      clearAbsenceTimer();
      cleanupMedia(true);
      leavePromise = room.disconnect();
      return leavePromise;
    },
  };
}
