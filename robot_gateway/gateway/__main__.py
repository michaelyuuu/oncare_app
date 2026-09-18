import asyncio, logging, signal, sys, time
from .config import load_config
from .core import GatewayCore
from .robot.mock import MockRobotAdapter
from .robot.navweb import NavWebAdapter
from .runner import GatewayRunner
from . import __version__
from .health_emit import emit

def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    path = (argv or sys.argv[1:])[0] if (argv or sys.argv[1:]) else None
    cfg = load_config(path)
    if cfg.adapter == "mock":
        adapter = MockRobotAdapter(travel_ms=cfg.mock_travel_ms)
        logging.getLogger("gateway").warning("SIMULATED ROBOT: adapter=mock")
    else:
        adapter = NavWebAdapter(cfg.navweb_base_url, cfg.health_base_url, goal_timeout_s=cfg.goal_timeout_s)
    core = GatewayCore(adapter, now_ms=lambda: int(time.monotonic() * 1000), version=__version__)
    runner = GatewayRunner(core, cfg.api_url, cfg.robot_token, cfg.heartbeat_ms, cfg.tick_ms,
                           health_emit=emit if cfg.adapter == "navweb" else None)
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
    finally:
        close = getattr(adapter, "close", None)
        if close is not None:
            close()
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
