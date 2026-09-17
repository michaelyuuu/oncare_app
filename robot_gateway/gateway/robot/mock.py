"""Simulated robot. Clearly labelled: every heartbeat says adapter="mock"."""
from typing import Literal
from .base import NavResult, RobotAdapter

class MockRobotAdapter(RobotAdapter):
    name = "mock"

    def __init__(self, travel_ms: int = 2000, ready: bool = True):
        self.travel_ms = travel_ms
        self._ready = ready
        self._estop = False
        self._pose: dict | None = {"x": 0.0, "y": 0.0, "yaw": 0.0}
        self._goal: dict | None = None
        self._started_ms: int | None = None
        self._pending: NavResult | None = None
        self._failure: NavResult | None = None

    def inject_failure(self, outcome: Literal["navigation_failed"], reason: str = "injected") -> None:
        self._failure = NavResult(outcome, reason)

    def start_goto(self, location: dict) -> None:
        self._goal = location
        self._started_ms = None
        self._pending = None

    def poll(self, now_ms: int) -> NavResult | None:
        if self._pending is not None:
            r, self._pending = self._pending, None
            self._goal = None
            return r
        if self._goal is None:
            return None
        # An injected failure fires on the next poll regardless of elapsed
        # travel time: it simulates the robot discovering mid-navigation
        # that it cannot proceed, which is not gated by a fixed timer.
        if self._failure is not None:
            f, self._failure = self._failure, None
            self._goal = None
            return f
        if self._started_ms is None:
            self._started_ms = now_ms
        if now_ms - self._started_ms < self.travel_ms:
            return None
        goal, self._goal = self._goal, None
        self._pose = {"x": float(goal["x"]), "y": float(goal["y"]), "yaw": float(goal["yaw"])}
        return NavResult("arrived")

    def cancel(self) -> None:
        if self._goal is not None:
            self._pending = NavResult("cancelled")

    def resume(self) -> None:
        self._estop = False
        self._ready = True

    def safety_stop(self) -> None:
        self._estop = True
        self._ready = False
        self._goal = None
        self._pending = None

    def state(self) -> dict:
        return {"ready": self._ready and not self._estop, "pose": self._pose,
                "navState": "navigating" if self._goal is not None else "idle",
                "estop": self._estop, "lift": "unknown", "battery": "unknown"}
