#!/usr/bin/env python3
"""Tarot Website server.

Serves the static site and proxies AI reading requests to the MiniMax
API. The API key is loaded once from ~/.dsh/secrets.env (MINIMAX_API_KEY)
at startup and is never sent to the browser, logged, or written anywhere.

Visitors need no key and pay nothing: readings are paid by the site
owner's MiniMax account. A per-IP rate limit protects the owner's
credits when the site is public.

Environment:
    TAROT_HOST           bind address (default 127.0.0.1; 0.0.0.0 in Docker)
    TAROT_PORT           port (default 8811)
    TAROT_SECRETS_FILE   file holding MINIMAX_API_KEY (default ~/.dsh/secrets.env)
    TAROT_RATE_LIMIT     max readings per IP per window (default 15)
    TAROT_RATE_WINDOW    window in seconds (default 3600)

Usage:
    python3 server.py            # serves http://127.0.0.1:8811
"""

import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import defaultdict
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("TAROT_HOST", "127.0.0.1")
PORT = int(os.environ.get("TAROT_PORT", "8811"))
MINIMAX_URL = "https://api.minimax.io/v1/chat/completions"
MAX_BODY = 100_000  # bytes

# Rate limiting so a public site cannot drain the owner's API credits.
RATE_LIMIT = int(os.environ.get("TAROT_RATE_LIMIT", "15"))  # readings per IP
RATE_WINDOW = int(os.environ.get("TAROT_RATE_WINDOW", "3600"))  # seconds
_read_times = defaultdict(list)
_rate_lock = threading.Lock()


def load_api_key():
    """Read MINIMAX_API_KEY from the configured secrets file without printing it."""
    path = os.path.expanduser(os.environ.get("TAROT_SECRETS_FILE", "~/.dsh/secrets.env"))
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                m = re.match(r"^\s*MINIMAX_API_KEY=(.+?)\s*$", line)
                if m:
                    return m.group(1).strip().strip("\"'")
    except FileNotFoundError:
        pass
    return None


API_KEY = load_api_key()


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # quiet single-line logs; never include request bodies
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def end_headers(self):
        # "no-cache" = always revalidate: unchanged files answer 304
        # (cheap), changed files are re-served — so deploys reach
        # visitors on a normal refresh instead of sitting in the
        # browser's heuristic cache.
        if self.command in ("GET", "HEAD"):
            self.send_header("Cache-Control", "no-cache")
        # CORS for cross-origin visitors (e.g. the site on GitHub Pages
        # at thefool.im calling this proxy on the NAS).
        if getattr(self, "_cors", False):
            self._send_cors_headers()
        super().end_headers()

    def _send_cors_headers(self):
        # Echo the caller's Origin so any origin may call the public,
        # rate-limited endpoint (no credentials involved).
        origin = self.headers.get("Origin")
        self.send_header("Access-Control-Allow-Origin", origin or "*")
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")

    def do_OPTIONS(self):
        # Preflight for cross-origin POSTs — answer without consuming
        # rate limit and without touching the upstream API.
        self._cors = self.path == "/api/read"
        if self._cors:
            self.send_response(204)
            self.end_headers()
        else:
            self.send_error(404)

    def _client_ip(self):
        # Tailscale Funnel (and any reverse proxy) puts the real visitor IP
        # in X-Forwarded-For; fall back to the socket peer.
        forwarded = self.headers.get("X-Forwarded-For")
        if forwarded:
            return forwarded.split(",")[0].strip()
        return self.client_address[0]

    def _rate_limited(self):
        ip = self._client_ip()
        now = time.time()
        with _rate_lock:
            times = _read_times[ip]
            while times and now - times[0] > RATE_WINDOW:
                times.pop(0)
            if len(times) >= RATE_LIMIT:
                return True
            times.append(now)
            return False

    def do_POST(self):
        self._cors = self.path == "/api/read"
        if self.path != "/api/read":
            self.send_error(404)
            return
        if self._rate_limited():
            self.send_error(
                429, "Too many readings from your address — please try again later."
            )
            return

        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            self.send_error(413, "request too large")
            return

        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
            messages = payload.get("messages")
            model = payload.get("model")
            if (
                not isinstance(messages, list)
                or not messages
                or not all(
                    isinstance(m, dict)
                    and isinstance(m.get("role"), str)
                    and m.get("role") in ("system", "user", "assistant")
                    and isinstance(m.get("content"), str)
                    for m in messages
                )
            ):
                raise ValueError("messages must be a non-empty list of {role, content}")
            if not isinstance(model, str) or not model:
                model = "MiniMax-M3"
        except (ValueError, TypeError, json.JSONDecodeError) as e:
            self.send_error(400, "invalid request: %s" % e)
            return

        if not API_KEY:
            self.send_error(500, "MINIMAX_API_KEY not found in ~/.dsh/secrets.env")
            return

        body = json.dumps(
            {
                "model": model,
                "messages": messages,
                "stream": True,
                "thinking": {"type": "disabled"},
            }
        ).encode()
        req = urllib.request.Request(
            MINIMAX_URL,
            data=body,
            headers={
                "Authorization": "Bearer " + API_KEY,
                "Content-Type": "application/json",
            },
        )
        try:
            upstream = urllib.request.urlopen(req, timeout=120)
        except urllib.error.HTTPError as e:
            detail = e.read()[:300].decode("utf-8", "replace")
            self.send_error(502, "upstream error %s: %s" % (e.code, detail))
            return
        except Exception as e:  # URLError, timeout, ...
            self.send_error(502, "upstream error: %s" % e)
            return

        # stream the SSE response straight through to the browser
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        try:
            while True:
                chunk = upstream.read(1024)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass  # visitor closed the page mid-stream


def main():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    if not API_KEY:
        print(
            "WARNING: MINIMAX_API_KEY not found in ~/.dsh/secrets.env — "
            "the AI reader will return errors until it is added.",
            file=sys.stderr,
        )
    print("Tarot Website serving at http://%s:%d" % (HOST, PORT))
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
