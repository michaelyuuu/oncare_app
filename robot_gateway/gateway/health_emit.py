"""Source-compatible heartbeat bus emission, not a claim of tile visibility.

Envelope matches robot/mobile/common/heartbeat.py. The current health page
renders fixed component names and needs a separately authorized tile change.
"""
import itertools
import json
import os
import socket
import time

_sequence = itertools.count(1)


def emit(hb: dict, host="127.0.0.1", port=5808) -> None:
    payload = {"name": "oncare_gateway", "state": "ok", "note": "",
               "seq": next(_sequence), "pid": os.getpid(), "wall": time.time(),
               "detail": {"robot_ready": bool(hb.get("robotReady")),
                          "active": hb.get("activeCorrelationId"),
                          "adapter": hb.get("adapter"), "gateway_version": hb.get("gatewayVersion")}}
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sender:
            sender.setblocking(False)
            sender.sendto(json.dumps(payload, default=str).encode(), (host, port))
    except OSError:
        pass
