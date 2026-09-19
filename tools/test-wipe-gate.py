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


QUEUES = {}                 # device -> the queue_key start_job was given


def fake_start_job(kind, cmd, marker, device, **kw):
    STARTED.append(device)      # record the attempt; wipe nothing
    QUEUES[device] = kw.get("queue_key")
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

# --------------------------------------------------------------------------
# Plan step 36 (kiosk half), owner decision D36. nvme0n1 and nvme0n2 are two
# namespaces of ONE drive. Both must be wiped - the engine's format and its
# overwrite cover only the namespace they are given, so refusing one of them
# (an earlier version did, saying the other's wipe "covers" it) left data on
# the drive. They must not be erased AT ONCE, though, so each job is queued on
# its controller (start_job's queue_key; the real queue is exercised in
# tools/test-wipe-namespaces.py). Here: what the handler asks start_job for.
print("")
print("nvme namespaces of one controller")

NS = [{"device": "/dev/nvme0n1", "model": "Samsung", "serial": "", "controller": "nvme0",
       "namespaces": ["/dev/nvme0n1", "/dev/nvme0n2"]},
      {"device": "/dev/nvme0n2", "model": "Samsung", "serial": "", "controller": "nvme0",
       "namespaces": ["/dev/nvme0n1", "/dev/nvme0n2"]},
      {"device": "/dev/nvme1n1", "model": "WD", "serial": "", "controller": "nvme1",
       "namespaces": ["/dev/nvme1n1"]},
      {"device": "/dev/sda", "model": "HDD", "serial": "", "controller": None,
       "namespaces": []}]
srv.list_drives = lambda *a, **k: NS

QUEUES.clear()
sent, started = post({"devices": ["/dev/nvme0n1", "/dev/nvme0n2"]})
check("two namespaces of one controller: accepted, NOT refused",
      sent and sent[0] == 200 and started == ["/dev/nvme0n1", "/dev/nvme0n2"], (sent, started))
check("... each queued on the controller, so they run one after the other",
      QUEUES.get("/dev/nvme0n1") == QUEUES.get("/dev/nvme0n2") == "nvme0", QUEUES)

QUEUES.clear()
sent, started = post({"devices": ["/dev/sda", "/dev/nvme0n2", "/dev/nvme1n1", "/dev/nvme0n1"]})
check("mixed with other drives: every drive starts",
      sent and sent[0] == 200 and sorted(started) == ["/dev/nvme0n1", "/dev/nvme0n2",
                                                      "/dev/nvme1n1", "/dev/sda"], (sent, started))
check("... a different controller gets its own queue, a SATA disk none",
      QUEUES.get("/dev/nvme1n1") == "nvme1" and QUEUES.get("/dev/sda") is None, QUEUES)

sent, started = post({"devices": ["/dev/nvme0n2"]})
check("one namespace alone starts", sent and sent[0] == 200 and started == ["/dev/nvme0n2"],
      (sent, started))

# A sibling already being wiped: the new request is not refused with "that
# erase covers it too" (it may not) - it queues behind it.
srv.JOBS["wipe:/dev/nvme0n1"] = {"running": True}
QUEUES.clear()
sent, started = post({"devices": ["/dev/nvme0n2"]})
check("sibling namespace already being wiped: accepted, queued behind it",
      sent and sent[0] == 200 and started == ["/dev/nvme0n2"]
      and QUEUES.get("/dev/nvme0n2") == "nvme0", (sent, started, QUEUES))
check("... and no message claims one namespace's wipe covers the other",
      "covers" not in json.dumps(sent), sent)
srv.JOBS.pop("wipe:/dev/nvme0n1", None)

# ---- which controller a namespace belongs to: nvme_controller -------------
print("")
print("nvme_controller reads sysfs")

SYS = os.path.join(_TMP, "sys")


def fake_link(name, target):
    """/sys/block/<name> -> <target> (a real directory in the temp tree). On a
    PC where symlinks cannot be made (Windows without developer mode) this
    returns False and the sysfs cases are skipped, never faked."""
    os.makedirs(os.path.join(SYS, target), exist_ok=True)
    os.makedirs(os.path.join(SYS, "block"), exist_ok=True)
    try:
        os.symlink(os.path.join(SYS, target), os.path.join(SYS, "block", name),
                   target_is_directory=True)
        return True
    except (OSError, NotImplementedError):
        return False


srv.SYS_ROOT = SYS
if fake_link("nvme0n1", "devices/pci0000.00/0000.00.1d.0/0000.3d.00.0/nvme/nvme1/nvme0n1"):
    fake_link("nvme0n2", "devices/pci0000.00/0000.00.1d.0/0000.3d.00.0/nvme/nvme1/nvme0n2")
    fake_link("nvme2n1", "devices/virtual/nvme-subsystem/nvme-subsys2/nvme2n1")
    check("sysfs wins over the name: nvme0n1 on controller nvme1",
          srv.nvme_controller("nvme0n1") == "nvme1", srv.nvme_controller("nvme0n1"))
    check("its sibling namespace: same controller",
          srv.nvme_controller("nvme0n2") == "nvme1", srv.nvme_controller("nvme0n2"))
    check("multipath kernel: grouped by subsystem",
          srv.nvme_controller("nvme2n1") == "nvme-subsys2", srv.nvme_controller("nvme2n1"))
else:
    print("  SKIP symlinks not available here - sysfs cases not run (they run on Linux/CI)")
check("no sysfs entry: falls back to the name", srv.nvme_controller("nvme3n2") == "nvme3",
      srv.nvme_controller("nvme3n2"))
check("SATA disk: not an NVMe namespace", srv.nvme_controller("sda") is None)
check("controller character device name is not a namespace",
      srv.nvme_controller("nvme0") is None)
check("path-injection-shaped name: None", srv.nvme_controller("../nvme0n1") is None)
srv.SYS_ROOT = "/sys"

# ---- list_drives groups the namespaces -------------------------------------
print("")
print("list_drives exposes controller and namespaces")

LSBLK = "\n".join([
    'NAME="nvme0n1" SIZE="512110190592" MODEL="Samsung SSD" TRAN="nvme" RM="0" ROTA="0" TYPE="disk" SERIAL="S1"',
    'NAME="nvme0n2" SIZE="1000000000" MODEL="Samsung SSD" TRAN="nvme" RM="0" ROTA="0" TYPE="disk" SERIAL="S1"',
    'NAME="nvme1n1" SIZE="256060514304" MODEL="WD SN530" TRAN="nvme" RM="0" ROTA="0" TYPE="disk" SERIAL="W9"',
    'NAME="sda" SIZE="500107862016" MODEL="WD Blue" TRAN="sata" RM="0" ROTA="1" TYPE="disk" SERIAL="X1"',
]) + "\n"


class _Run:
    stdout = LSBLK


# A fresh copy of the module: the one above has list_drives stubbed out. Its
# lsblk call is answered by LSBLK (the subprocess module is shared, so the
# real run is put back straight after), and sysfs points
# at an empty folder so grouping is by name and the same on every OS.
spec2 = importlib.util.spec_from_file_location("als_server2", os.path.join(HERE, "gui", "server.py"))
srv2 = importlib.util.module_from_spec(spec2)
spec2.loader.exec_module(srv2)
srv2.SYS_ROOT = os.path.join(_TMP, "no-sys")
real_run = srv2.subprocess.run
srv2.subprocess.run = lambda *a, **k: _Run()
try:
    got = {d["device"]: d for d in srv2.list_drives(force=True)}
finally:
    srv2.subprocess.run = real_run
check("all four disks listed", sorted(got) == ["/dev/nvme0n1", "/dev/nvme0n2", "/dev/nvme1n1",
                                               "/dev/sda"], sorted(got))
check("nvme0n1 and nvme0n2 name the same controller",
      got["/dev/nvme0n1"]["controller"] == got["/dev/nvme0n2"]["controller"] == "nvme0",
      (got["/dev/nvme0n1"].get("controller"), got["/dev/nvme0n2"].get("controller")))
check("each lists both namespaces",
      got["/dev/nvme0n1"]["namespaces"] == ["/dev/nvme0n1", "/dev/nvme0n2"]
      and got["/dev/nvme0n2"]["namespaces"] == ["/dev/nvme0n1", "/dev/nvme0n2"],
      got["/dev/nvme0n1"].get("namespaces"))
check("a single-namespace drive lists only itself",
      got["/dev/nvme1n1"]["controller"] == "nvme1"
      and got["/dev/nvme1n1"]["namespaces"] == ["/dev/nvme1n1"], got["/dev/nvme1n1"])
check("a SATA disk has no controller and no namespaces",
      got["/dev/sda"]["controller"] is None and got["/dev/sda"]["namespaces"] == [],
      got["/dev/sda"])

print("")
print("%d passed, %d failed" % (PASS[0], len(FAIL)))
sys.exit(1 if FAIL else 0)
