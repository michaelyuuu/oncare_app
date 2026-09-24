import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError, type Api } from "@oncare/web-common";
import { Settings, type PinGuard } from "../src/screens/Settings";
import { HoldToUnlock } from "../src/components/HoldToUnlock";
afterEach(() => { cleanup(); vi.useRealTimers(); });
function enterPin() { for (const digit of ["1", "2", "3", "4"]) fireEvent.click(screen.getByRole("button", { name: digit })); }
test("three wrong PINs lock for 30 seconds including across remount, then permit retry", async () => {
  vi.useFakeTimers(); const post = vi.fn().mockRejectedValue(new ApiError(401, "invalid_pin"));
  const api = { get: vi.fn(), post, patch: vi.fn(), del: vi.fn() } as Api;
  const guard: PinGuard = { failures: 0, lockedUntil: 0 };
  const props = { api, requirePin: true, currentToken: "demo", onBack: vi.fn(), onSaveToken: vi.fn(), pinGuard: guard };
  const view = render(<Settings {...props}/>);
  for (let i = 0; i < 3; i++) { enterPin(); await act(async () => {}); }
  expect(post).toHaveBeenCalledTimes(3); expect(screen.getByRole("button", { name: "1" })).toBeDisabled();
  expect(screen.queryByLabelText("Device token")).not.toBeInTheDocument();
  view.unmount(); render(<Settings {...props}/>);
  await act(async () => vi.advanceTimersByTimeAsync(29_999));
  expect(screen.getByRole("button", { name: "1" })).toBeDisabled();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(screen.getByRole("button", { name: "1" })).toBeEnabled();
  post.mockResolvedValue({ ok: true }); enterPin(); await act(async () => {});
  expect(screen.getByLabelText("Device token")).toBeInTheDocument();
});
test("PIN request disables repeat entry, network failure returns home, timers clean up", async () => {
  vi.useFakeTimers(); let reject: (error: Error) => void = () => {};
  const post = vi.fn(() => new Promise((_, fail) => { reject = fail; }));
  const onError = vi.fn(); const view = render(<Settings api={{ get: vi.fn(), post, patch: vi.fn(), del: vi.fn() } as Api} requirePin currentToken="demo" onBack={vi.fn()} onSaveToken={vi.fn()} onError={onError}/>);
  enterPin(); enterPin(); expect(post).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error("offline"))); expect(onError).toHaveBeenCalledTimes(1);
  view.unmount(); expect(vi.getTimerCount()).toBe(0);
});
test("closing settings before each deferred PIN rejection still locks after three failures", async () => {
  vi.useFakeTimers();
  let reject: (error: Error) => void = () => {};
  const post = vi.fn(() => new Promise((_, fail) => { reject = fail; }));
  const guard: PinGuard = { failures: 0, lockedUntil: 0 };
  const props = { api: { get: vi.fn(), post, patch: vi.fn(), del: vi.fn() } as Api, requirePin: true, currentToken: "demo", onSaveToken: vi.fn(), pinGuard: guard };
  for (let attempt = 0; attempt < 3; attempt++) {
    const view = render(<Settings {...props} onBack={() => view.unmount()}/>);
    enterPin();
    fireEvent.click(screen.getByRole("button", { name: "Back to resident view" }));
    expect(screen.queryByRole("group", { name: "PIN" })).not.toBeInTheDocument();
    await act(async () => reject(new ApiError(401, "invalid_pin")));
  }
  expect(post).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
  render(<Settings {...props} onBack={vi.fn()}/>);
  expect(screen.getByRole("button", { name: "1" })).toBeDisabled();
  await act(async () => vi.advanceTimersByTimeAsync(29_999));
  expect(screen.getByRole("button", { name: "1" })).toBeDisabled();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(screen.getByRole("button", { name: "1" })).toBeEnabled();
});
test("hold requires three seconds; cancel and unmount remove timers", () => {
  vi.useFakeTimers(); const unlock = vi.fn(); const view = render(<HoldToUnlock onUnlock={unlock}/>);
  const logo = screen.getByRole("button"); fireEvent.pointerDown(logo);
  act(() => vi.advanceTimersByTime(2999)); expect(unlock).not.toHaveBeenCalled();
  fireEvent.pointerCancel(logo); act(() => vi.advanceTimersByTime(1)); expect(unlock).not.toHaveBeenCalled();
  fireEvent.pointerDown(logo); act(() => vi.advanceTimersByTime(3000)); expect(unlock).toHaveBeenCalledTimes(1);
  fireEvent.pointerDown(logo); view.unmount(); expect(vi.getTimerCount()).toBe(0);
});
