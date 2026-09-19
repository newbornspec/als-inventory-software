#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""The kiosk's local service answers only the station's own page.

server.py listens on 127.0.0.1:8800, which keeps other machines out but not
other web pages: any page the station's browser loads can send requests
there. It never looked at Host or Origin and parsed every POST body as JSON
whatever its Content-Type, so:
  - a hostile page could POST text/plain {"devices":["/dev/nvme0n1"]} to
    /api/wipe/start - a "simple" request, no CORS preflight - and a wipe
    started with no confirmation, filed under the signed-in operator; or
    rewrite settings via /api/settings;
  - a DNS-rebinding page (its hostname re-pointed at 127.0.0.1) could READ
    /api/wipe/eligibility (drive serials via the operator's token) and
    /api/bootstrap.

This runs the REAL Handler on a real ThreadingHTTPServer on a free local
port and sends raw requests with the headers a browser would send. The
actions behind the endpoints are stubbed (nothing is wiped, saved or
re-scanned): the test only records whether they were reached.

    python3 tools/test-kiosk-origin.py
"""
import http.client
import importlib.util
import json
import os
import sys
import threading
import time
from http.server import ThreadingHTTPServer

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


# ---- the actions behind the endpoints, stubbed to only record -----------
REACHED = []
srv.CONF_PATH = None
srv.refresh = lambda *a, **k: REACHED.append("rescan")
srv.save_conf = lambda updates: REACHED.append("settings") or None
srv.start_job = lambda *a, **k: REACHED.append("wipe") or True
srv.certificate_eligibility = lambda asset: REACHED.append("eligibility") or {"known": False}
srv.report_now = lambda *a, **k: None        # serving "/" must not write a boot report
srv.STATE["conf"] = {"AUDIT_URL": "https://als-inventory-software-production.up.railway.app"}

httpd = ThreadingHTTPServer(("127.0.0.1", 0), srv.Handler)
PORT = httpd.server_address[1]
srv.PORT = PORT                       # what the handler checks Host/Origin against
threading.Thread(target=httpd.serve_forever, daemon=True).start()
OWN = "http://127.0.0.1:%d" % PORT


def req(method, path, headers=None, body=None, host=None):
    """One request with exactly these headers. `host` overrides Host (which
    http.client would otherwise set to 127.0.0.1:PORT, as a browser does)."""
    c = http.client.HTTPConnection("127.0.0.1", PORT, timeout=10)
    c.putrequest(method, path, skip_host=host is not None, skip_accept_encoding=True)
    if host is not None:
        c.putheader("Host", host)
    raw = body.encode() if isinstance(body, str) else (body or b"")
    for k, v in (headers or {}).items():
        c.putheader(k, v)
    if method == "POST":
        c.putheader("Content-Length", str(len(raw)))
    c.endheaders(raw if method == "POST" else None)
    r = c.getresponse()
    data = r.read()
    c.close()
    try:
        return r.status, json.loads(data or b"{}")
    except ValueError:
        return r.status, data


def settle():
    time.sleep(0.2)                   # /api/rescan runs refresh on a thread


WIPE = json.dumps({"devices": ["/dev/nvme0n1"], "method": "auto"})

try:
    print("cross-site POSTs (CSRF) are refused before they reach anything")
    for label, hdrs in (
            ("text/plain from another origin", {"Origin": "http://evil.example", "Content-Type": "text/plain"}),
            ("form post from another origin",
             {"Origin": "https://evil.example", "Content-Type": "application/x-www-form-urlencoded"}),
            ("application/json claimed from another origin",
             {"Origin": "http://evil.example", "Content-Type": "application/json"}),
            ("Origin: null (sandboxed frame, file://)", {"Origin": "null", "Content-Type": "text/plain"}),
            ("text/plain with no Origin at all", {"Content-Type": "text/plain"})):
        REACHED.clear()
        codes = [req("POST", p, hdrs, b)[0] for p, b in
                 (("/api/wipe/start", WIPE), ("/api/settings", '{"wifiSsid":"x"}'),
                  ("/api/rescan", "{}"), ("/api/operator/signout", "{}"))]
        settle()
        check("%s: every POST refused (403/415), nothing reached" % label,
              all(c in (403, 415) for c in codes) and not REACHED, (codes, REACHED))

    print("DNS rebinding: a foreign Host is refused, reads included")
    REACHED.clear()
    for path in ("/api/wipe/eligibility?assetId=a-1", "/api/bootstrap", "/"):
        code, _ = req("GET", path, host="attacker.example:%d" % PORT)
        check("GET %s with Host attacker.example: 403" % path, code == 403, code)
    code, _ = req("POST", "/api/rescan", {"Content-Type": "application/json"}, "{}",
                  host="attacker.example:%d" % PORT)
    settle()
    check("POST with Host attacker.example: 403, nothing reached", code == 403 and not REACHED,
          (code, REACHED))
    code, _ = req("GET", "/api/bootstrap", host="127.0.0.1:1")
    check("the right address with the wrong port is foreign too", code == 403, code)

    print("the station's own page still works")
    REACHED.clear()
    code, _ = req("POST", "/api/rescan", {"Origin": OWN, "Content-Type": "application/json"}, "{}")
    settle()
    check("POST from http://127.0.0.1:PORT, application/json: served", code == 200 and REACHED == ["rescan"],
          (code, REACHED))
    REACHED.clear()
    code, _ = req("POST", "/api/rescan",
                  {"Origin": "http://localhost:%d" % PORT, "Content-Type": "application/json; charset=utf-8"},
                  "{}", host="localhost:%d" % PORT)
    settle()
    check("localhost:PORT and a charset parameter: served", code == 200 and REACHED == ["rescan"],
          (code, REACHED))
    REACHED.clear()
    code, ans = req("GET", "/api/wipe/eligibility?assetId=a-1")
    check("same-origin GET (no Origin header, as browsers send it): served",
          code == 200 and REACHED == ["eligibility"], (code, ans, REACHED))
    code, _ = req("GET", "/api/priorAudit?lotId=l-1", {"Origin": OWN})
    check("GET with our own Origin: served", code == 200, code)
    code, _ = req("GET", "/", host="127.0.0.1:%d" % PORT)
    check("the page itself is served to its own address", code in (200, 500), code)
    REACHED.clear()
    code, _ = req("POST", "/api/rescan", None, "{}")
    settle()
    check("a POST with neither Origin nor Content-Type (a local tool, curl -d): served",
          code == 200 and REACHED == ["rescan"], (code, REACHED))

    print("the page's own requests match what the guard allows")
    with open(os.path.join(HERE, "gui", "index.html"), encoding="utf-8") as fh:
        page = fh.read()
    check("index.html's jpost sends Content-Type application/json",
          "headers:{'Content-Type':'application/json'}" in page, "")
finally:
    httpd.shutdown()

print("")
print("%d passed, %d failed" % (PASS[0], len(FAIL)))
sys.exit(1 if FAIL else 0)
