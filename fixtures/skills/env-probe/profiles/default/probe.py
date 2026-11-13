#!/usr/bin/env python3
"""Print the injected deployment env and serve a minimal Forge gateway."""
import json
import os
import signal
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

KEYS = [
    "PROBE_REQUIRED",
    "PROBE_FIXED",
    "FORGE_RUNTIME_BIN",
    "PAOS_SKILL_NAME",
    "PAOS_SKILL_VERSION",
    "PAOS_RUNTIME_INSTANCE_ID",
]
payload = {key: os.environ.get(key) for key in KEYS}
line = json.dumps({"event": "env-probe", "cwd": os.getcwd(), "env": payload}, ensure_ascii=False)
print(line, flush=True)
with open("/tmp/forge-env-probe.json", "w", encoding="utf-8") as handle:
    handle.write(line + "\n")


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"ok": True, "data": {"tools": [{"tool_id": "probe.report", "semantics": "query"}]}}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


port = int(os.environ.get("PROBE_PORT", "19199"))
server = HTTPServer(("127.0.0.1", port), Handler)


def stop(*_args):
    server.shutdown()
    sys.exit(0)


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
server.serve_forever()
