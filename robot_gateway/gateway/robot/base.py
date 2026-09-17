from dataclasses import dataclass
from typing import Literal, Protocol

@dataclass(frozen=True)
class NavResult:
    outcome: Literal["arrived", "navigation_failed", "cancelled"]
    reason: str | None = None

class RobotAdapter(Protocol):
    """Contract for a robot backend (the mock here, a real navweb adapter
    in a later plan).

    - `start_goto(location, now_ms)` is non-blocking: it commands the robot
      towards `location` and records `now_ms` as the travel start time, so
      the adapter's own timing baseline is set at the moment the goal is
      issued -- it does not depend on when `poll()` happens to be called
      next.
    - `poll(now_ms)` may be called at any cadence: immediately after
      `start_goto` (it should simply report "not there yet" by returning
      `None`), only once long after `start_goto`, or repeatedly in between.
      Each terminal outcome (arrived, navigation_failed, cancelled) is
      reported exactly once: once `poll()` returns a `NavResult` for the
      current goal, that goal is cleared and a further `poll()` returns
      `None` until the next `start_goto`.
    """
    name: str
    def start_goto(self, location: dict, now_ms: int) -> None: ...
    def poll(self, now_ms: int) -> NavResult | None: ...
    def cancel(self) -> None: ...
    def resume(self) -> None: ...
    def safety_stop(self) -> None: ...
    def state(self) -> dict: ...
