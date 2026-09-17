import pytest
from gateway.core import GatewayCore
from gateway.messages import validate_up
from gateway.robot.mock import MockRobotAdapter

LOCATIONS = {"type": "locations", "locations": [
    {"id": "room_demo_01", "name": "Demo room", "kind": "resident_room", "x": 1.0, "y": 2.0, "yaw": 0.0, "approved": True},
    {"id": "old_room", "name": "Old", "kind": "resident_room", "x": 0.0, "y": 0.0, "yaw": 0.0, "approved": False},
]}

def intent(corr="visit_1", loc="room_demo_01", expires="2099-01-01T00:00:00.000Z", kind="request_visit"):
    return {"type": "intent", "intent": kind, "correlationId": corr, "expiresAt": expires, "payload": {"locationId": loc}}

@pytest.fixture
def core(clock):
    adapter = MockRobotAdapter(travel_ms=1000)
    c = GatewayCore(adapter, now_ms=clock.now_ms)
    c.on_connected()
    assert c.handle(LOCATIONS) == []
    return c

def types(msgs):
    return [(m["type"], m.get("result") or m.get("event")) for m in msgs]

def test_accepts_intent_and_reports_en_route_then_arrived(core, clock):
    out = core.handle(intent())
    for m in out: validate_up(m)
    assert types(out) == [("ack", "accepted"), ("state_event", "robot_en_route")]
    assert core.active_correlation_id == "visit_1"
    assert core.tick() == []
    clock.advance(1000)
    out = core.tick()
    assert types(out) == [("state_event", "arrived")]
    assert out[0]["correlationId"] == "visit_1"
    assert core.active_correlation_id is None

def test_duplicate_correlation_is_acked_duplicate_and_not_re_executed(core, clock):
    core.handle(intent())
    clock.advance(1000); core.tick()
    out = core.handle(intent())
    assert types(out) == [("ack", "duplicate")]
    assert core.active_correlation_id is None

def test_expired_intent(core):
    out = core.handle(intent(expires="2000-01-01T00:00:00.000Z"))
    assert types(out) == [("ack", "expired")]

def test_busy_while_active(core):
    core.handle(intent("visit_1"))
    out = core.handle(intent("visit_2"))
    assert types(out) == [("ack", "busy")]

def test_unknown_or_unapproved_location_is_rejected(core):
    assert core.handle(intent(loc="nowhere"))[0] == {"type": "ack", "correlationId": "visit_1", "result": "rejected", "reason": "unknown_location"}
    assert core.handle(intent("visit_2", loc="old_room"))[0]["reason"] == "unknown_location"

def test_deliver_item_not_implemented_yet(core):
    msg = {"type": "intent", "intent": "deliver_item", "correlationId": "task_1", "expiresAt": "2099-01-01T00:00:00.000Z",
           "payload": {"itemId": "water_bottle", "pickupLocationId": "room_demo_01", "destinationLocationId": "room_demo_01", "standbyLocationId": "room_demo_01", "mode": "tray"}}
    out = core.handle(msg)
    assert out[0]["result"] == "rejected" and out[0]["reason"] == "not_implemented"

def test_navigation_failure_is_reported(clock):
    adapter = MockRobotAdapter(travel_ms=100)
    adapter.inject_failure("navigation_failed", reason="blocked")
    c = GatewayCore(adapter, now_ms=clock.now_ms); c.on_connected(); c.handle(LOCATIONS)
    c.handle(intent())
    clock.advance(100)
    out = c.tick()
    assert types(out) == [("state_event", "navigation_failed")] and out[0]["detail"] == {"reason": "blocked"}

def test_cancel_active_intent(core):
    core.handle(intent())
    assert core.handle({"type": "cancel", "correlationId": "visit_1"}) == []
    out = core.tick()
    assert types(out) == [("state_event", "cancelled")]
    assert core.active_correlation_id is None

def test_cancel_unknown_id_is_ignored(core):
    core.handle(intent())
    assert core.handle({"type": "cancel", "correlationId": "other"}) == []
    assert core.active_correlation_id == "visit_1"

def test_stop_reports_safety_stopped_and_blocks_until_resume(core):
    core.handle(intent())
    out = core.handle({"type": "stop", "reason": "staff"})
    assert types(out) == [("state_event", "safety_stopped")]
    assert core.heartbeat()["robotReady"] is False and core.heartbeat()["estop"] is True
    assert core.handle(intent("visit_2"))[0] == {"type": "ack", "correlationId": "visit_2", "result": "rejected", "reason": "stopped"}
    assert core.handle({"type": "resume"}) == []
    assert core.heartbeat()["robotReady"] is True
    assert types(core.handle(intent("visit_3"))) == [("ack", "accepted"), ("state_event", "robot_en_route")]

def test_disconnect_longer_than_grace_cancels_and_safety_stops(core, clock):
    core.handle(intent())
    core.on_disconnected()
    clock.advance(9_999)
    assert core.tick() == []
    clock.advance(1)
    out = core.tick()
    assert types(out) == [("state_event", "safety_stopped")]
    assert core.active_correlation_id is None
    core.on_connected()
    assert core.heartbeat()["robotReady"] is False   # stays stopped until an explicit resume

def test_robot_not_ready_rejects(clock):
    c = GatewayCore(MockRobotAdapter(ready=False), now_ms=clock.now_ms); c.on_connected(); c.handle(LOCATIONS)
    assert c.handle(intent())[0]["reason"] == "robot_not_ready"

def test_heartbeat_shape(core):
    hb = core.heartbeat()
    validate_up(hb)
    assert hb["adapter"] == "mock" and hb["activeCorrelationId"] is None and hb["gatewayVersion"] == "0.0.1"

def test_invalid_down_message_raises(core):
    from gateway.messages import MessageError
    with pytest.raises(MessageError):
        core.handle({"type": "joy", "vx": 1.0})
