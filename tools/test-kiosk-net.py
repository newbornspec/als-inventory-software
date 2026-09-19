#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""The header chip's live connection state (GET /api/net) is truthful, cached,
and never makes the kiosk wait.

The incident: the owner saw "Connected" on a station that was not. The chip
was set once, from /api/bootstrap when the page loaded, and bootstrap is not
re-polled once the page has settled - a Wi-Fi drop or a server outage after
start-up never showed. server.py now keeps a live answer (net_refresh_once, on
the net_worker thread every 10 s) and /api/net only reads it.

Proves, against the real server.py with NetworkManager and the API stood in
for (nothing leaves 127.0.0.1, no nmcli is run):
  - the nmcli terse parser keeps an SSID containing ':' or '\\' whole;
  - link detection: nothing connected / Wi-Fi with its SSID / Ethernet (wins
    over Wi-Fi) / "connected (externally)" / "connecting" is not connected /
    nmcli missing;
  - the state for every combination: no link, link but API silent, link and
    API OK, probe exceptions and timeouts - and the real server_reachable
    against a fake API (200, 401 = still an answer, closed port, no AUDIT_URL);
  - "since" moves only when the state changes;
  - becoming connected triggers exactly ONE queue flush per transition, none
    while it stays connected, none with an empty queue;
  - /api/net answers at once while a probe hangs (a stub that sleeps), over
    real HTTP to the real Handler, and a probe hung past NET_STALE stops the
    last "connected" being repeated;
  - the answer has exactly the contract's keys, with no token, no password,
    and nmcli is never asked for secrets; it needs no token (operator
    sign-in on, nobody signed in).

    python3 tools/test-kiosk-net.py
"""
import importlib.util
import io
import json
import os
import socket
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("als_server", os.path.join(HERE, "gui", "server.py"))
srv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(srv)

PASS, FAIL = [0], []


def check(name, cond, detail=""):
    if cond:
        PASS[0] += 1
        print("  ok   %s" % name)
    else:
        FAIL.append(name)
        print("  FAIL %s   %s" % (name, detail))


WIFI_PASSWORD = "hunter2-wifi-secret"
TOKEN = "tok-very-secret-123"
ADMIN_PIN = "8642"
srv.STATE["conf"] = {"AUDIT_URL": "", "WIFI_SSID": "ALS Warehouse", "WIFI_PASSWORD": WIFI_PASSWORD,
                     "AUDIT_PASSWORD": "station-pass-secret", "AUDIT_ADMIN_PIN": ADMIN_PIN}
srv.STATE["token"] = TOKEN

# --- NetworkManager stand-in ---------------------------------------------
NM = {"status": "", "list": "", "calls": []}


def fake_nmcli(args, timeout=5):
    NM["calls"].append(list(args))
    if "status" in args:
        return NM["status"]
    if "list" in args:
        return NM["list"]
    return None


REAL_NMCLI = srv._nmcli
srv._nmcli = fake_nmcli


class Fake(srv.Handler):
    """The real Handler's do_GET, minus the socket."""
    def __init__(self, path):
        self.path = path
        self.headers = {"Content-Length": "0"}
        self.rfile = io.BytesIO(b"")
        self.sent = None

    def _send(self, code, payload, ctype="application/json"):
        self.sent = (code, payload)


def get(path):
    h = Fake(path)
    h.do_GET()
    return h.sent


def reset_net(state="checking", since=1):
    with srv.NET_LOCK:
        srv.NET.update(state=state, via=None, ssid=None, checkedAt=None, since=since,
                       probingSince=None)


# Probe stand-ins. Each test sets what the link and the API do.
REAL_REACH = srv.server_reachable
REAL_LINK = srv.nm_link
PROBE = {"link": (True, "wifi", "ALS Warehouse"), "api": "ok"}


def fake_link():
    v = PROBE["link"]
    if isinstance(v, BaseException):
        raise v
    return v


def fake_reach(timeout=15):
    v = PROBE["api"]
    if v == "ok":
        return None
    if isinstance(v, BaseException):
        raise v
    if callable(v):
        return v(timeout)
    raise RuntimeError("unreachable")


FLUSHES = {"n": 0, "waiting": 1}
FLUSHED = threading.Event()


def fake_queue_flush():
    FLUSHES["n"] += 1
    FLUSHED.set()
    return 0


REAL_QUEUE_FLUSH = srv.queue_flush
srv.queue_flush = fake_queue_flush
srv.queue_count = lambda: FLUSHES["waiting"]


def settle():
    """Let a flush thread (if one was started) run."""
    time.sleep(0.15)


print("nmcli terse parsing")
check("plain fields", srv._nm_split("wifi:connected:ALS") == ["wifi", "connected", "ALS"],
      srv._nm_split("wifi:connected:ALS"))
check("an escaped ':' stays inside the SSID",
      srv._nm_split("yes:Shop\\:Floor") == ["yes", "Shop:Floor"], srv._nm_split("yes:Shop\\:Floor"))
check("an escaped backslash stays one backslash",
      srv._nm_split("yes:a\\\\b") == ["yes", "a\\b"], srv._nm_split("yes:a\\\\b"))
check("empty trailing field kept", srv._nm_split("wifi:disconnected:") == ["wifi", "disconnected", ""])

print("link detection (nm_link)")
NM.update(status="wifi:disconnected:\nethernet:unavailable:\nloopback:connected (externally):lo\n",
          list="")
check("nothing connected (loopback does not count) -> no link",
      srv.nm_link() == (False, None, None), srv.nm_link())
NM.update(status="wifi:connected:ALS Warehouse\nethernet:unavailable:\n",
          list="no:Neighbour\nyes:ALS Warehouse\n")
check("Wi-Fi connected -> wifi with the active SSID",
      srv.nm_link() == (True, "wifi", "ALS Warehouse"), srv.nm_link())
NM.update(status="wifi:connected:conn-name-not-ssid\n", list="yes:Shop\\:Floor\n")
check("the SSID comes from the active network, not the connection name, ':' intact",
      srv.nm_link() == (True, "wifi", "Shop:Floor"), srv.nm_link())
NM.update(status="wifi:connected:ALS Warehouse\n", list=None)
check("SSID list unavailable -> falls back to the connection name",
      srv.nm_link() == (True, "wifi", "ALS Warehouse"), srv.nm_link())
NM.update(status="wifi:connected:ALS Warehouse\nethernet:connected:Wired connection 1\n",
          list="yes:ALS Warehouse\n")
check("Ethernet and Wi-Fi both up -> Ethernet, no SSID",
      srv.nm_link() == (True, "ethernet", None), srv.nm_link())
NM.update(status="ethernet:connected (externally):eth0\n")
check("'connected (externally)' counts", srv.nm_link() == (True, "ethernet", None), srv.nm_link())
NM.update(status="wifi:connecting (getting IP configuration):ALS Warehouse\n")
check("'connecting ...' is not connected yet", srv.nm_link() == (False, None, None), srv.nm_link())
NM.update(status=None)
check("nmcli missing/failing -> unknown", srv.nm_link() == (None, None, None), srv.nm_link())
asked = [" ".join(c) for c in NM["calls"]]
check("nmcli is never asked for secrets",
      not any(("secret" in a.lower() or "psk" in a.lower() or "security" in a.lower()
               or a.startswith("-s") or " -s " in a) for a in asked), asked)
check("the SSID list never forces a rescan",
      all("--rescan no" in a for a in asked if "list" in a), asked)
# The real runner with a binary that cannot exist: "don't know", not a crash.
_r = REAL_NMCLI(["--version"], timeout=2)
check("real _nmcli: never raises (None when nmcli is missing)", _r is None or isinstance(_r, str), _r)

print("state mapping (net_state)")
for up, api, want in ((None, False, "no-network"), (False, False, "no-network"),
                      (True, False, "server-unreachable"), (True, True, "connected"),
                      (False, True, "connected"), (None, True, "connected")):
    check("link %s, api %s -> %s" % (up, api, want), srv.net_state(up, api) == want,
          srv.net_state(up, api))

print("probe (net_refresh_once) for every combination")
srv.nm_link = fake_link
srv.server_reachable = fake_reach
FLUSHES["waiting"] = 0
CASES = [
    ("no link, API silent", (False, None, None), RuntimeError("down"),
     {"state": "no-network", "via": None, "ssid": None}),
    ("Wi-Fi up, API silent", (True, "wifi", "ALS Warehouse"), RuntimeError("down"),
     {"state": "server-unreachable", "via": "wifi", "ssid": "ALS Warehouse"}),
    ("Wi-Fi up, API times out", (True, "wifi", "ALS Warehouse"), socket.timeout("timed out"),
     {"state": "server-unreachable", "via": "wifi", "ssid": "ALS Warehouse"}),
    ("Ethernet up, API OK", (True, "ethernet", None), "ok",
     {"state": "connected", "via": "ethernet", "ssid": None}),
    ("Wi-Fi up, API OK", (True, "wifi", "ALS Warehouse"), "ok",
     {"state": "connected", "via": "wifi", "ssid": "ALS Warehouse"}),
    ("nmcli raises, API OK", OSError("nmcli exploded"), "ok",
     {"state": "connected", "via": None, "ssid": None}),
    ("nmcli raises, API raises", OSError("nmcli exploded"), OSError("no route"),
     {"state": "no-network", "via": None, "ssid": None}),
    ("nmcli unknown, API OK", (None, None, None), "ok",
     {"state": "connected", "via": None, "ssid": None}),
    ("no link reported but API answers (unmanaged link)", (False, None, None), "ok",
     {"state": "connected", "via": None, "ssid": None}),
]
for name, link, api, want in CASES:
    reset_net()
    PROBE.update(link=link, api=api)
    try:
        srv.net_refresh_once()
        code, body = get("/api/net")
        got = {k: body.get(k) for k in ("state", "via", "ssid")}
        check(name + " -> " + want["state"], code == 200 and got == want, (code, body))
    except Exception as exc:  # noqa: BLE001
        check(name + " (no exception escapes)", False, repr(exc))
check("the probe is marked finished afterwards", srv.NET["probingSince"] is None)

print("since / checkedAt")
reset_net(state="connected", since=5)
PROBE.update(link=(True, "wifi", "ALS Warehouse"), api="ok")
srv.net_refresh_once()
b = get("/api/net")[1]
check("same state again: since unchanged", b["since"] == 5, b)
check("checkedAt is set (epoch seconds)", isinstance(b["checkedAt"], int)
      and abs(b["checkedAt"] - time.time()) < 5, b)
PROBE.update(api=RuntimeError("down"))
srv.net_refresh_once()
b = get("/api/net")[1]
check("state changed: since moves to now", b["state"] == "server-unreachable"
      and abs(b["since"] - time.time()) < 5, b)
reset_net()
check("'checking' before the first probe", get("/api/net")[1]["state"] == "checking",
      get("/api/net")[1])

print("back online -> exactly one queue flush")
FLUSHES.update(n=0, waiting=1)
reset_net(state="no-network")
PROBE.update(link=(True, "wifi", "ALS Warehouse"), api="ok")
srv.net_refresh_once()
FLUSHED.wait(2)
settle()
check("no-network -> connected: one flush", FLUSHES["n"] == 1, FLUSHES)
srv.net_refresh_once()
srv.net_refresh_once()
settle()
check("staying connected: no further flush", FLUSHES["n"] == 1, FLUSHES)
PROBE.update(api=RuntimeError("down"))
srv.net_refresh_once()
settle()
check("going down: no flush", FLUSHES["n"] == 1, FLUSHES)
PROBE.update(api="ok")
FLUSHED.clear()
srv.net_refresh_once()
FLUSHED.wait(2)
settle()
check("server-unreachable -> connected: one more flush", FLUSHES["n"] == 2, FLUSHES)
FLUSHES.update(n=0, waiting=0)
reset_net(state="no-network")
srv.net_refresh_once()
settle()
check("nothing waiting: no flush started", FLUSHES["n"] == 0, FLUSHES)
FLUSHES.update(n=0, waiting=1)
reset_net(state="checking")
FLUSHED.clear()
srv.net_refresh_once()
FLUSHED.wait(2)
settle()
check("first probe after start (checking -> connected): one flush", FLUSHES["n"] == 1, FLUSHES)
# The real queue_flush refuses to run twice at once (FLUSH_LOCK): the guard
# this relies on so its flush and refresh()'s cannot overlap.
srv.FLUSH_LOCK.acquire()
try:
    t0 = time.time()
    r = REAL_QUEUE_FLUSH()
    check("the real queue_flush returns at once while another flush runs",
          r == 0 and time.time() - t0 < 0.5, r)
finally:
    srv.FLUSH_LOCK.release()
FLUSHES["waiting"] = 0

print("never blocks on a hung probe (real HTTP to the real Handler)")
RELEASE = threading.Event()


def hung(timeout):
    RELEASE.wait(20)          # a probe that hangs (a DNS lookup on a dead network)
    raise RuntimeError("hung then failed")


reset_net(state="connected")
with srv.NET_LOCK:
    srv.NET.update(via="wifi", ssid="ALS Warehouse", checkedAt=int(time.time()))
PROBE.update(link=(True, "wifi", "ALS Warehouse"), api=hung)
worker = threading.Thread(target=srv.net_refresh_once, daemon=True)
worker.start()
time.sleep(0.1)
httpd = ThreadingHTTPServer(("127.0.0.1", 0), srv.Handler)
srv.PORT = httpd.server_address[1]          # local_hosts() checks Host against it
threading.Thread(target=httpd.serve_forever, daemon=True).start()
url = "http://127.0.0.1:%d/api/net" % srv.PORT
t0 = time.time()
with urllib.request.urlopen(url, timeout=5) as r:
    raw = r.read().decode()
    code = r.status
took = time.time() - t0
body = json.loads(raw)
check("/api/net answered while the probe hangs", code == 200 and took < 1.0, (code, took))
check("...with the last cached answer", body["state"] == "connected" and body["via"] == "wifi", body)
old_stale = srv.NET_STALE
srv.NET_STALE = 0.3
time.sleep(0.5)
with urllib.request.urlopen(url, timeout=5) as r:
    body = json.loads(r.read().decode())
check("a probe hung past NET_STALE: no longer claims connected",
      body["state"] == "server-unreachable", body)
check("the probe is still running (it really was hung)", worker.is_alive())
RELEASE.set()
worker.join(5)
srv.NET_STALE = old_stale
with urllib.request.urlopen(url, timeout=5) as r:
    body = json.loads(r.read().decode())
check("when the hung probe finally fails, that is the answer",
      body["state"] == "server-unreachable" and not worker.is_alive(), body)

# Before any probe ever finished and one is hung: not "Checking..." forever.
reset_net(state="checking")
with srv.NET_LOCK:
    srv.NET["probingSince"] = time.time() - 60
check("first probe hung past NET_STALE: not connected, not checking",
      get("/api/net")[1]["state"] == "no-network", get("/api/net")[1])
reset_net()

print("no secrets, no token needed")
srv.STATE["conf"]["AUDIT_OPERATOR_SIGNIN"] = "1"
srv.STATE["operator_token"] = "op-token-secret-456"
PROBE.update(link=(True, "wifi", "ALS Warehouse"), api="ok")
srv.net_refresh_once()
with urllib.request.urlopen(url, timeout=5) as r:
    raw = r.read().decode()
    code = r.status
body = json.loads(raw)
check("sign-in on, nobody signed in: /api/net still answers", code == 200 and
      body["state"] == "connected", (code, body))
check("exactly the contract's keys", sorted(body) == ["checkedAt", "since", "ssid", "state", "via"],
      sorted(body))
check("the SSID is reported", body["ssid"] == "ALS Warehouse", body)
for secret in (WIFI_PASSWORD, TOKEN, "op-token-secret-456", "station-pass-secret"):
    check("no secret in the answer (%s...)" % secret[:6], secret not in raw, raw)
check("no 'password' or 'token' field anywhere", "password" not in raw.lower()
      and "token" not in raw.lower(), raw)
httpd.shutdown()

print("the real server_reachable against a fake API")
srv.nm_link = fake_link
srv.server_reachable = REAL_REACH
API = {"code": 200}


class FakeApi(BaseHTTPRequestHandler):
    def log_message(self, *_a):
        pass

    def do_GET(self):  # noqa: N802
        raw = b'{"ok":true}'
        self.send_response(API["code"])
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


api_srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeApi)
threading.Thread(target=api_srv.serve_forever, daemon=True).start()
srv.STATE["conf"]["AUDIT_URL"] = "http://127.0.0.1:%d" % api_srv.server_address[1]
PROBE.update(link=(True, "ethernet", None))
reset_net()
srv.net_refresh_once()
check("API root answers 200 -> connected", srv.net_status()["state"] == "connected",
      srv.net_status())
API["code"] = 401
srv.net_refresh_once()
check("API answers 401 (an answer, no token needed) -> connected",
      srv.net_status()["state"] == "connected", srv.net_status())
# The API crashed or is redeploying: Railway's edge still completes TLS and
# answers 502/503 (or 404 "Application not found" for a removed service), and
# a proxy's error page looks the same. None of that is the ALS server, so the
# chip must not stay green through the outage it exists to show.
for code in (500, 502, 503, 504, 404):
    API["code"] = code
    srv.net_refresh_once()
    check("API root answers %d (edge/proxy error, not the app) -> server-unreachable" % code,
          srv.net_status()["state"] == "server-unreachable", srv.net_status())
API["code"] = 200
srv.net_refresh_once()
check("API back to 200 -> connected again", srv.net_status()["state"] == "connected",
      srv.net_status())
api_srv.shutdown()
api_srv.server_close()
s = socket.socket()
s.bind(("127.0.0.1", 0))
dead = s.getsockname()[1]
s.close()                                   # nothing listens there now
srv.STATE["conf"]["AUDIT_URL"] = "http://127.0.0.1:%d" % dead
srv.net_refresh_once()
check("nothing listening -> server-unreachable", srv.net_status()["state"] == "server-unreachable",
      srv.net_status())
srv.STATE["conf"]["AUDIT_URL"] = ""
srv.net_refresh_once()
check("no AUDIT_URL -> not connected", srv.net_status()["state"] == "server-unreachable",
      srv.net_status())
PROBE.update(link=(False, None, None))
srv.net_refresh_once()
check("no AUDIT_URL, no link -> no-network", srv.net_status()["state"] == "no-network",
      srv.net_status())

print("the worker re-probes on a kick")
srv.server_reachable = fake_reach
PROBE.update(link=(True, "wifi", "ALS Warehouse"), api="ok")
COUNT = {"n": 0}
real_once = srv.net_refresh_once


def counting_once():
    COUNT["n"] += 1
    return real_once()


srv.net_refresh_once = counting_once
srv.NET_EVERY = 3600                        # only a kick can wake it
threading.Thread(target=srv.net_worker, daemon=True).start()
deadline = time.time() + 3
while COUNT["n"] < 1 and time.time() < deadline:
    time.sleep(0.02)
srv.NET_KICK.set()
deadline = time.time() + 3
while COUNT["n"] < 2 and time.time() < deadline:
    time.sleep(0.02)
check("probes at start, and again at once when kicked", COUNT["n"] >= 2, COUNT)
check("main() starts the worker", "target=net_worker" in open(
    os.path.join(HERE, "gui", "server.py"), encoding="utf-8").read())

print("")
print("%d passed, %d failed" % (PASS[0], len(FAIL)))
sys.exit(1 if FAIL else 0)
