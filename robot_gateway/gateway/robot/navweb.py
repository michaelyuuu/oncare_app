"""Nonblocking adapter for loopback nav_web and health_web HTTP.

One worker serializes allowlisted HTTP calls. Public methods only update a
bounded command slot or inspect cached state, so endpoint timeouts cannot
stall gateway heartbeats. STOP invalidates unsent work; an in-flight call
can delay the physical stop by at most its HTTP timeout. No automatic
resume follows safety stop, endpoint loss, or no-progress timeout.
"""
from collections import deque
from dataclasses import dataclass
import json
import http.client
import io
import math
import socket
import threading
import time
from typing import Callable, Literal
import urllib.parse

from .base import NavResult
from .mapcheck import is_cell_free, parse_map_blob


@dataclass(frozen=True)
class ParsedState:
    pose: dict | None
    nav_status: Literal["idle", "active", "succeeded", "failed", "canceled", "unknown"]
    estop: bool
    nav_up: bool
    lift: str
    goal: tuple[float, float, float] | None
    distance: float | None


def _finite(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _vector(value):
    if (isinstance(value, list) and len(value) == 3
            and all(_finite(v) for v in value)):
        return tuple(float(v) for v in value)
    return None


def _parse_state(d: dict) -> ParsedState:
    """Only mapping of nav_web.py:1492-1521; source pose/goal are arrays."""
    nav = d.get("nav") if isinstance(d.get("nav"), dict) else {}
    stack = d.get("stack") if isinstance(d.get("stack"), dict) else {}
    lift = d.get("lift") if isinstance(d.get("lift"), dict) else {}
    pose = _vector(d.get("pose"))
    states = {"idle": "idle", "sending": "active", "navigating": "active",
              "succeeded": "succeeded", "aborted": "failed", "rejected": "failed",
              "unavailable": "failed", "canceled": "canceled"}
    status = states.get(nav.get("state"), "unknown") if isinstance(nav.get("state"), str) else "unknown"
    estop = d.get("estop") if type(d.get("estop")) is bool else True
    up = (stack.get("running") is True and stack.get("mode") in ("nav", "explore")
          and pose is not None and status not in ("unknown", "failed")
          and type(d.get("estop")) is bool)
    distance = nav.get("dist")
    if not _finite(distance) or distance < 0:
        distance = None
    lift_note = lift.get("busy") or lift.get("last") or "unknown"
    return ParsedState(dict(zip(("x", "y", "yaw"), pose)) if pose else None,
                       status, estop, up, lift_note if isinstance(lift_note, str) else "unknown",
                       _vector(nav.get("goal")), distance)


class _DeadlineReader(io.RawIOBase):
    """HTTPResponse framing over a socket with one absolute request deadline."""

    def __init__(self, connection, deadline):
        self.connection = connection
        self.deadline = deadline
        self.remaining_bytes = 64 * 1024

    def readable(self):
        return True

    def readinto(self, buffer):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0 or self.remaining_bytes <= 0:
            raise TimeoutError("HTTP deadline or response limit exceeded")
        self.connection.settimeout(remaining)
        count = self.connection.recv_into(buffer, min(len(buffer), self.remaining_bytes))
        self.remaining_bytes -= count
        return count

    def makefile(self, *_args, **_kwargs):
        return io.BufferedReader(self)


def _origin(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1"
            or parsed.username or parsed.password or parsed.path not in ("", "/")
            or parsed.query or parsed.fragment or not parsed.port):
        raise ValueError("expected an explicit loopback HTTP origin")
    return f"http://127.0.0.1:{parsed.port}"


class NavWebAdapter:
    name = "navweb"
    SNAPSHOT_MAX_AGE_S = 1.0
    REFRESH_S = 0.25

    def __init__(self, navweb_url="http://127.0.0.1:5804", health_url="http://127.0.0.1:5808",
                 http_timeout_s=2.0, goal_timeout_s=120.0, now_ms: Callable[[], int] | None = None):
        self.navweb_url, self.health_url = _origin(navweb_url), _origin(health_url)
        if not (math.isfinite(http_timeout_s) and 0 < http_timeout_s <= 2.0
                and math.isfinite(goal_timeout_s) and goal_timeout_s > 0):
            raise ValueError("invalid adapter timeout")
        self.timeout = http_timeout_s
        self.goal_timeout_ms = goal_timeout_s * 1000
        self.now_ms = now_ms or (lambda: int(time.monotonic() * 1000))
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._closed = False
        self._closing = False
        self._navigation_issued = False
        self._generation = 0
        self._latched = False
        self._controls = deque()
        self._control_inflight = False
        self._queued_goal = None
        self._goal = None
        self._pending = None
        self._snapshot = None
        self._observed_at = 0.0
        self._next_refresh = 0.0
        self._worker = threading.Thread(target=self._run, name="navweb-http", daemon=True)
        self._worker.start()

    def close(self):
        """Drain a latching stop for possible navigation, then join the worker.

        At most one in-flight request plus the stop request may remain. Hard
        process termination or an unreachable endpoint cannot guarantee stop.
        """
        with self._lock:
            if not self._closing and not self._closed:
                needs_stop = (self._goal is not None or self._navigation_issued
                              or any(kind in ("stop", "cancel") for kind, _ in self._controls))
                self._closing = True
                self._generation += 1
                self._goal = self._queued_goal = self._pending = None
                self._controls.clear()
                if needs_stop:
                    self._latched = True
                    self._controls.append(("stop", self._generation))
        self._wake.set()
        self._worker.join(2 * self.timeout + 0.5)

    def _request(self, method, path, body=None):
        allowed = {("GET", "/state"), ("GET", "/map.bin"), ("GET", "/health.json"),
                   ("POST", "/goal"), ("POST", "/cancel"), ("POST", "/resume"), ("POST", "/lift")}
        if (method, path) not in allowed:
            raise ValueError("HTTP operation not allowed")
        base = self.health_url if path == "/health.json" else self.navweb_url
        data = json.dumps(body or {}, allow_nan=False).encode() if method == "POST" else b""
        port = urllib.parse.urlsplit(base).port
        headers = (f"{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n"
                   "Connection: close\r\n")
        if method == "POST":
            headers += f"Content-Type: application/json\r\nContent-Length: {len(data)}\r\n"
        deadline = time.monotonic() + self.timeout
        limit = 32 * 1024 * 1024 if path == "/map.bin" else 1024 * 1024
        try:
            # Numeric IPv4 only: no DNS, proxy, redirects, or reusable connection.
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as connection:
                connection.settimeout(max(0.000001, deadline - time.monotonic()))
                connection.connect(("127.0.0.1", port))
                connection.settimeout(max(0.000001, deadline - time.monotonic()))
                connection.sendall(headers.encode("ascii") + b"\r\n" + data)
                reader = _DeadlineReader(connection, deadline)
                with http.client.HTTPResponse(reader) as response:
                    response.begin()
                    if response.length is not None and response.length > limit:
                        return None
                    reader.remaining_bytes = limit + 64 * 1024
                    raw = response.read(limit + 1)
                    if (len(raw) > limit or time.monotonic() >= deadline
                            or (response.length is not None and response.length != 0)):
                        return None
                    if path == "/map.bin":
                        return raw if 200 <= response.status < 300 else None
                    value = json.loads(raw)
                    if not isinstance(value, dict):
                        return None
                    if 200 <= response.status < 300 or (method == "POST" and value.get("ok") is False):
                        return value
                    return None
        except (OSError, ValueError, http.client.HTTPException):
            return None

    def _post(self, path, body=None):
        response = self._request("POST", path, body)
        return response is not None and response.get("ok") is True

    def _valid(self, generation):
        with self._lock:
            return not self._closed and not self._closing and generation == self._generation

    def start_goto(self, location: dict, now_ms: int) -> None:
        with self._lock:
            if self._closed or self._closing:
                return
            self._generation += 1
            self._pending = None
            self._goal = None
            self._queued_goal = None
            if (not isinstance(location, dict) or location.get("approved") is not True
                    or not isinstance(location.get("id"), str) or not location["id"]):
                self._pending = NavResult("navigation_failed", "unknown_location")
            elif any(not _finite(location.get(k)) for k in ("x", "y", "yaw")):
                self._pending = NavResult("navigation_failed", "bad_location")
            elif self._latched or not self._ready_locked():
                self._pending = NavResult("navigation_failed", "robot_not_ready")
            else:
                target = {key: float(location[key]) for key in ("x", "y", "yaw")}
                self._goal = {"target": target, "last_progress": now_ms, "best": None, "accepted": False}
                self._queued_goal = (self._generation, target)
        self._wake.set()

    def _finish_locked(self, outcome, reason=None):
        self._goal = None
        self._pending = NavResult(outcome, reason)

    def _expire_locked(self, now_ms):
        if not self._goal or now_ms - self._goal["last_progress"] < self.goal_timeout_ms:
            return False
        self._generation += 1
        self._latched = True
        self._queued_goal = None
        self._controls.clear()
        self._controls.append(("stop", self._generation))
        self._finish_locked("navigation_failed", "timeout")
        self._wake.set()
        return True

    def poll(self, now_ms: int) -> NavResult | None:
        with self._lock:
            self._expire_locked(now_ms)
            result, self._pending = self._pending, None
            return result

    def safety_stop(self) -> None:
        with self._lock:
            if self._closed or self._closing:
                return
            self._generation += 1
            self._latched = True
            self._goal = self._queued_goal = self._pending = None
            self._controls.clear()
            self._controls.append(("stop", self._generation))
        self._wake.set()

    def cancel(self) -> None:
        with self._lock:
            if self._closed or self._closing:
                return
            self._generation += 1
            self._queued_goal = None
            if not self._latched:
                self._controls.clear()
                self._controls.append(("cancel", self._generation))
        self._wake.set()

    def resume(self) -> None:
        with self._lock:
            if self._closed or self._closing:
                return
            # Preserve an unsent safety stop before an explicitly requested resume.
            stops = [job for job in self._controls if job[0] == "stop"]
            self._controls.clear()
            self._controls.extend(stops[:1])
            self._controls.append(("resume", self._generation))
        self._wake.set()

    def lift_rest(self) -> bool:
        """Queue rest only; True acknowledges queuing, not physical completion."""
        with self._lock:
            if self._closed or self._closing or self._goal or self._controls or not self._ready_locked():
                return False
            self._controls.append(("lift", self._generation))
        self._wake.set()
        return True

    def _ready_locked(self):
        return (not self._closed and not self._closing and self._snapshot is not None and self._snapshot["ready"] and not self._latched
                and not self._controls and not self._control_inflight
                and time.monotonic() - self._observed_at < self.SNAPSHOT_MAX_AGE_S)

    def state(self) -> dict:
        with self._lock:
            if self._snapshot is None or time.monotonic() - self._observed_at >= self.SNAPSHOT_MAX_AGE_S:
                return {"ready": False, "pose": None, "navState": "unreachable", "estop": True,
                        "lift": "unknown", "battery": "unknown"}
            return {**self._snapshot, "pose": dict(self._snapshot["pose"]) if self._snapshot["pose"] else None,
                    "ready": self._ready_locked(), "estop": self._snapshot["estop"] or self._latched}

    def _run_goal(self, generation, target):
        if not self._valid(generation):
            return
        blob = self._request("GET", "/map.bin")
        reason = "no_map"
        ok = False
        if blob is not None:
            try:
                ok, reason = is_cell_free(parse_map_blob(blob), target["x"], target["y"])
            except ValueError:
                reason = "bad_map"
        if not self._valid(generation):
            return
        if ok:
            with self._lock:
                if self._closed or self._closing or generation != self._generation:
                    return
                self._navigation_issued = True
            response = self._request("POST", "/goal", target)
            ok = response is not None and response.get("ok") is True
            reason = "goal_refused" if response is not None and response.get("ok") is False else "goal_uncertain"
        with self._lock:
            if generation == self._generation and self._goal and not self._closed:
                if ok:
                    self._goal["accepted"] = True
                elif reason == "goal_uncertain":
                    self._uncertain_locked(reason)
                else:
                    if reason == "goal_refused":
                        self._navigation_issued = False
                    self._finish_locked("navigation_failed", reason)

    def _uncertain_locked(self, reason):
        """One bounded cleanup attempt; failed cleanup stays latched/tracked."""
        self._generation += 1
        self._latched = True
        self._queued_goal = None
        self._controls.clear()
        self._controls.append(("stop", self._generation))
        self._finish_locked("navigation_failed", reason)
        self._wake.set()

    def _run_control(self, kind, generation):
        if kind != "stop" and not self._valid(generation):
            return
        if kind in ("stop", "cancel"):
            ok = self._post("/cancel")
            if ok:
                with self._lock:
                    self._navigation_issued = False
                    if kind == "cancel" and generation == self._generation and self._goal:
                        self._finish_locked("cancelled")
            elif kind == "cancel":
                with self._lock:
                    if generation == self._generation:
                        self._uncertain_locked("cancel_failed")
            if kind == "cancel" and ok and self._valid(generation):
                self._post("/resume")
        elif kind == "resume":
            ok = self._post("/resume")
            with self._lock:
                if ok and generation == self._generation:
                    self._latched = False
        elif kind == "lift":
            self._post("/lift", {"cmd": "preset", "slot": "rest"})

    def _refresh(self):
        started = time.monotonic()
        data = self._request("GET", "/state")
        with self._lock:
            if self._closed or self._closing or self._controls:
                return  # Do not put another HTTP timeout ahead of a queued STOP.
        health = self._request("GET", "/health.json") if data is not None else None
        parsed = _parse_state(data) if data is not None else None
        tiles = health.get("tiles") if health else None
        base_up = isinstance(tiles, list) and any(isinstance(tile, dict) and tile.get("key") == "base_rpc"
                    and tile.get("state") == "ok" and tile.get("value") == "up" for tile in tiles)
        with self._lock:
            if self._closed or self._closing:
                return
            self._observed_at = started
            self._snapshot = {"ready": bool(parsed and parsed.nav_up and base_up and not parsed.estop),
                              "pose": parsed.pose if parsed else None,
                              "navState": parsed.nav_status if parsed and health is not None else "unreachable",
                              "estop": parsed.estop if parsed else True,
                              "lift": parsed.lift if parsed else "unknown", "battery": "unknown"}
            if not self._goal or not self._goal["accepted"] or parsed is None:
                return
            if self._expire_locked(self.now_ms()):
                return
            if parsed.estop:
                self._latched = True
                self._finish_locked("cancelled", "estop")
                return
            target = self._goal["target"]
            expected = (round(target["x"], 3), round(target["y"], 3), round(target["yaw"], 4))
            if parsed.goal != expected:
                return
            if parsed.nav_status == "succeeded":
                self._navigation_issued = False
                self._finish_locked("arrived")
            elif parsed.nav_status == "failed":
                self._navigation_issued = False
                self._finish_locked("navigation_failed", "failed")
            elif parsed.nav_status == "active" and parsed.distance is not None:
                best = self._goal["best"]
                if best is None:
                    self._goal["best"] = parsed.distance
                elif parsed.distance < best:
                    self._goal["best"] = parsed.distance
                    self._goal["last_progress"] = self.now_ms()

    def _run(self):
        while True:
            with self._lock:
                if self._closed or (self._closing and not self._controls):
                    self._closed = True
                    return
                control = self._controls.popleft() if self._controls else None
                self._control_inflight = control is not None
                goal = None
                if control is None:
                    goal, self._queued_goal = self._queued_goal, None
            if control:
                try:
                    self._run_control(*control)
                finally:
                    with self._lock:
                        self._control_inflight = False
                        self._observed_at = 0.0
                    self._next_refresh = 0.0
            elif goal:
                self._run_goal(*goal)
            elif time.monotonic() >= self._next_refresh:
                self._refresh()
                self._next_refresh = time.monotonic() + self.REFRESH_S
            else:
                self._wake.wait(max(0, self._next_refresh - time.monotonic()))
                self._wake.clear()
