import pytest
from gateway.core import GatewayCore
from gateway.robot.mock import MockRobotAdapter
from test_core_deliver import LOCS, deliver, staff


class RestRecorder(MockRobotAdapter):
    def __init__(self):
        super().__init__(travel_ms=1)
        self.rests = 0
        self.override = {}

    def lift_rest(self):
        self.rests += 1
        assert self._goal is None
        return True

    def state(self):
        return {**super().state(), **self.override}


def setup(clock):
    adapter = RestRecorder()
    core = GatewayCore(adapter, clock.now_ms)
    core.handle(LOCS)
    return core, adapter


def test_tray_only_rests_after_completed_standby_not_pickup_or_room(clock):
    core, adapter = setup(clock)
    core.handle(deliver())
    for event in ("staff_loaded", "received"):
        clock.advance(1)
        core.tick()
        assert adapter.rests == 0
        core.handle(staff("task_1", event))
    clock.advance(1)
    assert core.tick()[0]["event"] == "completed_leg"
    assert core.active_correlation_id is None and adapter.rests == 1
    core.tick()
    assert adapter.rests == 1


@pytest.mark.parametrize("condition", ["good", "room", "revoked", "moved", "moving", "not_ready", "estop", "stop", "failure"])
def test_staff_standby_arrival_guard(clock, condition):
    core, adapter = setup(clock)
    location = "room_demo_01" if condition == "room" else "standby_demo"
    core.handle({"type": "intent", "intent": "request_visit", "correlationId": "return", "expiresAt": "2099-01-01T00:00:00Z", "payload": {"locationId": location}})
    if condition == "revoked":
        core.handle({"type": "locations", "locations": []})
    if condition == "moved":
        core.handle({"type": "locations", "locations": [{**LOCS["locations"][2], "x": 99}]})
    if condition == "moving":
        adapter.override = {"navState": "active"}
    if condition == "not_ready":
        adapter.override = {"ready": False}
    if condition == "estop":
        adapter.override = {"estop": True}
    if condition == "stop":
        core.handle({"type": "stop", "reason": "staff_stop"})
    if condition == "failure":
        adapter.inject_failure("navigation_failed")
    clock.advance(1)
    core.tick()
    assert adapter.rests == (1 if condition == "good" else 0)
