import asyncio, json, logging, time
import pytest
import websockets
from websockets.exceptions import ConnectionClosed
from gateway.core import GatewayCore
from gateway.robot.mock import MockRobotAdapter
from gateway.runner import GatewayRunner

LOCATIONS = {"type": "locations", "locations": [{"id": "room_demo_01", "name": "Demo room", "kind": "resident_room", "x": 1.0, "y": 2.0, "yaw": 0.0, "approved": True}]}

class FakeApi:
    """Minimal stand-in for the API's /gateway endpoint."""
    def __init__(self):
        self.received: list[dict] = []
        self.connections = 0
        self.server = None
        self.port = 0
        self._conn = None

    async def start(self):
        self.server = await websockets.serve(self._handler, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]

    async def _handler(self, ws):
        self.connections += 1
        self._conn = ws
        try:
            async for raw in ws:
                self.received.append(json.loads(raw))
        except websockets.ConnectionClosed:
            pass

    async def send(self, msg: dict):
        await self._conn.send(json.dumps(msg))

    async def drop(self):
        await self._conn.close()

    async def stop(self):
        self.server.close()
        await self.server.wait_closed()

async def wait_for(pred, timeout=3.0):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        if pred():
            return True
        await asyncio.sleep(0.02)
    return False

@pytest.fixture
async def api():
    a = FakeApi(); await a.start()
    yield a
    await a.stop()

def make_runner(api, travel_ms=200, reconnect_min_s=0.05, reconnect_max_s=0.1):
    core = GatewayCore(MockRobotAdapter(travel_ms=travel_ms), now_ms=lambda: int(time.monotonic() * 1000), disconnect_grace_ms=300)
    runner = GatewayRunner(core, api_url=f"ws://127.0.0.1:{api.port}", robot_token="robot-demo-token", heartbeat_ms=100, tick_ms=20, reconnect_min_s=reconnect_min_s, reconnect_max_s=reconnect_max_s)
    return core, runner

async def test_connects_heartbeats_and_executes_an_intent(api):
    core, runner = make_runner(api)
    stop = asyncio.Event()
    task = asyncio.create_task(runner.run(stop))
    assert await wait_for(lambda: any(m["type"] == "heartbeat" for m in api.received))
    await api.send(LOCATIONS)
    await api.send({"type": "intent", "intent": "request_visit", "correlationId": "visit_1", "expiresAt": "2099-01-01T00:00:00.000Z", "payload": {"locationId": "room_demo_01"}})
    assert await wait_for(lambda: any(m.get("event") == "arrived" for m in api.received))
    kinds = [(m["type"], m.get("result") or m.get("event")) for m in api.received if m["type"] != "heartbeat"]
    assert kinds == [("ack", "accepted"), ("state_event", "robot_en_route"), ("state_event", "arrived")]
    stop.set(); await task

async def test_reconnects_after_drop_and_flushes_queued_messages(api):
    # reconnect slower than the 300 ms grace so the offline tick fires the safety stop before the link comes back
    core, runner = make_runner(api, travel_ms=5000, reconnect_min_s=0.5, reconnect_max_s=0.6)
    stop = asyncio.Event()
    task = asyncio.create_task(runner.run(stop))
    assert await wait_for(lambda: api.connections == 1 and api.received)
    await api.send(LOCATIONS)
    await api.send({"type": "intent", "intent": "request_visit", "correlationId": "visit_2", "expiresAt": "2099-01-01T00:00:00.000Z", "payload": {"locationId": "room_demo_01"}})
    assert await wait_for(lambda: any(m.get("event") == "robot_en_route" for m in api.received))
    await api.drop()
    # link lost longer than the 300 ms grace: the core safety-stops while offline, and the event arrives after reconnect
    assert await wait_for(lambda: api.connections == 2, timeout=5.0)
    assert await wait_for(lambda: any(m.get("event") == "safety_stopped" for m in api.received), timeout=5.0)
    assert core.active_correlation_id is None
    assert await wait_for(lambda: any(m["type"] == "heartbeat" and m["robotReady"] is False for m in api.received[-5:]))
    stop.set(); await task

async def test_invalid_message_from_api_is_ignored(api):
    core, runner = make_runner(api)
    stop = asyncio.Event()
    task = asyncio.create_task(runner.run(stop))
    assert await wait_for(lambda: api.received)
    await api.send({"type": "joy", "vx": 1})
    await api._conn.send("not json at all")
    await asyncio.sleep(0.2)
    assert all(m["type"] in ("heartbeat",) for m in api.received)
    stop.set(); await task

async def test_connect_error_never_logs_the_token(caplog, capsys):
    # A malformed api_url (no scheme) makes websockets.connect raise InvalidURI, whose
    # message embeds the full URI -- including the token query param. The runner must
    # never let that string reach a log record or stderr, and must keep looping (not crash).
    core = GatewayCore(MockRobotAdapter(), now_ms=lambda: int(time.monotonic() * 1000))
    runner = GatewayRunner(core, api_url="not-a-url", robot_token="SECRET_TOKEN_XYZ",
                            heartbeat_ms=100, tick_ms=20, reconnect_min_s=0.05, reconnect_max_s=0.1)
    stop = asyncio.Event()
    with caplog.at_level(logging.DEBUG, logger="gateway"):
        task = asyncio.create_task(runner.run(stop))
        await asyncio.sleep(0.3)
        stop.set()
        await task   # must return without raising
    assert "SECRET_TOKEN_XYZ" not in caplog.text
    out, err = capsys.readouterr()
    assert "SECRET_TOKEN_XYZ" not in out
    assert "SECRET_TOKEN_XYZ" not in err

class ReplayingApi(FakeApi):
    """Like FakeApi, but pushes the locations table on every connection the way
    the real API does, and can be told to drop the link the moment it sees the
    robot's ack -- i.e. while the mock robot is still travelling."""
    def __init__(self, drop_on_ack: bool = False):
        super().__init__()
        self.drop_on_ack = drop_on_ack

    async def _handler(self, ws):
        self.connections += 1
        self._conn = ws
        await ws.send(json.dumps(LOCATIONS))
        try:
            async for raw in ws:
                m = json.loads(raw)
                self.received.append(m)
                if self.drop_on_ack and m.get("type") == "ack":
                    self.drop_on_ack = False
                    await ws.close()
        except websockets.ConnectionClosed:
            pass

class FlappingApi(FakeApi):
    """Accepts a TCP/WebSocket handshake then drops it until explicitly healed."""
    def __init__(self):
        super().__init__()
        self.flapping = True

    async def _handler(self, ws):
        self.connections += 1
        self._conn = ws
        if self.flapping:
            await ws.close()
            return
        await ws.send(json.dumps(LOCATIONS))
        try:
            async for raw in ws:
                self.received.append(json.loads(raw))
        except websockets.ConnectionClosed:
            pass

async def test_unproven_flapping_connections_do_not_reset_safety_grace():
    api = FlappingApi()
    await api.start()
    now_ms = lambda: int(time.monotonic() * 1000)
    core = GatewayCore(MockRobotAdapter(travel_ms=5_000), now_ms=now_ms, disconnect_grace_ms=300)
    core.on_connected()
    core.handle(LOCATIONS)
    core.handle({"type": "intent", "intent": "request_visit", "correlationId": "visit_flap", "expiresAt": "2099-01-01T00:00:00.000Z", "payload": {"locationId": "room_demo_01"}})
    core.on_disconnected()
    runner = GatewayRunner(core, api_url=f"ws://127.0.0.1:{api.port}", robot_token="t", heartbeat_ms=100,
                           tick_ms=20, reconnect_min_s=0.05, reconnect_max_s=0.1)
    stop = asyncio.Event()
    task = asyncio.create_task(runner.run(stop))
    try:
        assert await wait_for(lambda: core.active_correlation_id is None, timeout=2.0)
        assert runner.current_backoff == runner.reconnect_max_s
        assert any(m.get("event") == "safety_stopped" for m in runner._queue)
        api.flapping = False
        assert await wait_for(lambda: any(m.get("event") == "safety_stopped" for m in api.received), timeout=2.0)
    finally:
        stop.set(); await task; await api.stop()

async def test_send_queues_the_message_when_the_link_dies_under_it():
    core = GatewayCore(MockRobotAdapter(), now_ms=lambda: 0)
    runner = GatewayRunner(core, api_url="ws://127.0.0.1:1", robot_token="t")
    ws = _RecordingWS(fail_first=True)
    with pytest.raises(ConnectionClosed):
        await runner._send(ws, {"type": "state_event", "event": "arrived"})
    assert runner._queue == [{"type": "state_event", "event": "arrived"}]
    assert ws.sent == []
    # a send that works does not queue anything
    await runner._send(ws, {"type": "state_event", "event": "cancelled"})
    assert runner._queue == [{"type": "state_event", "event": "arrived"}]
    assert ws.sent == [{"type": "state_event", "event": "cancelled"}]

async def test_a_failed_first_event_keeps_the_rest_of_its_batch_queued():
    core = GatewayCore(MockRobotAdapter(), now_ms=lambda: 0)
    runner = GatewayRunner(core, api_url="ws://127.0.0.1:1", robot_token="t")
    events = [
        {"type": "ack", "correlationId": "visit_1", "result": "accepted"},
        {"type": "state_event", "correlationId": "visit_1", "event": "robot_en_route"},
    ]
    ws = _RecordingWS(fail_first=True)
    with pytest.raises(ConnectionClosed):
        await runner._send_all(ws, events)
    assert runner._queue == events
    await runner._flush(ws)
    assert ws.sent == events

async def test_cancelling_a_suspended_send_keeps_the_whole_batch_for_replay():
    core = GatewayCore(MockRobotAdapter(), now_ms=lambda: 0)
    runner = GatewayRunner(core, api_url="ws://127.0.0.1:1", robot_token="t")
    events = [
        {"type": "state_event", "correlationId": "visit_1", "event": "arrived"},
        {"type": "state_event", "correlationId": "visit_2", "event": "arrived"},
    ]
    blocked = _BlockingWS()
    send = asyncio.create_task(runner._send_all(blocked, events))
    await blocked.started.wait()
    send.cancel()
    with pytest.raises(asyncio.CancelledError):
        await send
    assert runner._queue == events
    replay = _RecordingWS()
    await runner._flush(replay)
    assert replay.sent == events and runner._queue == []

async def test_a_drop_mid_travel_loses_no_state_event():
    api = ReplayingApi(drop_on_ack=True)
    await api.start()
    core, runner = make_runner(api, travel_ms=200, reconnect_min_s=0.05, reconnect_max_s=0.1)
    stop = asyncio.Event()
    task = asyncio.create_task(runner.run(stop))
    try:
        assert await wait_for(lambda: api.connections == 1)
        await api.send({"type": "intent", "intent": "request_visit", "correlationId": "visit_i1", "expiresAt": "2099-01-01T00:00:00.000Z", "payload": {"locationId": "room_demo_01"}})
        # the API hangs up as soon as it has the ack, while the robot is still moving
        assert await wait_for(lambda: api.connections == 2, timeout=3.0)
        assert await wait_for(lambda: any(m.get("event") == "arrived" for m in api.received), timeout=3.0)
        await asyncio.sleep(0.3)
        assert [m.get("event") for m in api.received if m.get("event") == "arrived"] == ["arrived"]
        assert core.active_correlation_id is None
    finally:
        stop.set(); await task; await api.stop()

class _RecordingWS:
    """Fake socket for unit-testing _flush without a real connection."""
    def __init__(self, fail_first: bool = False):
        self.sent: list[dict] = []
        self._fail_first = fail_first

    async def send(self, raw: str) -> None:
        if self._fail_first:
            self._fail_first = False
            raise ConnectionClosed(None, None)
        self.sent.append(json.loads(raw))

class _BlockingWS:
    def __init__(self):
        self.started = asyncio.Event()
        self._unblock = asyncio.Event()

    async def send(self, raw: str) -> None:
        self.started.set()
        await self._unblock.wait()

async def test_flush_leaves_message_queued_if_send_fails():
    core = GatewayCore(MockRobotAdapter(), now_ms=lambda: 0)
    runner = GatewayRunner(core, api_url="ws://127.0.0.1:1", robot_token="t")
    runner._queue = [{"a": 1}, {"b": 2}, {"c": 3}]
    ws = _RecordingWS(fail_first=True)
    with pytest.raises(ConnectionClosed):
        await runner._flush(ws)
    assert runner._queue == [{"a": 1}, {"b": 2}, {"c": 3}]
    assert ws.sent == []

async def test_flush_sends_all_queued_messages_in_order_and_empties_queue():
    core = GatewayCore(MockRobotAdapter(), now_ms=lambda: 0)
    runner = GatewayRunner(core, api_url="ws://127.0.0.1:1", robot_token="t")
    runner._queue = [{"a": 1}, {"b": 2}, {"c": 3}]
    ws = _RecordingWS(fail_first=False)
    await runner._flush(ws)
    assert runner._queue == []
    assert ws.sent == [{"a": 1}, {"b": 2}, {"c": 3}]
