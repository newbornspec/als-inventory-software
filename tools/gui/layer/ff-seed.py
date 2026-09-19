#!/usr/bin/env python3
"""Make the kiosk's Firefox profile TEMPLATE during the layer build.

Run by tools/make-als-layer.sh (als_make_ff_seed), as root, inside a private
mount namespace where the stage's firefox-esr is bind-mounted read-only at
/usr/lib/firefox-esr - the SAME path it has on the station, which is what keeps
the startup cache valid there (compatibility.ini records the path; a different
one makes Firefox throw the cache away).

    ff-seed.py --firefox /usr/lib/firefox-esr/firefox --home <work>/home \
               --userjs <work>/user.js --out <work>/seed

WHY. On the station every boot is a brand-new profile ($HOME is RAM), so
Firefox does its first-run work - building the startup cache, the add-on
database, running every prefs migration - on every boot, before its first
request. Measured off the station with the same ESR (cold cache, lz4 layer):
1.76 s from launch to first request with a fresh profile, 0.94 s from a copy of
this template (+0.04 s for the copy). The copy stayed valid at a different
profile path: Firefox renamed the seeded startup cache to *-current.bin with
identical hashes, set no crash or safe-mode counters.

WHAT IT DOES. One headless run with the kiosk's own user.js, onto a page served
by this script on a free local port; it waits for the first request, lets
Firefox settle, then quits it CLEANLY through Marionette - a SIGTERM'd Firefox
does not finish its shutdown (sessionCheckpoints stops early) and would leave a
half-written profile. Only the files that save first-run WORK are kept:

    startupCache/  compatibility.ini  prefs.js  extensions.json
    addonStartup.json.lz4  xulstore.json  times.json

and prefs.js is cleaned: nothing Marionette set, nothing the kiosk's user.js
sets (that is rewritten on top at every launch anyway), and no per-install
identifiers (telemetry client/profile ids, Normandy user id, ...) - every
station would otherwise share one.

ONE shared value is kept on purpose: extensions.webextensions.uuids, the
internal moz-extension:// origins of Firefox's BUILT-IN add-ons (formautofill,
webcompat, pictureinpicture, ...). The startup caches this template exists to
ship were built with those UUIDs in them (webext.sc.lz4, scriptCache.bin), so
dropping the pref would hand Firefox caches that name origins it no longer
has. They identify no user or install to anyone: nothing reports them, and the
kiosk shows only its own page on 127.0.0.1, never a site that could probe
them. The name filter below cannot catch it (the value is a JSON map, not a
bare UUID), and the test pins that it is kept.

Exit 0 with the template in --out, anything else = no template. The build
treats every failure as "ship no template": the kiosk then starts from an
empty profile exactly as before, so nothing here can cost a boot.

Standard library only.
"""
import argparse
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

KEEP = ("startupCache", "compatibility.ini", "prefs.js", "extensions.json",
        "addonStartup.json.lz4", "xulstore.json", "times.json")

# Per-install identifiers. Matched on the pref NAME, case-insensitively; the
# same expression is checked again by make-als-layer.sh and inspect.sh.
ID_NAME = re.compile(r'(user_?id|client_?id|profile_?(group_?)?id|uuid|impression_?id|context_?id|agent_?id|store_?id)"', re.I)
# ... and any pref whose whole value is a bare UUID or 32 hex digits (the shape
# of dom.push.userAgentID), whatever it is called.
UUID_VALUE = re.compile(r',\s*"(\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?|[0-9a-f]{32})"\s*\);\s*$', re.I)
PREF_NAME = re.compile(r'^\s*user_pref\("([^"]+)"')

SEED_PREFS = (
    # Marionette otherwise writes ~60 TESTING prefs into prefs.js
    # (focusmanager.testmode, a dummy services.settings.server, ...).
    'user_pref("remote.prefs.recommended", false);\n'
    # 0 = any free port; Firefox writes the one it got to MarionetteActivePort.
    'user_pref("marionette.port", 0);\n'
)

FIRST = threading.Event()


class Page(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        FIRST.set()
        body = b"<!doctype html><title>ALS</title><p>seed</p>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def say(msg):
    print("  seed: " + msg, flush=True)


def marionette_quit(port, timeout=30):
    """New session, then Marionette:Quit - Firefox's own clean shutdown."""
    def rd(s):
        n = b""
        while not n.endswith(b":"):
            c = s.recv(1)
            if not c:
                raise OSError("marionette closed the connection")
            n += c
        ln = int(n[:-1])
        b = b""
        while len(b) < ln:
            c = s.recv(ln - len(b))
            if not c:
                raise OSError("marionette closed the connection")
            b += c
        return json.loads(b)

    def wr(s, obj):
        b = json.dumps(obj).encode()
        s.sendall(str(len(b)).encode() + b":" + b)

    s = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    try:
        rd(s)  # hello
        wr(s, [0, 1, "WebDriver:NewSession", {}])
        rd(s)
        wr(s, [0, 2, "Marionette:Quit", {}])
        try:
            rd(s)
        except (OSError, ValueError):
            pass  # Firefox may close the socket as it quits
    finally:
        s.close()


def clean_prefs(path, userjs_names):
    out = []
    for line in open(path, encoding="utf-8", errors="replace"):
        m = PREF_NAME.match(line)
        if m:
            name = m.group(1)
            if (name in userjs_names or name.startswith(("marionette.", "remote."))
                    or ID_NAME.search('"' + name + '"') or UUID_VALUE.search(line)):
                continue
        out.append(line)
    with open(path, "w", encoding="utf-8") as fh:
        fh.writelines(out)


def kill_group(p):
    try:
        os.killpg(p.pid, signal.SIGKILL)
    except OSError:
        pass
    try:
        p.wait(10)
    except subprocess.TimeoutExpired:
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--firefox", required=True)
    ap.add_argument("--home", required=True)
    ap.add_argument("--userjs", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--settle", type=float, default=15)
    ap.add_argument("--timeout", type=float, default=90)
    a = ap.parse_args()

    # The build's `timeout` sends SIGTERM; turn it into a normal exit so the
    # finally below still kills Firefox's whole process group.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(3))

    userjs = open(a.userjs, encoding="utf-8").read()
    userjs_names = {m.group(1) for m in map(PREF_NAME.match, userjs.splitlines()) if m}
    if not userjs_names:
        say("the kiosk user.js has no prefs in it - refusing")
        return 1

    shutil.rmtree(a.home, ignore_errors=True)
    prof = os.path.join(a.home, "als-kiosk-profile-esr")
    os.makedirs(prof)
    with open(os.path.join(prof, "user.js"), "w", encoding="utf-8") as fh:
        fh.write(userjs + ("" if userjs.endswith("\n") else "\n") + SEED_PREFS)

    srv = ThreadingHTTPServer(("127.0.0.1", 0), Page)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:%d/" % srv.server_address[1]

    # A clean environment: no DISPLAY/XAUTHORITY from whoever ran sudo (Firefox
    # refuses to run as root against another user's X authority), no proxy.
    env = {"HOME": a.home, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
           "XDG_CACHE_HOME": a.home + "/.cache", "XDG_CONFIG_HOME": a.home + "/.config",
           "XDG_RUNTIME_DIR": a.home + "/.run", "LANG": "C.UTF-8",
           "MOZ_CRASHREPORTER_DISABLE": "1"}
    os.makedirs(env["XDG_RUNTIME_DIR"], mode=0o700, exist_ok=True)
    cmd = [a.firefox, "--headless", "--marionette", "--no-remote",
           "--profile", prof, "--kiosk", url]
    log = open(os.path.join(a.home, "firefox.log"), "w")
    t0 = time.monotonic()
    p = subprocess.Popen(cmd, env=env, stdout=log, stderr=subprocess.STDOUT,
                         stdin=subprocess.DEVNULL, start_new_session=True)
    try:
        if not FIRST.wait(a.timeout):
            say("Firefox made no request within %.0f s" % a.timeout)
            return 1
        say("first request after %.1f s; settling %.0f s" % (time.monotonic() - t0, a.settle))
        time.sleep(a.settle)
        port = None
        apf = os.path.join(prof, "MarionetteActivePort")
        for _ in range(100):
            try:
                port = int(open(apf).read().strip())
                break
            except (OSError, ValueError):
                time.sleep(0.1)
        if port is None:
            say("Firefox did not report its Marionette port - no clean quit possible")
            return 1
        try:
            marionette_quit(port)
        except (OSError, ValueError) as e:
            say("Marionette quit failed: %s" % e)
            return 1
        try:
            rc = p.wait(60)
        except subprocess.TimeoutExpired:
            say("Firefox did not exit within 60 s of the quit")
            return 1
        say("Firefox exited (rc %s)" % rc)
    finally:
        if p.poll() is None:
            kill_group(p)
        srv.shutdown()
        log.close()

    ck = os.path.join(prof, "sessionCheckpoints.json")
    try:
        cp = json.load(open(ck))
    except (OSError, ValueError):
        cp = {}
    if not (cp.get("profile-before-change") or cp.get("profile-before-change-telemetry")):
        say("shutdown was NOT clean (sessionCheckpoints: %s) - no template" % sorted(cp))
        return 1

    shutil.rmtree(a.out, ignore_errors=True)
    os.makedirs(a.out)
    for f in KEEP:
        src = os.path.join(prof, f)
        if os.path.isdir(src) and not os.path.islink(src):
            shutil.copytree(src, os.path.join(a.out, f), symlinks=False)
        elif os.path.isfile(src) and not os.path.islink(src):
            shutil.copy2(src, os.path.join(a.out, f))
    for f in ("compatibility.ini", "prefs.js"):
        if not os.path.isfile(os.path.join(a.out, f)):
            say("the profile has no %s - no template" % f)
            return 1
    sc = os.path.join(a.out, "startupCache")
    if not os.path.isdir(sc) or not os.listdir(sc):
        say("the profile has no startup cache - no template")
        return 1
    clean_prefs(os.path.join(a.out, "prefs.js"), userjs_names)
    total = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(a.out) for f in fs)
    say("template ready: %s (%.1f MB)" % (", ".join(sorted(os.listdir(a.out))), total / 1e6))
    return 0


if __name__ == "__main__":
    sys.exit(main())
