import pytest
from gateway.messages import MessageError, validate_down, validate_up

INTENT = {"type": "intent", "intent": "request_visit", "correlationId": "visit_1",
          "expiresAt": "2026-09-17T00:05:00.000Z", "payload": {"locationId": "room_demo_01"}}

def test_valid_intent_passes():
    validate_down(INTENT)

def test_raw_coordinates_are_rejected():
    with pytest.raises(MessageError):
        validate_down({**INTENT, "payload": {"x": 1.0, "y": 2.0, "yaw": 0.0}})

def test_unknown_type_is_rejected():
    with pytest.raises(MessageError):
        validate_down({"type": "joy", "vx": 1})

def test_resume_is_a_valid_down_message():
    validate_down({"type": "resume"})

def test_up_heartbeat_validates_and_unknown_event_fails():
    validate_up({"type": "heartbeat", "at": "2026-09-17T00:00:00.000Z", "robotReady": True, "adapter": "mock",
                 "pose": None, "navState": "idle", "estop": False, "lift": "unknown", "battery": "unknown",
                 "activeCorrelationId": None, "gatewayVersion": "0.0.1"})
    with pytest.raises(MessageError):
        validate_up({"type": "state_event", "correlationId": "c", "at": "2026-09-17T00:00:00.000Z", "event": "teleported"})
