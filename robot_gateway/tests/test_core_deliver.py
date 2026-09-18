import pytest

from gateway.core import GatewayCore
from gateway.messages import validate_up
from gateway.robot.mock import MockRobotAdapter


LOCS = {"type": "locations", "locations": [
    {"id": "pickup_station_demo", "name": "Nurse station", "kind": "pickup_station", "x": 0.0, "y": 0.0, "yaw": 0.0, "approved": True},
    {"id": "room_demo_01", "name": "Room", "kind": "resident_room", "x": 3.0, "y": 1.0, "yaw": 0.0, "approved": True},
    {"id": "standby_demo", "name": "Standby", "kind": "standby", "x": 1.0, "y": 1.0, "yaw": 0.0, "approved": True},
]}


def deliver(corr="task_1", pickup="pickup_station_demo", dest="room_demo_01", standby="standby_demo"):
    return {"type": "intent", "intent": "deliver_item", "correlationId": corr, "expiresAt": "2099-01-01T00:00:00.000Z",
            "payload": {"itemId": "water_bottle", "pickupLocationId": pickup, "destinationLocationId": dest,
                        "standbyLocationId": standby, "mode": "tray"}}


def staff(corr, event):
    return {"type": "staff_event", "correlationId": corr, "event": event}


def kinds(msgs):
    return [(m["type"], m.get("result") or m.get("event")) for m in msgs]


def assert_delivery_event(message, event, leg, reason=None):
    validate_up(message)
    assert message["event"] == event
    assert message["detail"] == {"leg": leg, "mode": "tray", **({"reason": reason} if reason else {})}


@pytest.fixture
def core(clock):
    c = GatewayCore(MockRobotAdapter(travel_ms=1000), now_ms=clock.now_ms)
    c.on_connected()
    c.handle(LOCS)
    return c


def test_full_tray_delivery_waits_for_staff_between_all_three_legs(core, clock):
    out = core.handle(deliver())
    for message in out:
        validate_up(message)
    assert kinds(out) == [("ack", "accepted"), ("state_event", "robot_en_route")]
    assert_delivery_event(out[1], "robot_en_route", "pickup")

    clock.advance(1000)
    out = core.tick()
    assert_delivery_event(out[0], "arrived_pickup", "pickup")
    clock.advance(5000)
    assert core.tick() == []
    assert core.heartbeat()["activeCorrelationId"] == "task_1"

    assert core.handle(staff("task_1", "staff_loaded")) == []
    clock.advance(1000)
    out = core.tick()
    assert_delivery_event(out[0], "arrived_delivery", "delivery")
    assert core.heartbeat()["activeCorrelationId"] == "task_1"

    assert core.handle(staff("task_1", "received")) == []
    clock.advance(1000)
    out = core.tick()
    assert_delivery_event(out[0], "completed_leg", "standby")
    assert core.active_correlation_id is None


@pytest.mark.parametrize("field", ["pickup", "dest", "standby"])
def test_unknown_location_in_any_leg_is_rejected(core, field):
    kwargs = {field: "nowhere"}
    assert core.handle(deliver(**kwargs))[0]["reason"] == "unknown_location"


def test_delivery_rejects_non_tray_execution_mode(core):
    message = deliver()
    message["payload"]["mode"] = "manipulation"
    assert core.handle(message) == [{"type": "ack", "correlationId": "task_1", "result": "rejected",
                                     "reason": "unsupported_mode"}]


def test_staff_events_for_other_correlation_or_wrong_phase_are_ignored(core, clock):
    core.handle(deliver())
    assert core.handle(staff("task_1", "staff_loaded")) == []
    clock.advance(1000)
    core.tick()
    assert core.handle(staff("other", "staff_loaded")) == []
    assert core.handle(staff("task_1", "received")) == []
    clock.advance(1000)
    assert core.tick() == []


def test_replayed_staff_events_do_not_skip_delivery_legs(core, clock):
    core.handle(deliver())
    clock.advance(1000)
    core.tick()
    core.handle(staff("task_1", "staff_loaded"))
    core.handle(staff("task_1", "staff_loaded"))
    clock.advance(1000)
    out = core.tick()
    assert_delivery_event(out[0], "arrived_delivery", "delivery")
    clock.advance(1000)
    assert core.tick() == []
    core.handle(staff("task_1", "received"))
    core.handle(staff("task_1", "received"))
    clock.advance(1000)
    out = core.tick()
    assert_delivery_event(out[0], "completed_leg", "standby")


@pytest.mark.parametrize("wait_leg,ready_event", [("pickup", None), ("delivery", "staff_loaded")])
def test_cancel_while_waiting_for_staff_emits_immediately_and_clears_active(core, clock, wait_leg, ready_event):
    core.handle(deliver())
    clock.advance(1000)
    core.tick()
    if ready_event:
        core.handle(staff("task_1", ready_event))
        clock.advance(1000)
        core.tick()
    out = core.handle({"type": "cancel", "correlationId": "task_1"})
    assert_delivery_event(out[0], "cancelled", wait_leg)
    assert core.active_correlation_id is None
    assert core.tick() == []


def test_cancel_during_moving_leg_retains_adapter_cancel_behavior(core):
    core.handle(deliver())
    assert core.handle({"type": "cancel", "correlationId": "task_1"}) == []
    out = core.tick()
    assert_delivery_event(out[0], "cancelled", "pickup")
    assert core.active_correlation_id is None


def test_stop_while_waiting_for_staff_includes_tray_detail(core, clock):
    core.handle(deliver())
    clock.advance(1000)
    core.tick()
    out = core.handle({"type": "stop", "reason": "staff_stop"})
    assert_delivery_event(out[0], "safety_stopped", "pickup", "staff_stop")
    assert core.heartbeat()["robotReady"] is False


def test_link_loss_while_waiting_includes_tray_detail(core, clock):
    core.handle(deliver())
    clock.advance(1000)
    core.tick()
    core.on_disconnected()
    clock.advance(10_000)
    out = core.tick()
    assert_delivery_event(out[0], "safety_stopped", "pickup", "link_lost")
    assert core.active_correlation_id is None


def test_navigation_failure_on_delivery_leg_includes_tray_detail(clock):
    adapter = MockRobotAdapter(travel_ms=100)
    c = GatewayCore(adapter, now_ms=clock.now_ms)
    c.on_connected()
    c.handle(LOCS)
    c.handle(deliver())
    clock.advance(100)
    c.tick()
    c.handle(staff("task_1", "staff_loaded"))
    adapter.inject_failure("navigation_failed", reason="blocked")
    clock.advance(100)
    out = c.tick()
    assert_delivery_event(out[0], "navigation_failed", "delivery", "blocked")


def test_visit_intent_still_works_and_is_busy_during_delivery(core):
    core.handle(deliver())
    visit = {"type": "intent", "intent": "request_visit", "correlationId": "visit_9",
             "expiresAt": "2099-01-01T00:00:00.000Z", "payload": {"locationId": "room_demo_01"}}
    assert core.handle(visit)[0]["result"] == "busy"
