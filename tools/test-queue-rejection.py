#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""A queued record the SERVER refuses is kept, retried, and SHOWN - never
retried in silence.

The incident: an NVMe drive was sanitized and verified clean, but its record
(no auditKind, no lotId) was answered 400 "No audit lot selected" by the API.
upload_audit and the queue flush treated that exactly like a network outage:
keep it, retry every 45 s, say "1 waiting to upload". The operator was never
told, and the record could never succeed.

Runs the real upload_audit / queue_flush / queue_status / Handler GETs against
a fake API on 127.0.0.1 (nothing leaves this machine), so every HTTP error is a
genuine urllib HTTPError. The queue lives in a temp file.

Proves: a 400 keeps the record queued, byte for byte, records the server's
reason and the status reports it; the reason is never in any POSTed body; a
refused record is retried, less often; a network error or a 5xx still queues
with no server reason; the "not now" statuses (401/408/409/429) are not
refusals; nothing stamps a workflow or lot onto a queued record.

    python3 tools/test-queue-rejection.py
"""
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

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


LOT_REASON = "No audit lot selected — pick the lot you are working on in Als Inventory first."
# What /devices/hardware-audit answers now: (status, JSON body).
API = {"answer": (400, {"statusCode": 400, "message": LOT_REASON, "error": "Bad Request"})}
BODIES = []        # every hardware-audit body the fake API received, parsed


class FakeApi(BaseHTTPRequestHandler):
    def log_message(self, *_a):
        pass

    def _json(self, code, obj):
        raw = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):  # noqa: N802
        return self._json(200, [])

    def do_POST(self):  # noqa: N802
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        if self.path == "/auth/login":
            if API.get("login"):
                code, body = API["login"]
                return self._json(code, body)
            return self._json(200, {"accessToken": "tok-station", "user": {
                "id": "u-station", "name": "Station", "role": "",
                "permissions": ["perform_amazon_audit", "perform_goods_in_audit"]}})
        if self.path == "/devices/hardware-audit":
            BODIES.append({"raw": raw.decode("utf-8", "replace"), "json": json.loads(raw)})
            code, body = API["answer"]
            return self._json(code, body)
        return self._json(404, {"message": "not here"})


API_SRV = ThreadingHTTPServer(("127.0.0.1", 0), FakeApi)
threading.Thread(target=API_SRV.serve_forever, name="fake-api", daemon=True).start()
API_URL = "http://127.0.0.1:%d" % API_SRV.server_address[1]

TMP = tempfile.mkdtemp(prefix="als-queue-rejection-")
srv.CONF_PATH = None
srv.QUEUE_FALLBACK = os.path.join(TMP, "audit-queue.jsonl")
srv.PENDING_FALLBACK = os.path.join(TMP, "wipe-pending.jsonl")
srv.STATE["conf"] = {"AUDIT_URL": API_URL, "AUDIT_EMAIL": "station@example.test",
                     "AUDIT_PASSWORD": "not-a-real-password"}
srv.STATE["token"] = None


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


def reset():
    srv.queue_write([])
    with srv.REJECTED_LOCK:
        srv.REJECTED.clear()
    BODIES.clear()


def age_rejections(secs):
    """Pretend the refusals happened `secs` seconds ago."""
    with srv.REJECTED_LOCK:
        for v in srv.REJECTED.values():
            v["at"] -= secs


def queue_bytes():
    with open(srv.QUEUE_FALLBACK, "rb") as fh:
        return fh.read()


# The incident's record, as the station queued it: a wipe, no auditKind, no
# lotId (the dual-permission account had not chosen a workflow).
WIPE = {"profile": {"identification": {"manufacturer": "Dell", "model": "Latitude 7490",
                                       "serialNumber": "HOST-1"}},
        "dataWipeStatus": "wiped",
        "dataWipeMethod": "NVMe crypto erase — verified (reads as random)",
        "wipedAt": "2026-09-19T10:01:07Z", "wipeStartedAt": "2026-09-19T10:00:00Z",
        "wipedDrive": {"serialNumber": "S5H2NS0N", "model": "Samsung SSD 980",
                       "devicePath": "/dev/nvme0n1"},
        "sanitisationLevel": "purge", "verification": "clean",
        "toolName": "als-audit-station", "toolVersion": "2026.09.19"}

try:
    print("a 400 from the API: kept, reason recorded, reported")
    reset()
    out, queued, err = srv.upload_audit(json.loads(json.dumps(WIPE)))
    check("the live POST reached the API once", len(BODIES) == 1, len(BODIES))
    check("upload_audit: queued, no response", out is None and queued is True, (out, queued))
    check("upload_audit: the message is the server's reason, not a network error",
          LOT_REASON in err and "did not accept" in err and "HTTP 400" in err, err)
    q = srv.queue_load()
    check("the record is in the queue, exactly as it was made", q == [WIPE], q)
    rej = srv.rejection_of(WIPE)
    check("the refusal is remembered with the server's reason and status",
          rej and rej["code"] == 400 and rej["reason"] == LOT_REASON, rej)
    st = srv.queue_status()
    check("queue_status: 1 waiting, 1 refused, 1 of them a wipe",
          st["waiting"] == 1 and st["waitingRejected"] == 1 and st["waitingRejectedWipes"] == 1,
          st)
    check("queue_status: the reason and status are reported",
          st["rejected"] == [{"code": 400, "reason": LOT_REASON, "count": 1, "wipes": 1}],
          st["rejected"])
    sent = get("/api/queue")
    check("GET /api/queue reports the refusal (what the page polls)",
          sent[0] == 200 and sent[1]["waitingRejected"] == 1
          and sent[1]["rejected"][0]["reason"] == LOT_REASON, sent)
    boot = get("/api/bootstrap")
    check("GET /api/bootstrap reports it too, and still says 1 waiting",
          boot[0] == 200 and boot[1].get("waitingRejected") == 1 and boot[1].get("waiting") == 1
          and boot[1].get("waitingHeld") == 0 and "queueDurable" in boot[1],
          {k: boot[1].get(k) for k in ("waiting", "waitingHeld", "waitingRejected")})

    print("a refused record is retried - less often - and never changed")
    before = queue_bytes()
    srv.queue_flush()
    check("an immediate flush does not re-send it (retry is throttled)", len(BODIES) == 1,
          len(BODIES))
    age_rejections(srv.REJECT_RETRY_SECS + 1)
    srv.STATE["workflow"] = "goods_in"          # the operator picks a workflow now
    srv.queue_flush()
    check("after the retry interval it IS sent again", len(BODIES) == 2, len(BODIES))
    check("still refused: still queued", srv.queue_load() == [WIPE], srv.queue_load())
    check("the queue file was not rewritten with anything new", queue_bytes() == before,
          (before[:120], queue_bytes()[:120]))
    check("retried as made: no workflow or lot stamped on at flush time",
          all("auditKind" not in b["json"] and "lotId" not in b["json"] for b in BODIES),
          [sorted(b["json"]) for b in BODIES])
    check("every POSTed body is exactly the record that was made",
          all(b["json"] == WIPE for b in BODIES), [b["json"] for b in BODIES])
    check("the stored reason is never in a POSTed body",
          not any(LOT_REASON in b["raw"] or "No audit lot" in b["raw"] or "rejected" in b["raw"]
                  or "\\u2014 pick the lot" in b["raw"] for b in BODIES),
          [b["raw"][:200] for b in BODIES])

    print("the API accepts it once fixed: sent, and the refusal forgotten")
    API["answer"] = (201, {"assetId": "asset-1", "tag": "ALS-1"})
    age_rejections(srv.REJECT_RETRY_SECS + 1)
    srv.queue_flush()
    check("sent", len(BODIES) == 3 and BODIES[-1]["json"] == WIPE, len(BODIES))
    check("the queue is empty", srv.queue_load() == [], srv.queue_load())
    st = srv.queue_status()
    check("nothing reported as refused any more",
          st["waiting"] == 0 and st["waitingRejected"] == 0 and st["rejected"] == [], st)
    check("the refusal was forgotten", srv.REJECTED == {}, srv.REJECTED)

    print("a network error still queues, with no server reason")
    reset()
    srv.STATE["conf"]["AUDIT_URL"] = "http://127.0.0.1:1"       # nothing listens
    out, queued, err = srv.upload_audit(dict(WIPE, wipedAt="2026-09-19T11:00:00Z"))
    srv.STATE["conf"]["AUDIT_URL"] = API_URL
    check("queued", queued is True and len(srv.queue_load()) == 1, (queued, srv.queue_load()))
    check("no server reason recorded", srv.REJECTED == {}, srv.REJECTED)
    check("the message is not a server refusal", "did not accept" not in err, err)
    st = srv.queue_status()
    check("status: 1 waiting, 0 refused", st["waiting"] == 1 and st["waitingRejected"] == 0, st)

    print("which HTTP answers are refusals")
    for code, body, want in (
            (500, {"message": "Internal server error"}, False),
            (503, {}, False),
            (401, {"message": "Unauthorized"}, False),
            (408, {"message": "Request Timeout"}, False),
            (409, {"message": "Conflict"}, False),
            (429, {"message": "Too Many Requests"}, False),
            (403, {"message": "This account has been disabled."}, False),
            (403, {"message": "You do not have access to this lot."}, True),
            (404, {"message": "Lot 9 not found"}, True),
            (400, {"message": ["profile must be an object", "lotId must be a UUID"]}, True)):
        reset()
        srv.STATE["token"] = None
        API["answer"] = (code, body)
        _o, queued, err = srv.upload_audit(dict(WIPE, notes="case %d" % code))
        rej = srv.rejection_of(dict(WIPE, notes="case %d" % code))
        check("HTTP %d %s: %s" % (code, str(body.get("message"))[:40],
                                  "refusal" if want else "not a refusal, just queued"),
              queued and bool(rej) == want and len(srv.queue_load()) == 1, (rej, err))
    check("a validation 400 (a list of messages): the messages are joined",
          rej and rej["reason"] == "profile must be an object; lotId must be a UUID", rej)

    print("a refusal noted on a retry (the record was first queued offline)")
    reset()
    srv.queue_write([WIPE])                      # queued by an earlier boot, offline
    API["answer"] = (400, {"message": LOT_REASON})
    srv.queue_flush()
    check("the flush noted the refusal", (srv.rejection_of(WIPE) or {}).get("reason") == LOT_REASON,
          srv.REJECTED)
    check("...and kept the record", srv.queue_load() == [WIPE], srv.queue_load())
    # A later network failure does not wipe out what the server said.
    age_rejections(srv.REJECT_RETRY_SECS + 1)
    srv.STATE["conf"]["AUDIT_URL"] = "http://127.0.0.1:1"
    srv.queue_flush()
    srv.STATE["conf"]["AUDIT_URL"] = API_URL
    check("a network error on the retry keeps the last server reason shown",
          srv.queue_status()["waitingRejected"] == 1, srv.queue_status())

    print("a wipe whose record is refused: the run panel says the server refused it")
    reset()
    JOBS = []
    srv.SCRIPT = "/fake/hardware-audit.sh"
    srv.audit_cmd = lambda *a, **k: list(a)
    srv.list_drives = lambda *a, **k: [{"device": "/dev/nvme0n1", "model": "Samsung SSD 980",
                                        "serial": "S5H2NS0N", "bytes": 512110190592,
                                        "rotational": False, "transport": "nvme"}]
    srv.start_job = lambda kind, argv, marker, device="", on_done=None, **kw: (
        JOBS.append(on_done) or True)          # never runs an engine
    srv.STATE["profile"] = {"identification": {"serialNumber": "HOST-1"},
                            "storage": [{"serialNumber": "S5H2NS0N"}]}
    srv.STATE["workflow"] = "goods_in"
    h = srv.Handler.__new__(srv.Handler)
    raw = json.dumps({"devices": ["/dev/nvme0n1"]}).encode()
    h.path, h.headers, h.rfile = "/api/wipe/start", {"Content-Length": str(len(raw))}, io.BytesIO(raw)
    h._send = lambda code, payload, ctype=None: setattr(h, "sent", (code, payload))
    h.do_POST()
    check("goods_in wipe with no lot on the page: started (the API may use the active lot)",
          h.sent[0] == 200 and len(JOBS) == 1, h.sent)
    API["answer"] = (400, {"message": LOT_REASON})
    res = {"status": "wiped", "method": "NVMe crypto erase", "device": "/dev/nvme0n1"}
    JOBS[0](res)
    check("the result says queued, and why: the server's reason, not 'no connection'",
          res.get("queued") and LOT_REASON in (res.get("recordError") or "")
          and "no connection" not in (res.get("recordError") or ""), res)
    q = srv.queue_load()
    check("the wipe record is kept, carrying the workflow it was made under",
          len(q) == 1 and q[0].get("auditKind") == "goods_in" and "lotId" not in q[0], q)

    print("a failed STATION sign-in is not the server refusing the record")
    # Flag off, authed_api signs the shared account in first, through the same
    # api(). A 400 from /auth/login (a short AUDIT_PASSWORD fails LoginDto) or
    # a 404 (AUDIT_URL points at the wrong path) is about the station, not the
    # record: the record never reached /devices/hardware-audit. Reporting it
    # as "not accepted by the server" blamed the record, and throttled its
    # retry for 10 minutes after the password had been fixed.
    for code, body in ((400, {"message": ["password must be longer than or equal to 8 characters"]}),
                       (404, {"message": "Cannot POST /api/auth/login"})):
        reset()
        srv.STATE["token"] = None
        API["answer"] = (201, {"assetId": "asset-1", "tag": "ALS-1"})
        API["login"] = (code, body)
        rec = dict(WIPE, notes="login %d" % code)
        _o, queued, err = srv.upload_audit(rec)
        check("login HTTP %d: the record never reached the API" % code, BODIES == [], BODIES)
        check("login HTTP %d: queued, and NOT noted as a refusal of the record" % code,
              queued and srv.rejection_of(rec) is None and srv.REJECTED == {},
              (queued, srv.REJECTED))
        check("login HTTP %d: the message is about the station's sign-in" % code,
              "did not accept this record" not in err and "sign in" in err.lower(), err)
        st = srv.queue_status()
        check("login HTTP %d: status shows 1 waiting, 0 refused" % code,
              st["waiting"] == 1 and st["waitingRejected"] == 0, st)
        srv.queue_flush()
        check("login HTTP %d: a flush does not note a refusal either" % code,
              srv.REJECTED == {} and srv.queue_status()["waitingRejected"] == 0, srv.REJECTED)
        # Fixed in Settings: the next flush sends it straight away - no
        # throttle was set by a refusal that was never about the record.
        API["login"] = None
        srv.queue_flush()
        check("login HTTP %d: once sign-in works the next flush sends it at once" % code,
              len(BODIES) == 1 and srv.queue_load() == [], (len(BODIES), srv.queue_load()))

    print("the page shows it")
    with open(os.path.join(HERE, "gui", "index.html"), encoding="utf-8") as fh:
        page = fh.read()
    check("index.html has the refused-records banner", 'id="rejBanner"' in page
          and "not accepted by the server" in page)
    check("index.html polls /api/queue on its own", "jget('/api/queue')" in page
          and "setInterval(pollQueue" in page)
finally:
    API_SRV.shutdown()
    shutil.rmtree(TMP, True)

print("")
print("%d passed, %d failed" % (PASS[0], len(FAIL)))
sys.exit(1 if FAIL else 0)
