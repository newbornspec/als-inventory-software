#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""A wipe is refused BEFORE anything is erased when its record could not be
filed: an account holding both audit permissions that has not picked Amazon or
Goods In yet (or an account with no audit permission at all).

The incident this guards: the station account held perform_amazon_audit AND
perform_goods_in_audit, the operator wiped an NVMe drive without choosing a
workflow, the record went out with no auditKind and no lotId, the API answered
400 "No audit lot selected", and the record sat in the queue retrying forever.
The drive was erased either way; the only safe moment to refuse is before.

Drives the real Handler.do_POST("/api/wipe/start") with the real
current_workflow() / stamp_provenance(). Stubs only the edges: list_drives()
(what lsblk would enumerate), start_job() (so no engine ever runs and nothing
is erased) and upload_audit() (so nothing leaves this process).

    python3 tools/test-wipe-workflow.py
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


TMP = tempfile.mkdtemp(prefix="als-wipe-workflow-")
PROFILE = {"identification": {"manufacturer": "Dell", "model": "Latitude 7490",
                              "serialNumber": "HOST-1"},
           "storage": [{"model": "Samsung SSD", "serialNumber": "S1"}]}
OFFERED = [{"device": "/dev/nvme0n1", "model": "Samsung SSD", "serial": "S1",
            "bytes": 512110190592, "rotational": False, "transport": "nvme"}]
JOBS, UPLOADS = [], []


def fake_start_job(kind, argv, marker, device="", on_done=None, **kw):
    JOBS.append({"device": device, "argv": list(argv), "on_done": on_done})
    return True


def fake_upload(payload):
    UPLOADS.append(json.loads(json.dumps(payload)))
    return {"assetId": "asset-1", "tag": "T1"}, False, ""


srv.CONF_PATH = None
srv.PENDING_FALLBACK = os.path.join(TMP, "wipe-pending.jsonl")
srv.QUEUE_FALLBACK = os.path.join(TMP, "queue.jsonl")
srv.SCRIPT = "/fake/hardware-audit.sh"
srv.audit_cmd = lambda *a, **k: list(a)
srv.list_drives = lambda *a, **k: OFFERED
srv.start_job = fake_start_job
srv.upload_audit = fake_upload
srv.STATE["conf"] = {}
srv.STATE["profile"] = json.loads(json.dumps(PROFILE))


class Fake(srv.Handler):
    def __init__(self, path, body):
        raw = json.dumps(body).encode()
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


def account(role="", permissions=None, workflow=""):
    srv.STATE["role"] = role
    srv.STATE["permissions"] = permissions
    srv.STATE["workflow"] = workflow


def start(lot=None):
    JOBS.clear()
    UPLOADS.clear()
    body = {"devices": ["/dev/nvme0n1"]}
    if lot:
        body["lotId"] = lot
    return post("/api/wipe/start", body)


BOTH = ["perform_amazon_audit", "perform_goods_in_audit"]

try:
    print("dual-permission account, no workflow chosen")
    account(permissions=BOTH)
    check("current_workflow() is '' (the incident's state)", srv.current_workflow() == "")
    sent = start(lot="lot-1")
    check("wipe/start refused with 409", sent and sent[0] == 409, sent)
    msg = (sent or (0, {}))[1].get("message", "")
    check("the reason tells the operator to choose Amazon or Goods In",
          "Amazon" in msg and "Goods In" in msg and "Choose" in msg, msg)
    check("the reason says nothing was erased", "Nothing was erased" in msg, msg)
    check("the engine was never started", JOBS == [], JOBS)
    check("no wipe marker left on the stick (nothing to record)",
          srv._pending_load_unlocked() == [], srv._pending_load_unlocked())

    print("admin (both workflows) without a choice: refused the same way")
    account(role="admin", permissions=[])
    sent = start(lot="lot-1")
    check("admin with no workflow chosen: 409, engine not started",
          sent and sent[0] == 409 and JOBS == [], (sent, JOBS))

    print("account with no audit permission at all")
    account(permissions=["view_assets"])
    sent = start()
    msg = (sent or (0, {}))[1].get("message", "")
    check("refused with 409, engine not started", sent and sent[0] == 409 and JOBS == [],
          (sent, JOBS))
    check("the reason names the missing permission", "no audit permission" in msg, msg)

    print("workflow chosen: allowed, and the record carries it")
    account(permissions=BOTH)
    sent = post("/api/workflow", {"workflow": "goods_in"})
    check("the operator picks Goods In", sent[0] == 200, sent)
    sent = start(lot="lot-1")
    check("goods_in: wipe starts", sent and sent[0] == 200 and len(JOBS) == 1, (sent, JOBS))
    JOBS[0]["on_done"]({"status": "wiped", "method": "NVMe crypto erase",
                        "device": "/dev/nvme0n1"})
    rec = UPLOADS[-1] if UPLOADS else {}
    check("goods_in record: auditKind goods_in", rec.get("auditKind") == "goods_in", rec)
    check("goods_in record: the chosen lot", rec.get("lotId") == "lot-1", rec)

    # The workflow is fixed when the wipe STARTS. Switching to Amazon for the
    # next machine while this one erases must not turn its record into an
    # Amazon one (which would drop the lot it was made for).
    sent = start(lot="lot-1")
    post("/api/workflow", {"workflow": "amazon"})
    JOBS[0]["on_done"]({"status": "wiped", "method": "NVMe crypto erase",
                        "device": "/dev/nvme0n1"})
    rec = UPLOADS[-1] if UPLOADS else {}
    check("switching workflow mid-wipe: still filed as goods_in, lot kept",
          rec.get("auditKind") == "goods_in" and rec.get("lotId") == "lot-1", rec)

    sent = start(lot="lot-1")
    check("amazon: wipe starts", sent and sent[0] == 200 and len(JOBS) == 1, (sent, JOBS))
    JOBS[0]["on_done"]({"status": "wiped", "method": "NVMe crypto erase",
                        "device": "/dev/nvme0n1"})
    rec = UPLOADS[-1] if UPLOADS else {}
    check("amazon record: auditKind amazon, no lot (even though one was sent)",
          rec.get("auditKind") == "amazon" and "lotId" not in rec, rec)

    # The lot rule is the capture upload's (/api/audit): the API also accepts
    # the account's own active lot, which this station cannot see, so a
    # Goods In wipe with no lotId is NOT refused here (the page asks for a
    # batch, exactly as it does for Start audit).
    post("/api/workflow", {"workflow": "goods_in"})
    sent = start()
    check("goods_in without a lotId: not refused by the station (API decides)",
          sent and sent[0] == 200 and len(JOBS) == 1, (sent, JOBS))

    print("single-permission and legacy accounts: unchanged")
    account(permissions=["perform_goods_in_audit"])
    sent = start(lot="lot-1")
    check("goods-in-only account: starts without choosing",
          sent and sent[0] == 200 and len(JOBS) == 1, (sent, JOBS))
    account(permissions=["perform_amazon_audit"])
    sent = start()
    check("amazon-only account: starts without choosing",
          sent and sent[0] == 200 and len(JOBS) == 1, (sent, JOBS))
    account(permissions=None)       # a server that predates permissions
    sent = start(lot="lot-1")
    check("legacy server (no permissions sent): starts as goods_in",
          sent and sent[0] == 200 and len(JOBS) == 1, (sent, JOBS))

    print("the page: Wipe says why it is not offered")
    with open(os.path.join(HERE, "gui", "index.html"), encoding="utf-8") as fh:
        page = fh.read()
    check("index.html has a wipe gate that asks for a workflow",
          "function wipeGate()" in page and "Choose Amazon / General audit or Goods In" in page)
    check("the gate disables Wipe and shows the reason",
          "$('wStart').disabled=!selectedWipeDrives().length||!!why" in page
          and 'id="wGateMsg"' in page)
    check("confirmWipe refuses on the gate too (no request is sent)",
          "const gate=wipeGate();" in page)
finally:
    shutil.rmtree(TMP, True)

print("")
print("%d passed, %d failed" % (PASS[0], len(FAIL)))
sys.exit(1 if FAIL else 0)
