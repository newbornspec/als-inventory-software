#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Two namespaces of one NVMe drive are wiped one after the other, each with
its own result - never at the same time, and never one "on behalf of" the other.

nvme0n1 and nvme0n2 are namespaces of ONE drive (one controller). The first
version of plan step 36's kiosk half refused a request naming both and told
the operator to tick only one "because the wipe covers the other as well".
That is true only of an NVMe SANITIZE. The engine this kiosk runs tries a
per-namespace `nvme format` first, and its overwrite fallback (and
AUDIT_WIPE_METHOD=overwrite/zero) shreds only the namespace it is given - so
the operator unticked nvme0n2, wiped nvme0n1, was told the machine was clean,
and nvme0n2 kept the customer's data. The real hazard two namespaces pose is
two erases on one controller AT ONCE (a sanitize in progress makes the other
command fail or abort it). So both are accepted and the second waits for the
first: each namespace gets its own erase and its own record, whatever method
the engine ends up using.

Runs the real Handler, the real start_job and the real record_wipe; the
"engine" is a python one-liner that sleeps and logs when it started and ended.
Nothing touches a disk. The network (upload_audit) is stubbed.

    python3 tools/test-wipe-namespaces.py
"""
import atexit
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("als_server", os.path.join(HERE, "gui", "server.py"))
srv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(srv)

_TMP = tempfile.mkdtemp(prefix="als-wipe-ns-")
atexit.register(shutil.rmtree, _TMP, True)
srv.CONF_PATH = None
srv.PENDING_FALLBACK = os.path.join(_TMP, "wipe-pending.jsonl")
srv.QUEUE_FALLBACK = os.path.join(_TMP, "audit-queue.jsonl")
TRACE = os.path.join(_TMP, "engine-trace.txt")

PASS, FAIL = [0], []


def check(name, cond, detail=""):
    if cond:
        PASS[0] += 1
        print("  ok   %s" % name)
    else:
        FAIL.append(name)
        print("  FAIL %s   %s" % (name, detail))


def ns(dev, ctrl, sibs, serial):
    return {"device": dev, "model": "Samsung SSD", "serial": serial, "bytes": 10 ** 9,
            "rotational": False, "transport": "nvme", "controller": ctrl, "namespaces": sibs}


PAIR = ["/dev/nvme0n1", "/dev/nvme0n2"]
OFFERED = [ns("/dev/nvme0n1", "nvme0", PAIR, "S1"),
           ns("/dev/nvme0n2", "nvme0", PAIR, "S1"),
           ns("/dev/nvme1n1", "nvme1", ["/dev/nvme1n1"], "W9")]
LIST_DELAY = [0.0]


def fake_list_drives(*_a, **_k):
    # The real one spends seconds in lsblk + smartctl; that is the window two
    # overlapping requests race in.
    if LIST_DELAY[0]:
        time.sleep(LIST_DELAY[0])
    return OFFERED


srv.list_drives = fake_list_drives
srv.SCRIPT = "/fake/hardware-audit.sh"
srv.STATE["profile"] = {"identification": {"serialNumber": "HOST-1"},
                        "storage": [{"serialNumber": "S1"}, {"serialNumber": "W9"}]}

ENGINE_SECS = 0.6


def fake_audit_cmd(*args, **_kw):
    # No startedAt/finishedAt in the result: the record then falls back to the
    # time the kiosk started the engine, which must be when it REALLY started.
    dev = args[1]
    line = "WIPE_RESULT " + json.dumps({"status": "wiped", "device": dev,
                                        "method": "NVMe format (crypto)", "reason": ""})
    src = ("import sys, time\n"
           "def log(w):\n"
           "    with open(%r, 'a') as fh:\n"
           "        fh.write('%%s %%s %%r\\n' %% (w, %r, time.time()))\n"
           "log('start')\n"
           "print('wiping %s')\n"
           "sys.stdout.flush()\n"
           "time.sleep(%r)\n"
           "log('end')\n"
           "print(%r)\n"
           "sys.stdout.flush()\n") % (TRACE, dev, dev, ENGINE_SECS, line)
    return [sys.executable, "-c", src]


UPLOADS = []
UP_LOCK = threading.Lock()


def fake_upload(payload):
    with UP_LOCK:
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


def wait_idle(devs, secs=20):
    end = time.time() + secs
    while time.time() < end:
        if all(not job(d).get("running") for d in devs):
            return True
        time.sleep(0.05)
    return False


def trace():
    """{device: (start, end)} from the stand-in engine's own log."""
    out = {}
    try:
        with open(TRACE) as fh:
            for line in fh:
                what, dev, t = line.split(" ", 2)
                s, e = out.get(dev, (None, None))
                t = float(t)
                out[dev] = (t, e) if what == "start" else (s, t)
    except OSError:
        pass
    return out


def reset():
    for f in (TRACE,):
        try:
            os.remove(f)
        except OSError:
            pass
    del UPLOADS[:]
    for k in list(srv.JOBS):
        if k.startswith("wipe:"):
            srv.JOBS.pop(k)


def overlap(a, b):
    return a[0] < b[1] and b[0] < a[1]


def pending():
    return srv._pending_load_unlocked()


# --------------------------------------------------------------------------
print("both namespaces of one drive in one request")
reset()
sent = post("/api/wipe/start", {"devices": PAIR + ["/dev/nvme1n1"]})
check("accepted (200), not refused", sent and sent[0] == 200, sent)
check("all three drives started", sent and sent[1].get("started") == PAIR + ["/dev/nvme1n1"], sent)
time.sleep(0.15)
j2 = job("/dev/nvme0n2")
check("the second namespace is running (waiting counts as running)", j2.get("running"), j2)
check("... and says what it is waiting for",
      "/dev/nvme0n1" in (j2.get("waiting") or ""), j2.get("waiting"))
check("... without looking stuck (idle stays low while it waits)",
      (j2.get("idle") or 0) < 5, j2.get("idle"))
check("the first namespace is not waiting", not job("/dev/nvme0n1").get("waiting"),
      job("/dev/nvme0n1").get("waiting"))
check("all finished", wait_idle(PAIR + ["/dev/nvme1n1"]))
tr = trace()
check("every engine ran", sorted(tr) == sorted(PAIR + ["/dev/nvme1n1"]), tr)
if all(d in tr and None not in tr[d] for d in PAIR + ["/dev/nvme1n1"]):
    check("the two namespaces never erased at the same time",
          not overlap(tr["/dev/nvme0n1"], tr["/dev/nvme0n2"]), tr)
    check("nvme0n1 first, in the order asked",
          tr["/dev/nvme0n1"][1] <= tr["/dev/nvme0n2"][0] + 0.001, tr)
    check("a different drive (nvme1) still ran alongside, not queued",
          overlap(tr["/dev/nvme0n1"], tr["/dev/nvme1n1"]), tr)
r1, r2 = job("/dev/nvme0n1").get("result") or {}, job("/dev/nvme0n2").get("result") or {}
check("each namespace has its own wiped + recorded result",
      r1.get("status") == r2.get("status") == "wiped" and r1.get("recorded") and r2.get("recorded"),
      (r1, r2))
by_dev = {(u.get("wipedDrive") or {}).get("devicePath"): u for u in UPLOADS}
check("one record per drive, three in all", len(UPLOADS) == 3 and sorted(by_dev) ==
      sorted(PAIR + ["/dev/nvme1n1"]), [u.get("wipedDrive") for u in UPLOADS])
st2 = by_dev.get("/dev/nvme0n2", {}).get("wipeStartedAt")
if "/dev/nvme0n1" in tr and st2:
    # wipeStartedAt is second precision; the first namespace's END (rounded
    # down) is the earliest the second can honestly say it started.
    first_end = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(int(tr["/dev/nvme0n1"][1]) - 1))
    check("the waiting namespace's record says when its erase REALLY started",
          st2 >= first_end, (st2, first_end))
else:
    check("the waiting namespace's record has a start time", False, by_dev.get("/dev/nvme0n2"))
check("no wipe marker left behind", pending() == [], pending())

# --------------------------------------------------------------------------
print("")
print("two overlapping requests, one per namespace (double tap, two tabs)")
reset()
LIST_DELAY[0] = 0.3
res = {}


def fire(dev):
    res[dev] = post("/api/wipe/start", {"devices": [dev]})


ts = [threading.Thread(target=fire, args=(d,)) for d in PAIR]
for t in ts:
    t.start()
for t in ts:
    t.join()
LIST_DELAY[0] = 0.0
check("both requests accepted", all(res[d] and res[d][0] == 200 for d in PAIR), res)
check("both finished", wait_idle(PAIR))
tr = trace()
if all(d in tr and None not in tr[d] for d in PAIR):
    check("... and still never at the same time", not overlap(tr[PAIR[0]], tr[PAIR[1]]), tr)
else:
    check("both engines ran", False, tr)
check("two records", len(UPLOADS) == 2, len(UPLOADS))

# --------------------------------------------------------------------------
print("")
print("stopping the namespace that is still waiting")
reset()
sent = post("/api/wipe/start", {"devices": PAIR})
check("accepted", sent and sent[0] == 200, sent)
time.sleep(0.1)
c = post("/api/wipe/cancel", {"device": "/dev/nvme0n2"})
check("the waiting one can be stopped", c and c[1].get("ok"), c)
check("both finished", wait_idle(PAIR))
tr = trace()
check("its engine never ran", "/dev/nvme0n2" not in tr, tr)
check("the one ahead of it was not disturbed", "/dev/nvme0n1" in tr and None not in tr["/dev/nvme0n1"], tr)
r2 = job("/dev/nvme0n2").get("result") or {}
check("its result: refused - nothing written", r2.get("status") == "refused"
      and "nothing was written" in (r2.get("reason") or "").lower(), r2)
check("... and it is NOT filed as a failed wipe",
      [(u.get("wipedDrive") or {}).get("devicePath") for u in UPLOADS] == ["/dev/nvme0n1"],
      [(u.get("wipedDrive") or {}).get("devicePath") for u in UPLOADS])
check("no wipe marker left behind", pending() == [], pending())
check("the drive's queue is empty afterwards", not srv.DRIVE_QUEUES, srv.DRIVE_QUEUES)

print("")
print("%d passed, %d failed" % (PASS[0], len(FAIL)))
sys.exit(1 if FAIL else 0)
