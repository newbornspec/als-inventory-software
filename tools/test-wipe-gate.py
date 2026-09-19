#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""The wipe endpoint must only ever wipe a disk it OFFERED.

Before this, POST /api/wipe/start checked the device name against a regex and
nothing else. The regex is an injection guard: "/dev/sdb" passes it whether sdb
is the machine's internal disk or the USB stick the station booted from. The
install endpoint had already learned to check against list_drives(); the wipe
endpoint had not. Device names also shift when a drive is plugged or unplugged,
so a name the screen showed a minute ago proves nothing now.

This drives the real Handler.do_POST with a crafted request and stubs only the
edges: what list_drives() enumerates, and start_job() so nothing is ever wiped.

    python3 tools/test-wipe-gate.py
"""
import atexit
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("als_server", os.path.join(HERE, "gui", "server.py"))
srv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(srv)

# In-progress wipe markers (and any queued record) go to a scratch folder, never
# beside a real audit.conf or into the machine's /tmp.
_TMP = tempfile.mkdtemp(prefix="als-test-")
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


# What the station offers: one internal disk. The boot stick (sdb) is NOT here -
# list_drives() excludes USB and removable devices, which is the whole point.
OFFERED = [{"device": "/dev/nvme0n1", "model": "internal"}]
STARTED = []


def fake_start_job(kind, cmd, marker, device, **kw):
    STARTED.append(device)      # record the attempt; wipe nothing
    return True


srv.list_drives = lambda *a, **k: OFFERED
srv.start_job = fake_start_job
srv.SCRIPT = "/fake/hardware-audit.sh"      # the handler 500s without an engine
srv.audit_cmd = lambda *a, **k: ["true"]
# The handler refuses to erase anything on a machine it has not identified
# (test-capture.py covers that); these cases are about WHICH disk, so give it
# an identified machine.
srv.STATE["profile"] = {"identification": {"serialNumber": "HOST-1"}, "storage": []}


class Fake(srv.Handler):
    """The real Handler, minus the socket."""

    def __init__(self, path, body):   # noqa: D401 - deliberately skip BaseHTTPRequestHandler.__init__
        raw = json.dumps(body).encode()
        self.path = path
        self.headers = {"Content-Length": str(len(raw))}
        self.rfile = io.BytesIO(raw)
        self.sent = None

    def _send(self, code, payload, ctype="application/json"):
        self.sent = (code, payload)


def post(body):
    STARTED.clear()
    h = Fake("/api/wipe/start", body)
    h.do_POST()
    return h.sent, list(STARTED)


print("wipe gate")

# 1. The disk it offered is wiped.
sent, started = post({"devices": ["/dev/nvme0n1"]})
check("offered internal disk: the wipe starts", started == ["/dev/nvme0n1"], (sent, started))

# 2. THE CASE. The boot stick - a name that passes the regex and was never
#    offered. Before the fix this reached start_job.
sent, started = post({"devices": ["/dev/sdb"]})
check("boot stick /dev/sdb: refused", sent and sent[0] == 400, sent)
check("boot stick /dev/sdb: nothing started", started == [], started)
check("boot stick /dev/sdb: says why", sent and "not an internal disk" in sent[1].get("message", ""), sent)

# 3. Mixed batch: one good, one not. ALL or nothing - a request that names the
#    boot stick is refused whole, so the good disk is not wiped on the strength
#    of a request that was wrong about something.
sent, started = post({"devices": ["/dev/nvme0n1", "/dev/sdb"]})
check("mixed batch: refused whole", sent and sent[0] == 400, sent)
check("mixed batch: not even the good disk started", started == [], started)

# 4. The single-device form of the request goes through the same gate.
sent, started = post({"device": "/dev/sdb"})
check("single 'device' field: boot stick refused", sent and sent[0] == 400 and started == [], (sent, started))

# 5. The regex still runs first for things that are not device names at all.
sent, started = post({"devices": ["/dev/sdb; rm -rf /"]})
check("injection attempt: refused before anything else", sent and sent[0] == 400 and started == [], (sent, started))

# 6. Nothing offered at all (list_drives() found no disks, or failed): nothing
#    can be wiped, rather than everything.
srv.list_drives = lambda *a, **k: None
sent, started = post({"devices": ["/dev/nvme0n1"]})
check("no disks enumerated: refuses, does not fail open", sent and sent[0] == 400 and started == [], (sent, started))

print("")
print("%d passed, %d failed" % (PASS[0], len(FAIL)))
sys.exit(1 if FAIL else 0)
