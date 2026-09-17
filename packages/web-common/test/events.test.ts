import { describe, expect, test, vi } from "vitest";
import { connectEvents } from "../src/events";

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  constructor(public url: string) { FakeSocket.instances.push(this); }
  close() { this.closed = true; this.onclose?.(); }
  emit(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  emitRaw(value: unknown) { this.onmessage?.({ data: value }); }
}

describe("connectEvents", () => {
  test("connects to /events with the token, skips hello, forwards audit events", () => {
    FakeSocket.instances = [];
    const seen: unknown[] = [];
    const h = connectEvents("http://api", "tok", (event) => seen.push(event), { WebSocketImpl: FakeSocket as unknown as typeof WebSocket });
    const socket = FakeSocket.instances[0]!;

    expect(socket.url).toBe("ws://api/events?token=tok");
    socket.onopen?.();
    socket.emit({ type: "hello", principal: {} });
    socket.emit({ id: "e1", toState: "accepted" });
    expect(seen).toEqual([{ id: "e1", toState: "accepted" }]);
    h.close();
    expect(socket.closed).toBe(true);
  });

  test("reconnects after an unexpected close until close() is called", () => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    const statuses: string[] = [];
    const h = connectEvents("http://api", "tok", () => {}, { WebSocketImpl: FakeSocket as unknown as typeof WebSocket, reconnectMs: 500, onStatus: (status) => statuses.push(status) });

    FakeSocket.instances[0]!.onopen?.();
    FakeSocket.instances[0]!.onclose?.();
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(FakeSocket.instances).toHaveLength(2);
    h.close();
    vi.advanceTimersByTime(5000);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(statuses).toEqual(["open", "closed"]);
    vi.useRealTimers();
  });

  test("resolves relative API URLs against the browser location", () => {
    FakeSocket.instances = [];
    const h = connectEvents("/api", "token with space", () => {}, { WebSocketImpl: FakeSocket as unknown as typeof WebSocket });

    expect(FakeSocket.instances[0]!.url).toBe("ws://localhost:3000/api/events?token=token%20with%20space");
    h.close();
  });

  test("ignores malformed event frames", () => {
    FakeSocket.instances = [];
    const seen: unknown[] = [];
    const h = connectEvents("http://api", "tok", (event) => seen.push(event), { WebSocketImpl: FakeSocket as unknown as typeof WebSocket });

    FakeSocket.instances[0]!.emitRaw("not json");
    FakeSocket.instances[0]!.emitRaw(JSON.stringify(null));
    expect(seen).toEqual([]);
    h.close();
  });

  test("does not report or reconnect after an intentional close", () => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    const statuses: string[] = [];
    const h = connectEvents("http://api", "tok", () => {}, { WebSocketImpl: FakeSocket as unknown as typeof WebSocket, reconnectMs: 500, onStatus: (status) => statuses.push(status) });

    FakeSocket.instances[0]!.onopen?.();
    h.close();
    vi.advanceTimersByTime(500);
    expect(statuses).toEqual(["open"]);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.useRealTimers();
  });
});
