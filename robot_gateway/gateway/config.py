import os, tomllib
from dataclasses import dataclass
from typing import Literal

@dataclass(frozen=True)
class Config:
    api_url: str
    robot_token: str
    adapter: Literal["mock", "navweb"] = "mock"
    heartbeat_ms: int = 1000
    tick_ms: int = 250
    mock_travel_ms: int = 2000

def load_config(path: str | None = None) -> Config:
    data: dict = {}
    if path:
        with open(path, "rb") as f:
            data = tomllib.load(f)
    api_url = os.environ.get("ONCARE_API_URL", data.get("api_url", "ws://127.0.0.1:3000"))
    token = os.environ.get("ONCARE_ROBOT_TOKEN", data.get("robot_token", ""))
    adapter = os.environ.get("ROBOT_ADAPTER", data.get("adapter", "mock"))
    if adapter not in ("mock", "navweb"):
        raise ValueError(f"unknown adapter {adapter!r}")
    if not token:
        raise ValueError("robot_token is required (config file or ONCARE_ROBOT_TOKEN)")
    return Config(api_url=api_url, robot_token=token, adapter=adapter,
                  heartbeat_ms=int(data.get("heartbeat_ms", 1000)), tick_ms=int(data.get("tick_ms", 250)),
                  mock_travel_ms=int(data.get("mock_travel_ms", 2000)))
