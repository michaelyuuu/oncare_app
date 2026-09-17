import asyncio, json, time
import pytest
import websockets
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
