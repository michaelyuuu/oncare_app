"""The only place in the gateway that touches sockets. GatewayCore stays pure:
this module feeds it inbound messages, ticks it on a timer, sends whatever it
produces, and manages the WebSocket connection lifecycle (heartbeat, offline
safe-stop ticking, reconnect with backoff, queuing while disconnected)."""
import asyncio, json, logging, random
import websockets
from websockets.exceptions import ConnectionClosed
from .core import GatewayCore
from .messages import MessageError

log = logging.getLogger("gateway")

class GatewayRunner:
    def __init__(self, core: GatewayCore, api_url: str, robot_token: str, heartbeat_ms: int = 1000, tick_ms: int = 250,
                 reconnect_min_s: float = 1.0, reconnect_max_s: float = 10.0):
        self.core = core
        self.url = f"{api_url.rstrip('/')}/gateway?token={robot_token}"
        self.heartbeat_s = heartbeat_ms / 1000
        self.tick_s = tick_ms / 1000
        self.reconnect_min_s = reconnect_min_s
        self.reconnect_max_s = reconnect_max_s
        self._queue: list[dict] = []

    async def run(self, stop: asyncio.Event) -> None:
        backoff = self.reconnect_min_s
        while not stop.is_set():
            try:
                async with websockets.connect(self.url, open_timeout=5) as ws:
                    backoff = self.reconnect_min_s
                    self.core.on_connected()
                    log.info("connected to %s", self.url.split("?")[0])
                    await self._flush(ws)
                    await ws.send(json.dumps(self.core.heartbeat()))
                    await self._session(ws, stop)
            except (OSError, ConnectionClosed, asyncio.TimeoutError) as e:
                log.warning("link down: %s", e)
            if stop.is_set():
                return
            self.core.on_disconnected()
            await self._offline_wait(stop, backoff)
            backoff = min(self.reconnect_max_s, backoff * 2)

    async def _session(self, ws, stop: asyncio.Event) -> None:
        async def recv():
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                    if not isinstance(msg, dict):
                        raise MessageError("not an object")
                    for out in self.core.handle(msg):
                        await ws.send(json.dumps(out))
                except (MessageError, json.JSONDecodeError) as e:
                    log.warning("ignored invalid message: %s", e)
        async def tick():
            while True:
                for out in self.core.tick():
                    await ws.send(json.dumps(out))
                await asyncio.sleep(self.tick_s)
        async def heartbeat():
            while True:
                await asyncio.sleep(self.heartbeat_s)
                await ws.send(json.dumps(self.core.heartbeat()))
        async def stopper():
            await stop.wait()
            await ws.close()
        tasks = [asyncio.create_task(c()) for c in (recv, tick, heartbeat, stopper)]
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for d in done:
                d.result()   # re-raise ConnectionClosed etc.
        finally:
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _offline_wait(self, stop: asyncio.Event, seconds: float) -> None:
        """Keep ticking the core while offline so the disconnect grace timer can fire."""
        deadline = asyncio.get_event_loop().time() + seconds + random.uniform(0, seconds * 0.2)
        while not stop.is_set() and asyncio.get_event_loop().time() < deadline:
            self._queue.extend(self.core.tick())
            await asyncio.sleep(self.tick_s)

    async def _flush(self, ws) -> None:
        while self._queue:
            await ws.send(json.dumps(self._queue.pop(0)))
