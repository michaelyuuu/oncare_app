"""Pure gateway logic: no sockets, no clocks of its own. The runner feeds it messages and ticks."""
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Callable
from .messages import validate_down
from .robot.base import NavResult, RobotAdapter

def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

def _real_now_ms() -> int:
    """Real wall-clock ms, used only to judge whether an absolute expiresAt
    timestamp has passed. The injected `now_ms` clock is a separate, purely
    relative clock used for travel-time and disconnect-grace durations."""
    return int(datetime.now(timezone.utc).timestamp() * 1000)

def _parse_iso_ms(s: str) -> int:
    return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)

class GatewayCore:
    def __init__(self, adapter: RobotAdapter, now_ms: Callable[[], int], version: str = "0.0.1", disconnect_grace_ms: int = 10_000):
        self.adapter = adapter
        self.now_ms = now_ms
        self.version = version
        self.disconnect_grace_ms = disconnect_grace_ms
        self.locations: dict[str, dict] = {}
        self._active: dict | None = None            # {"correlationId": str}
        self._seen: OrderedDict[str, None] = OrderedDict()
        self._stopped = False
        self._disconnected_at: int | None = None
        # An outcome the adapter already reported when we polled it right
        # after start_goto (e.g. an injected failure fires on the very next
        # poll, regardless of elapsed travel time). We hold it here and
        # surface it on the next tick() instead of from handle(), since
        # state_events for an intent are always reported via tick().
        self._pending_completion: NavResult | None = None

    # ---- lifecycle -------------------------------------------------------
    def on_connected(self) -> None:
        self._disconnected_at = None

    def on_disconnected(self) -> None:
        if self._disconnected_at is None:
            self._disconnected_at = self.now_ms()

    @property
    def active_correlation_id(self) -> str | None:
        return self._active["correlationId"] if self._active else None

    # ---- messages ----------------------------------------------------------
    def handle(self, msg: dict) -> list[dict]:
        validate_down(msg)
        t = msg["type"]
        if t == "locations":
            self.locations = {l["id"]: l for l in msg["locations"] if l["approved"]}
            return []
        if t == "intent":
            return self._handle_intent(msg)
        if t == "cancel":
            if self._active and self._active["correlationId"] == msg["correlationId"]:
                self._pending_completion = None
                self.adapter.cancel()
            return []
        if t == "stop":
            self.adapter.safety_stop()
            self._stopped = True
            if self._active:
                corr = self._active["correlationId"]
                self._active = None
                self._pending_completion = None
                return [self._state_event(corr, "safety_stopped", {"reason": msg["reason"]})]
            return []
        if t == "resume":
            self._stopped = False
            self.adapter.resume()
            return []
        if t == "staff_event":
            return []   # Plan 5 (tray mode) consumes these
        return []

    def _handle_intent(self, msg: dict) -> list[dict]:
        corr = msg["correlationId"]
        ack = lambda result, reason=None: {"type": "ack", "correlationId": corr, "result": result, **({"reason": reason} if reason else {})}
        if corr in self._seen:
            return [ack("duplicate")]
        if _parse_iso_ms(msg["expiresAt"]) <= _real_now_ms():
            return [ack("expired")]
        if self._active is not None:
            return [ack("busy")]
        if self._stopped:
            return [ack("rejected", "stopped")]
        if msg["intent"] == "deliver_item":
            return [ack("rejected", "not_implemented")]
        loc = self.locations.get(msg["payload"]["locationId"])
        if loc is None:
            return [ack("rejected", "unknown_location")]
        if not self.adapter.state()["ready"]:
            return [ack("rejected", "robot_not_ready")]
        self._remember(corr)
        self.adapter.start_goto(loc)
        self._active = {"correlationId": corr}
        # Prime the adapter's own timing baseline immediately (some adapters
        # only start counting travel time from their first poll() call) and
        # capture any outcome that is already available (e.g. an injected
        # failure) to report on the next tick() rather than losing it.
        immediate = self.adapter.poll(self.now_ms())
        if immediate is not None:
            self._pending_completion = immediate
        return [ack("accepted"), self._state_event(corr, "robot_en_route")]

    def _remember(self, corr: str) -> None:
        self._seen[corr] = None
        while len(self._seen) > 1000:
            self._seen.popitem(last=False)

    # ---- periodic ------------------------------------------------------------
    def tick(self) -> list[dict]:
        # While the link is down we cannot reliably act on the robot's
        # progress, so we don't poll it at all -- we only watch how long
        # the disconnect has lasted and force a safety stop past the grace
        # period. Progress is picked back up once on_connected() is called.
        if self._disconnected_at is not None:
            if self._active is not None and self.now_ms() - self._disconnected_at >= self.disconnect_grace_ms:
                self.adapter.cancel()
                self.adapter.safety_stop()
                self._stopped = True
                corr = self._active["correlationId"]
                self._active = None
                self._pending_completion = None
                return [self._state_event(corr, "safety_stopped", {"reason": "link_lost"})]
            return []
        if self._active is None:
            return []
        if self._pending_completion is not None:
            result, self._pending_completion = self._pending_completion, None
        else:
            result = self.adapter.poll(self.now_ms())
        if result is None:
            return []
        corr = self._active["correlationId"]
        self._active = None
        detail = {"reason": result.reason} if result.reason else None
        return [self._state_event(corr, result.outcome, detail)]

    def heartbeat(self) -> dict:
        s = self.adapter.state()
        return {"type": "heartbeat", "at": _iso_now(), "robotReady": bool(s["ready"]) and not self._stopped,
                "adapter": self.adapter.name, "pose": s["pose"], "navState": s["navState"], "estop": bool(s["estop"]) or self._stopped,
                "lift": s["lift"], "battery": s["battery"], "activeCorrelationId": self.active_correlation_id, "gatewayVersion": self.version}

    def _state_event(self, corr: str, event: str, detail: dict | None = None) -> dict:
        m = {"type": "state_event", "correlationId": corr, "at": _iso_now(), "event": event}
        if detail:
            m["detail"] = detail
        return m
