import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createCall } from "../src/call";

const livekit = vi.hoisted(() => {
  class FakeTrack {
    el = { play: vi.fn(), remove: vi.fn(), volume: 1 };
    attach = vi.fn(() => this.el);
    detach = vi.fn(() => [this.el]);
    setVolume = vi.fn();

    constructor(public kind: "video" | "audio") {}
  }

  class FakeRoom {
    static last: FakeRoom;
    handlers = new Map<string, Function[]>();
    remoteParticipants = new Map<string, unknown>();
    localParticipant = {
      setMicrophoneEnabled: vi.fn(async () => {}),
      setCameraEnabled: vi.fn(async () => {}),
      videoTrackPublications: new Map<string, { track?: FakeTrack }>(),
    };
    connected = false;
    connectError: Error | null = null;
    disconnect = vi.fn(async () => {
      this.connected = false;
      this.emit("disconnected");
    });

    constructor(_options?: unknown) { FakeRoom.last = this; }
    on(ev: string, h: Function) {
      const handlers = this.handlers.get(ev) ?? [];
      handlers.push(h);
      this.handlers.set(ev, handlers);
      return this;
    }
    emit(ev: string, ...args: unknown[]) {
      for (const h of this.handlers.get(ev) ?? []) h(...args);
    }
    async connect(_url: string, _token: string) {
      if (this.connectError) throw this.connectError;
      this.connected = true;
    }
  }

  return {
    FakeRoom,
    FakeTrack,
    RoomEvent: {
      TrackSubscribed: "trackSubscribed",
      TrackUnsubscribed: "trackUnsubscribed",
      ParticipantConnected: "participantConnected",
      ParticipantDisconnected: "participantDisconnected",
      Disconnected: "disconnected",
      Reconnecting: "reconnecting",
      Reconnected: "reconnected",
    },
  };
});

vi.mock("livekit-client", () => ({
  Room: livekit.FakeRoom,
  RoomEvent: livekit.RoomEvent,
  Track: { Kind: { Video: "video", Audio: "audio" } },
}));

const { FakeRoom, FakeTrack } = livekit;

function callbacks() {
  return {
    onRemoteVideo: vi.fn(),
    onRemoteAudio: vi.fn(),
    onRemoteParticipant: vi.fn(),
    onLocalState: vi.fn(),
    onLost: vi.fn(),
  };
}

describe("createCall", () => {
  test("reports camera publishing before microphone startup completes", async () => {
    const cb = callbacks();
    let finishMic!: () => void;
    const pending = createCall("wss://x", "tok", cb, { publish: true, RoomImpl: FakeRoom as never });
    FakeRoom.last.localParticipant.setMicrophoneEnabled.mockImplementation(() => new Promise<void>((resolve) => { finishMic = resolve; }));
    await Promise.resolve();
    await Promise.resolve();
    expect(cb.onLocalState).toHaveBeenLastCalledWith({ camera: true, mic: false });
    finishMic();
    const handle = await pending;
    expect(cb.onLocalState).toHaveBeenLastCalledWith({ camera: true, mic: true });
    await handle.leave();
  });

  test.each(["camera", "microphone"])("loss during pending %s startup stops continuation and late notifications", async (stage) => {
    const cb = callbacks();
    let finish!: () => void;
    const pending = createCall("wss://x", "tok", cb, { publish: true, RoomImpl: FakeRoom as never });
    const room = FakeRoom.last;
    const operation = stage === "camera" ? room.localParticipant.setCameraEnabled : room.localParticipant.setMicrophoneEnabled;
    operation.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    await Promise.resolve();
    await Promise.resolve();
    room.emit("disconnected");
    expect(room.disconnect).toHaveBeenCalledTimes(1);
    const notifications = cb.onLocalState.mock.calls.length;
    finish();
    await expect(pending).rejects.toThrow("Call ended during startup");
    expect(cb.onLocalState).toHaveBeenCalledTimes(notifications);
    expect(cb.onRemoteParticipant).not.toHaveBeenCalled();
    expect(room.disconnect).toHaveBeenCalledTimes(1);
    expect(cb.onLost).toHaveBeenCalledTimes(1);
    if (stage === "camera") expect(room.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
  });

  test.each(["mic", "camera"] as const)("pending %s control does not notify after leave", async (control) => {
    const cb = callbacks();
    const handle = await createCall("wss://x", "tok", cb, { publish: true, RoomImpl: FakeRoom as never });
    let finish!: () => void;
    const operation = control === "mic" ? FakeRoom.last.localParticipant.setMicrophoneEnabled : FakeRoom.last.localParticipant.setCameraEnabled;
    operation.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const pending = control === "mic" ? handle.setMic(false) : handle.setCamera(false);
    const notifications = cb.onLocalState.mock.calls.length;
    await handle.leave();
    finish();
    await pending;
    expect(cb.onLocalState).toHaveBeenCalledTimes(notifications);
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("connects, publishes when asked, and reports initial presence", async () => {
    const cb = callbacks();
    const handle = await createCall("wss://x", "tok", cb, { publish: true, RoomImpl: FakeRoom as never });
    const room = FakeRoom.last;

    expect(room.connected).toBe(true);
    expect(room.localParticipant.setCameraEnabled).toHaveBeenCalledWith(true);
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    expect(cb.onLocalState).toHaveBeenLastCalledWith({ camera: true, mic: true });
    expect(cb.onRemoteParticipant).toHaveBeenCalledWith(false);
    await handle.leave();
  });

  test("keeps subscribe-only calls unable to publish through setters", async () => {
    const cb = callbacks();
    const handle = await createCall("wss://x", "tok", cb, { publish: false, RoomImpl: FakeRoom as never });

    await handle.setCamera(true);
    await handle.setMic(true);

    expect(FakeRoom.last.localParticipant.setCameraEnabled).not.toHaveBeenCalled();
    expect(FakeRoom.last.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(cb.onLocalState).toHaveBeenLastCalledWith({ camera: false, mic: false });
    await handle.leave();
  });

  test("attaches only the first remote camera and clears it when that track leaves", async () => {
    const cb = callbacks();
    const handle = await createCall("wss://x", "tok", cb, { publish: true, RoomImpl: FakeRoom as never });
    const first = new FakeTrack("video");
    const second = new FakeTrack("video");

    FakeRoom.last.emit("trackSubscribed", first, {}, {});
    FakeRoom.last.emit("trackSubscribed", second, {}, {});
    expect(cb.onRemoteVideo).toHaveBeenCalledTimes(1);
    expect(cb.onRemoteVideo).toHaveBeenCalledWith(first.el);
    expect(second.attach).not.toHaveBeenCalled();

    FakeRoom.last.emit("trackUnsubscribed", second, {}, {});
    expect(cb.onRemoteVideo).toHaveBeenCalledTimes(1);
    FakeRoom.last.emit("trackUnsubscribed", first, {}, {});
    expect(first.el.remove).toHaveBeenCalled();
    expect(cb.onRemoteVideo).toHaveBeenLastCalledWith(null);
    await handle.leave();
  });

  test("tracks each remote audio lifetime and applies clamped volume only while subscribed", async () => {
    const cb = callbacks();
    const handle = await createCall("wss://x", "tok", cb, { publish: true, RoomImpl: FakeRoom as never });
    const first = new FakeTrack("audio");
    const second = new FakeTrack("audio");

    FakeRoom.last.emit("trackSubscribed", first, {}, {});
    FakeRoom.last.emit("trackSubscribed", second, {}, {});
    handle.setVolume(130);
    expect(first.setVolume).toHaveBeenLastCalledWith(1);
    expect(second.setVolume).toHaveBeenLastCalledWith(1);

    FakeRoom.last.emit("trackUnsubscribed", first, {}, {});
    expect(first.el.remove).toHaveBeenCalled();
    expect(cb.onRemoteAudio).not.toHaveBeenLastCalledWith(null);
    handle.setVolume(-10);
    expect(first.setVolume).toHaveBeenCalledTimes(2);
    expect(second.setVolume).toHaveBeenLastCalledWith(0);

    FakeRoom.last.emit("trackUnsubscribed", second, {}, {});
    expect(cb.onRemoteAudio).toHaveBeenLastCalledWith(null);
    await handle.leave();
  });

  test("reports participant presence and loses once after ten seconds of absence", async () => {
    const cb = callbacks();
    const handle = await createCall("wss://x", "tok", cb, { publish: true, RoomImpl: FakeRoom as never });
    const room = FakeRoom.last;

    room.remoteParticipants.set("p1", {});
    room.emit("participantConnected", {});
    expect(cb.onRemoteParticipant).toHaveBeenLastCalledWith(true);
    room.remoteParticipants.clear();
    room.emit("participantDisconnected", {});
    expect(cb.onRemoteParticipant).toHaveBeenLastCalledWith(false);
    vi.advanceTimersByTime(9_999);
    expect(cb.onLost).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cb.onLost).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(20_000);
    expect(cb.onLost).toHaveBeenCalledTimes(1);
    await handle.leave();
  });

  test("cancels the absence deadline when a participant returns", async () => {
    const cb = callbacks();
    const handle = await createCall("wss://x", "tok", cb, { publish: true, RoomImpl: FakeRoom as never });
    const room = FakeRoom.last;
    room.remoteParticipants.set("p1", {});
    room.emit("participantConnected", {});
    room.remoteParticipants.clear();
    room.emit("participantDisconnected", {});
    vi.advanceTimersByTime(5_000);
    room.remoteParticipants.set("p1", {});
    room.emit("participantConnected", {});
    vi.advanceTimersByTime(10_000);
    expect(cb.onLost).not.toHaveBeenCalled();
    await handle.leave();
  });

  test("bounds reconnecting to ten seconds after a peer has been present and cancels on recovery", async () => {
    const cb = callbacks();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const handle = await createCall("wss://secret-host", "secret-token", cb, { publish: true, RoomImpl: FakeRoom as never });
    const room = FakeRoom.last;
    room.remoteParticipants.set("p1", {});
    room.emit("participantConnected", {});

    room.emit("reconnecting");
    vi.advanceTimersByTime(5_000);
    room.emit("reconnected");
    vi.advanceTimersByTime(10_000);
    expect(cb.onLost).not.toHaveBeenCalled();
    room.emit("reconnecting");
    vi.advanceTimersByTime(10_000);
    expect(cb.onLost).toHaveBeenCalledTimes(1);
    expect(info.mock.calls.flat().join(" ")).not.toMatch(/secret-host|secret-token/);
    await handle.leave();
  });

  test("reconnect timeout removes attached media and reports terminal callbacks once", async () => {
    const cb = callbacks();
    vi.spyOn(console, "info").mockImplementation(() => {});
    const handle = await createCall("wss://x", "tok", cb, { publish: true, RoomImpl: FakeRoom as never });
    const room = FakeRoom.last;
    const video = new FakeTrack("video");
    const audio = new FakeTrack("audio");
    room.remoteParticipants.set("p1", {});
    room.emit("participantConnected", {});
    room.emit("trackSubscribed", video, {}, {});
    room.emit("trackSubscribed", audio, {}, {});

    room.emit("reconnecting");
    vi.advanceTimersByTime(10_000);
    room.emit("disconnected");
    room.emit("trackUnsubscribed", video, {}, {});

    expect(video.detach).toHaveBeenCalledTimes(1);
    expect(audio.detach).toHaveBeenCalledTimes(1);
    expect(video.el.remove).toHaveBeenCalledTimes(1);
    expect(audio.el.remove).toHaveBeenCalledTimes(1);
    expect(cb.onRemoteVideo).toHaveBeenLastCalledWith(null);
    expect(cb.onRemoteVideo).toHaveBeenCalledTimes(2);
    expect(cb.onRemoteAudio).toHaveBeenLastCalledWith(null);
    expect(cb.onRemoteAudio).toHaveBeenCalledTimes(2);
    expect(cb.onLost).toHaveBeenCalledTimes(1);
    await handle.leave();
  });

  test("unexpected disconnect reports loss once and suppresses later stale events", async () => {
    const cb = callbacks();
    vi.spyOn(console, "info").mockImplementation(() => {});
    const handle = await createCall("wss://x", "tok", cb, { publish: true, RoomImpl: FakeRoom as never });
    const room = FakeRoom.last;
    room.remoteParticipants.set("p1", {});
    room.emit("participantConnected", {});
    room.emit("reconnecting");
    room.emit("disconnected");
    room.emit("disconnected");
    room.emit("trackSubscribed", new FakeTrack("video"), {}, {});
    vi.advanceTimersByTime(10_000);

    expect(cb.onLost).toHaveBeenCalledTimes(1);
    expect(cb.onRemoteVideo).not.toHaveBeenCalled();
    await handle.leave();
  });

  test("leave is idempotent, removes attached media, and suppresses stale callbacks", async () => {
    const cb = callbacks();
    const handle = await createCall("wss://x", "tok", cb, { publish: true, RoomImpl: FakeRoom as never });
    const room = FakeRoom.last;
    const video = new FakeTrack("video");
    const audio = new FakeTrack("audio");
    room.emit("trackSubscribed", video, {}, {});
    room.emit("trackSubscribed", audio, {}, {});

    await handle.leave();
    await handle.leave();
    room.emit("participantConnected", {});
    room.emit("trackSubscribed", new FakeTrack("video"), {}, {});

    expect(room.disconnect).toHaveBeenCalledTimes(1);
    expect(video.el.remove).toHaveBeenCalled();
    expect(audio.el.remove).toHaveBeenCalled();
    expect(cb.onRemoteVideo).toHaveBeenLastCalledWith(null);
    expect(cb.onRemoteAudio).toHaveBeenLastCalledWith(null);
    expect(cb.onLost).not.toHaveBeenCalled();
  });

  test("disconnects and suppresses callbacks when startup publishing fails", async () => {
    const cb = callbacks();
    const room = new FakeRoom();
    room.localParticipant.setCameraEnabled.mockRejectedValueOnce(new Error("permission denied"));

    await expect(createCall("wss://x", "tok", cb, { publish: true, RoomImpl: class extends FakeRoom {
      constructor() { super(); return room; }
    } as never })).rejects.toThrow("permission denied");

    expect(room.disconnect).toHaveBeenCalledTimes(1);
    room.emit("disconnected");
    room.emit("participantConnected", {});
    expect(cb.onLost).not.toHaveBeenCalled();
    expect(cb.onRemoteParticipant).not.toHaveBeenCalled();
  });

  test("setMic and setCamera report successful local state and expose local preview", async () => {
    const cb = callbacks();
    const handle = await createCall("wss://x", "tok", cb, { publish: true, RoomImpl: FakeRoom as never });
    const preview = new FakeTrack("video");
    FakeRoom.last.localParticipant.videoTrackPublications.set("camera", { track: preview });

    await handle.setMic(false);
    await handle.setCamera(false);
    expect(cb.onLocalState).toHaveBeenLastCalledWith({ camera: false, mic: false });
    expect(handle.localVideoElement()).toBe(preview.el);
    await handle.leave();
  });
});
