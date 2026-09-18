import pytest

from gateway.config import load_config, Config
from gateway import __main__ as entry
from gateway.robot.mock import MockRobotAdapter


def test_navweb_config_defaults_and_timeout_override(tmp_path, monkeypatch):
    monkeypatch.setenv("ONCARE_ROBOT_TOKEN", "test-token")
    monkeypatch.delenv("ROBOT_ADAPTER", raising=False)
    path = tmp_path / "config.toml"
    path.write_text('adapter="navweb"\ngoal_timeout_s=15\n', encoding="utf-8")
    cfg = load_config(str(path))
    assert cfg.navweb_base_url == "http://127.0.0.1:5804"
    assert cfg.health_base_url == "http://127.0.0.1:5808"
    assert cfg.goal_timeout_s == 15
    assert Config("ws://api", "test").goal_timeout_s == 120


@pytest.mark.parametrize("setting", ['navweb_base_url="http://127.0.0.1:1234"', 'health_base_url="http://example.com:5808"', 'goal_timeout_s=0', 'goal_timeout_s=nan'])
def test_config_refuses_nonproduction_endpoint_or_invalid_timeout(tmp_path, monkeypatch, setting):
    monkeypatch.setenv("ONCARE_ROBOT_TOKEN", "test-token")
    path = tmp_path / "config.toml"
    path.write_text('adapter="navweb"\n' + setting + '\n', encoding="utf-8")
    with pytest.raises(ValueError):
        load_config(str(path))


def test_main_constructs_navweb_and_closes_worker_even_on_runner_error(monkeypatch):
    observed = []
    class Adapter(MockRobotAdapter):
        def close(self):
            observed.append("closed")
    def factory(*args, **kwargs):
        observed.append((args, kwargs))
        return Adapter()
    async def run(_runner, _stop):
        raise RuntimeError("test shutdown")
    monkeypatch.setattr(entry, "load_config", lambda _path: Config("ws://api", "test", adapter="navweb", goal_timeout_s=30))
    monkeypatch.setattr(entry, "NavWebAdapter", factory)
    monkeypatch.setattr(entry.GatewayRunner, "run", run)
    with pytest.raises(RuntimeError, match="test shutdown"):
        entry.main(["test.toml"])
    assert observed == [(("http://127.0.0.1:5804", "http://127.0.0.1:5808"), {"goal_timeout_s": 30}), "closed"]
