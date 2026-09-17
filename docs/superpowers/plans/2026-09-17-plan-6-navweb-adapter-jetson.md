# Plan 6: Real Robot — `NavWebAdapter` on the Jetson, Location Table, Deployment

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks 4–5 touch the physical robot: they run only on the Jetson with a person at the robot, and only after the owner has confirmed `./ontaru doctor` passes.

**Goal:** Replace the mock robot with the real Ontaru base for navigation: the gateway drives the robot through `nav_web`'s existing HTTP endpoints, reports readiness from `health.json`, appears on the robot's own health page, and is deployed as a systemd unit on the Jetson. Staff can set the three demo locations from the map.

**Architecture:** `NavWebAdapter` implements the same `RobotAdapter` protocol as the mock, talking only to `127.0.0.1:5804` (`nav_web`) and `127.0.0.1:5808` (`health_web`) with the stdlib `urllib`. It never touches `/joy`, `console_web`, the base RPC, or any arm port. The API gains `PATCH /locations/:id` so staff can record map coordinates without editing the database.

**Tech Stack:** Python 3.12 stdlib (`urllib.request`, `gzip`, `struct`, `socket`), pytest with a local `http.server` fake for `nav_web`; systemd on the Jetson.

**Spec:** `docs/superpowers/specs/2026-09-17-oncare-platform-design.md` (section 3, including the evidence list of `nav_web` endpoints)

**Depends on:** Plans 1–5 complete. Owner inputs: SSH access to the Jetson; the robot brought up with `./ontaru up nav <map.yaml>` (from `on_software_all`); a person at the robot for Tasks 4–5.

## Global Constraints

- The gateway calls only: `GET /state`, `GET /map.bin`, `POST /goal`, `POST /cancel`, `POST /resume`, `POST /lift` (preset `rest` only) on `:5804`, and `GET /health.json` on `:5808`. No other endpoint, port, topic, or process. The word `joy` must not appear in `robot_gateway/gateway/robot/navweb.py`.
- `POST /goal` is sent only for a location id that the API marked `approved`, after the gateway's own `/map.bin` cell check passes. Raw coordinates never arrive from the cloud.
- `safety_stop()` = `POST /cancel` (latches the robot's soft e-stop) and nothing else. `resume()` = `POST /resume`. `cancel()` = `POST /cancel` followed by `POST /resume` (clear the latch so the next approved goal can run). This mirrors `stop_all`/`resume` in `nav_web.py:1307-1328`.
- `robot_ready` is true only when `/state` reports the nav stack up and not e-stopped AND `health.json` reports `base_server` serving. If either endpoint is unreachable, `ready = false` and the heartbeat still goes out.
- Timeouts: every HTTP call 2 s; `/state` polled at the runner's tick rate (250 ms); a goal that reports no progress for 120 s → `navigation_failed` with reason `timeout`.
- Never modify anything under `D:/ontaru/AGI carehouse/on_software_all`. Reading `robot/mobile/web/nav_web.py` (lines ~1122-1176 goal validation and send, ~1300-1330 stop/resume, ~1492-1535 `state_json`/`map_blob`) and `robot/mobile/common/heartbeat.py` to match formats is required and is read-only.
- Hardware tests are marked `@pytest.mark.hardware` and are excluded by default.
- Commit trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC
  ```

## File structure produced by this plan

```
robot_gateway/gateway/robot/navweb.py        NavWebAdapter (RobotAdapter over nav_web/health_web HTTP)
robot_gateway/gateway/robot/mapcheck.py      parse /map.bin, is_cell_free(x, y, radius_m)
robot_gateway/gateway/health_emit.py         UDP heartbeat to the robot health page (format copied from heartbeat.py)
robot_gateway/gateway/__main__.py            navweb adapter selection
robot_gateway/tests/fake_navweb.py           http.server fake with scripted /state sequences
robot_gateway/tests/fixtures/navweb_state_idle.json, navweb_state_navigating.json, navweb_state_estop.json, health_ok.json, health_nobase.json
robot_gateway/tests/test_navweb_adapter.py, test_mapcheck.py, test_health_emit.py
robot_gateway/tests/test_hardware_navweb.py  @hardware: read-only checks against the live robot, plus one attended goto
robot_gateway/deploy/oncare-gateway.service  systemd unit
apps/api/src/routes/locations.ts             GET /locations (staff), PATCH /locations/:id (staff) -> re-sends `locations` to the robot
apps/api/test/locations.test.ts
apps/staff/src/components/Locations.tsx      staff sets x/y/yaw per location from the robot's current pose ("Use robot's position here")
docs/jetson-gateway-setup.md
```

---

### Task 1: Map check and `/state` / `health.json` fixtures

**Files:**
- Create: `robot_gateway/gateway/robot/mapcheck.py`, `robot_gateway/tests/test_mapcheck.py`
- Create: fixtures under `robot_gateway/tests/fixtures/` — **captured from the real robot** by the owner or the implementer over SSH with `curl -s http://127.0.0.1:5804/state > navweb_state_idle.json` (robot idle), the same during a navigation and while soft-e-stopped, and `curl -s http://127.0.0.1:5808/health.json > health_ok.json`. If the robot is not reachable when this task runs, write the fixtures by hand from `nav_web.py:1492-1521` and `health_web.py:2300-2453` and mark each file with a top-level `"_synthetic": true` key; Task 4 replaces them with real captures.
- Create: `robot_gateway/tests/fixtures/map_small.bin` generated by the test itself (a 20×20 grid with a wall) using the same header layout as `map_blob` (`nav_web.py:1526`): read that function and encode the 7-float header (`resolution, origin_x, origin_y, width, height, ...`) exactly as it does; document the layout in a docstring in `mapcheck.py` with the line reference.

**Interfaces:**
```python
@dataclass(frozen=True) class OccupancyGrid: resolution: float; origin_x: float; origin_y: float; width: int; height: int; data: bytes   # one byte per cell: 0 free, 100 occupied, 255 unknown (match nav_web's encoding; document it)
def parse_map_blob(blob: bytes) -> OccupancyGrid            # gunzip + header + cells
def is_cell_free(grid: OccupancyGrid, x: float, y: float, radius_m: float = 0.35) -> tuple[bool, str]   # (ok, reason) reasons: "outside_map" | "unknown" | "occupied" | "ok"
```

- [ ] **Step 1: Write the failing test**

```python
# robot_gateway/tests/test_mapcheck.py
import gzip, struct
import pytest
from gateway.robot.mapcheck import OccupancyGrid, is_cell_free, parse_map_blob

def make_blob(width=20, height=20, res=0.1, ox=-1.0, oy=-1.0, wall_col=10):
    cells = bytearray(width * height)
    for r in range(height):
        for c in range(width):
            cells[r * width + c] = 100 if c == wall_col else 0
    for c in range(width): cells[0 * width + c] = 255     # top row unknown
    header = struct.pack("<7f", res, ox, oy, float(width), float(height), 0.0, 0.0)   # adjust to nav_web's real layout
    return gzip.compress(header + bytes(cells))

def test_parse_round_trip():
    g = parse_map_blob(make_blob())
    assert (g.width, g.height) == (20, 20) and g.resolution == pytest.approx(0.1) and len(g.data) == 400

def test_free_cell_ok():
    g = parse_map_blob(make_blob())
    assert is_cell_free(g, -0.5, -0.5, radius_m=0.0) == (True, "ok")

def test_wall_is_occupied_and_radius_catches_nearby_wall():
    g = parse_map_blob(make_blob())
    x_wall = -1.0 + 10 * 0.1 + 0.05
    assert is_cell_free(g, x_wall, -0.5, radius_m=0.0) == (False, "occupied")
    assert is_cell_free(g, x_wall - 0.2, -0.5, radius_m=0.35) == (False, "occupied")
    assert is_cell_free(g, x_wall - 0.2, -0.5, radius_m=0.0) == (True, "ok")

def test_outside_and_unknown():
    g = parse_map_blob(make_blob())
    assert is_cell_free(g, 50.0, 50.0) == (False, "outside_map")
    assert is_cell_free(g, -0.5, -1.0 + 0.05, radius_m=0.0) == (False, "unknown")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd robot_gateway && .venv/Scripts/python -m pytest tests/test_mapcheck.py -q`
Expected: `ModuleNotFoundError: gateway.robot.mapcheck`.

- [ ] **Step 3: Write the implementation**

```python
# robot_gateway/gateway/robot/mapcheck.py
"""Occupancy-grid check before sending a goal.

Blob layout mirrors nav_web.map_blob (on_software_all/robot/mobile/web/nav_web.py ~1526):
gzip( <7 little-endian float32 header> + <width*height uint8 cells> ).
Header fields, in order: resolution [m/cell], origin_x, origin_y, width, height, <2 reserved>.
Cell values: 0 = free, 100 = occupied, 255 = unknown.  Verify against the real function
before trusting this on hardware; Task 4 asserts a live /map.bin parses.
"""
import gzip, math, struct
from dataclasses import dataclass

HEADER = struct.Struct("<7f")

@dataclass(frozen=True)
class OccupancyGrid:
    resolution: float
    origin_x: float
    origin_y: float
    width: int
    height: int
    data: bytes

def parse_map_blob(blob: bytes) -> OccupancyGrid:
    raw = gzip.decompress(blob)
    res, ox, oy, w, h, _a, _b = HEADER.unpack_from(raw, 0)
    width, height = int(w), int(h)
    cells = raw[HEADER.size:HEADER.size + width * height]
    if len(cells) != width * height:
        raise ValueError("map blob truncated")
    return OccupancyGrid(res, ox, oy, width, height, cells)

def is_cell_free(grid: OccupancyGrid, x: float, y: float, radius_m: float = 0.35) -> tuple[bool, str]:
    cx = int(math.floor((x - grid.origin_x) / grid.resolution))
    cy = int(math.floor((y - grid.origin_y) / grid.resolution))
    if not (0 <= cx < grid.width and 0 <= cy < grid.height):
        return False, "outside_map"
    r = int(math.ceil(radius_m / grid.resolution))
    worst = "ok"
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if dx * dx + dy * dy > r * r:
                continue
            px, py = cx + dx, cy + dy
            if not (0 <= px < grid.width and 0 <= py < grid.height):
                continue
            v = grid.data[py * grid.width + px]
            if v == 100:
                return False, "occupied"
            if v == 255 and dx == 0 and dy == 0:
                worst = "unknown"
    return (worst == "ok"), worst
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd robot_gateway && .venv/Scripts/python -m pytest tests/test_mapcheck.py -q`
Expected: PASS (4). Then read `nav_web.py` around `map_blob` and, if its header differs from the docstring, change `HEADER`/unpack order to match and update the docstring — the test's `make_blob` must match the real layout too.

- [ ] **Step 5: Commit**

```bash
git add robot_gateway/gateway/robot/mapcheck.py robot_gateway/tests/test_mapcheck.py robot_gateway/tests/fixtures
git commit -m "feat(gateway): occupancy-grid goal check mirroring nav_web map.bin" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 2: `NavWebAdapter` against a fake `nav_web`

**Files:**
- Create: `robot_gateway/gateway/robot/navweb.py`, `robot_gateway/tests/fake_navweb.py`, `robot_gateway/tests/test_navweb_adapter.py`
- Modify: `robot_gateway/gateway/__main__.py` — `adapter == "navweb"` constructs `NavWebAdapter()`; `config.py` gains `navweb_base_url = "http://127.0.0.1:5804"`, `health_base_url = "http://127.0.0.1:5808"`, `goal_timeout_s = 120`.

**Interfaces:**
```python
class NavWebAdapter(RobotAdapter):
    name = "navweb"
    def __init__(self, navweb_url="http://127.0.0.1:5804", health_url="http://127.0.0.1:5808", http_timeout_s=2.0, goal_timeout_s=120.0, now_ms=None): ...
    def start_goto(self, location): ...    # GET /map.bin -> is_cell_free -> POST /goal {x,y,yaw}; on check failure the next poll() returns NavResult("navigation_failed", reason)
    def poll(self, now_ms): ...            # GET /state -> map nav status to arrived | navigation_failed | None; cancelled when estop latched during a goal; timeout after goal_timeout_s without "succeeded"
    def cancel(self): ...                  # POST /cancel then POST /resume; next poll -> cancelled
    def safety_stop(self): ...             # POST /cancel only
    def resume(self): ...                  # POST /resume
    def state(self): ...                   # {"ready", "pose", "navState", "estop", "lift", "battery": "unknown"} from /state + health.json; unreachable -> ready False, navState "unreachable"
    def lift_rest(self): ...               # POST /lift {"cmd":"preset","slot":"rest"}; only used by the runner when idle at standby (Plan 5 spec rule 7)
```
- Field mapping from `/state` is written after reading `state_json` in `nav_web.py` (~1492-1521). The plan cannot know the exact key names; the adapter must isolate them in ONE function `_parse_state(d: dict) -> ParsedState(pose, nav_status: Literal["idle","active","succeeded","failed","canceled"], estop: bool, nav_up: bool, lift: str)` with the fixture JSON as the executable documentation. Any key missing → treat as not ready.

- [ ] **Step 1: Write the failing test**

```python
# robot_gateway/tests/fake_navweb.py
"""A tiny stand-in for nav_web + health_web on 127.0.0.1, driven by the test."""
import json, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class FakeNavWeb:
    def __init__(self, state: dict, health: dict, map_blob: bytes):
        self.state, self.health, self.map_blob = state, health, map_blob
        self.posts: list[tuple[str, dict]] = []
        outer = self
        class H(BaseHTTPRequestHandler):
            def log_message(self, *a): pass
            def _json(self, obj, code=200):
                b = json.dumps(obj).encode(); self.send_response(code); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
            def do_GET(self):
                if self.path == "/state": return self._json(outer.state)
                if self.path == "/health.json": return self._json(outer.health)
                if self.path == "/map.bin":
                    self.send_response(200); self.send_header("content-type", "application/octet-stream"); self.send_header("content-length", str(len(outer.map_blob))); self.end_headers(); self.wfile.write(outer.map_blob); return
                self._json({"error": "not_found"}, 404)
            def do_POST(self):
                n = int(self.headers.get("content-length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                outer.posts.append((self.path, body))
                if self.path == "/goal" and outer.state.get("estop"): return self._json({"ok": False, "error": "estopped"}, 409)
                self._json({"ok": True})
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
    @property
    def url(self): return f"http://127.0.0.1:{self.port}"
    def stop(self): self.server.shutdown()
```

```python
# robot_gateway/tests/test_navweb_adapter.py
import json, pathlib
import pytest
from gateway.robot.navweb import NavWebAdapter
from tests.fake_navweb import FakeNavWeb
from tests.test_mapcheck import make_blob

FIX = pathlib.Path(__file__).parent / "fixtures"
def fx(name): return json.loads((FIX / name).read_text(encoding="utf-8"))
LOC = {"id": "room_demo_01", "x": -0.5, "y": -0.5, "yaw": 0.0}

@pytest.fixture
def fake():
    f = FakeNavWeb(fx("navweb_state_idle.json"), fx("health_ok.json"), make_blob()); yield f; f.stop()

@pytest.fixture
def adapter(fake, clock):
    return NavWebAdapter(navweb_url=fake.url, health_url=fake.url, goal_timeout_s=10, now_ms=clock.now_ms)

def test_ready_when_nav_up_base_up_no_estop(adapter):
    s = adapter.state()
    assert s["ready"] is True and s["estop"] is False and s["battery"] == "unknown" and s["pose"] is not None

def test_not_ready_without_base_server(fake, adapter):
    fake.health = fx("health_nobase.json")
    assert adapter.state()["ready"] is False

def test_not_ready_when_unreachable(clock):
    a = NavWebAdapter(navweb_url="http://127.0.0.1:1", health_url="http://127.0.0.1:1", now_ms=clock.now_ms)
    s = a.state()
    assert s["ready"] is False and s["navState"] == "unreachable"

def test_goto_checks_map_then_posts_goal_and_reports_arrival(fake, adapter, clock):
    adapter.start_goto(LOC)
    assert fake.posts == [("/goal", {"x": -0.5, "y": -0.5, "yaw": 0.0})]
    fake.state = fx("navweb_state_navigating.json")
    assert adapter.poll(clock.now_ms()) is None
    fake.state = {**fx("navweb_state_idle.json"), "nav": {**fx("navweb_state_idle.json")["nav"], "status": "succeeded"}}
    r = adapter.poll(clock.now_ms())
    assert r is not None and r.outcome == "arrived"

def test_goto_refuses_occupied_cell_without_posting(fake, adapter, clock):
    adapter.start_goto({"id": "wall", "x": -1.0 + 10 * 0.1 + 0.05, "y": -0.5, "yaw": 0.0})
    assert fake.posts == []
    r = adapter.poll(clock.now_ms())
    assert r is not None and r.outcome == "navigation_failed" and r.reason == "occupied"

def test_estop_during_goal_reports_cancelled(fake, adapter, clock):
    adapter.start_goto(LOC)
    fake.state = fx("navweb_state_estop.json")
    r = adapter.poll(clock.now_ms())
    assert r is not None and r.outcome == "cancelled"

def test_timeout(fake, adapter, clock):
    adapter.start_goto(LOC)
    fake.state = fx("navweb_state_navigating.json")
    clock.advance(10_000)
    r = adapter.poll(clock.now_ms())
    assert r is not None and r.outcome == "navigation_failed" and r.reason == "timeout"

def test_cancel_posts_cancel_then_resume(fake, adapter, clock):
    adapter.start_goto(LOC); fake.posts.clear()
    adapter.cancel()
    assert [p for p, _ in fake.posts] == ["/cancel", "/resume"]
    r = adapter.poll(clock.now_ms())
    assert r is not None and r.outcome == "cancelled"

def test_safety_stop_only_cancels_and_resume_resumes(fake, adapter):
    adapter.safety_stop(); adapter.resume()
    assert [p for p, _ in fake.posts] == ["/cancel", "/resume"]

def test_never_uses_forbidden_endpoints():
    src = pathlib.Path("gateway/robot/navweb.py").read_text(encoding="utf-8")
    for bad in ("/joy", "5810", "console", "50000", "5101", "5103", "arm"):
        assert bad not in src, bad
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd robot_gateway && .venv/Scripts/python -m pytest tests/test_navweb_adapter.py -q`
Expected: `ModuleNotFoundError: gateway.robot.navweb`.

- [ ] **Step 3: Write the implementation**

```python
# robot_gateway/gateway/robot/navweb.py
"""RobotAdapter over the Ontaru robot's existing nav_web (:5804) and health_web (:5808) HTTP pages.
Allowed calls only: GET /state, GET /map.bin, POST /goal, POST /cancel, POST /resume, POST /lift, GET /health.json.
"""
import json, time, urllib.error, urllib.request
from dataclasses import dataclass
from typing import Callable, Literal
from .base import NavResult, RobotAdapter
from .mapcheck import is_cell_free, parse_map_blob

@dataclass(frozen=True)
class ParsedState:
    pose: dict | None
    nav_status: Literal["idle", "active", "succeeded", "failed", "canceled", "unknown"]
    estop: bool
    nav_up: bool
    lift: str

def _parse_state(d: dict) -> ParsedState:
    """Single place that knows nav_web's /state keys (see nav_web.py state_json). Missing keys -> not ready."""
    nav = d.get("nav") or {}
    pose = d.get("pose")
    if isinstance(pose, dict) and all(k in pose for k in ("x", "y", "yaw")):
        pose = {"x": float(pose["x"]), "y": float(pose["y"]), "yaw": float(pose["yaw"])}
    else:
        pose = None
    status = str(nav.get("status") or "unknown")
    return ParsedState(pose=pose, nav_status=status if status in ("idle", "active", "succeeded", "failed", "canceled") else "unknown",
                       estop=bool(d.get("estop", True)), nav_up=bool(nav.get("up", False) or d.get("stack", {}).get("running", False)),
                       lift=str((d.get("lift") or {}).get("busy") or (d.get("lift") or {}).get("last") or "unknown"))

class NavWebAdapter(RobotAdapter):
    name = "navweb"

    def __init__(self, navweb_url="http://127.0.0.1:5804", health_url="http://127.0.0.1:5808", http_timeout_s=2.0, goal_timeout_s=120.0, now_ms: Callable[[], int] | None = None):
        self.navweb_url = navweb_url.rstrip("/"); self.health_url = health_url.rstrip("/")
        self.timeout = http_timeout_s; self.goal_timeout_ms = int(goal_timeout_s * 1000)
        self.now_ms = now_ms or (lambda: int(time.monotonic() * 1000))
        self._goal_started_ms: int | None = None
        self._pending: NavResult | None = None
        self._active = False

    # ---- http ---------------------------------------------------------------
    def _get_json(self, base: str, path: str) -> dict | None:
        try:
            with urllib.request.urlopen(f"{base}{path}", timeout=self.timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except (urllib.error.URLError, OSError, ValueError):
            return None
    def _get_bytes(self, path: str) -> bytes | None:
        try:
            with urllib.request.urlopen(f"{self.navweb_url}{path}", timeout=self.timeout) as r:
                return r.read()
        except (urllib.error.URLError, OSError):
            return None
    def _post(self, path: str, body: dict | None = None) -> bool:
        data = json.dumps(body or {}).encode("utf-8")
        req = urllib.request.Request(f"{self.navweb_url}{path}", data=data, headers={"content-type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return 200 <= r.status < 300
        except (urllib.error.URLError, OSError):
            return False

    # ---- RobotAdapter ---------------------------------------------------------
    def start_goto(self, location: dict) -> None:
        self._pending = None
        blob = self._get_bytes("/map.bin")
        if blob is None:
            self._pending = NavResult("navigation_failed", "no_map"); return
        try:
            ok, reason = is_cell_free(parse_map_blob(blob), float(location["x"]), float(location["y"]))
        except ValueError:
            ok, reason = False, "bad_map"
        if not ok:
            self._pending = NavResult("navigation_failed", reason); return
        if not self._post("/goal", {"x": float(location["x"]), "y": float(location["y"]), "yaw": float(location["yaw"])}):
            self._pending = NavResult("navigation_failed", "goal_refused"); return
        self._active = True
        self._goal_started_ms = self.now_ms()

    def poll(self, now_ms: int) -> NavResult | None:
        if self._pending is not None:
            r, self._pending = self._pending, None
            self._active = False
            return r
        if not self._active:
            return None
        d = self._get_json(self.navweb_url, "/state")
        if d is None:
            return None    # transient; the timeout below bounds it
        s = _parse_state(d)
        if s.estop:
            self._active = False; return NavResult("cancelled", "estop")
        if s.nav_status == "succeeded":
            self._active = False; return NavResult("arrived")
        if s.nav_status in ("failed", "canceled"):
            self._active = False; return NavResult("navigation_failed" if s.nav_status == "failed" else "cancelled", s.nav_status)
        if self._goal_started_ms is not None and now_ms - self._goal_started_ms > self.goal_timeout_ms:
            self._post("/cancel"); self._post("/resume")
            self._active = False; return NavResult("navigation_failed", "timeout")
        return None

    def cancel(self) -> None:
        self._post("/cancel"); self._post("/resume")
        if self._active:
            self._pending = NavResult("cancelled")

    def safety_stop(self) -> None:
        self._post("/cancel")
        self._active = False

    def resume(self) -> None:
        self._post("/resume")

    def lift_rest(self) -> bool:
        return self._post("/lift", {"cmd": "preset", "slot": "rest"})

    def state(self) -> dict:
        d = self._get_json(self.navweb_url, "/state")
        h = self._get_json(self.health_url, "/health.json")
        if d is None:
            return {"ready": False, "pose": None, "navState": "unreachable", "estop": True, "lift": "unknown", "battery": "unknown"}
        s = _parse_state(d)
        base_up = bool(((h or {}).get("base") or {}).get("serving") or ((h or {}).get("ports") or {}).get("50000"))
        ready = s.nav_up and base_up and not s.estop
        return {"ready": ready, "pose": s.pose, "navState": "navigating" if self._active else s.nav_status, "estop": s.estop, "lift": s.lift, "battery": "unknown"}
```

The two places marked by comments (`_parse_state` and the `base_up` expression in `state()`) must be corrected against the real `state_json` and `health.json` structures while implementing; keep the fixtures consistent with whatever the real keys are.

`__main__.py`: `elif cfg.adapter == "navweb": adapter = NavWebAdapter(cfg.navweb_base_url, cfg.health_base_url, goal_timeout_s=cfg.goal_timeout_s)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd robot_gateway && .venv/Scripts/python -m pytest -m "not hardware" -q`
Expected: PASS (10 new).

- [ ] **Step 5: Commit**

```bash
git add robot_gateway/gateway/robot/navweb.py robot_gateway/gateway/__main__.py robot_gateway/gateway/config.py robot_gateway/tests/fake_navweb.py robot_gateway/tests/test_navweb_adapter.py robot_gateway/config.example.toml
git commit -m "feat(gateway): NavWebAdapter driving the real base through nav_web HTTP with map check and safe stop" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 3: Health-page heartbeat, staff location editing, `locations` re-send

**Files:**
- Create: `robot_gateway/gateway/health_emit.py`, `robot_gateway/tests/test_health_emit.py`
- Modify: `robot_gateway/gateway/runner.py` — call `health_emit.emit(core.heartbeat())` alongside every cloud heartbeat when `adapter == "navweb"`
- Create: `apps/api/src/routes/locations.ts`, `apps/api/test/locations.test.ts`; modify `apps/api/src/app.ts`
- Create: `apps/staff/src/components/Locations.tsx`; modify `apps/staff/src/pages/Console.tsx` (a fourth panel below Robot) and `en.json` (`staff.locations.title` "Locations", `staff.locations.use_pose` "Use robot's position here", `staff.locations.saved` "Saved")

**Interfaces:**
- `health_emit.emit(hb: dict, host="127.0.0.1", port=5808)`: fire-and-forget UDP datagram whose JSON matches `robot/mobile/common/heartbeat.py`'s `Emitter("oncare_gateway").emit(**fields)` wire format — read that file and copy the envelope (name, timestamp, fields) exactly; fields: `robot_ready`, `active`, `adapter`, `gateway_version`. Test with a local UDP socket capturing one datagram.
- API: `GET /locations` (staff) → all rows; `PATCH /locations/:id` (staff) body `{ x?, y?, yaw?, approved? }` → updates, audits (`entityType: "robot"`, reason `location_updated`, correlationId = location id), and re-sends the full approved `locations` message to every connected robot via `hub` (add `GatewayHub.broadcast(msg)`).
- Staff `Locations` panel: table of locations with x/y/yaw; per row "Use robot's position here" copies `queue.robot.lastHeartbeat.pose` into the row and PATCHes it. Disabled when no pose.

- [ ] **Step 1: Write the failing tests**

```python
# robot_gateway/tests/test_health_emit.py
import json, socket
from gateway.health_emit import emit

def test_emits_one_datagram_with_the_health_page_envelope():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); sock.bind(("127.0.0.1", 0)); sock.settimeout(1.0)
    port = sock.getsockname()[1]
    emit({"robotReady": True, "activeCorrelationId": None, "adapter": "navweb", "gatewayVersion": "0.0.1"}, host="127.0.0.1", port=port)
    data, _ = sock.recvfrom(65535)
    msg = json.loads(data)
    assert msg["name"] == "oncare_gateway"                # envelope key names: match heartbeat.py exactly
    assert msg["fields"]["robot_ready"] is True and msg["fields"]["adapter"] == "navweb"
    sock.close()

def test_emit_never_raises_when_nobody_listens():
    emit({"robotReady": False, "activeCorrelationId": None, "adapter": "navweb", "gatewayVersion": "x"}, host="127.0.0.1", port=1)
```

```ts
// apps/api/test/locations.test.ts
import { describe, expect, test } from "vitest";
import type { GatewayDown } from "@oncare/contracts";
import { makeTestApp } from "./helpers";
import { SEED_IDS } from "../src/db/seed";
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("locations", () => {
  test("staff lists and updates a location; the robot receives the new table", async () => {
    const { app, tokens } = await makeTestApp();
    const sent: GatewayDown[] = [];
    app.hub.attach(SEED_IDS.robot, { send: (m) => { sent.push(m); } });
    expect((await app.inject({ method: "GET", url: "/locations", headers: auth(tokens.staff) })).json().locations).toHaveLength(3);
    const res = await app.inject({ method: "PATCH", url: `/locations/${SEED_IDS.roomLocation}`, headers: auth(tokens.staff), payload: { x: 3.25, y: -1.5, yaw: 1.57 } });
    expect(res.json().location).toMatchObject({ id: SEED_IDS.roomLocation, x: 3.25, y: -1.5, yaw: 1.57 });
    const last = sent.at(-1) as any;
    expect(last.type).toBe("locations");
    expect(last.locations.find((l: any) => l.id === SEED_IDS.roomLocation)).toMatchObject({ x: 3.25, y: -1.5 });
  });
  test("family cannot touch locations; unknown id is 404; bad body 400", async () => {
    const { app, tokens } = await makeTestApp();
    expect((await app.inject({ method: "PATCH", url: `/locations/${SEED_IDS.roomLocation}`, headers: auth(tokens.family), payload: { x: 1 } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: `/locations/nope`, headers: auth(tokens.staff), payload: { x: 1 } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: `/locations/${SEED_IDS.roomLocation}`, headers: auth(tokens.staff), payload: { x: "far" } })).statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd robot_gateway && .venv/Scripts/python -m pytest tests/test_health_emit.py -q` and `npx vitest run apps/api/test/locations.test.ts`
Expected: both FAIL (module / routes missing).

- [ ] **Step 3: Write the implementation**

```python
# robot_gateway/gateway/health_emit.py
"""Make the gateway visible as a tile on the robot's health page (health_web :5808).
Wire format copied from on_software_all/robot/mobile/common/heartbeat.py — keep in sync by hand; do not import across repos."""
import json, socket, time
NAME = "oncare_gateway"
def emit(hb: dict, host: str = "127.0.0.1", port: int = 5808) -> None:
    msg = {"name": NAME, "t": time.time(), "fields": {"robot_ready": bool(hb.get("robotReady")), "active": hb.get("activeCorrelationId"),
                                                   "adapter": hb.get("adapter"), "gateway_version": hb.get("gatewayVersion")}}
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.sendto(json.dumps(msg).encode("utf-8"), (host, port))
        s.close()
    except OSError:
        pass
```
Adjust `NAME`/envelope keys to match `heartbeat.py` after reading it; update the test's key names identically.

`runner.py`: constructor gains `health_emit: Callable[[dict], None] | None = None`; the heartbeat loop calls it with the same dict it sends to the cloud. `__main__.py` passes `health_emit.emit` only for `navweb`.

```ts
// apps/api/src/routes/locations.ts
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { makeTransitionEvent } from "@oncare/core";
import { requireRole } from "../auth/plugin";
import type { Db } from "../db/client";
import * as t from "../db/schema";

export function approvedLocations(db: Db) {
  return db.select().from(t.location).where(eq(t.location.approved, true)).all().map((l) => ({ id: l.id, name: l.name, kind: l.kind, x: l.x, y: l.y, yaw: l.yaw, approved: l.approved }));
}

export async function locationRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  app.get("/locations", { preHandler: requireRole("staff") }, async () => ({ locations: db.select().from(t.location).all() }));
  app.patch("/locations/:id", { preHandler: requireRole("staff") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ x: z.number().optional(), y: z.number().optional(), yaw: z.number().optional(), approved: z.boolean().optional() }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    if (!db.select().from(t.location).where(eq(t.location.id, id)).get()) return reply.code(404).send({ error: "not_found" });
    db.update(t.location).set(body.data).where(eq(t.location.id, id)).run();
    const robot = db.select().from(t.robot).get();
    db.insert(t.auditEvent).values(makeTransitionEvent({ actorType: "staff", actorId: req.principal.id, entityType: "robot", entityId: robot?.id ?? "robot", fromState: null, toState: null, reason: "location_updated", correlationId: id })).run();
    app.hub.broadcast({ type: "locations", locations: approvedLocations(db) });
    return { location: db.select().from(t.location).where(eq(t.location.id, id)).get() };
  });
}
```
`GatewayHub.broadcast(msg)`: `for (const [, link] of this.links) link.send(msg)`. Replace the inline mapping in `routes/gateway-ws.ts` with `approvedLocations(db)`.

`Locations.tsx`: fetch `/locations`, render rows with editable x/y/yaw inputs and the "Use robot's position here" button (fills from `pose`), Save → PATCH. Add the panel to `Console.tsx` under `RobotPanel`, passing `queue.robot?.lastHeartbeat?.pose ?? null`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd robot_gateway && .venv/Scripts/python -m pytest -m "not hardware" -q` and `npx vitest run && npx tsc -b`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add robot_gateway/gateway/health_emit.py robot_gateway/gateway/runner.py robot_gateway/gateway/__main__.py robot_gateway/tests/test_health_emit.py apps/api/src/routes/locations.ts apps/api/src/routes/gateway-ws.ts apps/api/src/services/gateway-hub.ts apps/api/src/app.ts apps/api/test/locations.test.ts apps/staff packages/web-common/src/i18n/en.json
git commit -m "feat: gateway health-page heartbeat; staff can set map locations and the robot receives them live" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 4: Deployment on the Jetson and read-only hardware verification (`@hardware`)

**Files:**
- Create: `robot_gateway/deploy/oncare-gateway.service`, `docs/jetson-gateway-setup.md`, `robot_gateway/tests/test_hardware_navweb.py`
- Replace synthetic fixtures with real captures (remove `_synthetic` keys).

**Requires:** SSH to the Jetson; the robot brought up with `./ontaru up nav <map>` by the owner; nobody needs to be at the robot for this task (nothing moves).

- [ ] **Step 1: Write the unit and the doc**

```ini
# robot_gateway/deploy/oncare-gateway.service
[Unit]
Description=OnCare Robot Gateway (cloud intents -> nav_web)
After=network-online.target health-web.service
Wants=network-online.target

[Service]
Type=simple
User=%i
WorkingDirectory=/home/%i/oncare_app/robot_gateway
Environment=ROBOT_ADAPTER=navweb
ExecStart=/home/%i/oncare_app/robot_gateway/.venv/bin/python -m gateway /home/%i/oncare_app/robot_gateway/config.toml
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

`docs/jetson-gateway-setup.md` must contain: (1) clone `oncare_app` to `~/oncare_app` on the Jetson (only `robot_gateway/` is needed at runtime); (2) `python3 -m venv .venv && .venv/bin/pip install -e .` inside `robot_gateway` using the **system** Python 3.12 (the ROS shell must NOT be sourced for this venv — the launcher note in `docs/OPERATING.md` about `PYTHONPATH` shadowing applies); (3) `config.toml` with `api_url = "ws://<dev-pc-lan-ip>:3000"` (or Tailscale IP), `robot_token` from the API seed (`robot-demo-token` for the demo; rotate for anything real), `adapter = "navweb"`; (4) preflight: `./ontaru doctor`, `./ontaru up nav ~/maps/<map>.yaml`, `curl -s 127.0.0.1:5804/state | head -c 300`, `curl -s 127.0.0.1:5808/health.json | head -c 300`; (5) capture the fixtures (idle, navigating during a manual nav_web goal, e-stopped after pressing STOP on the nav_web page, health ok, health with base_server down) into `robot_gateway/tests/fixtures/`; (6) install the unit as `oncare-gateway@<user>.service`, enable, start, `journalctl -u oncare-gateway@<user> -f`; (7) expected log lines and the gateway tile on the health page; (8) rollback: `systemctl stop`, and nothing else on the robot changed.

```python
# robot_gateway/tests/test_hardware_navweb.py
"""Read-only checks against the live robot. Run on the Jetson with: pytest -m hardware tests/test_hardware_navweb.py"""
import pytest
from gateway.robot.navweb import NavWebAdapter, _parse_state
from gateway.robot.mapcheck import parse_map_blob

pytestmark = pytest.mark.hardware

def test_state_parses_and_reports_ready():
    a = NavWebAdapter()
    s = a.state()
    assert s["navState"] != "unreachable"
    assert s["pose"] is not None
    assert s["ready"] in (True, False)   # printed for the operator
    print("state:", s)

def test_map_blob_parses():
    a = NavWebAdapter()
    blob = a._get_bytes("/map.bin")
    assert blob is not None
    g = parse_map_blob(blob)
    assert g.width > 0 and g.height > 0 and len(g.data) == g.width * g.height
    print("map:", g.width, g.height, g.resolution)

def test_current_pose_cell_is_free():
    a = NavWebAdapter()
    from gateway.robot.mapcheck import is_cell_free
    s = a.state(); g = parse_map_blob(a._get_bytes("/map.bin"))
    ok, reason = is_cell_free(g, s["pose"]["x"], s["pose"]["y"], radius_m=0.0)
    assert reason in ("ok", "unknown"), reason
```

- [ ] **Step 2: Run on the Jetson**

`cd ~/oncare_app/robot_gateway && .venv/bin/python -m pytest -m hardware tests/test_hardware_navweb.py -q -s`
Expected: 3 PASS with printed state/map. If `_parse_state` reads the wrong keys, fix it (and the fixtures) and re-run the non-hardware suite on the Windows machine.

- [ ] **Step 3: Start the service and confirm it appears on both sides**

On the Jetson: `sudo cp deploy/oncare-gateway.service /etc/systemd/system/oncare-gateway@.service && sudo systemctl daemon-reload && sudo systemctl enable --now oncare-gateway@$USER`. On the dev PC with `npm run dev` running: the staff console's Robot panel shows Connected, adapter `navweb` (no SIMULATED badge), a real pose. The robot's health page (`http://<jetson>:5808/`) shows an `oncare_gateway` tile.

- [ ] **Step 4: Commit**

```bash
git add robot_gateway/deploy robot_gateway/tests/test_hardware_navweb.py robot_gateway/tests/fixtures docs/jetson-gateway-setup.md
git commit -m "feat(gateway): Jetson systemd deployment, setup runbook, read-only hardware checks and real fixtures" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

### Task 5: Attended real-robot run (visit, then tray delivery)

**Requires:** a person at the robot with the nav_web STOP page open on a phone; owner present; clear corridor.

- [ ] **Step 1: Record the three locations** — drive the robot with the nav_web page (not through our system) to the standby spot, the pickup station, and the demo room; at each, in the staff console press "Use robot's position here" on the matching location row and Save. Confirm the robot's log shows `locations` received.
- [ ] **Step 2: Visit** — from the family app request a visit. Expected: staff console shows the intent accepted, the robot drives to the room (`robot_en_route` → `awaiting_resident_consent` when Nav2 succeeds), iPad rings, answer, video works, end call. Record request-to-ring latency and Nav2 travel time in `docs/demo-visit-flow.md` "Real robot" section.
- [ ] **Step 3: Tray delivery** — "bring the water bottle" → confirm → approve; robot drives to the pickup station; staff places the bottle on the tray and presses "Loaded on tray"; robot drives to the room; resident taps "I have it"; robot returns to standby. Record times in `docs/demo-task-flow.md`.
- [ ] **Step 4: Failure drills** — (a) press STOP in the staff console mid-drive: robot halts (soft e-stop latched), task → `safety_stopped`, family sees the message; release with PIN; "Return to standby" works. (b) Pull the Jetson's network cable for 15 s during a drive: the gateway log shows `link down`, then `safety_stopped` after the 10 s grace, the robot halts; reconnect; the staff console shows the `safety_stopped` event. (c) Set a location to an occupied cell via PATCH and request a visit: the gateway rejects it with `navigation_failed: occupied` before sending any goal.
- [ ] **Step 5: Write results** into `docs/rehearsal-2026-09-XX.md` (date of the run): what passed, measured times, anything that needed a manual step, and the exact `nav_web.py` keys `_parse_state` relies on. Commit:

```bash
git add docs
git commit -m "docs: first attended real-robot rehearsal results" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01WGyKQhufstXCvJ4vgEzefC"
```

---

## Plan self-review

**Spec coverage (Plan 6):** §3 `NavWebAdapter` over the listed `nav_web` endpoints with the double map check (Tasks 1–2); `stop` = `/cancel` without resume, `cancel` = `/cancel` + `/resume` (Task 2); `robot_ready` from `/state` + `health.json` (Task 2); heartbeat to the robot's own health page (Task 3); location table owned by the API with staff editing (Task 3); lift only `preset rest` (Task 2 `lift_rest`, wired by the runner only at standby — the runner change is one line in Task 3: after a `completed_leg` with `leg == "standby"` call `adapter.lift_rest()` if present); deployment and rehearsal (Tasks 4–5). Rule 6 (no `/joy`, no console, no arm ports) is enforced by a source-scanning test.

**Placeholder scan:** the `_parse_state` key names and the health `base_up` expression are explicitly marked as "verify against the real file" with the exact line ranges; they are unknowns the plan cannot resolve from the dev machine, not placeholders. Fixtures may start synthetic and are replaced in Task 4.

**Type consistency:** `NavResult` outcomes (Plan 2 base) ↔ adapter returns; `RobotAdapter` methods (`start_goto/poll/cancel/resume/safety_stop/state`) ↔ `GatewayCore` calls; `GatewayHub.broadcast` (Task 3) ↔ `locations` route; `LocationSchema` (contracts) ↔ `approvedLocations()` shape.
