"""Opt-in, attended READ-ONLY checks; collection opens no sockets.

Never run without owner authorization, attendance and successful doctor
preflight. See docs/jetson-gateway-setup.md. No navigation/control methods are
called, and the test-side transport guard rejects every non-read operation.
"""
import math
import time

import pytest

from gateway.robot.navweb import NavWebAdapter
from gateway.robot.mapcheck import is_cell_free, parse_map_blob

pytestmark = pytest.mark.hardware


class ReadOnlyNavWeb(NavWebAdapter):
    def _request(self, method, path, body=None):
        if method != "GET" or path not in ("/state", "/health.json", "/map.bin") or body is not None:
            raise AssertionError("hardware verification permits read-only observations only")
        return super()._request(method, path)


@pytest.fixture
def observation():
    adapter = ReadOnlyNavWeb()
    try:
        # The adapter starts fail-closed; wait for its worker, not one immediate
        # state() call. The preflight requires a healthy, stationary nav stack.
        deadline = time.monotonic() + 6
        state = adapter.state()
        while not state["ready"] and time.monotonic() < deadline:
            time.sleep(0.05)
            state = adapter.state()
        assert state["ready"] is True, f"preflight robot not ready: {state}"
        assert state["estop"] is False
        assert state["navState"] in ("idle", "succeeded"), "stop verification if navigation is active"
        assert state["pose"] is not None
        assert all(math.isfinite(state["pose"][axis]) for axis in ("x", "y", "yaw"))
        yield adapter, state
    finally:
        # No goal/control was issued; read-only close sends no robot command.
        adapter.close()


def test_state_parses_and_reports_ready(observation):
    _, state = observation
    assert state["battery"] == "unknown"
    print("live read-only state:", state)


def test_map_blob_parses(observation):
    adapter, _ = observation
    blob = adapter._request("GET", "/map.bin")
    assert blob is not None, "map endpoint unavailable"
    grid = parse_map_blob(blob)
    assert grid.width > 0 and grid.height > 0 and grid.resolution > 0
    assert len(grid.data) == grid.width * grid.height
    print("live map geometry:", grid.width, grid.height, grid.resolution, grid.origin_yaw)


def test_current_pose_cell_is_free(observation):
    adapter, state = observation
    blob = adapter._request("GET", "/map.bin")
    assert blob is not None, "map endpoint unavailable"
    grid = parse_map_blob(blob)
    pose = state["pose"]
    ok, reason = is_cell_free(grid, pose["x"], pose["y"], radius_m=0.0)
    assert ok is True and reason == "ok", f"current pose is not in a known free cell: {reason}"
