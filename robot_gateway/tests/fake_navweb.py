"""Loopback HTTP fixture only; never connects to robot services."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class FakeNavWeb:
    def __init__(self, state, health, map_blob):
        self.state, self.health, self.map_blob = state, health, map_blob
        self.requests = []
        self.posts = []
        self.responses = {}
        self.gates = {}
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def respond(self, body, code=200, headers=None):
                data = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(code)
                self.send_header("content-length", str(len(data) + (10 if (headers or {}).get("X-Test-Truncated") else 0)))
                for key, value in (headers or {}).items():
                    self.send_header(key, value)
                self.end_headers()
                try:
                    self.wfile.write(data)
                except OSError:
                    pass

            def gate(self):
                if self.path in outer.gates:
                    entered, release = outer.gates[self.path]
                    entered.set()
                    release.wait(3)

            def do_GET(self):
                outer.requests.append(("GET", self.path))
                self.gate()
                if self.path in outer.responses:
                    return self.respond(*outer.responses[self.path])
                if self.path == "/state":
                    return self.respond(outer.state)
                if self.path == "/health.json":
                    return self.respond(outer.health)
                if self.path == "/map.bin":
                    return self.respond(outer.map_blob)
                self.respond({}, 404)

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
                outer.requests.append(("POST", self.path))
                outer.posts.append((self.path, body))
                self.gate()
                if self.path in outer.responses:
                    return self.respond(*outer.responses[self.path])
                if self.path == "/goal":
                    outer.state["nav"] = {"state": "sending", "dist": None, "goal": [body[k] for k in ("x", "y", "yaw")], "auto": None, "queue": []}
                elif self.path == "/cancel":
                    outer.state["estop"] = True
                    outer.state["nav"]["state"] = "canceled"
                elif self.path == "/resume":
                    outer.state["estop"] = False
                elif self.path != "/lift":
                    return self.respond({}, 404)
                self.respond({"ok": True})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.01), daemon=True)
        self.thread.start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server.server_port}"

    def block(self, path):
        entered, release = threading.Event(), threading.Event()
        self.gates[path] = entered, release
        return entered, release

    def close(self):
        for _, release in self.gates.values():
            release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(1)
