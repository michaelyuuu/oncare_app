import asyncio, logging, signal, sys, time
from .config import load_config
from .core import GatewayCore
from .robot.mock import MockRobotAdapter
from .runner import GatewayRunner
from . import __version__

def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    path = (argv or sys.argv[1:])[0] if (argv or sys.argv[1:]) else None
    cfg = load_config(path)
    if cfg.adapter == "mock":
        adapter = MockRobotAdapter(travel_ms=cfg.mock_travel_ms)
        logging.getLogger("gateway").warning("SIMULATED ROBOT: adapter=mock")
    else:
        raise SystemExit("navweb adapter arrives in Plan 6")
    core = GatewayCore(adapter, now_ms=lambda: int(time.monotonic() * 1000), version=__version__)
    runner = GatewayRunner(core, cfg.api_url, cfg.robot_token, cfg.heartbeat_ms, cfg.tick_ms)
    stop = asyncio.Event()
    async def _run():
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, stop.set)
            except NotImplementedError:   # Windows
                pass
        await runner.run(stop)
    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        pass
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
