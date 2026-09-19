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


def start(lot=None, workflow=None):
    JOBS.clear()
    UPLOADS.clear()
    body = {"devices": ["/dev/nvme0n1"]}
    if lot:
        body["lotId"] = lot
    if workflow is not None:
        body["workflow"] = workflow
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

    sent = start()
    check("amazon: wipe starts", sent and sent[0] == 200 and len(JOBS) == 1, (sent, JOBS))
    JOBS[0]["on_done"]({"status": "wiped", "method": "NVMe crypto erase",
                        "device": "/dev/nvme0n1"})
    rec = UPLOADS[-1] if UPLOADS else {}
    check("amazon record: auditKind amazon, no lot",
          rec.get("auditKind") == "amazon" and "lotId" not in rec, rec)

    print("a page whose view of the workflow is stale: refused before erasing")
    # The server's workflow is global; the lot comes from the page. A second
    # tab (or a page that has not re-read the workflow since it was changed
    # elsewhere) showing Goods In with a batch used to have its wipe filed as
    # Amazon with the batch silently dropped - a different workflow and lot
    # than the operator chose on screen.
    sent = start(lot="lot-GOODSIN-7", workflow="goods_in")
    msg = (sent or (0, {}))[1].get("message", "")
    check("page shows goods_in, station is amazon: 409, engine not started",
          sent and sent[0] == 409 and JOBS == [], (sent, JOBS))
    check("the reason says the workflow changed and to check it",
          "Amazon" in msg and "Goods In" in msg and "Nothing was erased" in msg, msg)
    sent = start(lot="lot-GOODSIN-7")
    check("a batch sent while the station is amazon (page without a workflow field): 409",
          sent and sent[0] == 409 and JOBS == [], (sent, JOBS))
    sent = start(workflow="amazon")
    check("page and station agree (amazon): starts",
          sent and sent[0] == 200 and len(JOBS) == 1, (sent, JOBS))
    post("/api/workflow", {"workflow": "goods_in"})
    sent = start(workflow="amazon")
    check("page shows amazon, station is goods_in: 409, engine not started",
          sent and sent[0] == 409 and JOBS == [], (sent, JOBS))
    sent = start(lot="lot-1", workflow="goods_in")
    check("page and station agree (goods_in): starts",
          sent and sent[0] == 200 and len(JOBS) == 1, (sent, JOBS))
    sent = start(lot="lot-1", workflow="bogus")
    check("an unknown workflow from the page: 409, engine not started",
          sent and sent[0] == 409 and JOBS == [], (sent, JOBS))

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

    print("a restore files a record too: the same workflow gate, fixed at start")
    # /api/os/install overwrites the internal disk and files its record
    # through the same upload_audit. It had neither protection: a restore
    # with no workflow chosen started, and its kind-less record got the same
    # 400; and the workflow was read when the restore ENDED, so switching to
    # Amazon for the next machine filed a Goods In restore as Amazon and
    # dropped its lot.
    srv.mount_image_server = lambda *a, **k: (TMP, "stick", "")
    srv.INSTALL_SH = "/fake/install-image.sh"

    def restore(lot=None, workflow=None):
        JOBS.clear()
        UPLOADS.clear()
        body = {"device": "/dev/nvme0n1", "imageId": "win11", "imageName": "Windows 11"}
        if lot:
            body["lotId"] = lot
        if workflow is not None:
            body["workflow"] = workflow
        return post("/api/os/install", body)

    account(permissions=BOTH)
    sent = restore(lot="lot-GOODSIN-7")
    msg = (sent or (0, {}))[1].get("message", "")
    check("restore, no workflow chosen: refused with 409", sent and sent[0] == 409, sent)
    check("restore refusal asks for Amazon or Goods In", "Amazon" in msg and "Goods In" in msg,
          msg)
    check("restore refusal: the restore was never started", JOBS == [], JOBS)
    account(permissions=["view_assets"])
    sent = restore()
    check("restore, no audit permission: refused, never started",
          sent and sent[0] == 409 and JOBS == [], (sent, JOBS))

    account(permissions=BOTH, workflow="goods_in")
    sent = restore(lot="lot-GOODSIN-7")
    check("restore under goods_in: starts", sent and sent[0] == 200 and len(JOBS) == 1,
          (sent, JOBS))
    srv.STATE["workflow"] = "amazon"         # next machine, while this one restores
    JOBS[0]["on_done"]({"status": "installed", "device": "/dev/nvme0n1"})
    rec = UPLOADS[-1] if UPLOADS else {}
    check("switching workflow mid-restore: still filed as goods_in, lot kept",
          rec.get("auditKind") == "goods_in" and rec.get("lotId") == "lot-GOODSIN-7", rec)

    account(permissions=BOTH, workflow="amazon")
    sent = restore()
    check("restore under amazon: starts", sent and sent[0] == 200 and len(JOBS) == 1,
          (sent, JOBS))
    srv.STATE["workflow"] = "goods_in"
    JOBS[0]["on_done"]({"status": "installed", "device": "/dev/nvme0n1"})
    rec = UPLOADS[-1] if UPLOADS else {}
    check("switching workflow mid-restore: an amazon restore stays amazon, no lot",
          rec.get("auditKind") == "amazon" and "lotId" not in rec, rec)

    account(permissions=BOTH, workflow="amazon")
    sent = restore(lot="lot-GOODSIN-7", workflow="goods_in")
    check("restore from a stale page (goods_in shown, station amazon): 409, never started",
          sent and sent[0] == 409 and JOBS == [], (sent, JOBS))
    sent = restore(lot="lot-GOODSIN-7")
    check("restore with a batch while the station is amazon: 409, never started",
          sent and sent[0] == 409 and JOBS == [], (sent, JOBS))
    sent = restore(workflow="amazon")
    check("restore, page and station agree: starts",
          sent and sent[0] == 200 and len(JOBS) == 1, (sent, JOBS))

    account(permissions=["perform_goods_in_audit"])
    sent = restore(lot="lot-1")
    check("restore, goods-in-only account: starts without choosing",
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
    check("Restore (Load OS Image) has the same gate: disabled with the reason shown",
          "function installGate()" in page and 'id="iGateMsg"' in page
          and "$('iStart').disabled=!!why" in page)
    check("confirmInstall refuses on the gate too", "const gate=installGate();" in page)
    check("the page sends the workflow it showed with a wipe and a restore",
          page.count("workflow:wf()") >= 2, page.count("workflow:wf()"))
finally:
    shutil.rmtree(TMP, True)

print("")
print("%d passed, %d failed" % (PASS[0], len(FAIL)))
sys.exit(1 if FAIL else 0)
