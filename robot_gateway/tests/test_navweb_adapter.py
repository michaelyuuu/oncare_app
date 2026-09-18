import json
from pathlib import Path
import time

import pytest

from gateway.robot.navweb import NavWebAdapter
from gateway.core import GatewayCore
from fake_navweb import FakeNavWeb
from test_mapcheck import make_blob

FIX = Path(__file__).parent / "fixtures"
LOC = {"id": "room", "approved": True, "x": -0.5, "y": -0.5, "yaw": 0.0}


def fx(name):
    return json.loads((FIX / name).read_text(encoding="utf-8"))


def eventually(predicate, timeout=2):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.01)
    raise AssertionError("condition did not complete")


@pytest.fixture
def fake():
    server = FakeNavWeb(fx("navweb_state_idle.json"), fx("health_ok.json"), make_blob())
    yield server
    server.close()


@pytest.fixture
def adapter(fake, clock):
    value = NavWebAdapter(fake.url, fake.url, goal_timeout_s=10, now_ms=clock.now_ms)
    eventually(lambda: value.state()["ready"])
    yield value
    value.close()


def start(fake, adapter, clock):
    adapter.start_goto(LOC, clock.now_ms())
    eventually(lambda: any(path == "/goal" for path, _ in fake.posts))


def result(adapter, clock):
    return eventually(lambda: adapter.poll(clock.now_ms()))


def test_source_state_and_health_readiness(fake, adapter):
    state = adapter.state()
    assert state["pose"] == {"x": -0.5, "y": -0.5, "yaw": 0.0}
    assert state["ready"] is True and state["battery"] == "unknown"
    fake.health = fx("health_nobase.json")
    eventually(lambda: not adapter.state()["ready"])
    fake.health = fx("health_ok.json")
    fake.state["estop"] = True
    eventually(lambda: adapter.state()["estop"])
    assert not adapter.state()["ready"]


@pytest.mark.parametrize("key", ["pose", "nav", "stack", "estop"])
def test_missing_source_fields_fail_closed(fake, adapter, key):
    del fake.state[key]
    eventually(lambda: not adapter.state()["ready"])


def test_goto_map_before_goal_and_matching_arrival_once(fake, adapter, clock):
    start(fake, adapter, clock)
    assert fake.posts == [("/goal", {"x": -0.5, "y": -0.5, "yaw": 0.0})]
    assert fake.requests.index(("GET", "/map.bin")) < fake.requests.index(("POST", "/goal"))
    fake.state["nav"]["state"] = "navigating"
    fake.state["nav"]["dist"] = 1
    eventually(lambda: adapter.state()["navState"] == "active")
    fake.state["nav"]["state"] = "succeeded"
    assert result(adapter, clock).outcome == "arrived"
    assert adapter.poll(clock.now_ms()) is None


@pytest.mark.parametrize("location,want", [({**LOC, "x": 0.05}, "occupied"), ({**LOC, "approved": False}, "unknown_location"), ({**LOC, "x": -0.95}, "outside_map")])
def test_rejected_locations_never_send_goal(fake, adapter, clock, location, want):
    adapter.start_goto(location, clock.now_ms())
    answer = result(adapter, clock)
    assert (answer.outcome, answer.reason) == ("navigation_failed", want)
    assert fake.posts == []


def test_bad_map_and_body_level_refusal(fake, adapter, clock):
    fake.map_blob = b"bad"
    adapter.start_goto(LOC, clock.now_ms())
    assert result(adapter, clock).reason == "bad_map"
    assert fake.posts == []
    fake.map_blob = make_blob()
    fake.responses["/goal"] = ({"ok": False, "error": "not ready"}, 200)
    adapter.start_goto(LOC, clock.now_ms())
    assert result(adapter, clock).reason == "goal_refused"


def test_estop_and_explicit_cancel_are_distinct_from_recovery(fake, adapter, clock):
    start(fake, adapter, clock)
    fake.state["nav"]["state"] = "canceled"
    eventually(lambda: adapter.state()["navState"] == "canceled")
    assert adapter.poll(clock.now_ms()) is None
    fake.state = fx("navweb_state_estop.json")
    assert result(adapter, clock).outcome == "cancelled"


def test_cancel_order_and_safety_stop_never_resume(fake, adapter, clock):
    start(fake, adapter, clock)
    adapter.cancel()
    assert result(adapter, clock).outcome == "cancelled"
    eventually(lambda: len(fake.posts) == 3)
    assert [path for path, _ in fake.posts] == ["/goal", "/cancel", "/resume"]
    adapter.safety_stop()
    eventually(lambda: len(fake.posts) == 4)
    assert fake.posts[-1][0] == "/cancel"
    assert adapter.state()["ready"] is False
    adapter.resume()
    eventually(lambda: len(fake.posts) == 5)
    assert fake.posts[-1][0] == "/resume"


def test_safety_stop_during_map_fetch_invalidates_unsent_goal(fake, adapter, clock):
    entered, release = fake.block("/map.bin")
    adapter.start_goto(LOC, clock.now_ms())
    assert entered.wait(1)
    started = time.monotonic()
    adapter.safety_stop()
    assert time.monotonic() - started < 0.1
    release.set()
    eventually(lambda: fake.posts)
    assert [path for path, _ in fake.posts] == ["/cancel"]


def test_safety_stop_during_cancel_never_clears_latch(fake, adapter, clock):
    start(fake, adapter, clock)
    entered, release = fake.block("/cancel")
    adapter.cancel()
    assert entered.wait(1)
    adapter.safety_stop()
    release.set()
    eventually(lambda: len(fake.posts) >= 3)
    assert all(path != "/resume" for path, _ in fake.posts)


def test_stale_previous_goal_success_does_not_complete_current_goal(fake, adapter, clock):
    start(fake, adapter, clock)
    fake.state["nav"] = {"state": "succeeded", "goal": [5, 6, 0], "dist": None}
    eventually(lambda: adapter.state()["navState"] == "succeeded")
    assert adapter.poll(clock.now_ms()) is None
    fake.state["nav"]["goal"] = [-0.5, -0.5, 0]
    assert result(adapter, clock).outcome == "arrived"


def test_progress_resets_timeout_but_outages_do_not(fake, adapter, clock):
    start(fake, adapter, clock)
    fake.state["nav"].update(state="navigating", dist=5)
    fake.state["pose"] = [-0.4, -0.5, 0]
    eventually(lambda: adapter.state()["pose"] == {"x": -0.4, "y": -0.5, "yaw": 0.0})
    clock.advance(9000)
    fake.state["nav"]["dist"] = 4
    fake.state["pose"] = [-0.3, -0.5, 0]
    # The pose from the same snapshot proves this measurement was consumed.
    eventually(lambda: adapter.state()["pose"] == {"x": -0.3, "y": -0.5, "yaw": 0.0})
    clock.advance(1000)
    assert adapter.poll(clock.now_ms()) is None
    fake.responses["/state"] = ({}, 503)
    eventually(lambda: adapter.state()["navState"] == "unreachable")
    clock.advance(9000)
    answer = result(adapter, clock)
    assert (answer.outcome, answer.reason) == ("navigation_failed", "timeout")
    assert adapter.poll(clock.now_ms()) is None


def test_slow_http_does_not_block_heartbeat_and_stale_data_is_not_ready(fake, adapter, clock):
    entered, release = fake.block("/state")
    assert entered.wait(1)
    core = GatewayCore(adapter, clock.now_ms)
    started = time.monotonic()
    for _ in range(5):
        core.tick()
        core.heartbeat()
    assert time.monotonic() - started < 0.1
    eventually(lambda: not core.heartbeat()["robotReady"], timeout=1.5)
    release.set()


def test_disconnect_only_issues_latching_stop(clock):
    from gateway.robot.mock import MockRobotAdapter
    class Recording(MockRobotAdapter):
        def __init__(self):
            super().__init__()
            self.calls = []
        def cancel(self):
            self.calls.append("cancel_resume")
            super().cancel()
        def safety_stop(self):
            self.calls.append("stop")
            super().safety_stop()
    adapter = Recording()
    core = GatewayCore(adapter, clock.now_ms)
    core.handle({"type": "locations", "locations": [{**LOC, "name": "Room", "kind": "resident_room"}]})
    core.handle({"type": "intent", "intent": "request_visit", "correlationId": "c1", "expiresAt": "2099-01-01T00:00:00Z", "payload": {"locationId": "room"}})
    core.on_disconnected()
    clock.advance(10000)
    assert core.tick()[0]["event"] == "safety_stopped"
    assert adapter.calls == ["stop"]


@pytest.mark.parametrize("url", ["http://example.com:5804", "http://localhost:5804", "https://127.0.0.1:5804", "http://127.0.0.1:5804/path", "http://user@127.0.0.1:5804", "http://127.0.0.1:5804?next=x"])
def test_non_loopback_origins_rejected_before_any_http(url):
    with pytest.raises(ValueError):
        NavWebAdapter(navweb_url=url)


def test_redirects_cannot_escape_allowlist(fake, adapter, clock):
    fake.responses["/map.bin"] = (b"", 302, {"Location": fake.url + "/forbidden"})
    adapter.start_goto(LOC, clock.now_ms())
    assert result(adapter, clock).reason == "no_map"
    assert ("GET", "/forbidden") not in fake.requests


def test_timeout_latches_without_auto_resume(fake, adapter, clock):
    start(fake, adapter, clock)
    fake.responses["/state"] = ({}, 503)
    eventually(lambda: adapter.state()["navState"] == "unreachable")
    clock.advance(10000)
    assert result(adapter, clock).reason == "timeout"
    eventually(lambda: fake.posts[-1][0] == "/cancel")
    assert [path for path, _ in fake.posts] == ["/goal", "/cancel"]
    fake.responses.clear()
    fake.state["estop"] = False
    time.sleep(0.3)
    assert adapter.state()["ready"] is False


def test_control_pending_suppresses_readiness(fake, adapter, clock):
    start(fake, adapter, clock)
    entered, release = fake.block("/cancel")
    adapter.cancel()
    assert entered.wait(1)
    assert adapter.state()["ready"] is False
    release.set()


def test_first_distance_is_baseline_not_progress(fake, adapter, clock):
    start(fake, adapter, clock)
    entered, release = fake.block("/state")
    assert entered.wait(1)
    clock.advance(9000)
    fake.state["nav"].update(state="navigating", dist=5)
    release.set()
    eventually(lambda: adapter.state()["navState"] == "active")
    time.sleep(0.05)
    clock.advance(1000)
    assert result(adapter, clock).reason == "timeout"


def test_rest_payload_is_only_lift_operation_and_close_stops_http(fake, adapter):
    assert adapter.lift_rest() is True
    eventually(lambda: fake.posts)
    assert fake.posts == [("/lift", {"cmd": "preset", "slot": "rest"})]
    adapter.close()
    count = len(fake.requests)
    time.sleep(0.3)
    assert len(fake.requests) == count


def test_proxy_environment_cannot_redirect_loopback_requests(fake, clock, monkeypatch):
    monkeypatch.setenv("http_proxy", "http://127.0.0.1:1")
    monkeypatch.setenv("no_proxy", "")
    with_adapter = NavWebAdapter(fake.url, fake.url, now_ms=clock.now_ms)
    try:
        eventually(lambda: with_adapter.state()["ready"])
    finally:
        with_adapter.close()


def test_late_success_cannot_win_over_no_progress_deadline(fake, adapter, clock):
    start(fake, adapter, clock)
    entered, release = fake.block("/state")
    assert entered.wait(1)
    clock.advance(10000)
    fake.state["nav"]["state"] = "succeeded"
    release.set()
    eventually(lambda: fake.posts[-1][0] == "/cancel")
    assert result(adapter, clock).reason == "timeout"


def test_truncated_http_does_not_kill_worker_or_prevent_stop(fake, adapter):
    fake.responses["/state"] = (b'{"pose":', 200, {"X-Test-Truncated": "1"})
    eventually(lambda: adapter.state()["navState"] == "unreachable")
    adapter.safety_stop()
    eventually(lambda: any(path == "/cancel" for path, _ in fake.posts))


def test_read_only_close_sends_no_robot_command(fake, adapter):
    adapter.close()
    assert fake.posts == []


def test_active_shutdown_latches_stop_without_resume(fake, adapter, clock):
    start(fake, adapter, clock)
    adapter.close()
    assert [path for path, _ in fake.posts] == ["/goal", "/cancel"]


def test_shutdown_during_goal_post_drains_stop_and_invalidates_resume(fake, adapter, clock):
    import threading
    entered, release = fake.block("/goal")
    adapter.start_goto(LOC, clock.now_ms())
    assert entered.wait(1)
    adapter.resume()
    closer = threading.Thread(target=adapter.close)
    closer.start()
    release.set()
    closer.join(3)
    assert not closer.is_alive()
    assert [path for path, _ in fake.posts] == ["/goal", "/cancel"]


def test_unrepresentable_pose_fails_closed_without_losing_stop_worker(fake, adapter):
    fake.state["pose"] = [10 ** 400, 0, 0]
    eventually(lambda: not adapter.state()["ready"])
    adapter.safety_stop()
    eventually(lambda: any(path == "/cancel" for path, _ in fake.posts))


@pytest.mark.parametrize("reply", [b"invalid json", {}, {"ok": "true"}])
def test_uncertain_goal_latches_and_attempts_stop_despite_fresh_active_state(fake, adapter, clock, reply):
    fake.responses["/goal"] = (reply, 200)
    fake.responses["/cancel"] = ({"ok": False}, 200)
    start(fake, adapter, clock)
    assert result(adapter, clock).reason == "goal_uncertain"
    eventually(lambda: ("/cancel", {}) in fake.posts)
    fake.state["nav"].update(state="navigating", goal=[-0.5, -0.5, 0])
    eventually(lambda: adapter.state()["navState"] == "active")
    assert adapter.state()["ready"] is False
    adapter.start_goto(LOC, clock.now_ms())
    assert result(adapter, clock).reason == "robot_not_ready"
    assert [path for path, _ in fake.posts] == ["/goal", "/cancel"]


def test_failed_cancel_latches_retries_stop_and_never_claims_cancelled(fake, adapter, clock):
    start(fake, adapter, clock)
    fake.responses["/cancel"] = ({"ok": False}, 503)
    adapter.cancel()
    answer = result(adapter, clock)
    assert (answer.outcome, answer.reason) == ("navigation_failed", "cancel_failed")
    eventually(lambda: len(fake.posts) == 3)
    fake.state["nav"]["state"] = "navigating"
    eventually(lambda: adapter.state()["navState"] == "active")
    assert adapter.state()["ready"] is False
    assert [path for path, _ in fake.posts] == ["/goal", "/cancel", "/cancel"]


@pytest.mark.parametrize("phase", ["headers", "body"])
def test_total_http_deadline_releases_worker_for_stop_during_slow_stream(fake, clock, phase):
    value = NavWebAdapter(fake.url, fake.url, http_timeout_s=0.15, now_ms=clock.now_ms)
    try:
        eventually(lambda: value.state()["ready"])
        entered = fake.stream("/state", phase)
        assert entered.wait(1)
        started = time.monotonic()
        value.safety_stop()
        eventually(lambda: ("/cancel", {}) in fake.posts, timeout=0.35)
        assert time.monotonic() - started < 0.35
    finally:
        value.close()


def test_accepted_goal_with_lost_response_is_stopped_and_stays_latched(fake, clock):
    import threading
    value = NavWebAdapter(fake.url, fake.url, http_timeout_s=0.15, now_ms=clock.now_ms)
    entered, release = threading.Event(), threading.Event()
    fake.response_gates["/goal"] = entered, release
    try:
        eventually(lambda: value.state()["ready"])
        value.start_goto(LOC, clock.now_ms())
        assert entered.wait(1)
        assert fake.state["nav"]["state"] == "sending"
        assert result(value, clock).reason == "goal_uncertain"
        eventually(lambda: fake.state["estop"] is True)
        release.set()
        assert [path for path, _ in fake.posts] == ["/goal", "/cancel"]
        fake.state["estop"] = False
        eventually(lambda: value.state()["navState"] == "canceled")
        assert value.state()["ready"] is False
    finally:
        release.set()
        value.close()


@pytest.mark.parametrize("wire", [
    b'HTTP/1.1 200 OK\r\nContent-Length: 22\r\n\r\n{"ok": true}',
    b'HTTP/1.1 200 OK\r\nContent-Length: 1048577\r\n\r\n',
    b'HTTP/1.1 200 OK\r\n' + b'X-Pad: ' + b'x' * 65536 + b'\r\n\r\n{"ok": true}',
], ids=["truncated", "large-body", "large-header"])
def test_invalid_or_oversized_goal_framing_is_uncertain_and_stopped(fake, adapter, clock, wire):
    fake.raw_responses["/goal"] = wire
    start(fake, adapter, clock)
    assert result(adapter, clock).reason == "goal_uncertain"
    eventually(lambda: ("/cancel", {}) in fake.posts)
    assert not adapter.state()["ready"]


def test_chunked_goal_acknowledgment_uses_http_framing(fake, adapter, clock):
    fake.raw_responses["/goal"] = (b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n'
                                   b'5\r\n{"ok"\r\n6\r\n: true\r\n1\r\n}\r\n0\r\n\r\n')
    start(fake, adapter, clock)
    fake.state["nav"]["state"] = "succeeded"
    assert result(adapter, clock).outcome == "arrived"
    assert [path for path, _ in fake.posts] == ["/goal"]
