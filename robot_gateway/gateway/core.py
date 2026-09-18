"""Pure gateway logic: no sockets, no clocks of its own. The runner feeds it messages and ticks."""
import time
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Callable
from .messages import validate_down
from .robot.base import RobotAdapter

def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

def _parse_iso_ms(s: str) -> int:
    return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)

class GatewayCore:
    def __init__(self, adapter: RobotAdapter, now_ms: Callable[[], int],
                 wall_ms: Callable[[], int] = lambda: int(time.time() * 1000),
                 version: str = "0.0.1", disconnect_grace_ms: int = 10_000):
        self.adapter = adapter
        self.now_ms = now_ms
        # `now_ms` is a relative/monotonic-ish clock used only for durations
        # (travel time, disconnect grace). `expiresAt` is an absolute
        # real-world timestamp set by the cloud, so it is judged against
        # `wall_ms` instead -- a second, independently injectable clock, so
        # the core still owns no clock of its own.
        self.wall_ms = wall_ms
        self.version = version
        self.disconnect_grace_ms = disconnect_grace_ms
        self.locations: dict[str, dict] = {}
        self._active: dict | None = None
        self._seen: OrderedDict[str, None] = OrderedDict()
        self._stopped = False
        self._disconnected_at: int | None = None

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
                if self._active["kind"] == "deliver" and self._active["leg"] in ("await_loaded", "await_received"):
                    active = self._active
                    self._active = None
                    return [self._delivery_event(active, "cancelled")]
                self.adapter.cancel()
            return []
        if t == "stop":
            self.adapter.safety_stop()
            self._stopped = True
            if self._active:
                active = self._active
                self._active = None
                if active["kind"] == "deliver":
                    return [self._delivery_event(active, "safety_stopped", msg["reason"])]
                return [self._state_event(active["correlationId"], "safety_stopped", {"reason": msg["reason"]})]
            return []
        if t == "resume":
            self._stopped = False
            self.adapter.resume()
            return []
        if t == "staff_event":
            active = self._active
            if active is None or active["kind"] != "deliver" or active["correlationId"] != msg["correlationId"]:
                return []
            payload = active["payload"]
            if msg["event"] == "staff_loaded" and active["leg"] == "await_loaded":
                self.adapter.start_goto(payload["delivery"], self.now_ms())
                active["leg"] = "delivery"
            elif msg["event"] == "received" and active["leg"] == "await_received":
                self.adapter.start_goto(payload["standby"], self.now_ms())
                active["leg"] = "standby"
            return []
        return []

    def _handle_intent(self, msg: dict) -> list[dict]:
        corr = msg["correlationId"]
        ack = lambda result, reason=None: {"type": "ack", "correlationId": corr, "result": result, **({"reason": reason} if reason else {})}
        if corr in self._seen:
            return [ack("duplicate")]
        if _parse_iso_ms(msg["expiresAt"]) <= self.wall_ms():
            return [ack("expired")]
        if self._active is not None:
            return [ack("busy")]
        if self._stopped:
            return [ack("rejected", "stopped")]
        payload = msg["payload"]
        if msg["intent"] == "deliver_item":
            if payload["mode"] != "tray":
                return [ack("rejected", "unsupported_mode")]
            legs = {
                "pickup": self.locations.get(payload["pickupLocationId"]),
                "delivery": self.locations.get(payload["destinationLocationId"]),
                "standby": self.locations.get(payload["standbyLocationId"]),
            }
            if any(location is None for location in legs.values()):
                return [ack("rejected", "unknown_location")]
            if not self.adapter.state()["ready"]:
                return [ack("rejected", "robot_not_ready")]
            self._remember(corr)
            self.adapter.start_goto(legs["pickup"], self.now_ms())
            self._active = {"correlationId": corr, "kind": "deliver", "leg": "pickup",
                            "payload": {**legs, "mode": payload["mode"]}}
            return [ack("accepted"), self._delivery_event(self._active, "robot_en_route")]
        loc = self.locations.get(payload["locationId"])
        if loc is None:
            return [ack("rejected", "unknown_location")]
        if not self.adapter.state()["ready"]:
            return [ack("rejected", "robot_not_ready")]
        self._remember(corr)
        self.adapter.start_goto(loc, self.now_ms())
        self._active = {"correlationId": corr, "kind": "visit", "leg": "goto", "payload": payload, "location": dict(loc)}
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
                self.adapter.safety_stop()
                self._stopped = True
                active = self._active
                self._active = None
                if active["kind"] == "deliver":
                    return [self._delivery_event(active, "safety_stopped", "link_lost")]
                return [self._state_event(active["correlationId"], "safety_stopped", {"reason": "link_lost"})]
            return []
        if self._active is None:
            return []
        result = self.adapter.poll(self.now_ms())
        if result is None:
            return []
        active = self._active
        if active["kind"] == "visit":
            self._active = None
            if result.outcome == "arrived":
                self._rest_at_standby(active["location"])
            detail = {"reason": result.reason} if result.reason else None
            return [self._state_event(active["correlationId"], result.outcome, detail)]
        if result.outcome != "arrived":
            self._active = None
            return [self._delivery_event(active, result.outcome, result.reason)]
        if active["leg"] == "pickup":
            active["leg"] = "await_loaded"
            return [self._delivery_event(active, "arrived_pickup")]
        if active["leg"] == "delivery":
            active["leg"] = "await_received"
            return [self._delivery_event(active, "arrived_delivery")]
        self._active = None
        self._rest_at_standby(active["payload"]["standby"])
        return [self._delivery_event(active, "completed_leg")]

    def _rest_at_standby(self, target: dict) -> None:
        current = self.locations.get(target["id"])
        if (self._active is not None or self._stopped or not current
                or current != target or current.get("kind") != "standby"
                or current.get("approved") is not True):
            return
        state = self.adapter.state()
        if (state["ready"] and not state["estop"]
                and state["navState"] in ("idle", "succeeded", "arrived")):
            # Optional backend capability; True acknowledges queuing only.
            rest = getattr(self.adapter, "lift_rest", None)
            if rest is not None:
                rest()

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

    def _delivery_event(self, active: dict, event: str, reason: str | None = None) -> dict:
        leg = {"await_loaded": "pickup", "await_received": "delivery"}.get(active["leg"], active["leg"])
        detail = {"leg": leg, "mode": active["payload"]["mode"]}
        if reason:
            detail["reason"] = reason
        return self._state_event(active["correlationId"], event, detail)
