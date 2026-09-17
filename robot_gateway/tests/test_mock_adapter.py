from gateway.robot.mock import MockRobotAdapter

LOC = {"id": "room_demo_01", "x": 1.0, "y": 2.0, "yaw": 0.0}

def test_arrives_after_travel_time(clock):
    a = MockRobotAdapter(travel_ms=2000)
    a.start_goto(LOC)
    assert a.poll(clock.now_ms()) is None
    assert a.state()["navState"] == "navigating"
    clock.advance(1999)
    assert a.poll(clock.now_ms()) is None
    clock.advance(1)
    r = a.poll(clock.now_ms())
    assert r is not None and r.outcome == "arrived"
    assert a.state()["navState"] == "idle" and a.state()["pose"] == {"x": 1.0, "y": 2.0, "yaw": 0.0}

def test_injected_failure(clock):
    a = MockRobotAdapter(travel_ms=100)
    a.inject_failure("navigation_failed", reason="blocked")
    a.start_goto(LOC)
    clock.advance(100)
    r = a.poll(clock.now_ms())
    assert r is not None and r.outcome == "navigation_failed" and r.reason == "blocked"

def test_cancel_reports_cancelled_once(clock):
    a = MockRobotAdapter(travel_ms=5000)
    a.start_goto(LOC)
    a.cancel()
    r = a.poll(clock.now_ms())
    assert r is not None and r.outcome == "cancelled"
    assert a.poll(clock.now_ms()) is None

def test_safety_stop_makes_robot_not_ready_until_resume(clock):
    a = MockRobotAdapter()
    a.safety_stop()
    assert a.state()["estop"] is True and a.state()["ready"] is False
    a.resume()
    assert a.state()["estop"] is False and a.state()["ready"] is True

def test_poll_without_goal_is_none(clock):
    assert MockRobotAdapter().poll(clock.now_ms()) is None
