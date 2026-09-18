import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiError, type CallHandle } from "@oncare/web-common";

const callMock = vi.hoisted(() => ({ createCall: vi.fn(), callbacks: undefined as any }));
vi.mock("@oncare/web-common", async (importOriginal) => {
  const original = await importOriginal<typeof import("@oncare/web-common")>();
  return { ...original, createCall: callMock.createCall };
});

import { CallPanel } from "../src/components/CallPanel";

let localVideo: HTMLVideoElement;
let handle: CallHandle;

function apiWithToken() {
  return {
    get: vi.fn(),
    post: vi.fn(async () => ({ url: "wss://video.example", token: "token", room: "v1" })),
  } as any;
}

beforeEach(() => {
  localVideo = document.createElement("video");
  handle = {
    setVolume: vi.fn(),
    setMic: vi.fn(async () => {}),
    setCamera: vi.fn(async () => {}),
    localVideoElement: vi.fn(() => localVideo),
    leave: vi.fn(async () => {}),
  };
  callMock.callbacks = undefined;
  callMock.createCall.mockReset().mockImplementation(async (_url, _token, callbacks) => {
    callMock.callbacks = callbacks;
    callbacks.onLocalState({ camera: true, mic: true });
    return handle;
  });
});

afterEach(() => cleanup());

test("joins with publishing, attaches scoped media and the initial muted preview, and toggles controls", async () => {
  const api = apiWithToken();
  const { container } = render(<CallPanel api={api} visitId="v1" residentName="Mom" onConnected={vi.fn()} onLost={vi.fn()} />);

  expect(await screen.findByText("Waiting for Mom to join…")).toBeInTheDocument();
  await waitFor(() => expect(callMock.createCall).toHaveBeenCalled());
  expect(callMock.createCall).toHaveBeenCalledWith("wss://video.example", "token", expect.any(Object), { publish: true });
  expect(localVideo).toBe(container.querySelector(".call-local video"));
  expect(localVideo.muted).toBe(true);

  const remoteVideo = document.createElement("video");
  const remoteAudio = document.createElement("audio");
  act(() => {
    callMock.callbacks.onRemoteVideo(remoteVideo);
    callMock.callbacks.onRemoteAudio(remoteAudio);
  });
  expect(remoteVideo).toBe(container.querySelector(".call-remote video"));
  expect(remoteAudio).toBe(container.querySelector(".call-media-audio audio"));
  expect(document.body.lastElementChild).not.toBe(remoteAudio);

  await userEvent.click(screen.getByRole("button", { name: "Mute" }));
  await userEvent.click(screen.getByRole("button", { name: "Camera off" }));
  expect(handle.setMic).toHaveBeenCalledWith(false);
  expect(handle.setCamera).toHaveBeenCalledWith(false);
  act(() => callMock.callbacks.onLocalState({ camera: false, mic: false }));
  expect(screen.getByRole("button", { name: "Unmute" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Camera on" })).toBeInTheDocument();
});

test("reports connected and terminal loss exactly once and ignores callbacks after unmount", async () => {
  const onConnected = vi.fn();
  const onLost = vi.fn();
  const view = render(<CallPanel api={apiWithToken()} visitId="v1" residentName="Mom" onConnected={onConnected} onLost={onLost} />);
  await waitFor(() => expect(callMock.callbacks).toBeDefined());

  act(() => {
    callMock.callbacks.onRemoteParticipant(true);
    callMock.callbacks.onRemoteParticipant(false);
    callMock.callbacks.onRemoteParticipant(true);
    callMock.callbacks.onLost();
    callMock.callbacks.onLost();
  });
  expect(onConnected).toHaveBeenCalledTimes(1);
  expect(onLost).toHaveBeenCalledTimes(1);
  expect(handle.leave).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Connected")).toBeInTheDocument();

  const staleCallbacks = callMock.callbacks;
  view.unmount();
  expect(handle.leave).toHaveBeenCalledTimes(1);
  act(() => {
    staleCallbacks.onRemoteParticipant(true);
    staleCallbacks.onLost();
  });
  expect(onConnected).toHaveBeenCalledTimes(1);
  expect(onLost).toHaveBeenCalledTimes(1);
});

test("uses the latest lifecycle callbacks without rejoining", async () => {
  const firstConnected = vi.fn();
  const latestConnected = vi.fn();
  const latestLost = vi.fn();
  const api = apiWithToken();
  const view = render(<CallPanel api={api} visitId="v1" residentName="Mom" onConnected={firstConnected} onLost={vi.fn()} />);
  await waitFor(() => expect(callMock.callbacks).toBeDefined());
  view.rerender(<CallPanel api={api} visitId="v1" residentName="Mom" onConnected={latestConnected} onLost={latestLost} />);
  const callbacks = callMock.callbacks;

  act(() => {
    callbacks.onRemoteParticipant(true);
    callbacks.onLost();
  });
  expect(firstConnected).not.toHaveBeenCalled();
  expect(latestConnected).toHaveBeenCalledTimes(1);
  expect(latestLost).toHaveBeenCalledTimes(1);
  expect(callMock.createCall).toHaveBeenCalledTimes(1);
});

test("ignores callbacks from a replaced call generation without leaving the new handle", async () => {
  const oldConnected = vi.fn();
  const oldLost = vi.fn();
  const newConnected = vi.fn();
  const newLost = vi.fn();
  const oldHandle = handle;
  const newHandle: CallHandle = {
    setVolume: vi.fn(), setMic: vi.fn(async () => {}), setCamera: vi.fn(async () => {}),
    localVideoElement: vi.fn(() => document.createElement("video")), leave: vi.fn(async () => {}),
  };
  callMock.createCall
    .mockImplementationOnce(async (_url, _token, callbacks) => { callbacks.onLocalState({ camera: true, mic: true }); return oldHandle; })
    .mockImplementationOnce(async (_url, _token, callbacks) => { callbacks.onLocalState({ camera: true, mic: true }); return newHandle; });
  const firstApi = apiWithToken();
  const secondApi = apiWithToken();
  const view = render(<CallPanel api={firstApi} visitId="v1" residentName="Mom" onConnected={oldConnected} onLost={oldLost} />);
  await waitFor(() => expect(callMock.createCall).toHaveBeenCalledTimes(1));
  const oldCallbacks = callMock.createCall.mock.calls[0]![2];

  view.rerender(<CallPanel api={secondApi} visitId="v2" residentName="Dad" onConnected={newConnected} onLost={newLost} />);
  await waitFor(() => expect(callMock.createCall).toHaveBeenCalledTimes(2));
  const newCallbacks = callMock.createCall.mock.calls[1]![2];
  expect(oldHandle.leave).toHaveBeenCalledTimes(1);

  act(() => {
    oldCallbacks.onRemoteParticipant(true);
    oldCallbacks.onLost();
  });
  expect(oldConnected).not.toHaveBeenCalled();
  expect(oldLost).not.toHaveBeenCalled();
  expect(newConnected).not.toHaveBeenCalled();
  expect(newLost).not.toHaveBeenCalled();
  expect(newHandle.leave).not.toHaveBeenCalled();

  act(() => newCallbacks.onRemoteParticipant(true));
  expect(newConnected).toHaveBeenCalledTimes(1);
});

test("shows recoverable feedback when microphone or camera controls fail", async () => {
  handle.setMic = vi.fn(async () => { throw new Error("mic denied"); });
  handle.setCamera = vi.fn(async () => { throw new Error("camera denied"); });
  render(<CallPanel api={apiWithToken()} visitId="v1" residentName="Mom" onConnected={vi.fn()} onLost={vi.fn()} />);
  await waitFor(() => expect(callMock.callbacks).toBeDefined());

  await userEvent.click(screen.getByRole("button", { name: "Mute" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not update the call controls. Try again.");
  act(() => callMock.callbacks.onLocalState({ camera: true, mic: true }));
  await userEvent.click(screen.getByRole("button", { name: "Camera off" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not update the call controls. Try again.");
});

test("leaves a handle that resolves after unmount", async () => {
  let resolveHandle!: (value: CallHandle) => void;
  callMock.createCall.mockImplementation(() => new Promise<CallHandle>((resolve) => { resolveHandle = resolve; }));
  const view = render(<CallPanel api={apiWithToken()} visitId="v1" residentName="Mom" onConnected={vi.fn()} onLost={vi.fn()} />);
  await waitFor(() => expect(callMock.createCall).toHaveBeenCalled());
  view.unmount();

  await act(async () => resolveHandle(handle));
  expect(handle.leave).toHaveBeenCalledTimes(1);
});

test("waits for a server refresh on token 409 but reports other startup failures", async () => {
  const waitingLost = vi.fn();
  const failedLost = vi.fn();
  const waitingApi = apiWithToken();
  waitingApi.post.mockRejectedValue(new ApiError(409, "invalid_visit_state"));
  const failedApi = apiWithToken();
  failedApi.post.mockRejectedValue(new ApiError(503, "unavailable"));

  render(<CallPanel api={waitingApi} visitId="v1" residentName="Mom" onConnected={vi.fn()} onLost={waitingLost} />);
  render(<CallPanel api={failedApi} visitId="v2" residentName="Dad" onConnected={vi.fn()} onLost={failedLost} />);
  await waitFor(() => expect(failedLost).toHaveBeenCalledTimes(1));
  expect(waitingLost).not.toHaveBeenCalled();
  expect(screen.getByText("Waiting for Mom to join…")).toBeInTheDocument();
});
