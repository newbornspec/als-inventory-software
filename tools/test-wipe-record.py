#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""What the kiosk files after a wipe: one record per drive, saying which code
erased it.

Drives the real Handler.do_POST("/api/wipe/start") and the record_wipe callback
it hands to start_job. Stubs only the edges: list_drives() (what lsblk would
enumerate), start_job() (so no engine ever runs and nothing is erased), and the
network (api / upload_audit), so nothing leaves this process.

    python3 tools/test-wipe-record.py
"""
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

PASS, FAIL = [0], []


def check(name, cond, detail=""):
    if cond:
        PASS[0] += 1
        print("  ok   %s" % name)
    else:
        FAIL.append(name)
        print("  FAIL %s   %s" % (name, detail))


TMP = tempfile.mkdtemp(prefix="als-wipe-record-")

PROFILE = {"identification": {"manufacturer": "Dell", "model": "Latitude 7490",
                              "serialNumber": "HOST-1"},
           "storage": [{"model": "Samsung SSD", "serialNumber": "S1"},
                       {"model": "WD Blue", "serialNumber": "W2"}]}
OFFERED = [{"device": "/dev/nvme0n1", "model": "Samsung SSD", "serial": "S1"},
           {"device": "/dev/sda", "model": "WD Blue", "serial": "W2"}]
JOBS = []          # (device, argv, on_done, kwargs) per start_job call
UPLOADS = []


def fake_start_job(kind, argv, marker, device="", on_done=None, **kw):
    JOBS.append({"device": device, "argv": list(argv), "on_done": on_done, "kw": kw})
    return True


def fake_upload(payload):
    UPLOADS.append(json.loads(json.dumps(payload)))
    return {"assetId": "asset-1", "tag": "T1"}, False, ""


srv.SCRIPT = "/fake/hardware-audit.sh"
srv.audit_cmd = lambda *a, **k: list(a)
srv.list_drives = lambda *a, **k: OFFERED
srv.start_job = fake_start_job
srv.upload_audit = fake_upload
srv.stamp_provenance = lambda p: p
srv.STATE["profile"] = json.loads(json.dumps(PROFILE))
srv.STATE["conf"] = {}


class Fake(srv.Handler):
    def __init__(self, path, body):
        raw = json.dumps(body).encode()
        self.path = path
        self.headers = {"Content-Length": str(len(raw))}
        self.rfile = io.BytesIO(raw)
        self.sent = None

    def _send(self, code, payload, ctype="application/json"):
        self.sent = (code, payload)


def start(devs):
    JOBS.clear()
    UPLOADS.clear()
    h = Fake("/api/wipe/start", {"devices": list(devs)})
    h.do_POST()
    return h.sent


def stamp(text, binary=None):
    p = os.path.join(TMP, "stick-version-%d" % len(os.listdir(TMP)))
    with open(p, "wb") as fh:
        fh.write(binary if binary is not None else text.encode("utf-8"))
    return p


try:
    print("which code erased the drive")

    # The exact bytes PowerShell 5.1 writes: BOM, CRLF, commit then synced.
    ps = stamp(None, b"\xef\xbb\xbfcommit 7eda9ea\r\nsynced 2026-09-19T10:00:00\r\n")
    check("stamp as sync-usb.ps1 writes it: commit read", srv.stick_commit(ps) == "7eda9ea",
          srv.stick_commit(ps))
    check("dirty working tree: suffix kept",
          srv.stick_commit(stamp("commit 7eda9ea-dirty\nsynced x\n")) == "7eda9ea-dirty")
    check("UTF-16 stamp (plain Out-File): still read",
          srv.stick_commit(stamp(None, "commit abc1234\r\n".encode("utf-16"))) == "abc1234")
    check("no stamp on the stick: None", srv.stick_commit(os.path.join(TMP, "absent")) is None)
    check("'commit unknown' (git missing at sync time): None",
          srv.stick_commit(stamp("commit unknown\n")) is None)
    check("garbage: None", srv.stick_commit(stamp("\x00\x01 not a stamp")) is None)
    check("empty file: None", srv.stick_commit(stamp("")) is None)

    srv.STICK_VERSION_FILE = ps
    sent = start(["/dev/nvme0n1"])
    check("wipe starts", sent[0] == 200 and len(JOBS) == 1, sent)
    JOBS[0]["on_done"]({"status": "wiped", "method": "NVMe crypto erase", "device": "/dev/nvme0n1"})
    p = UPLOADS[-1] if UPLOADS else {}
    check("record carries toolName", p.get("toolName") == "als-audit-station", p)
    check("record carries toolVersion", p.get("toolVersion") == srv.ALS_TOOL_VERSION == "2026.09.19", p)
    check("record carries toolCommit", p.get("toolCommit") == "7eda9ea", p)

    # The engine's own version wins: it is the code that erased the drive.
    UPLOADS.clear()
    JOBS[0]["on_done"]({"status": "failed", "method": "none", "device": "/dev/nvme0n1",
                        "reason": "x", "toolVersion": "2026.10.01"})
    check("engine-reported toolVersion wins", UPLOADS and UPLOADS[-1]["toolVersion"] == "2026.10.01",
          UPLOADS)
    UPLOADS.clear()
    JOBS[0]["on_done"]({"status": "wiped", "method": "m", "device": "/dev/nvme0n1",
                        "toolVersion": {"not": "a string"}})
    check("junk engine toolVersion: ours is used", UPLOADS and UPLOADS[-1]["toolVersion"] == "2026.09.19",
          UPLOADS)

    srv.STICK_VERSION_FILE = os.path.join(TMP, "absent")
    UPLOADS.clear()
    JOBS[0]["on_done"]({"status": "wiped", "method": "m", "device": "/dev/nvme0n1"})
    p = UPLOADS[-1] if UPLOADS else {}
    check("no stamp: toolCommit omitted, not empty", "toolCommit" not in p and p.get("toolVersion"), p)
finally:
    shutil.rmtree(TMP, ignore_errors=True)

print("")
print("%d passed, %d failed" % (PASS[0], len(FAIL)))
sys.exit(1 if FAIL else 0)
