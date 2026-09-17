import type { AuditEvent } from "@oncare/core";

export interface EventsHandle {
  close(): void;
}

export function connectEvents(
  baseUrl: string,
  token: string,
  onEvent: (event: AuditEvent) => void,
  opts: { WebSocketImpl?: typeof WebSocket; reconnectMs?: number; onStatus?: (status: "open" | "closed") => void } = {},
): EventsHandle {
  const WebSocketImpl = opts.WebSocketImpl ?? WebSocket;
  const browserLocation = typeof window === "undefined" ? "http://localhost/" : window.location.href;
  const url = new URL(baseUrl, browserLocation);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/events`;
  url.search = `?token=${encodeURIComponent(token)}`;

  let socket: WebSocket | null = null;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function open() {
    socket = new WebSocketImpl(url.toString());
    socket.onopen = () => opts.onStatus?.("open");
    socket.onmessage = (event) => {
      try {
        const message: unknown = JSON.parse(String(event.data));
        if (message === null || typeof message !== "object" || Array.isArray(message)) return;
        if ("type" in message && message.type === "hello") return;
        onEvent(message as AuditEvent);
      } catch {
        // Event streams may contain malformed frames; ignore them and keep the connection open.
      }
    };
    socket.onclose = () => {
      if (stopped) return;
      opts.onStatus?.("closed");
      reconnectTimer = setTimeout(open, opts.reconnectMs ?? 2000);
    };
  }

  open();
  return {
    close() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    },
  };
}
