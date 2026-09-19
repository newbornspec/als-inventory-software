#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Each drive's wipe result stays available until the operator is done with it,
and the certificate question goes to the server (contract C4), not to a guess.

The screen used to show each drive's outcome as a 4.2 s toast that the next
drive's toast overwrote, so two drives finishing a second apart left the first
result visible for under a second. The screen side of the fix (a result block
per drive, a Done button) is in index.html and is checked by
test-kiosk-ui.py; this checks the server side it depends on: that with two
REAL jobs - one failing, one wiping, finishing within a second of each other -
/api/job still hands back BOTH results, with what the screen needs to say
"recorded" and to ask about the certificate, long after both have ended.

Runs the real Handler, the real start_job and the real record_wipe. The
"engine" is a tiny python one-liner that prints a WIPE_RESULT line; nothing
touches a disk. The network (upload_audit, api) is stubbed.

    python3 tools/test-wipe-results.py
"""
import atexit
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
import time
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("als_server", os.path.join(HERE, "gui", "server.py"))
srv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(srv)

_TMP = tempfile.mkdtemp(prefix="als-wipe-results-")
atexit.register(shutil.rmtree, _TMP, True)
srv.CONF_PATH = None
srv.PENDING_FALLBACK = os.path.join(_TMP, "wipe-pending.jsonl")
srv.QUEUE_FALLBACK = os.path.join(_TMP, "audit-queue.jsonl")

PASS, FAIL = [0], []


def check(name, cond, detail=""):
    if cond:
        PASS[0] += 1
        print("  ok   %s" % name)
    else:
        FAIL.append(name)
        print("  FAIL %s   %s" % (name, detail))


OFFERED = [{"device": "/dev/nvme0n1", "model": "Samsung SSD", "serial": "S1",
            "bytes": 512110190592, "rotational": False, "transport": "nvme"},
           {"device": "/dev/sda", "model": "WD Blue", "serial": "W2",
            "bytes": 500107862016, "rotational": True, "transport": "sata"}]
srv.list_drives = lambda *a, **k: OFFERED
srv.SCRIPT = "/fake/hardware-audit.sh"
srv.STATE["profile"] = {"identification": {"serialNumber": "HOST-1"},
                        "storage": [{"serialNumber": "S1"}, {"serialNumber": "W2"}]}

# The stand-in engine: prints a line of progress and ONE WIPE_RESULT, exactly as
# gui_wipe_one does, then exits. The nvme drive fails, the sata one wipes.
RESULTS = {
    "/dev/nvme0n1": {"status": "failed", "device": "/dev/nvme0n1", "method": "none",
                     "reason": "sanitize aborted by the drive"},
    "/dev/sda": {"status": "wiped", "device": "/dev/sda",
                 "method": "Overwrite + verify", "reason": ""},
}


def fake_audit_cmd(*args, **_kw):
    dev = args[1]
    line = "WIPE_RESULT " + json.dumps(RESULTS[dev])
    src = "import sys\nprint('wiping %s')\nprint(%r)\nsys.stdout.flush()\n" % (dev, line)
    return [sys.executable, "-c", src]


UPLOADS = []


def fake_upload(payload):
    UPLOADS.append(payload)
    return {"assetId": "asset-7", "tag": "ALS-7", "name": "Latitude"}, False, ""


srv.audit_cmd = fake_audit_cmd
srv.upload_audit = fake_upload


class Fake(srv.Handler):
    """The real Handler, minus the socket."""

    def __init__(self, path, body=None):   # noqa: D401
        raw = json.dumps(body or {}).encode()
        self.path = path
        self.headers = {"Content-Length": str(len(raw))}
        self.rfile = io.BytesIO(raw)
        self.sent = None

    def _send(self, code, payload, ctype="application/json"):
        self.sent = (code, payload)


def post(path, body):
    h = Fake(path, body)
    h.do_POST()
    return h.sent


def get(path):
    h = Fake(path)
    h.do_GET()
    return h.sent


def job(dev):
    return get("/api/job?type=" + srv.wipe_kind(dev) + "&since=0")[1]


print("two drives, one fails and one wipes within a second")

t0 = time.time()
sent = post("/api/wipe/start", {"devices": ["/dev/nvme0n1", "/dev/sda"], "method": "auto"})
check("both wipes start", sent and sent[0] == 200 and
      sorted(sent[1].get("started", [])) == ["/dev/nvme0n1", "/dev/sda"], sent)

deadline = time.time() + 20
while time.time() < deadline and any(job(d).get("running") for d in RESULTS):
    time.sleep(0.05)
ended = time.time() - t0
check("both finished (stub engines are instant)", not any(job(d).get("running") for d in RESULTS),
      [job(d) for d in RESULTS])
check("and within a second or two of each other", ended < 5, ended)

# The operator looks away; the results must not have gone anywhere.
time.sleep(1.2)
a, b = job("/dev/nvme0n1"), job("/dev/sda")
ra, rb = a.get("result") or {}, b.get("result") or {}
check("failed drive: its result is still there", ra.get("status") == "failed", a)
check("failed drive: with its reason", ra.get("reason") == "sanitize aborted by the drive", ra)
check("wiped drive: its result is still there", rb.get("status") == "wiped", b)
check("wiped drive: with its method", rb.get("method") == "Overwrite + verify", rb)
check("wiped drive: recorded", rb.get("recorded") is True, rb)
check("wiped drive: carries the asset id the certificate is asked about",
      rb.get("recordAssetId") == "asset-7", rb)
check("failed drive: filed too (a failure is a record)", ra.get("recorded") is True, ra)
check("one result does not overwrite the other", ra.get("device") != rb.get("device"), (ra, rb))
check("each drive filed exactly once", len(UPLOADS) == 2, len(UPLOADS))
check("the progress log is kept alongside", "wiping /dev/sda" in (b.get("log") or []), b.get("log"))

# Polled again - as the screen does every 1.5 s - it is the same answer.
check("a later poll returns the same results",
      job("/dev/nvme0n1").get("result") == ra and job("/dev/sda").get("result") == rb)

print("")
print("certificate eligibility (contract C4) through /api/wipe/eligibility")

CALLS = []


def api_ok(path, method="GET", body=None, token=None, timeout=25):
    CALLS.append(path)
    return {"available": False, "reason": "drive W2 failed", "verdict": "failed",
            "drives": [{"key": "W2", "serialNumber": "W2", "model": "WD Blue",
                        "status": "failed", "method": None, "wipedAt": None,
                        "manual": False}],
            "extra": "not passed through"}


srv.ensure_token = lambda: "tok"
srv.api = api_ok
code, ans = get("/api/wipe/eligibility?assetId=asset-7")
check("asks the API about that asset", CALLS == ["/assets/asset-7/certificate-eligibility"], CALLS)
check("answer is known", code == 200 and ans.get("known") is True, ans)
check("verdict and reason passed through", ans.get("verdict") == "failed" and
      ans.get("reason") == "drive W2 failed" and ans.get("available") is False, ans)
check("drives passed through", (ans.get("drives") or [{}])[0].get("status") == "failed", ans)
check("nothing outside the contract passed through", "extra" not in ans, ans)


def api_404(path, **_kw):
    raise urllib.error.HTTPError("http://x" + path, 404, "Not Found", {}, None)


srv.api = api_404
code, ans = get("/api/wipe/eligibility?assetId=asset-7")
check("404 (API older than C4) is UNKNOWN, not 'no certificate'",
      code == 200 and ans.get("known") is False and "available" not in ans, ans)


def api_down(path, **_kw):
    raise OSError("network is unreachable")


srv.api = api_down
code, ans = get("/api/wipe/eligibility?assetId=asset-7")
check("offline is unknown too", code == 200 and ans.get("known") is False, ans)

srv.api = lambda *a, **k: {"available": "yes"}
code, ans = get("/api/wipe/eligibility?assetId=asset-7")
check("a malformed answer is unknown, never 'available'", ans.get("known") is False, ans)

CALLS.clear()
srv.api = api_ok
code, ans = get("/api/wipe/eligibility?assetId=../../auth/login")
check("an asset id that is not an id never reaches the API",
      ans.get("known") is False and CALLS == [], (ans, CALLS))
code, ans = get("/api/wipe/eligibility")
check("no asset id: unknown", ans.get("known") is False and CALLS == [], (ans, CALLS))

print("")
print("%d passed, %d failed" % (PASS[0], len(FAIL)))
sys.exit(1 if FAIL else 0)
