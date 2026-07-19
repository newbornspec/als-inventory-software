#!/usr/bin/env python3
"""
ALS Inventory — Audit & Wipe GUI backend.

A small, stdlib-only HTTP server that:
  * runs the existing hardware-audit.sh engine to capture the machine's profile
    (the script already emits JSON with AUDIT_DEBUG=1 — no duplicate logic),
  * talks to the ALS Inventory API (login, lots, sub-lots, upload),
  * serves the kiosk UI (single self-contained index.html).

The bash script stays the engine; this is only a frontend driver.
Run:  python3 server.py   then open http://127.0.0.1:8800
"""
import json
import os
import re
import subprocess
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("ALS_GUI_PORT", "8800"))

# Where the engine + config live (USB root first, then alongside this file).
SEARCH_DIRS = ["/run/archiso/bootmnt", "/cdrom", "/mnt/usb",
               os.path.dirname(HERE), HERE]


def _find(name):
    for d in SEARCH_DIRS:
        p = os.path.join(d, name)
        if os.path.isfile(p):
            return p
    return None


SCRIPT = _find("hardware-audit.sh")
CONF = _find("audit.conf")

STATE = {
    "profile": None,     # captured hardware profile (dict)
    "summary": "",       # human-readable capture summary from the script
    "token": None,
    "conf": {},
    "lots": [],
    "error": None,
    "capturing": False,
}
LOCK = threading.Lock()


# ---------------------------------------------------------------- config ----
def load_conf():
    """Parse the KEY="value" lines out of audit.conf (tolerates CRLF)."""
    conf = {}
    if not CONF:
        return conf
    try:
        with open(CONF, "r", errors="replace") as fh:
            for line in fh:
                line = line.strip().lstrip("﻿")
                if not line or line.startswith("#"):
                    continue
                m = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"?(.*?)"?\s*$', line)
                if m:
                    conf[m.group(1)] = m.group(2)
    except OSError as exc:
        STATE["error"] = "Could not read audit.conf: %s" % exc
    return conf


# ------------------------------------------------------------------- API ----
def api(path, method="GET", body=None, token=None, timeout=25):
    base = STATE["conf"].get("AUDIT_URL", "").rstrip("/")
    if not base:
        raise RuntimeError("AUDIT_URL is not set in audit.conf")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode(errors="replace")
    return json.loads(raw) if raw else None


def login():
    conf = STATE["conf"]
    out = api("/auth/login", "POST", {
        "email": conf.get("AUDIT_EMAIL", ""),
        "password": conf.get("AUDIT_PASSWORD", ""),
    })
    tok = (out or {}).get("accessToken")
    if not tok:
        raise RuntimeError("Sign-in failed — check AUDIT_EMAIL / AUDIT_PASSWORD.")
    STATE["token"] = tok
    return tok


def ensure_token():
    return STATE["token"] or login()


# --------------------------------------------------------------- capture ----
def capture():
    """Run the engine in debug mode: prints a summary, then the JSON profile."""
    if not SCRIPT:
        raise RuntimeError("hardware-audit.sh not found on the boot media.")
    env = dict(os.environ, AUDIT_DEBUG="1")
    proc = subprocess.run(["bash", SCRIPT], env=env, capture_output=True,
                          text=True, timeout=300)
    out = proc.stdout or ""
    profile, summary = None, []
    for line in out.splitlines():
        s = line.strip()
        if s.startswith("{") and s.endswith("}"):
            try:
                profile = json.loads(s)
                continue
            except ValueError:
                pass
        summary.append(line)
    if profile is None:
        raise RuntimeError("Could not read the hardware profile from the engine.")
    return profile, "\n".join(summary).strip()


def refresh(do_login=True):
    with LOCK:
        STATE["capturing"] = True
        STATE["error"] = None
    try:
        STATE["conf"] = load_conf()
        prof, summ = capture()
        STATE["profile"], STATE["summary"] = prof, summ
        if do_login:
            ensure_token()
            STATE["lots"] = api("/devices/lots", token=STATE["token"]) or []
    except Exception as exc:                              # noqa: BLE001
        STATE["error"] = str(exc)
    finally:
        with LOCK:
            STATE["capturing"] = False


def ident():
    p = STATE["profile"] or {}
    i = p.get("identification", {}) or {}
    cpu = (p.get("cpu") or {}).get("model", "")
    mem = (p.get("memory") or {}).get("totalGb")
    st = p.get("storage") or []
    return {
        "name": " ".join(x for x in [i.get("manufacturer"), i.get("model")] if x) or "Unknown device",
        "deviceType": i.get("deviceType", ""),
        "serial": i.get("serialNumber", ""),
        "cpu": cpu,
        "ramGb": mem,
        "storage": ", ".join(
            " ".join(x for x in [d.get("capacity"), d.get("type")] if x) for d in st),
        "drives": st,
        "battery": (p.get("battery") or {}).get("health", ""),
    }


# ---------------------------------------------------------------- server ----
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):        # keep the console quiet
        pass

    def _send(self, code, payload, ctype="application/json"):
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):                      # noqa: N802
        u = urlparse(self.path)
        if u.path in ("/", "/index.html"):
            try:
                with open(os.path.join(HERE, "index.html"), "rb") as fh:
                    return self._send(200, fh.read(), "text/html; charset=utf-8")
            except OSError:
                return self._send(500, b"index.html missing", "text/plain")

        if u.path == "/api/bootstrap":
            return self._send(200, {
                "ready": STATE["profile"] is not None,
                "capturing": STATE["capturing"],
                "error": STATE["error"],
                "device": ident() if STATE["profile"] else None,
                "summary": STATE["summary"],
                "lots": STATE["lots"],
                "wipeEnabled": STATE["conf"].get("AUDIT_WIPE", "0") == "1",
                "wipeMethod": STATE["conf"].get("AUDIT_WIPE_METHOD", "auto"),
                "server": STATE["conf"].get("AUDIT_URL", ""),
            })

        if u.path == "/api/sublots":
            batch = (parse_qs(u.query).get("batchId") or [""])[0]
            try:
                subs = api("/lots?batchId=" + batch, token=ensure_token()) or []
                return self._send(200, subs)
            except Exception as exc:                       # noqa: BLE001
                return self._send(500, {"message": str(exc)})

        return self._send(404, {"message": "not found"})

    def do_POST(self):                     # noqa: N802
        u = urlparse(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}") if length else {}

        if u.path == "/api/rescan":
            threading.Thread(target=refresh, daemon=True).start()
            return self._send(200, {"started": True})

        if u.path == "/api/audit":
            try:
                payload = {"lotId": body.get("lotId"), "profile": STATE["profile"]}
                if body.get("subLotId"):
                    payload["subLotId"] = body["subLotId"]
                if body.get("notes"):
                    payload["notes"] = body["notes"]
                out = api("/devices/hardware-audit", "POST", payload, ensure_token())
                return self._send(200, out or {})
            except Exception as exc:                       # noqa: BLE001
                return self._send(500, {"message": str(exc)})

        return self._send(404, {"message": "not found"})


def main():
    STATE["conf"] = load_conf()
    threading.Thread(target=refresh, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("ALS audit GUI on http://127.0.0.1:%d  (engine: %s)" % (PORT, SCRIPT))
    srv.serve_forever()


if __name__ == "__main__":
    main()
