import json
import os
import socket
import time

from gateway.health_emit import emit


def test_local_datagrams_match_source_envelope_and_increment_sequence():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as receiver:
        receiver.bind(("127.0.0.1", 0))
        receiver.settimeout(1)
        hb = {"robotReady": False, "activeCorrelationId": "task_1", "adapter": "navweb", "gatewayVersion": "0.0.1"}
        messages = []
        for _ in range(2):
            emit(hb, port=receiver.getsockname()[1])
            messages.append(json.loads(receiver.recvfrom(65535)[0]))
    first, second = messages
    assert set(first) == {"name", "state", "note", "seq", "pid", "wall", "detail"}
    assert first["name"] == "oncare_gateway" and first["state"] == "ok" and first["note"] == ""
    assert first["pid"] == os.getpid() and abs(first["wall"] - time.time()) < 2
    assert second["seq"] == first["seq"] + 1
    assert first["detail"] == {"robot_ready": False, "active": "task_1", "adapter": "navweb", "gateway_version": "0.0.1"}


def test_emit_tolerates_missing_listener_and_socket_failure(monkeypatch):
    emit({}, port=1)
    def fail(*_args):
        raise OSError("socket unavailable")
    monkeypatch.setattr(socket, "socket", fail)
    emit({})
