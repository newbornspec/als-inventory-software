#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Operators sign in at the station with their own account (plan step 27,
owner decision D27), behind AUDIT_OPERATOR_SIGNIN=1 in audit.conf.

Drives the real kiosk backend (tools/gui/server.py): Handler.do_POST for
/api/operator/signin, /api/wipe/start and friends, the real upload_audit and
offline queue, and the real urllib calls - against a FAKE API server on
127.0.0.1 that this test runs itself (login, refresh, hardware-audit), so the
401/refresh/network-down paths go through the same code the station uses.
Nothing leaves this machine. No engine runs: start_job is replaced by a stub
that only keeps the job's record callback, so nothing is ever erased.

Proves:
  - flag on, nobody signed in: /api/wipe/start (and audit, restore) refused,
    and no wipe marker or job is created;
  - flag on and the server unreachable: sign-in fails with a plain "no offline
    sign-in" message and wiping stays refused;
  - a signed-in operator's record goes under THEIR token, with their name;
  - operator A's queued record is NOT sent while B is signed in - not by B's
    flush, not by B's own upload - and IS sent once A signs in again;
  - a wipe A started and B finished is still A's record;
  - an access token near expiry is refreshed; a refused refresh signs the
    operator out; the shared AUDIT_EMAIL account is never used as a fallback;
  - the password never appears in any file the kiosk writes (every file under
    the temp directories this test hands it), nor in its in-memory state;
  - flag off: the old behaviour exactly (shared account, typed operator name,
    no sign-in needed, the sign-in endpoints refuse).

    python3 tools/test-operator-signin.py
"""
import base64
import importlib.util
import io
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("als_server_signin",
                                              os.path.join(HERE, "gui", "server.py"))
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


# Distinctive, so a scan for them cannot hit anything by accident.
PW_A = "Ann-pw-7Qz!x93kLm"
PW_B = "Bob-pw-4Rt#p28vNq"
PW_SHARED = "Shared-pw-9Hs$k51wEe"
USERS = {
    "ann@example.test": (PW_A, {"id": "u-ann", "name": "Ann Operator", "role": "admin",
                                "email": "ann@example.test", "permissions": []}),
    "bob@example.test": (PW_B, {"id": "u-bob", "name": "Bob Operator", "role": "admin",
                                "email": "bob@example.test", "permissions": []}),
    "station@example.test": (PW_SHARED, {"id": "u-station", "name": "Station Account",
                                         "role": "admin", "email": "station@example.test",
                                         "permissions": []}),
}

# ------------------------------------------------------------ fake API ----
API = {"life": 12 * 3600, "auditDown": False, "refreshFails": False, "n": 0}
ACCESS = {}       # access token -> user id
REFRESH = {}      # refresh token -> user id
LOGINS = []       # emails that logged in (never the password)
REFRESHES = []    # user ids refreshed
POSTS = []        # (user id, body) accepted by /devices/hardware-audit
REJECTED = []     # hardware-audit calls refused with 401
# user id -> the 403 message the API's PermissionsGuard answers for that
# account now (apps/api/src/auth/guards/permissions.guard.ts): its token is
# still valid, the account behind it is not.
FORBID = {}


def jwt_like(uid, life):
    API["n"] += 1
    now = int(time.time())
    claims = {"sub": uid, "iat": now, "exp": now + int(life), "n": API["n"]}
    body = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return "eyJhbGciOiJIUzI1NiJ9.%s.sig%d" % (body, API["n"])


def issue(user):
    acc, ref = jwt_like(user["id"], API["life"]), jwt_like(user["id"], 7 * 86400)
    ACCESS[acc], REFRESH[ref] = user["id"], user["id"]
    return {"accessToken": acc, "refreshToken": ref, "tokenType": "bearer", "user": user}


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

    def _forbidden(self):
        uid = ACCESS.get((self.headers.get("Authorization") or "")[len("Bearer "):])
        if uid in FORBID:
            self._json(403, {"statusCode": 403, "message": FORBID[uid], "error": "Forbidden"})
            return True
        return False

    def do_GET(self):  # noqa: N802
        if self._forbidden():
            return None
        if self.path == "/devices/lots":
            return self._json(200, [])
        return self._json(200, {"hello": True})

    def do_POST(self):  # noqa: N802
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}") if n else {}
        if self.path == "/auth/login":
            u = USERS.get(body.get("email"))
            if not u or body.get("password") != u[0]:
                return self._json(401, {"message": "Invalid credentials", "statusCode": 401})
            LOGINS.append(body.get("email"))
            return self._json(200, issue(u[1]))
        if self.path == "/auth/refresh":
            uid = REFRESH.get(body.get("refreshToken"))
            if API["refreshFails"] or not uid:
                return self._json(401, {"message": "Invalid or expired refresh token"})
            REFRESHES.append(uid)
            user = [u for _pw, u in USERS.values() if u["id"] == uid][0]
            return self._json(200, issue(user))
        if self.path == "/devices/hardware-audit":
            # Something that happens at the station WHILE this request is in
            # flight (one shot): e.g. the operator changes hands.
            hook = API.pop("onAudit", None)
            if hook:
                hook()
            if API["auditDown"]:
                return self._json(503, {"message": "down"})
            if self._forbidden():
                return None
            tok = (self.headers.get("Authorization") or "")[len("Bearer "):]
            uid = ACCESS.get(tok)
            if not uid:
                REJECTED.append(tok)
                return self._json(401, {"message": "Unauthorized"})
            POSTS.append((uid, body))
            return self._json(200, {"assetId": "asset-1", "tag": "T1", "name": "Latitude"})
        return self._json(404, {"message": "not found"})


API_SRV = ThreadingHTTPServer(("127.0.0.1", 0), FakeApi)
API_URL = "http://127.0.0.1:%d" % API_SRV.server_address[1]
threading.Thread(target=API_SRV.serve_forever, name="fake-api", daemon=True).start()

# --------------------------------------------------------- the station ----
TMP = tempfile.mkdtemp(prefix="als-operator-signin-")
STICK = os.path.join(TMP, "stick")          # stands in for the stick root
RAM = os.path.join(TMP, "ram")              # stands in for /tmp
os.makedirs(STICK)
os.makedirs(RAM)
CONF = os.path.join(STICK, "audit.conf")
srv.CONF_PATH = CONF
srv.QUEUE_FALLBACK = os.path.join(RAM, "als-audit-queue.jsonl")
srv.PENDING_FALLBACK = os.path.join(RAM, "als-wipe-pending.jsonl")
srv.STICK_VERSION_FILE = os.path.join(TMP, "absent")


def write_conf(signin, url=API_URL):
    lines = ['AUDIT_URL="%s"' % url,
             'AUDIT_EMAIL="station@example.test"',
             'AUDIT_PASSWORD="%s"' % PW_SHARED]
    if signin is not None:
        lines.append('AUDIT_OPERATOR_SIGNIN="%s"' % signin)
    with open(CONF, "w") as fh:
        fh.write("\n".join(lines) + "\n")
    srv.STATE["conf"] = srv.load_conf()


PROFILE = {"identification": {"manufacturer": "Dell", "model": "Latitude 7490",
                              "serialNumber": "HOST-1"},
           "storage": [{"model": "WD Blue", "serialNumber": "W2"}]}
OFFERED = [{"device": "/dev/sda", "model": "WD Blue", "serial": "W2",
            "bytes": 500107862016, "rotational": True, "transport": "sata"}]
JOBS = []

srv.SCRIPT = "/fake/hardware-audit.sh"
srv.audit_cmd = lambda *a, **k: list(a)
srv.list_drives = lambda *a, **k: OFFERED
srv.list_os_images = lambda *a, **k: []
srv.has_optical = lambda: False
srv.STATE["profile"] = json.loads(json.dumps(PROFILE))


def fake_start_job(kind, argv, marker, device="", on_done=None, **kw):
    JOBS.append({"device": device, "on_done": on_done})
    return True


srv.start_job = fake_start_job


class Fake(srv.Handler):
    def __init__(self, path, body=None):
        raw = json.dumps(body or {}).encode()
        self.path = path
        self.headers = {"Content-Length": str(len(raw))}
        self.rfile = io.BytesIO(raw)
        self.sent = None

    def _send(self, code, payload, ctype="application/json"):
        self.sent = (code, payload)


def post(path, body=None):
    h = Fake(path, body)
    h.do_POST()
    return h.sent


def get(path):
    h = Fake(path)
    h.do_GET()
    return h.sent


def settle():
    """Wait for the kiosk's background threads (the flush after a sign-in)."""
    for t in threading.enumerate():
        if t is not threading.current_thread() and t.name != "fake-api" and t.daemon:
            t.join(5)
    time.sleep(0.05)


def wipe():
    """Start a wipe of /dev/sda; returns (http code, message, job or None)."""
    JOBS.clear()
    # The accounts here are admins (both workflows), and a sign-out forgets
    # the workflow: pick Goods In the way the operator would at the top of
    # the screen, or the wipe is refused for having none (that refusal is
    # tested in test-wipe-workflow.py; this file is about WHO files).
    if not srv.current_workflow() and "goods_in" in srv.allowed_workflows():
        post("/api/workflow", {"workflow": "goods_in"})
    sent = post("/api/wipe/start", {"devices": ["/dev/sda"]})
    return sent[0], (sent[1] or {}).get("message", ""), (JOBS[0] if JOBS else None)


def finish(job):
    res = {"status": "wiped", "method": "Overwrite + verify", "device": "/dev/sda",
           "finishedAt": "2026-09-19T10:01:07Z"}
    job["on_done"](res)
    return res


def signin(email, pw):
    return post("/api/operator/signin", {"email": email, "password": pw})


def uid_of(email):
    return USERS[email][1]["id"]


try:
    # ================================================================ OFF ==
    print("flag off: exactly the old behaviour")
    write_conf(None)
    check("no AUDIT_OPERATOR_SIGNIN: off", srv.operator_signin_on() is False)
    write_conf("0")
    check("AUDIT_OPERATOR_SIGNIN=0: off", srv.operator_signin_on() is False)
    sent = post("/api/operator", {"name": "Pat at bench 3"})
    check("off: the typed operator name is accepted", sent[0] == 200, sent)
    code, msg, job = wipe()
    check("off: a wipe starts with nobody signed in", code == 200 and job, (code, msg))
    POSTS.clear()
    res = finish(job) if job else {}
    check("off: the record goes under the SHARED account",
          len(POSTS) == 1 and POSTS[0][0] == "u-station", POSTS)
    body = POSTS[0][1] if POSTS else {}
    check("off: operatorName is the typed name", body.get("operatorName") == "Pat at bench 3", body)
    check("off: no station-only tag reaches the API", srv.OPERATOR_TAG not in body, body)
    check("off: recorded on screen", res.get("recorded") is True, res)
    boot = get("/api/bootstrap")[1]
    check("off: bootstrap says sign-in is not required",
          boot.get("signin", {}).get("required") is False, boot.get("signin"))
    check("off: the header still shows the shared account", boot.get("currentUser") == "Station Account",
          boot.get("currentUser"))
    sent = signin("ann@example.test", PW_A)
    check("off: the sign-in endpoint refuses", sent[0] == 409, sent)
    check("off: ...and did not log anyone in", "ann@example.test" not in LOGINS, LOGINS)
    # A record queued under the shared account while the flag was off.
    API["auditDown"] = True
    code, msg, job = wipe()
    res = finish(job)
    API["auditDown"] = False
    check("off: offline record queued, untagged", res.get("queued") and
          srv.OPERATOR_TAG not in (srv.queue_load() or [{}])[0], srv.queue_load())

    # ================================================================= ON ==
    print("flag on: nobody signed in")
    write_conf("1")
    srv.STATE["token"] = None                 # a fresh boot with the flag on
    srv.STATE["userName"] = ""
    LOGINS.clear()
    check("AUDIT_OPERATOR_SIGNIN=1: on", srv.operator_signin_on() is True)
    code, msg, job = wipe()
    check("on, nobody signed in: wipe refused", code in (401, 409) and job is None, (code, msg))
    check("on, nobody signed in: the message says to sign in", "Sign in" in msg, msg)
    check("on, nobody signed in: no wipe marker written", srv._pending_load_unlocked() == [],
          srv._pending_load_unlocked())
    sent = post("/api/audit", {})
    check("on, nobody signed in: audit refused", sent[0] == 401, sent)
    sent = post("/api/operator", {"name": "Typed Name"})
    check("on: a typed operator name is refused", sent[0] == 409, sent)
    check("on: the shared account was never logged in", LOGINS == [], LOGINS)
    boot = get("/api/bootstrap")[1]
    check("on: bootstrap says sign-in required, nobody signed in",
          boot["signin"]["required"] is True and boot["signin"]["signedIn"] is False, boot["signin"])
    check("on: the header does not show the shared account",
          boot.get("currentUser") == "Not signed in", boot.get("currentUser"))
    check("on: the untagged shared-account record is held, not sent",
          boot.get("waitingHeld") == 1, boot.get("waitingHeld"))
    try:
        srv.login()
        check("on: login() refuses the shared account", False)
    except srv.SignInRequired:
        check("on: login() refuses the shared account", True)

    print("flag on: offline")
    write_conf("1", url="http://127.0.0.1:9")    # nothing listens on port 9
    sent = signin("ann@example.test", PW_A)
    check("offline: sign-in fails", sent[0] == 401, sent)
    check("offline: says there is no offline sign-in",
          "no offline sign-in" in (sent[1] or {}).get("message", ""), sent)
    srv.STATE["error"] = "Could not reach the server"
    code, msg, job = wipe()
    check("offline: wipe refused", code == 401 and job is None, (code, msg))
    check("offline: the refusal says the network is needed to sign in",
          "no offline sign-in" in msg, msg)
    srv.STATE["error"] = None
    write_conf("1")

    print("flag on: wrong password")
    sent = signin("ann@example.test", "wrong-password-1")
    check("wrong password: 401, plain words", sent[0] == 401 and
          "not accepted" in sent[1].get("message", ""), sent)
    check("wrong password: nobody signed in", srv.operator_identity() is None)

    print("flag on: operator A signs in and wipes")
    sent = signin("ann@example.test", PW_A)
    check("A signs in", sent[0] == 200 and sent[1].get("name") == "Ann Operator", sent)
    settle()
    boot = get("/api/bootstrap")[1]
    check("header shows A", boot.get("currentUser") == "Ann Operator", boot.get("currentUser"))
    check("A's sign-in did not send the shared-account record",
          all(p[0] != "u-ann" or p[1].get("operatorName") == "Ann Operator" for p in POSTS)
          and srv.queue_count() == 1, (POSTS, srv.queue_load()))
    POSTS.clear()
    code, msg, job = wipe()
    check("A signed in: wipe starts", code == 200 and job, (code, msg))
    finish(job)
    check("A's record goes under A's token", len(POSTS) == 1 and POSTS[0][0] == "u-ann", POSTS)
    body = POSTS[0][1] if POSTS else {}
    check("A's record names A", body.get("operatorName") == "Ann Operator", body)
    check("A's record: the station-only tag is not sent", srv.OPERATOR_TAG not in body, body)

    print("operator A's queued record is not sent under operator B")
    API["auditDown"] = True
    code, msg, job = wipe()
    res = finish(job)
    API["auditDown"] = False
    q = [it for it in srv.queue_load() if it.get(srv.OPERATOR_TAG)]
    check("A offline: record queued, tagged A", res.get("queued") and len(q) == 1 and
          q[0][srv.OPERATOR_TAG]["id"] == "u-ann", q)
    # A wipe A starts and is still running when A signs out.
    code, msg, running = wipe()
    check("A starts a second wipe", code == 200 and running, (code, msg))
    post("/api/operator/signout")
    check("A signed out", srv.operator_identity() is None)
    code, msg, job = wipe()
    check("after sign-out: wiping refused again", code == 401 and job is None, (code, msg))
    POSTS.clear()
    sent = signin("bob@example.test", PW_B)
    check("B signs in", sent[0] == 200, sent)
    settle()
    srv.queue_flush()
    check("B's flush did not send A's record", all(p[0] != "u-bob" or
          p[1].get("operatorName") == "Bob Operator" for p in POSTS) and
          not any(p[1].get("operatorName") == "Ann Operator" for p in POSTS), POSTS)
    check("A's record is still queued", any((it.get(srv.OPERATOR_TAG) or {}).get("id") == "u-ann"
                                            for it in srv.queue_load()), srv.queue_load())
    res = finish(running)                       # A's wipe ends while B is signed in
    check("A's running wipe, finished under B: NOT sent under B",
          not any(p[0] == "u-bob" and p[1].get("operatorName") == "Ann Operator" for p in POSTS)
          and not any(p[1].get("operatorName") == "Ann Operator" for p in POSTS), POSTS)
    check("...it is queued for A, and the screen says so",
          res.get("queued") and "Ann Operator" in (res.get("recordError") or ""), res)
    boot = get("/api/bootstrap")[1]
    check("bootstrap: A's two records (and the shared one) are held while B is signed in",
          boot.get("waitingHeld") == 3, (boot.get("waitingHeld"), srv.queue_load()))
    code, msg, job = wipe()
    finish(job)
    check("B's own record goes under B, naming B", POSTS and POSTS[-1][0] == "u-bob" and
          POSTS[-1][1].get("operatorName") == "Bob Operator", POSTS[-1:])
    post("/api/operator/signout")
    POSTS.clear()
    signin("ann@example.test", PW_A)
    settle()
    srv.queue_flush()
    mine = [p for p in POSTS if p[1].get("operatorName") == "Ann Operator"]
    check("A signs in again: A's queued records are sent, under A",
          len(mine) == 2 and all(p[0] == "u-ann" for p in mine), POSTS)
    check("the queued record kept its wipe date", all(p[1].get("wipedAt") == "2026-09-19T10:01:07Z"
                                                      for p in mine), mine)
    left = srv.queue_load()
    check("only the shared-account record is left, still held",
          len(left) == 1 and srv.OPERATOR_TAG not in left[0], left)

    print("a restart mid-wipe keeps the operator who started it")
    code, msg, job = wipe()
    marker = srv._pending_load_unlocked()
    check("the marker on the stick carries A's tag",
          marker and ((marker[-1].get("base") or {}).get(srv.OPERATOR_TAG) or {}).get("id") == "u-ann",
          marker)
    post("/api/operator/signout")
    n = srv.recover_pending_wipes()
    rec = [it for it in srv.queue_load() if it.get("dataWipeStatus") == "failed"]
    check("recovered as failed, tagged A", n >= 1 and rec and
          rec[-1][srv.OPERATOR_TAG]["id"] == "u-ann", rec)
    srv.queue_write([it for it in srv.queue_load() if it.get("dataWipeStatus") != "failed"])

    print("token expiry")
    API["life"] = 100                            # inside the 120 s renew margin
    POSTS.clear()
    signin("bob@example.test", PW_B)
    settle()
    REFRESHES.clear()
    tok1 = srv.OPERATOR.get("token")
    tok2 = srv.operator_token()
    check("near expiry: the token is refreshed", REFRESHES and REFRESHES[-1] == "u-bob"
          and tok2 != tok1, REFRESHES)
    API["life"] = 12 * 3600
    # The server stops honouring the access token (revoked, or expired early):
    # one refresh and a retry, still as Bob.
    ACCESS.pop(srv.OPERATOR.get("token"), None)
    REFRESHES.clear()
    code, msg, job = wipe()
    finish(job)
    check("401 on upload: refreshed once, sent as the same operator",
          REFRESHES == ["u-bob"] and POSTS and POSTS[-1][0] == "u-bob", (REFRESHES, POSTS[-1:]))
    # The refresh itself is refused: signed out, asked to sign in again.
    LOGINS.clear()
    API["refreshFails"] = True
    srv.OPERATOR["expiresMono"] = 0.0
    code, msg, job = wipe()
    check("refused refresh: wipe refused", code == 401 and job is None, (code, msg))
    check("refused refresh: says sign in again", "sign in again" in msg.lower(), msg)
    check("refused refresh: signed out", srv.operator_identity() is None)
    check("refused refresh: NEVER falls back to the shared account",
          "station@example.test" not in LOGINS and srv.STATE.get("token") in (None, ""), LOGINS)
    boot = get("/api/bootstrap")[1]
    check("refused refresh: the sign-in panel says why",
          "sign in again" in boot["signin"].get("message", "").lower(), boot["signin"])
    API["refreshFails"] = False

    print("a record is never sent under whoever signed in while it was in flight")
    ann_user, bob_user = USERS["ann@example.test"][1], USERS["bob@example.test"][1]
    signin("ann@example.test", PW_A)
    settle()
    code, msg, job = wipe()
    check("Ann starts a wipe", code == 200 and job, (code, msg))

    def hands_change():
        # Ann's token stops being honoured (it ran out across a lid-close
        # suspend, which the monotonic countdown does not see, or her sessions
        # were revoked) and, while her upload is in flight, she signs out and
        # Bob signs in.
        for t, u in list(ACCESS.items()):
            if u == "u-ann":
                ACCESS.pop(t)
        srv.operator_signout()
        with srv.OPERATOR_LOCK:
            srv._operator_set(issue(bob_user))
    POSTS.clear()
    REFRESHES.clear()
    before = srv.queue_count()
    API["onAudit"] = hands_change
    res = finish(job)
    check("401 after the operator changed hands: nothing posted under Bob",
          not any(p[0] == "u-bob" for p in POSTS), POSTS)
    check("...nothing posted at all, and Bob's session was not refreshed for it",
          POSTS == [] and REFRESHES == [], (POSTS, REFRESHES))
    q = srv.queue_load()
    check("...the record is queued, still tagged Ann",
          res.get("queued") and srv.queue_count() == before + 1 and
          (q[-1].get(srv.OPERATOR_TAG) or {}).get("id") == "u-ann", (res, q[-1:]))
    check("...the screen says it waits for Ann, not 'no connection'",
          "Ann Operator" in (res.get("recordError") or ""), res.get("recordError"))
    check("...Bob is still the one signed in", (srv.operator_identity() or {}).get("id") == "u-bob")

    # The narrower window with no 401 at all: the record is checked as Bob's,
    # then Ann signs in before its token is read.
    item = srv.stamp_provenance({"profile": PROFILE, "dataWipeStatus": "wiped",
                                 "dataWipeMethod": "m", "wipedAt": "2026-09-19T11:00:00Z"})
    real_held = srv.held_reason

    def held_then_swap(it):
        why = real_held(it)
        srv.held_reason = real_held
        srv.operator_signout()
        with srv.OPERATOR_LOCK:
            srv._operator_set(issue(ann_user))
        return why
    POSTS.clear()
    srv.held_reason = held_then_swap
    try:
        out, queued, err = srv.upload_audit(dict(item))
    finally:
        srv.held_reason = real_held
    check("hands change between the check and the send: not sent under Ann",
          POSTS == [], POSTS)
    check("...queued, still tagged Bob", queued and
          (srv.queue_load()[-1].get(srv.OPERATOR_TAG) or {}).get("id") == "u-bob", (queued, err))
    srv.operator_signout()

    print("audit.conf unreadable: the sign-in gate stays shut")
    write_conf("1")
    os.rename(CONF, CONF + ".gone")
    try:
        srv.STATE["conf"] = srv.load_conf()     # what refresh() does on every Rescan
        check("a read error after the flag was seen on: still on", srv.operator_signin_on() is True)
        check("...and the settings it had are kept", srv.STATE["conf"].get("AUDIT_URL") == API_URL,
              srv.STATE["conf"])
        code, msg, job = wipe()
        check("...wipe still refused with nobody signed in", code == 401 and job is None, (code, msg))
        # A station that has never managed to read its conf does not know
        # whether its operators must sign in: fail closed.
        srv.STATE["conf"] = {}
        getattr(srv, "CONF_READ", {})["ok"] = False
        srv.STATE["conf"] = srv.load_conf()
        code, msg, job = wipe()
        check("conf never read: wipe refused", code == 503 and job is None, (code, msg))
        check("...saying audit.conf could not be read", "audit.conf" in msg, msg)
        check("...no wipe marker written", srv._pending_load_unlocked() == [],
              srv._pending_load_unlocked())
    finally:
        os.rename(CONF + ".gone", CONF)
    write_conf("0")
    check("a successful read that says off: off", srv.operator_signin_on() is False)
    code, msg, job = wipe()
    check("...and wiping works as before", code == 200 and job, (code, msg))
    write_conf("1")

    print("a 403 that ENDS the session signs the operator out (HARDWARE-TESTS Test 4, 7.2)")
    # The API answers 403, not 401, when the token is still valid but the
    # account behind it is not: password changed, disabled, deleted. The
    # kiosk only acted on 401, so the operator stayed "signed in" while every
    # upload failed with a bare HTTP 403.
    write_conf("1")
    srv.operator_signout()
    signin("ann@example.test", PW_A)
    settle()
    with srv.QUEUE_LOCK:                             # start from an empty queue
        srv._queue_write_unlocked([])
    POSTS.clear()
    LOGINS.clear()
    FORBID["u-ann"] = "Your password was changed. Please sign in again."
    code, msg, job = wipe()
    check("password changed on the web: the wipe itself still starts (its token is valid)",
          code == 200 and job, (code, msg))
    finish(job)
    check("...its upload is refused: nothing filed", POSTS == [], POSTS)
    q = srv.queue_load()
    check("...the record is kept, waiting to upload, still Ann's",
          len(q) == 1 and (q[0].get(srv.OPERATOR_TAG) or {}).get("id") == "u-ann", q)
    check("...and Ann is signed out", srv.operator_identity() is None, srv.OPERATOR)
    boot = get("/api/bootstrap")[1]
    check("...the sign-in panel gives the server's reason",
          "password was changed" in boot["signin"].get("message", "").lower()
          and not boot["signin"].get("signedIn"), boot["signin"])
    check("...no fallback to the shared account", "station@example.test" not in LOGINS, LOGINS)
    code, msg, job = wipe()
    check("...the next wipe waits for a sign-in", code == 401 and job is None, (code, msg))
    FORBID.clear()                                   # the new password's token is fine
    signin("ann@example.test", PW_A)
    settle()
    check("signing in again uploads the held record, as Ann",
          [u for u, _b in POSTS] == ["u-ann"] and srv.queue_load() == [], (POSTS, srv.queue_load()))

    print("a disabled account is signed out by a lookup too, not only by an upload")
    srv.operator_signout()
    signin("bob@example.test", PW_B)
    settle()
    FORBID["u-bob"] = "This account has been disabled."
    code, ans = get("/api/wipe/eligibility?assetId=asset-1")
    check("the lookup answers 'unknown', not an error page", code == 200 and ans.get("known") is False,
          (code, ans))
    check("...and Bob is signed out", srv.operator_identity() is None, srv.OPERATOR)
    boot = get("/api/bootstrap")[1]
    check("...the panel says the account was disabled",
          "disabled" in boot["signin"].get("message", "").lower(), boot["signin"])
    FORBID.clear()

    print("a 403 about the REQUEST is not a session end")
    signin("ann@example.test", PW_A)
    settle()
    POSTS.clear()
    FORBID["u-ann"] = "You don't have permission to do this."
    code, msg, job = wipe()
    finish(job)
    check("no permission for one call: still signed in", (srv.operator_identity() or {}).get("id") == "u-ann",
          srv.OPERATOR)
    check("...the record is kept to retry", POSTS == [] and len(srv.queue_load()) == 1, srv.queue_load())
    # It is a refusal of THIS record, not a session end: shown with the
    # server's reason and retried less often (test-queue-rejection.py). Wind
    # the clock past that interval instead of waiting it out.
    check("...and the server's reason is shown with it",
          srv.queue_status()["rejected"][:1] == [{"code": 403, "count": 1, "wipes": 1,
                                                  "reason": "You don't have permission to do this."}],
          srv.queue_status())
    FORBID.clear()
    with srv.REJECTED_LOCK:
        for v in srv.REJECTED.values():
            v["at"] -= srv.REJECT_RETRY_SECS + 1
    srv.queue_flush()
    check("...and goes once the server accepts it", [u for u, _b in POSTS] == ["u-ann"], POSTS)
    srv.operator_signout()

    print("flag off: a session-ending 403 drops the shared account's cached token")
    write_conf("0")
    srv.STATE["token"] = None
    POSTS.clear()
    LOGINS.clear()
    srv.ensure_token()
    FORBID["u-station"] = "Your password was changed. Please sign in again."
    code, msg, job = wipe()
    finish(job)
    check("shared account refused: nothing filed, record queued",
          POSTS == [] and len(srv.queue_load()) == 1, (POSTS, srv.queue_load()))
    check("...the stale token is dropped", srv.STATE.get("token") is None, srv.STATE.get("token"))
    FORBID.clear()
    LOGINS.clear()
    srv.queue_flush()
    check("...the next send signs in again and files it",
          LOGINS == ["station@example.test"] and [u for u, _b in POSTS] == ["u-station"], (LOGINS, POSTS))
    write_conf("1")

    print("the browser is not invited to keep or fill the password")
    with open(os.path.join(HERE, "gui", "index.html"), encoding="utf-8") as fh:
        html = fh.read()
    m = re.search(r'<input id="signPass"[^>]*>', html)
    check("the sign-in password field is autocomplete=new-password (never autofilled "
          "with a saved login)", bool(m) and 'autocomplete="new-password"' in m.group(0),
          m.group(0) if m else "no field")

    print("the password is never written anywhere")
    signin("ann@example.test", PW_A)
    settle()
    API["auditDown"] = True
    code, msg, job = wipe()
    finish(job)                                  # queued on the "stick"
    API["auditDown"] = False
    wipe()                                       # leaves a wipe marker too
    sent = post("/api/audit", {})
    written = []
    for root, _dirs, files in os.walk(TMP):
        for f in files:
            p = os.path.join(root, f)
            with open(p, "rb") as fh:
                written.append((p, fh.read()))
    check("the kiosk did write files there (queue, markers)",
          any("audit-queue" in p for p, _ in written) and
          any("wipe-pending" in p for p, _ in written), [p for p, _ in written])
    for pw in (PW_A, PW_B):
        leaks = [p for p, raw in written if pw.encode() in raw]
        check("password %s... in no file the kiosk wrote" % pw[:6], leaks == [], leaks)
    state_dump = json.dumps({"STATE": srv.STATE, "OP": srv.OPERATOR}, default=str)
    check("passwords not kept in memory state", PW_A not in state_dump and PW_B not in state_dump)
    boot_raw = json.dumps(get("/api/bootstrap")[1])
    check("passwords not in what the page is sent", PW_A not in boot_raw and PW_B not in boot_raw)
    check("the access token is not sent to the page",
          srv.OPERATOR.get("token") not in boot_raw)
finally:
    API_SRV.shutdown()
    shutil.rmtree(TMP, ignore_errors=True)

print("")
print("%d passed, %d failed" % (PASS[0], len(FAIL)))
sys.exit(1 if FAIL else 0)
