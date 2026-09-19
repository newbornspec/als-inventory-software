#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""The "already audited" banner reports the MACHINE's wipe state, not the
newest row's.

prior_audit() (tools/gui/server.py) used to report the dataWipeStatus of the
newest audit row. A row is one DRIVE's event: a laptop whose NVMe failed at
10:00 and whose SATA disk wiped at 10:01 showed "wipe: wiped" on the kiosk
while the asset, the certificate and the API's per-drive roll-up (contract
C4, GET /assets/:id/certificate-eligibility) all said failed. It now asks C4,
and falls back to the newest row only when C4 is not there (an older API
answers 404) - labelled as a record, not as the machine's state.

Runs the real prior_audit through the real /api/priorAudit handler; only
api() (the network) is stubbed.

    python3 tools/test-prior-audit.py
"""
import importlib.util
import io
import json
import os
import sys
import urllib.error

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


class Fake(srv.Handler):
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


srv.CONF_PATH = None
srv.STATE["conf"] = {"AUDIT_URL": "https://api.example"}
srv.STATE["profile"] = {"identification": {"serialNumber": "HOST-1"}}
srv.ensure_token = lambda: "tok"

# Newest first, as GET /assets/:id/audits returns them: drive B wiped at
# 10:01, drive A failed at 10:00.
AUDITS = [{"createdAt": "2026-09-19T10:01:30Z", "dataWipeStatus": "wiped"},
          {"createdAt": "2026-09-19T10:00:30Z", "dataWipeStatus": "failed"}]
C4 = {"mode": "failed"}
CALLS = []


def fake_api(path, method="GET", body=None, token=None, timeout=25):
    CALLS.append(path)
    if path.startswith("/assets?"):
        return [{"id": "asset-9", "serialNumber": "HOST-1", "tag": "ALS-9", "name": "Latitude"}]
    if path == "/assets/asset-9/audits":
        return AUDITS
    if path == "/assets/asset-9/certificate-eligibility":
        m = C4["mode"]
        if m == "404":
            raise urllib.error.HTTPError("https://api.example" + path, 404, "Not Found", {}, None)
        if m == "offline":
            raise OSError("network is unreachable")
        return {"available": m == "wiped", "reason": None if m == "wiped" else "a drive failed",
                "verdict": m, "drives": []}
    raise AssertionError("unexpected call " + path)


srv.api = fake_api


def prior(lot):
    srv.PRIOR_CACHE.update(key=None, ts=0.0, data=None)
    CALLS.clear()
    code, ans = get("/api/priorAudit?lotId=" + lot)
    return ans


print("C4 answers: the banner carries the per-drive roll-up")
C4["mode"] = "failed"
p = prior("lot-1")
check("asks C4 about the asset it found", "/assets/asset-9/certificate-eligibility" in CALLS, CALLS)
check("newest row wiped, other drive failed: reported FAILED, not wiped",
      p.get("lastWipeStatus") == "failed" and p.get("wipeVerdict") == "failed", p)
check("...and says where that came from", p.get("wipeSource") == "rollup", p)
C4["mode"] = "incomplete"
p = prior("lot-2")
check("a drive with no wipe yet: incomplete", p.get("wipeVerdict") == "incomplete"
      and p.get("lastWipeStatus") == "incomplete", p)
C4["mode"] = "wiped"
p = prior("lot-3")
check("every drive wiped: wiped", p.get("wipeVerdict") == "wiped", p)
C4["mode"] = "none"
AUDITS[:] = [{"createdAt": "2026-09-19T09:00:00Z", "dataWipeStatus": "not_wiped"}]
p = prior("lot-4")
check("no wipe on record: verdict none, the row's own status kept",
      p.get("wipeVerdict") == "none" and p.get("lastWipeStatus") == "not_wiped", p)
AUDITS[:] = [{"createdAt": "2026-09-19T10:01:30Z", "dataWipeStatus": "wiped"},
             {"createdAt": "2026-09-19T10:00:30Z", "dataWipeStatus": "failed"}]

print("an API older than C4, or no answer: today's behaviour, labelled")
for mode in ("404", "offline"):
    C4["mode"] = mode
    p = prior("lot-5-" + mode)
    check("%s: still found, with the newest row's status" % mode,
          p.get("found") is True and p.get("lastWipeStatus") == "wiped", p)
    check("%s: no verdict claimed, source is the last record" % mode,
          "wipeVerdict" not in p and p.get("wipeSource") == "last-record", p)
    check("%s: the rest of the banner is unchanged" % mode,
          p.get("tag") == "ALS-9" and p.get("auditCount") == 2, p)

print("")
print("%d passed, %d failed" % (PASS[0], len(FAIL)))
sys.exit(1 if FAIL else 0)
