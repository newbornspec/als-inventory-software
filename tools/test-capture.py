#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""The kiosk must read the hardware profile from the one line the engine marks,
and must forget it when a capture fails.

Two failures this pins down:

  * capture() used to take the last line ANYWHERE in the engine's stdout that
    began with { and ended with }. One stray one-line object after the profile
    (a tool's JSON status, a debug echo) silently became the profile: no
    identification, serial None, and every wipe after it was filed under a
    machine with no identity.
  * A failed re-capture left the PREVIOUS profile in place, so a wipe started
    afterwards was filed under whichever machine was on the bench last. And the
    "no profile" check ran only after the erase, so a wipe with no profile
    destroyed the data and then recorded nothing at all.

Drives the real parse_profile / capture / refresh / Handler.do_POST. Stubs only
the edges: the engine process, list_drives() and start_job(), so nothing is
ever run against a disk.

    python3 tools/test-capture.py
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


HEADER = "--- captured JSON (debug; not uploaded) ---"
PROFILE = {"identification": {"manufacturer": "Dell", "model": "Latitude 7490",
                              "serialNumber": "REAL-SERIAL-123"},
           "storage": [{"model": "internal", "serialNumber": "DRIVE-1"}]}


def engine_out(*tail, profile_line=None):
    """What hardware-audit.sh prints under AUDIT_DEBUG=1: a human summary, the
    marker, the one-line profile, then whatever else ends up on stdout."""
    return "\n".join(["  Model          Dell Latitude 7490",
                      "  Storage        256GB SSD",
                      HEADER,
                      profile_line if profile_line is not None else json.dumps(PROFILE)]
                     + list(tail)) + "\n"


def raises(fn, *a):
    try:
        fn(*a)
    except RuntimeError as exc:
        return str(exc)
    return None


print("reading the profile")

# 1. THE CASE. A stray one-line object AFTER the profile. The old scan kept the
#    last {...} line, so this came back with serial None.
prof, summ = srv.parse_profile(engine_out('{"status":"ok"}'))
check("stray {...} after the profile: the real serial is read",
      prof["identification"]["serialNumber"] == "REAL-SERIAL-123", prof)
check("stray {...} after the profile: kept in the summary, not taken as data",
      '{"status":"ok"}' in summ and "REAL-SERIAL-123" not in summ, summ)
check("the human summary is kept", "Dell Latitude 7490" in summ, summ)

# 2. A stray object BEFORE the marker is ignored as well.
prof, _ = srv.parse_profile('{"x":1}\n' + engine_out())
check("stray {...} before the marker: ignored",
      prof["identification"]["serialNumber"] == "REAL-SERIAL-123", prof)

# 3. The prefixed form the engine may add later wins over everything else.
alt = dict(PROFILE, identification=dict(PROFILE["identification"], serialNumber="PREFIXED"))
prof, summ = srv.parse_profile("noise\nAUDIT_PROFILE " + json.dumps(alt) + "\n" + engine_out())
check("AUDIT_PROFILE line: read", prof["identification"]["serialNumber"] == "PREFIXED", prof)
check("AUDIT_PROFILE line: not echoed into the summary", "PREFIXED" not in summ, summ)

# 4. A blank line between the marker and the profile is tolerated.
prof, _ = srv.parse_profile(engine_out(profile_line="\n" + json.dumps(PROFILE)))
check("blank line after the marker: tolerated",
      prof["identification"]["serialNumber"] == "REAL-SERIAL-123", prof)

# 5. Pretty-printed output: a clear error, not a guess.
pretty = json.dumps(PROFILE, indent=2)
why = raises(srv.parse_profile, engine_out(profile_line=pretty))
check("pretty-printed profile: refused", why is not None, why)
check("pretty-printed profile: says why", why and "not a complete JSON object" in why, why)

# 6. No marker at all (engine died early): a clear error.
why = raises(srv.parse_profile, '{"identification":{"serialNumber":"X"}}\nsomething\n')
check("no marker: refused even though a {...} line exists", why is not None, why)
check("no marker: says the marker is missing", why and "no profile marker" in why, why)

# 7. A marker followed by something that is JSON but not a profile.
why = raises(srv.parse_profile, engine_out(profile_line='{"status":"ok"}'))
check("JSON without identification: refused", why and "identification" in why, why)
why = raises(srv.parse_profile, engine_out(profile_line='[1,2,3]'))
check("JSON array: refused", why is not None, why)
why = raises(srv.parse_profile, engine_out(profile_line='{"identification":"x"}'))
check("identification not an object: refused", why is not None, why)


print("capture() uses the same reader")


class R:
    def __init__(self, out):
        self.stdout, self.stderr, self.returncode = out, "", 0


real_run = srv.subprocess.run
srv.SCRIPT = "/fake/hardware-audit.sh"
srv.audit_cmd = lambda *a, **k: ["true"]
srv.subprocess.run = lambda *a, **k: R(engine_out('{"status":"ok"}'))
try:
    prof, _ = srv.capture()
    check("capture(): real serial despite a stray line",
          prof["identification"]["serialNumber"] == "REAL-SERIAL-123", prof)
finally:
    srv.subprocess.run = real_run


print("a failed re-capture forgets the old machine")

OFFERED = [{"device": "/dev/sda", "model": "internal", "serial": "DRIVE-1"}]
STARTED = []
ON_DONE = []


def fake_start_job(kind, argv, marker, device="", on_done=None, **kw):
    STARTED.append(device)
    ON_DONE.append(on_done)
    return True


srv.list_drives = lambda *a, **k: OFFERED
srv.start_job = fake_start_job
srv.load_conf = lambda: {}


class Fake(srv.Handler):
    def __init__(self, path, body):
        raw = json.dumps(body).encode()
        self.path = path
        self.headers = {"Content-Length": str(len(raw))}
        self.rfile = io.BytesIO(raw)
        self.sent = None

    def _send(self, code, payload, ctype="application/json"):
        self.sent = (code, payload)


def wipe(devs=("/dev/sda",)):
    STARTED.clear()
    ON_DONE.clear()
    h = Fake("/api/wipe/start", {"devices": list(devs)})
    h.do_POST()
    return h.sent, list(STARTED)


def capture_ok():
    return json.loads(json.dumps(PROFILE)), "summary"


def capture_fails():
    raise RuntimeError("Could not read the hardware profile from the engine: boom")


srv.capture = capture_ok
srv.refresh(do_login=False)
check("good capture: profile held", srv.STATE["profile"] and
      srv.STATE["profile"]["identification"]["serialNumber"] == "REAL-SERIAL-123", srv.STATE["profile"])
sent, started = wipe()
check("good capture: the wipe starts", sent[0] == 200 and started == ["/dev/sda"], (sent, started))

# THE CASE. Re-capture fails; the old profile must not survive it.
srv.capture = capture_fails
srv.refresh(do_login=False)
check("failed re-capture: the old profile is forgotten", srv.STATE["profile"] is None, srv.STATE["profile"])
check("failed re-capture: the error is shown", "boom" in (srv.STATE["error"] or ""), srv.STATE["error"])
sent, started = wipe()
check("failed re-capture: /api/wipe/start refuses", sent[0] == 409, sent)
check("failed re-capture: nothing is erased", started == [], started)
check("failed re-capture: tells the operator to Rescan", "Rescan" in sent[1].get("message", ""), sent)

# Never captured at all (the old code erased first and complained after).
srv.STATE["profile"] = None
sent, started = wipe()
check("no profile ever: refused BEFORE any erase", sent[0] == 409 and started == [], (sent, started))

# A capture in progress: the profile on screen is about to be replaced.
srv.STATE["profile"] = json.loads(json.dumps(PROFILE))
srv.STATE["capturing"] = True
sent, started = wipe()
check("capture in progress: refused", sent[0] == 409 and started == [], (sent, started))
srv.STATE["capturing"] = False

# The wipe is filed under the profile it was STARTED with, even if a Rescan
# fails (or changes things) while it runs.
UPLOADS = []
srv.upload_audit = lambda p: (UPLOADS.append(p) or ({"assetId": "a1"}, False, ""))
srv.stamp_provenance = lambda p: p
sent, started = wipe()
srv.STATE["profile"] = None           # a Rescan failed mid-wipe
ON_DONE[0]({"status": "wiped", "method": "m", "device": "/dev/sda"})
check("rescan mid-wipe: the record keeps the profile it started with",
      UPLOADS and UPLOADS[-1]["profile"]["identification"]["serialNumber"] == "REAL-SERIAL-123",
      UPLOADS)

print("")
print("%d passed, %d failed" % (PASS[0], len(FAIL)))
sys.exit(1 if FAIL else 0)
