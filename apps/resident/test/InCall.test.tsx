import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createCall: vi.fn() }));
vi.mock("@oncare/web-common", async (importOriginal) => {
  const original = await importOriginal<typeof import("@oncare/web-common")>();
  return { ...original, createCall: mocks.createCall };
});

import { ApiError, type CallCallbacks, type CallHandle } from "@oncare/web-common";
import { InCall } from "../src/screens/InCall";

let callbacks: CallCallbacks;
let handle: CallHandle;
let api: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };

beforeEach(() => {
  handle = {
    setVolume: vi.fn(), setMic: vi.fn(), setCamera: vi.fn(),
    localVideoElement: vi.fn(() => null), leave: vi.fn(async () => {}),
  };
  mocks.createCall.mockReset().mockImplementation(async (_url, _token, nextCallbacks) => {
    callbacks = nextCallbacks;
    return handle;
  });
  api = {
    get: vi.fn(),
    post: vi.fn(async () => ({ url: "wss://x", token: "tok", room: "v1" })),
  };
});
afterEach(() => cleanup());

function props(overrides: Record<string, unknown> = {}) {
  return {
    api: api as any, visitId: "v1", callerName: "Amy", active: true,
    onConnected: vi.fn(), onLost: vi.fn(), onEnd: vi.fn(), onLocalState: vi.fn(),
    ...overrides,
  };
}

test("joins the visit, scopes remote media, reports state, changes volume, and leaves on End", async () => {
  const input = props();
  render(<InCall {...input}/>);
  await waitFor(() => expect(mocks.createCall).toHaveBeenCalledWith("wss://x", "tok", expect.anything(), { publish: true }));
  expect(api.post).toHaveBeenCalledWith("/visits/v1/token");

  const firstVideo = document.createElement("video");
  const secondVideo = document.createElement("video");
  const audio = document.createElement("audio");
  act(() => { callbacks.onRemoteVideo(firstVideo); callbacks.onRemoteVideo(secondVideo); callbacks.onRemoteAudio(audio); });
  const stage = screen.getByTestId("video-stage");
  expect(stage.contains(firstVideo)).toBe(false);
  expect(stage.contains(secondVideo)).toBe(true);
  expect(stage.contains(audio)).toBe(true);
  expect(audio.hidden).toBe(true);

  act(() => {
    callbacks.onRemoteParticipant(true);
    callbacks.onRemoteParticipant(true);
    callbacks.onLocalState({ camera: true, mic: true });
  });
  expect(input.onConnected).toHaveBeenCalledTimes(1);
  expect(input.onLocalState).toHaveBeenLastCalledWith({ camera: true, mic: true });

  await userEvent.click(screen.getByRole("button", { name: "Louder" }));
  expect(handle.setVolume).toHaveBeenLastCalledWith(80);
  await userEvent.click(screen.getByRole("button", { name: "End" }));
  await waitFor(() => expect(handle.leave).toHaveBeenCalledTimes(1));
  expect(input.onEnd).toHaveBeenCalledTimes(1);
});

test("reports connection loss once and ignores SDK callbacks after cleanup", async () => {
  const input = props();
  const view = render(<InCall {...input}/>);
  await waitFor(() => expect(mocks.createCall).toHaveBeenCalled());
  act(() => { callbacks.onLost(); callbacks.onLost(); });
  expect(input.onLost).toHaveBeenCalledTimes(1);
  view.unmount();
  act(() => {
    callbacks.onRemoteParticipant(true);
    callbacks.onLocalState({ camera: true, mic: true });
    callbacks.onLost();
  });
  expect(input.onConnected).not.toHaveBeenCalled();
  expect(input.onLocalState).not.toHaveBeenCalled();
  expect(input.onLost).toHaveBeenCalledTimes(1);
});

test("leaves a handle that resolves after unmount", async () => {
  let resolveHandle!: (value: CallHandle) => void;
  mocks.createCall.mockImplementation((_url, _token, nextCallbacks) => {
    callbacks = nextCallbacks;
    return new Promise<CallHandle>((resolve) => { resolveHandle = resolve; });
  });
  const view = render(<InCall {...props()}/>);
  await waitFor(() => expect(mocks.createCall).toHaveBeenCalled());
  view.unmount();
  await act(async () => resolveHandle(handle));
  expect(handle.leave).toHaveBeenCalledTimes(1);
});

test("waits for server refresh on token 409 but reports other startup failures", async () => {
  const conflict = props();
  api.post.mockRejectedValueOnce(new ApiError(409, "invalid_visit_state"));
  const first = render(<InCall {...conflict}/>);
  await waitFor(() => expect(api.post).toHaveBeenCalled());
  expect(conflict.onLost).not.toHaveBeenCalled();
  first.unmount();

  const failure = props();
  api.post.mockRejectedValueOnce(new ApiError(500, "http_error"));
  render(<InCall {...failure}/>);
  await waitFor(() => expect(failure.onLost).toHaveBeenCalledTimes(1));
});
