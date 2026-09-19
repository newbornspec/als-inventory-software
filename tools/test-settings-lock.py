#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""The kiosk's Settings screen must not be a way to steal the station's login,
swap the OS image source, or weaken the wipe - and must still let an operator
fix Wi-Fi and switch the machine off.

Before this, a stick with no AUDIT_ADMIN_PIN let anyone at the screen change
every setting. Point AUDIT_URL at your own server and the next login sends you
the password stored on the stick. Point IMAGE_SERVER at your own share and every
machine refurbished afterwards gets your Windows image.

Drives the real Handler.do_POST. Stubs only the edges: the conf file write, the
image-server remount, and the power command (nothing is ever switched off).

    python3 tools/test-settings-lock.py
"""
import importlib.util
import io
import json
import os
import sys

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


PROD = "https://als-inventory-software-production.up.railway.app"
SAVED = []
POWER = []


def fake_save_conf(updates):
    SAVED.append(dict(updates))
    return None


class FakeThread:
    def __init__(self, target=None, args=(), daemon=None):
        self.target = target

    def start(self):
        pass                     # never actually remount, never power off


srv.save_conf = fake_save_conf
srv.threading.Thread = FakeThread
srv.subprocess.run = lambda cmd, *a, **k: POWER.append(cmd)


class Fake(srv.Handler):
    def __init__(self, path, body):
        raw = json.dumps(body).encode()
        self.path = path
        self.headers = {"Content-Length": str(len(raw))}
        self.rfile = io.BytesIO(raw)
        self.sent = None

    def _send(self, code, payload, ctype="application/json"):
        self.sent = (code, payload)


def conf(pin=None, url=PROD, image="", method=None):
    c = {"AUDIT_URL": url, "WIFI_SSID": "Warehouse", "IMAGE_SERVER": image, "AUDIT_WIPE": "0"}
    if pin is not None:
        c["AUDIT_ADMIN_PIN"] = pin
    if method is not None:
        c["AUDIT_WIPE_METHOD"] = method
    srv.STATE["conf"] = c
    srv.BOOT_API_HOST["host"] = srv.urlparse(url).hostname


def form(**over):
    """Exactly what index.html sends: every field, every save."""
    c = srv.STATE["conf"]
    body = {"wifiSsid": c.get("WIFI_SSID", ""), "serverUrl": c.get("AUDIT_URL", ""),
            "wipeMethod": c.get("AUDIT_WIPE_METHOD") or "auto",
            "imageServer": c.get("IMAGE_SERVER", "")}
    body.update(over)
    return body


def post(path, body):
    SAVED.clear()
    h = Fake(path, body)
    h.do_POST()
    return h.sent


print("no PIN on the stick - what an operator can still do")
conf()
r = post("/api/settings", form(wifiSsid="Site B", wifiPassword="x"))
check("change Wi-Fi: allowed", r[0] == 200 and SAVED and SAVED[0].get("WIFI_SSID") == "Site B", r)
r = post("/api/settings", form())
check("re-save with nothing changed: allowed", r[0] == 200, r)
conf(method=None)            # no AUDIT_WIPE_METHOD stored; the form shows "auto"
r = post("/api/settings", form())
check("unset wipe method shown as 'auto' is not a change", r[0] == 200, r)
conf(url=PROD + "/")
r = post("/api/settings", form(serverUrl=PROD))
check("trailing slash is not a change", r[0] == 200, r)

print("no PIN on the stick - the attacks")
conf()
r = post("/api/settings", form(serverUrl="https://collect-passwords.example"))
check("server address: refused", r[0] == 403 and not SAVED, r)
check("server address: says a PIN is needed", "needs an admin PIN" in (r[1] or {}).get("message", ""), r)
r = post("/api/settings", form(imageServer="10.0.0.66:/evil-images"))
check("image server: refused", r[0] == 403 and not SAVED, r)
r = post("/api/settings", form(wipeMethod="overwrite"))
check("wipe method: refused", r[0] == 403 and not SAVED, r)
r = post("/api/settings", form(wifiSsid="Site B", serverUrl="https://collect-passwords.example"))
check("Wi-Fi smuggled with a server change: whole save refused", r[0] == 403 and not SAVED, r)

print("PIN set")
conf(pin="4417")
r = post("/api/settings", form(wifiSsid="Site B"))
check("no PIN typed: refused even for Wi-Fi", r[0] == 403 and not SAVED, r)
r = post("/api/settings", form(wifiSsid="Site B", pin="0000"))
check("wrong PIN: refused", r[0] == 403 and not SAVED, r)
r = post("/api/settings", form(wifiSsid="Site B", pin="4417"))
check("right PIN: Wi-Fi saved", r[0] == 200 and SAVED[0].get("WIFI_SSID") == "Site B", r)
r = post("/api/settings", form(imageServer="192.168.1.50:/srv/als-images", pin="4417"))
check("right PIN: image server saved", r[0] == 200 and SAVED[0].get("IMAGE_SERVER") == "192.168.1.50:/srv/als-images", r)

print("even WITH the right PIN, the server address is allow-listed")
r = post("/api/settings", form(serverUrl="https://collect-passwords.example", pin="4417"))
check("arbitrary https host: refused", r[0] == 400 and not SAVED, r)
r = post("/api/settings", form(serverUrl="http://als-inventory-software-production.up.railway.app", pin="4417"))
check("plain http to the right host: refused", r[0] == 400 and not SAVED, r)
r = post("/api/settings", form(serverUrl="https://als-inventory-software-production.up.railway.app.evil.example", pin="4417"))
check("look-alike host: refused", r[0] == 400 and not SAVED, r)
conf(pin="4417", url="https://staging-als.example")
r = post("/api/settings", form(serverUrl=PROD, pin="4417"))
check("back to production from a hand-set server: allowed", r[0] == 200 and SAVED[0].get("AUDIT_URL") == PROD, r)
srv.STATE["conf"]["AUDIT_URL"] = PROD           # as save_conf would reload it
r = post("/api/settings", form(serverUrl="https://staging-als.example", pin="4417"))
check("the server audit.conf STARTED with stays allowed", r[0] == 200, r)

print("the text-mode wipe switch is retired (owner decision D9)")
# AUDIT_WIPE turned on the text-mode wipe, which no longer wipes anything. The
# kiosk must neither offer the switch nor write it - with or without a PIN, and
# even when a stale page still sends the old field.
conf()
h = Fake("/api/settings", {})
h.do_GET()
check("GET /api/settings: no wipeEnabled offered", h.sent[0] == 200 and "wipeEnabled" not in h.sent[1], h.sent)
check("GET /api/settings: the kiosk's default wipe method is still offered",
      h.sent[1].get("wipeMethod") == "auto", h.sent)
r = post("/api/settings", form(wipeEnabled=True))
check("no PIN, stale page sends wipeEnabled: AUDIT_WIPE not written",
      r[0] == 200 and SAVED and "AUDIT_WIPE" not in SAVED[0], (r, SAVED))
conf(pin="4417")
r = post("/api/settings", form(wipeEnabled=True, pin="4417"))
check("right PIN, wipeEnabled sent: AUDIT_WIPE still not written",
      r[0] == 200 and SAVED and "AUDIT_WIPE" not in SAVED[0], (r, SAVED))

print("the power button is not locked out")
conf()
POWER.clear()
r = post("/api/power", {"action": "shutdown"})
check("no PIN on stick: shutdown still works", r[0] == 200, r)
conf(pin="4417")
r = post("/api/power", {"action": "shutdown", "pin": "0000"})
check("PIN set, wrong PIN: shutdown refused", r[0] == 403, r)

print("")
print("%d passed, %d failed" % (PASS[0], len(FAIL)))
sys.exit(1 if FAIL else 0)
