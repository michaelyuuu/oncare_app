import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useIdleReturn } from "../src/idle";
function Probe({ onIdle, enabled = true }: { onIdle: () => void; enabled?: boolean }) { useIdleReturn(1000, onIdle, enabled); return null; }
beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });
test("fires once per idle period and rearms on interaction", () => {
  const idle = vi.fn(); render(<Probe onIdle={idle}/>);
  act(() => { vi.advanceTimersByTime(900); window.dispatchEvent(new Event("pointerdown")); vi.advanceTimersByTime(900); });
  expect(idle).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(5000)); expect(idle).toHaveBeenCalledTimes(1);
  act(() => { window.dispatchEvent(new Event("keydown")); vi.advanceTimersByTime(1000); }); expect(idle).toHaveBeenCalledTimes(2);
});
test("rerenders do not reset elapsed time and disabled/unmount cleans up", () => {
  const idle = vi.fn(); const view = render(<Probe onIdle={() => idle()}/>);
  act(() => vi.advanceTimersByTime(900)); view.rerender(<Probe onIdle={() => idle()}/>);
  act(() => vi.advanceTimersByTime(100)); expect(idle).toHaveBeenCalledTimes(1);
  view.rerender(<Probe onIdle={idle} enabled={false}/>);
  act(() => vi.advanceTimersByTime(5000)); expect(idle).toHaveBeenCalledTimes(1);
  view.unmount(); expect(vi.getTimerCount()).toBe(0);
});
