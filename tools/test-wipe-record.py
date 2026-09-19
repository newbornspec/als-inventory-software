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
OFFERED = [{"device": "/dev/nvme0n1", "model": "Samsung SSD", "serial": "S1",
            "bytes": 512110190592, "rotational": False, "transport": "nvme"},
           {"device": "/dev/sda", "model": "WD Blue", "serial": "W2",
            "bytes": 500107862016, "rotational": True, "transport": "sata"},
           # Internal, but plugged in AFTER the capture: not in the profile.
           {"device": "/dev/sdb", "model": "Hot-plugged", "serial": "FOREIGN-9"},
           # A drive that reports no serial at all (owner decision D18: allowed).
           {"device": "/dev/sdc", "model": "Unknown model", "serial": ""}]
REAL = {"start_job": srv.start_job, "upload_audit": srv.upload_audit,
        "audit_cmd": srv.audit_cmd}
JOBS = []          # (device, argv, on_done, kwargs) per start_job call
UPLOADS = []


srv.CONF_PATH = None
PFILE = os.path.join(TMP, "wipe-pending.jsonl")
srv.PENDING_FALLBACK = PFILE
srv.QUEUE_FALLBACK = os.path.join(TMP, "queue.jsonl")
BUSY = {"on": False}


def pending():
    return srv._pending_load_unlocked()


def fake_start_job(kind, argv, marker, device="", on_done=None, **kw):
    JOBS.append({"device": device, "argv": list(argv), "on_done": on_done, "kw": kw,
                 # What was on disk at the moment the engine would have started.
                 "pendingAtStart": pending()})
    return not BUSY["on"]


def fake_upload(payload):
    UPLOADS.append(json.loads(json.dumps(payload)))
    return {"assetId": "asset-1", "tag": "T1"}, False, ""


REAL_LIST_DRIVES = srv.list_drives
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

    print("only drives that were in the captured profile")

    # THE CASE. /dev/sdb is internal and offered by lsblk, but its serial was
    # not in the profile - it was plugged in (or swapped) after the capture.
    sent = start(["/dev/sdb"])
    check("drive not in the profile: 409", sent[0] == 409, sent)
    check("drive not in the profile: nothing started", JOBS == [], JOBS)
    check("drive not in the profile: says press Rescan", "Rescan" in sent[1].get("message", ""), sent)
    sent = start(["/dev/nvme0n1", "/dev/sdb"])
    check("mixed with a good drive: refused whole", sent[0] == 409 and JOBS == [], (sent, JOBS))

    # The expected serial goes to the engine as gui_wipe_one's 3rd argument.
    sent = start(["/dev/nvme0n1"])
    check("known drive: starts", sent[0] == 200 and len(JOBS) == 1, sent)
    check("expected serial passed to the engine as the 3rd wipe argument",
          JOBS and JOBS[0]["argv"] == ["--wipe-drive", "/dev/nvme0n1", "auto", "S1"], JOBS)
    check("a wipe job asks for a record even if it dies",
          JOBS and JOBS[0]["kw"].get("record_on_no_result") is True, JOBS)

    # No serial: allowed, no serial argument, recorded as identity unknown.
    sent = start(["/dev/sdc"])
    check("drive with no serial: allowed (D18)", sent[0] == 200 and len(JOBS) == 1, sent)
    check("drive with no serial: no serial argument",
          JOBS and JOBS[0]["argv"] == ["--wipe-drive", "/dev/sdc", "auto"], JOBS)
    JOBS[0]["on_done"]({"status": "wiped", "method": "overwrite", "device": "/dev/sdc"})
    p = UPLOADS[-1] if UPLOADS else {}
    wd = p.get("wipedDrive") or {}
    check("no serial: recorded by device path, no serialNumber",
          wd.get("devicePath") == "/dev/sdc" and "serialNumber" not in wd, wd)
    check("no serial: lsblk's 'Unknown model' placeholder is not sent as a model",
          "model" not in wd, wd)
    check("no serial: the record says identity unknown", "identity unknown" in (p.get("notes") or ""), p)

    print("each drive's record carries its own identity and dates")

    sent = start(["/dev/nvme0n1", "/dev/sda"])
    check("two drives: two jobs", sent[0] == 200 and len(JOBS) == 2, (sent, JOBS))
    for j in JOBS:
        j["on_done"]({"status": "wiped", "method": "m", "device": j["device"]})
    serials = [(u.get("wipedDrive") or {}).get("serialNumber") for u in UPLOADS]
    paths = [(u.get("wipedDrive") or {}).get("devicePath") for u in UPLOADS]
    check("two drives: two payloads", len(UPLOADS) == 2, UPLOADS)
    check("two drives: different serials", sorted(serials) == ["S1", "W2"], serials)
    check("two drives: each its own device path", sorted(paths) == ["/dev/nvme0n1", "/dev/sda"], paths)
    check("both records: the same machine profile",
          all(u["profile"]["identification"]["serialNumber"] == "HOST-1" for u in UPLOADS), UPLOADS)

    # A new engine's full WIPE_RESULT (contract C1) is carried through (C2).
    sent = start(["/dev/nvme0n1"])
    JOBS[0]["on_done"]({
        "status": "wiped", "device": "/dev/nvme0n1",
        "method": "NVMe crypto erase — verified (reads as random)", "reason": "",
        "toolVersion": "2026.09.19",
        "startedAt": "2026-09-19T10:00:00Z", "finishedAt": "2026-09-19T10:01:07Z",
        "drive": {"serialNumber": "S1", "model": "Samsung SSD 980", "sizeBytes": 512110190592,
                  "transport": "nvme", "rotational": False, "wwn": "eui.0025"},
        "methodRequested": "auto", "methodAttempted": "nvme-sanitize-crypto",
        "fallbackReason": "", "sanitisationLevel": "purge", "verification": "clean",
        "hiddenAreas": "none", "limitations": ["one", "", 7],
        "smart": {"reallocatedBefore": 0, "pendingBefore": 0, "reallocatedAfter": 0,
                  "pendingAfter": 0, "junk": "x"}})
    p = UPLOADS[-1]
    check("wipedAt = finishedAt", p.get("wipedAt") == "2026-09-19T10:01:07Z", p)
    check("wipeStartedAt = startedAt", p.get("wipeStartedAt") == "2026-09-19T10:00:00Z", p)
    check("wipedDrive from the engine, plus devicePath",
          p.get("wipedDrive") == {"serialNumber": "S1", "model": "Samsung SSD 980",
                                  "sizeBytes": 512110190592, "transport": "nvme",
                                  "rotational": False, "wwn": "eui.0025",
                                  "devicePath": "/dev/nvme0n1"}, p.get("wipedDrive"))
    check("method fields passed through",
          (p.get("methodRequested"), p.get("methodAttempted"), p.get("sanitisationLevel"),
           p.get("verification"), p.get("hiddenAreas")) ==
          ("auto", "nvme-sanitize-crypto", "purge", "clean", "none"), p)
    check("empty fallbackReason omitted, not sent empty", "fallbackReason" not in p, p)
    check("limitations -> wipeLimitations, strings only", p.get("wipeLimitations") == ["one"], p)
    check("smart -> wipeSmart, numbers only",
          p.get("wipeSmart") == {"reallocatedBefore": 0, "pendingBefore": 0,
                                 "reallocatedAfter": 0, "pendingAfter": 0}, p)
    check("no notes on a clean wipe", "notes" not in p, p)

    print("step 38: why a requested method was not used, bad sectors, BIOS lock")

    # A purge asked for, an overwrite achieved (the BIOS froze the drive): the
    # record carries all of it, not just the achieved label.
    sent = start(["/dev/sda"])
    JOBS[0]["on_done"]({
        "status": "wiped", "device": "/dev/sda", "method": "Overwrite + verify",
        "methodRequested": "secure", "methodAttempted": "ata-secure-erase,overwrite",
        "fallbackReason": "frozen", "sanitisationLevel": "clear", "verification": "clean",
        "hiddenAreas": "unknown",
        "limitations": ["12 reallocated sectors were not overwritten",
                        "Hidden areas could not be checked"],
        "smart": {"reallocatedBefore": 12, "pendingBefore": 0, "reallocatedAfter": 12,
                  "pendingAfter": None}})
    p = UPLOADS[-1]
    check("fallback: requested / attempted / reason / level all forwarded",
          (p.get("methodRequested"), p.get("methodAttempted"), p.get("fallbackReason"),
           p.get("sanitisationLevel"), p.get("verification"), p.get("hiddenAreas")) ==
          ("secure", "ata-secure-erase,overwrite", "frozen", "clear", "clean", "unknown"), p)
    check("fallback: the achieved method is still dataWipeMethod",
          p.get("dataWipeMethod") == "Overwrite + verify", p)
    check("limitations forwarded in order as wipeLimitations",
          p.get("wipeLimitations") == ["12 reallocated sectors were not overwritten",
                                       "Hidden areas could not be checked"], p)
    check("SMART counts forwarded, an unread count kept as null",
          p.get("wipeSmart") == {"reallocatedBefore": 12, "pendingBefore": 0,
                                 "reallocatedAfter": 12, "pendingAfter": None}, p)
    check("the engine's methodRequested wins over the station's default",
          p.get("methodRequested") == "secure", p)

    # biosLocked from the lock report captured with the profile. Old kiosk
    # records never carried it at all.
    check("no lock report in the profile: biosLocked left out", "biosLocked" not in p, p)

    def with_locks(locks):
        srv.STATE["profile"] = dict(json.loads(json.dumps(PROFILE)), locks=locks)
        start(["/dev/sda"])
        JOBS[0]["on_done"]({"status": "wiped", "method": "m", "device": "/dev/sda"})
        return UPLOADS[-1] if UPLOADS else {}

    try:
        p = with_locks({"status": "LOCKED", "checks": [
            {"key": "autopilot", "status": "PASS", "detail": "not registered"},
            {"key": "bios_pw", "status": "LOCKED", "detail": "supervisor password set"}]})
        check("a LOCKED check: biosLocked true", p.get("biosLocked") is True, p.get("biosLocked"))
        p = with_locks({"status": "CLEAR", "checks": [
            {"key": "bios_pw", "status": "PASS", "detail": "Deactivate|LOCKED|yes"}]})
        check("checks ran, nothing locked (a detail mentioning LOCKED): false",
              p.get("biosLocked") is False, p.get("biosLocked"))
        p = with_locks({"status": "WARNING", "checks": [{"key": "mdm", "status": "DETECTED"}]})
        check("WARNING, nothing locked: false", p.get("biosLocked") is False, p.get("biosLocked"))
        # lock_status ranks WARNING above UNKNOWN, so a WARNING roll-up can
        # hide a check that never finished (here the BIOS-password one).
        p = with_locks({"status": "WARNING", "checks": [{"key": "mdm", "status": "DETECTED"},
                                                        {"key": "bios_pw", "status": "UNKNOWN"}]})
        check("WARNING hiding an UNKNOWN check: left out, never claimed unlocked",
              "biosLocked" not in p, p.get("biosLocked"))
        p = with_locks({"status": "CLEAR", "checks": [{"key": "bios_pw", "status": "unknown"}]})
        check("an UNKNOWN check under any roll-up: left out", "biosLocked" not in p,
              p.get("biosLocked"))
        p = with_locks({"status": "UNVERIFIED", "checks": [{"key": "bios_pw", "status": "UNKNOWN"}]})
        check("UNVERIFIED: left out, never claimed unlocked", "biosLocked" not in p, p)
        p = with_locks("garbage")
        check("an unreadable lock report: left out", "biosLocked" not in p, p)
    finally:
        srv.STATE["profile"] = json.loads(json.dumps(PROFILE))
    check("bios_locked: no profile", srv.bios_locked(None) is None)
    # A restart-recovered record carries it too (built by the same function).
    rec = srv.pending_failed_payload({"device": "/dev/sda", "drive": {"serial": "W2"},
                                      "base": {"profile": dict(PROFILE, locks={"status": "LOCKED",
                                                                               "checks": []})}})
    check("recovered record: biosLocked from its own profile", rec.get("biosLocked") is True, rec)

    # An engine that predates C1: the station fills in what it saw itself.
    sent = start(["/dev/sda"])
    JOBS[0]["on_done"]({"status": "wiped", "method": "overwrite", "device": "/dev/sda",
                        "finishedAt": "yesterday"})
    p = UPLOADS[-1]
    check("old engine: wipedAt from the station clock, ISO UTC",
          srv.ISO_UTC.match(p.get("wipedAt") or ""), p)
    check("old engine: wipeStartedAt from the job start", srv.ISO_UTC.match(p.get("wipeStartedAt") or ""), p)
    check("old engine: drive identity from lsblk",
          p.get("wipedDrive") == {"serialNumber": "W2", "model": "WD Blue", "sizeBytes": 500107862016,
                                  "transport": "sata", "rotational": True, "devicePath": "/dev/sda"},
          p.get("wipedDrive"))
    check("old engine: methodRequested is what the station asked for", p.get("methodRequested") == "auto", p)
    check("old engine: no C1-only fields invented",
          not any(k in p for k in ("methodAttempted", "sanitisationLevel", "verification",
                                   "hiddenAreas", "wipeLimitations", "wipeSmart")), p)

    # Was the clock network-set for the whole wipe?
    srv.CLOCK["network"] = False
    start(["/dev/sda"])
    JOBS[0]["on_done"]({"status": "wiped", "method": "m", "device": "/dev/sda"})
    check("clock never synced: unsynced", UPLOADS[-1].get("wipedAtClock") == "unsynced", UPLOADS[-1])
    start(["/dev/sda"])
    srv.CLOCK["network"] = True             # synced only after the wipe began
    JOBS[0]["on_done"]({"status": "wiped", "method": "m", "device": "/dev/sda"})
    check("clock synced mid-wipe: still unsynced", UPLOADS[-1].get("wipedAtClock") == "unsynced", UPLOADS[-1])
    start(["/dev/sda"])
    JOBS[0]["on_done"]({"status": "wiped", "method": "m", "device": "/dev/sda"})
    check("clock synced before and after: network", UPLOADS[-1].get("wipedAtClock") == "network", UPLOADS[-1])
    srv.CLOCK["network"] = False

    # A refused result: the engine wrote nothing, so nothing is filed.
    start(["/dev/sda"])
    JOBS[0]["on_done"]({"status": "refused", "method": "none", "device": "/dev/sda",
                        "reason": "serial mismatch"})
    check("refused: nothing filed", UPLOADS == [], UPLOADS)

    # sync_clock only counts a NETWORK source as synced.
    srv.CLOCK["network"] = False
    real_inner = srv._sync_clock
    srv._sync_clock = lambda: (True, "set from the boot media date", False)
    srv.sync_clock()
    check("boot-media-date floor is not a network sync", srv.CLOCK["network"] is False)
    srv._sync_clock = lambda: (True, "clock already correct", True)
    srv.sync_clock()
    check("network time: synced", srv.CLOCK["network"] is True)
    srv._sync_clock = real_inner
    srv.CLOCK["network"] = False

    # The boot-time sync runs before the station has joined Wi-Fi (refresh's
    # connect_network does that), so it finds no time source. Once the network
    # is up the station must try again, or every wipe that session is filed
    # "unsynced" even though the clock is right.
    print("the clock is re-synced once the network is up")
    LINK = {"up": False}
    SYNCS = []

    def fake_inner_sync():
        SYNCS.append(LINK["up"])
        return (True, "clock already correct", True) if LINK["up"] else \
            (False, "no time source reachable", False)

    saved = (srv._sync_clock, srv.capture, srv.connect_network, srv.ensure_token,
             srv.api, srv.queue_count, srv.load_conf, dict(srv.STATE))
    srv._sync_clock = fake_inner_sync
    srv.capture = lambda: (json.loads(json.dumps(PROFILE)), "summary")
    srv.connect_network = lambda: LINK.update(up=True) or "connected"
    srv.ensure_token = lambda: "t"
    srv.api = lambda *a, **k: []
    srv.queue_count = lambda: 0
    srv.load_conf = lambda: {}
    try:
        srv.sync_clock()                    # boot(): Wi-Fi not associated yet
        check("boot sync before the network: unsynced", srv.CLOCK["network"] is False)
        srv.refresh()                       # joins Wi-Fi, logs in
        check("refresh after the network came up: clock re-synced", srv.CLOCK["network"] is True,
              SYNCS)
        check("refresh: no error", not srv.STATE.get("error"), srv.STATE.get("error"))
        start(["/dev/sda"])
        if JOBS:
            JOBS[0]["on_done"]({"status": "wiped", "method": "m", "device": "/dev/sda"})
        check("a wipe after that: wipedAtClock network",
              UPLOADS and UPLOADS[-1].get("wipedAtClock") == "network", UPLOADS)
        n = len(SYNCS)
        srv.refresh()
        check("already synced: a Rescan does not probe the clock again", len(SYNCS) == n, SYNCS)
    finally:
        (srv._sync_clock, srv.capture, srv.connect_network, srv.ensure_token,
         srv.api, srv.queue_count, srv.load_conf, st) = saved
        srv.STATE.clear()
        srv.STATE.update(st)
        srv.CLOCK["network"] = False

    print("a serial lsblk escapes is passed the way the engine reads it")

    # lsblk -P prints '$' as \x24 (and '"', '\', '`', control bytes likewise).
    # The engine decodes its own reading with printf %b before comparing, so
    # the expected serial it is handed must be decoded too.
    check("drive_serial: \\x24 decoded", srv.drive_serial(r"ABC\x24123") == "ABC$123",
          srv.drive_serial(r"ABC\x24123"))
    check("drive_serial: \\x5c is one backslash", srv.drive_serial(r"A\x5cB") == "A\\B")
    check("drive_serial: \\x22 is a quote", srv.drive_serial(r"A\x22B") == 'A"B')
    check("drive_serial: trimmed like the engine's sed", srv.drive_serial("  S1 \t") == "S1")
    check("drive_serial: a NUL is dropped (bash cannot hold one)",
          srv.drive_serial(r"A\x00B") == "AB", repr(srv.drive_serial(r"A\x00B")))
    check("drive_serial: plain serial unchanged", srv.drive_serial("S5H2NS0N") == "S5H2NS0N")
    check("drive_serial: None -> ''", srv.drive_serial(None) == "")
    nonutf = srv.drive_serial(r"A\xffB")
    check("drive_serial: a non-UTF-8 byte reaches the engine as that byte",
          nonutf.encode("utf-8", "surrogateescape") == b"A\xffB", repr(nonutf))

    LSBLK = ('NAME="sdd" SIZE="256060514304" MODEL="Odd SSD" TRAN="sata" RM="0" '
             'ROTA="0" TYPE="disk" SERIAL="ABC\\x24123"\n')

    class _R:
        stdout = LSBLK

    real_run, real_smart = srv.subprocess.run, srv.smart_health
    srv.subprocess.run = lambda *a, **k: _R()
    srv.smart_health = lambda *a, **k: None
    try:
        listed = REAL_LIST_DRIVES(force=True)
    finally:
        srv.subprocess.run, srv.smart_health = real_run, real_smart
    check("list_drives: serial decoded", listed and listed[0].get("serial") == "ABC$123", listed)

    # The profile holds the RAW lsblk value (the engine's pval does not decode).
    srv.STATE["profile"]["storage"].append({"model": "Odd SSD", "serialNumber": r"ABC\x24123"})
    OFFERED.append(dict(listed[0]) if listed else {})
    try:
        sent = start(["/dev/sdd"])
        check("escaped serial: the drive in the profile is allowed", sent[0] == 200, sent)
        check("escaped serial: the engine is handed the decoded serial",
              JOBS and JOBS[0]["argv"] == ["--wipe-drive", "/dev/sdd", "auto", "ABC$123"], JOBS)
        if JOBS:
            JOBS[0]["on_done"]({"status": "wiped", "method": "m", "device": "/dev/sdd",
                                "drive": {"serialNumber": "ABC$123"}})
        p = UPLOADS[-1] if UPLOADS else {}
        check("escaped serial: no spurious 'reported serial X, expected Y' note",
              "expected" not in (p.get("notes") or ""), p.get("notes"))
        check("escaped serial: recorded decoded",
              (p.get("wipedDrive") or {}).get("serialNumber") == "ABC$123", p.get("wipedDrive"))
    finally:
        srv.STATE["profile"]["storage"].pop()
        OFFERED.pop()

    print("a queued record keeps the date it was wiped")

    QFILE = os.path.join(TMP, "queue.jsonl")
    srv.QUEUE_FALLBACK = QFILE
    srv.CONF_PATH = None
    srv.STATE["token"] = "t"
    srv.upload_audit = REAL["upload_audit"]
    POSTED = []
    NET = {"up": False}

    def fake_api(path, method="GET", body=None, token=None, timeout=25):
        if not NET["up"]:
            raise OSError("network is unreachable")
        POSTED.append(json.loads(json.dumps(body)))
        return {"assetId": "a1"}

    srv.api = fake_api
    real_time = srv.time.time
    t0 = 1789812000.0                       # 2026-09-19T10:00:00Z
    try:
        srv.time.time = lambda: t0
        start(["/dev/sda"])                 # an old engine: no finishedAt
        res = {"status": "wiped", "method": "m", "device": "/dev/sda"}
        JOBS[0]["on_done"](res)
        check("offline: the record is queued", res.get("queued") and srv.queue_count() == 1, res)
        queued = srv.queue_load()[0] if srv.queue_count() else {}
        check("offline: the queued copy already carries wipedAt",
              queued.get("wipedAt") == "2026-09-19T10:00:00Z", queued)
        srv.time.time = lambda: t0 + 3 * 3600   # three hours later, back online
        NET["up"] = True
        sent_n = srv.queue_flush()
        check("flushed 3 hours later: sent", sent_n == 1 and len(POSTED) == 1, POSTED)
        check("flushed 3 hours later: keeps the ORIGINAL wipedAt",
              POSTED and POSTED[0].get("wipedAt") == "2026-09-19T10:00:00Z", POSTED)
        check("flushed: the queue is empty", srv.queue_count() == 0)
    finally:
        srv.time.time = real_time

    print("the offline queue")

    # The flush holds UPLOAD_LOCK while it posts.
    NET["up"] = True
    POSTED.clear()
    LOCKED = []

    def locked_api(path, method="GET", body=None, token=None, timeout=25):
        LOCKED.append(srv.UPLOAD_LOCK.locked())
        POSTED.append(body)
        return {}

    srv.api = locked_api
    srv.queue_add({"n": 1})
    srv.queue_flush()
    check("flush posts under UPLOAD_LOCK", LOCKED == [True], LOCKED)

    # A record queued WHILE a flush runs must survive it. The old flush wrote
    # back "what I read minus what I sent", deleting anything added meanwhile.
    srv.queue_add({"n": 2})

    def racing_api(path, method="GET", body=None, token=None, timeout=25):
        srv.queue_add({"n": 3})             # another drive's upload fails now
        return {}

    srv.api = racing_api
    srv.queue_flush()
    left = srv.queue_load()
    check("record queued during a flush: not lost", left == [{"n": 3}], left)
    srv.api = fake_api
    NET["up"] = False
    srv.queue_write([])

    print("a wipe the station loses sight of is still recorded")

    def fresh_process():
        """A second copy of server.py: shares nothing with `srv` but the disk,
        which is exactly what a restarted backend has."""
        sp = importlib.util.spec_from_file_location("als_server_restarted",
                                                    os.path.join(HERE, "gui", "server.py"))
        m = importlib.util.module_from_spec(sp)
        sp.loader.exec_module(m)
        m.CONF_PATH = None
        m.PENDING_FALLBACK = srv.PENDING_FALLBACK
        m.QUEUE_FALLBACK = srv.QUEUE_FALLBACK
        m.STICK_VERSION_FILE = srv.STICK_VERSION_FILE
        return m

    srv.queue_write([])
    # The earlier sections start wipes whose stubbed jobs never finish; their
    # markers are exactly what a restart would recover. Start clean.
    srv._pending_update(lambda items: [])
    srv.upload_audit = fake_upload
    srv.stamp_provenance = lambda p: dict(p, operatorName="Ann") if isinstance(p, dict) else p
    h = Fake("/api/wipe/start", {"devices": ["/dev/sda"], "lotId": "lot-7"})
    JOBS.clear()
    UPLOADS.clear()
    t_before = real_time()
    h.do_POST()
    check("marker: the wipe starts", h.sent[0] == 200 and len(JOBS) == 1, h.sent)
    at_start = JOBS[0]["pendingAtStart"] if JOBS else []
    check("marker: on disk BEFORE the engine starts", len(at_start) == 1 and
          at_start[0].get("device") == "/dev/sda", at_start)

    # THE CASE: the backend dies mid-wipe. The engine (own session) may carry
    # on, but nothing in this process will ever file its result.
    srv.stamp_provenance = lambda p: p      # a restarted process has no operator
    m = fresh_process()
    n = m.recover_pending_wipes()
    q = m.queue_load()
    check("restart mid-wipe: one record filed", n == 1 and len(q) == 1, q)
    r = q[0] if q else {}
    check("restart mid-wipe: status failed", r.get("dataWipeStatus") == "failed", r)
    check("restart mid-wipe: says the outcome is unknown",
          "outcome is unknown" in (r.get("notes") or ""), r.get("notes"))
    check("restart mid-wipe: filed under the machine it was started on",
          (r.get("profile") or {}).get("identification", {}).get("serialNumber") == "HOST-1", r)
    check("restart mid-wipe: names the drive",
          (r.get("wipedDrive") or {}).get("serialNumber") == "W2" and
          r["wipedDrive"].get("devicePath") == "/dev/sda", r.get("wipedDrive"))
    check("restart mid-wipe: keeps the lot and the operator stamped at start",
          r.get("lotId") == "lot-7" and r.get("operatorName") == "Ann", r)
    check("restart mid-wipe: carries the start time",
          srv.ISO_UTC.match(r.get("wipeStartedAt") or "") and
          r["wipeStartedAt"] >= srv.utc_iso(t_before - 1), r.get("wipeStartedAt"))
    check("restart mid-wipe: tool stamped", r.get("toolName") == "als-audit-station", r)
    check("restart mid-wipe: the marker is gone", pending() == [], pending())
    check("recovery twice: files nothing more", m.recover_pending_wipes() == 0 and
          len(m.queue_load()) == 1)
    srv.queue_write([])

    # A dead RTC after the restart: the record is never dated before its start.
    srv.pending_add({"device": "/dev/sda", "drive": {"serial": "W2"}, "method": "auto",
                     "startedEpoch": 1789812000.0, "clockAtStart": True,
                     "base": {"profile": PROFILE}})
    saved_t = m.time.time
    m.time.time = lambda: 946684800.0       # the machine thinks it is 2000
    try:
        m.recover_pending_wipes()
    finally:
        m.time.time = saved_t
    r = (m.queue_load() or [{}])[0]
    check("dead RTC at recovery: wipedAt not before the wipe started",
          r.get("wipedAt") == "2026-09-19T10:00:00Z", r.get("wipedAt"))
    check("recovered with the clock unsynced: says so", r.get("wipedAtClock") == "unsynced", r)
    srv.queue_write([])

    # The wipe finishes and uploads normally: the marker goes.
    start(["/dev/sda"])
    JOBS[0]["on_done"]({"status": "wiped", "method": "m", "device": "/dev/sda"})
    check("uploaded: one record, marker removed", len(UPLOADS) == 1 and pending() == [],
          (UPLOADS, pending()))

    # Refused: nothing written to the drive, nothing filed, marker removed.
    start(["/dev/sda"])
    JOBS[0]["on_done"]({"status": "refused", "method": "none", "device": "/dev/sda"})
    check("refused: nothing filed, marker removed", UPLOADS == [] and pending() == [],
          (UPLOADS, pending()))

    # A job that never started (a wipe already running on that drive).
    BUSY["on"] = True
    try:
        sent = start(["/dev/sda"])
    finally:
        BUSY["on"] = False
    check("never started: marker removed", sent[0] == 409 and pending() == [], (sent, pending()))

    # Power cut DURING the upload: the finished payload is already on disk.
    SEEN = []

    def dying_upload(payload):
        SEEN.append(pending())
        raise KeyboardInterrupt("power cut")    # nothing after this runs

    srv.upload_audit = dying_upload
    start(["/dev/sda"])
    try:
        JOBS[0]["on_done"]({"status": "wiped", "method": "m", "device": "/dev/sda",
                            "finishedAt": "2026-09-19T10:01:07Z"})
    except KeyboardInterrupt:
        pass
    during = SEEN[0] if SEEN else []
    check("during the upload: the marker holds the finished record",
          len(during) == 1 and (during[0].get("final") or {}).get("dataWipeStatus") == "wiped",
          during)
    m = fresh_process()
    m.recover_pending_wipes()
    q = m.queue_load()
    check("power cut mid-upload: the WIPED record is filed at the next boot, not a failed one",
          len(q) == 1 and q[0].get("dataWipeStatus") == "wiped" and
          q[0].get("wipedAt") == "2026-09-19T10:01:07Z", q)
    check("power cut mid-upload: marker gone", pending() == [], pending())
    srv.queue_write([])
    srv.upload_audit = fake_upload
    srv.stamp_provenance = lambda p: p

    # Offline: the record is queued, and the marker goes (the queue has it).
    srv.upload_audit = REAL["upload_audit"]
    start(["/dev/sda"])
    JOBS[0]["on_done"]({"status": "wiped", "method": "m", "device": "/dev/sda"})
    check("offline: queued once, marker removed", srv.queue_count() == 1 and pending() == [],
          (srv.queue_count(), pending()))
    srv.queue_write([])
    srv.upload_audit = fake_upload

    print("a wipe job that dies still files a failed record")

    import time as _t
    srv.upload_audit = fake_upload
    srv.start_job = REAL["start_job"]

    def run_real(engine_src, dev="/dev/sda"):
        srv.audit_cmd = lambda *a, **k: [sys.executable, "-c", engine_src]
        UPLOADS.clear()
        h = Fake("/api/wipe/start", {"devices": [dev]})
        h.do_POST()
        deadline = _t.time() + 20
        while _t.time() < deadline:
            job = srv.JOBS.get(srv.wipe_kind(dev)) or {}
            if job and not job.get("running"):
                return h.sent, job
            _t.sleep(0.05)
        return h.sent, srv.JOBS.get(srv.wipe_kind(dev))

    # Crashes half way: output, then exit 3, and no WIPE_RESULT at all.
    sent, job = run_real("print('Erasing /dev/sda ...'); import sys; sys.exit(3)")
    check("dead job: started", sent[0] == 200, sent)
    check("dead job: files status failed", len(UPLOADS) == 1 and UPLOADS[0]["dataWipeStatus"] == "failed",
          UPLOADS)
    check("dead job: the reason says it died", "without a result" in (UPLOADS[0].get("notes") or "")
          if UPLOADS else False, UPLOADS)
    check("dead job: the record names the drive",
          UPLOADS and (UPLOADS[0].get("wipedDrive") or {}).get("serialNumber") == "W2", UPLOADS)
    check("dead job: the screen shows failed + recorded",
          (job.get("result") or {}).get("status") == "failed" and job["result"].get("recorded"), job)

    # An unreadable result line is not a verdict either.
    sent, job = run_real("print('WIPE_RESULT [1,2]')")
    check("non-object WIPE_RESULT: files failed, job still finishes",
          len(UPLOADS) == 1 and UPLOADS[0]["dataWipeStatus"] == "failed" and not job.get("running"),
          (UPLOADS, job))

    # A real engine refusal through the real job runner: nothing filed.
    sent, job = run_real('print(\'WIPE_RESULT {"status":"refused","method":"none",'
                         '"device":"/dev/sda","reason":"serial mismatch"}\')')
    check("refused through the real job runner: nothing filed", UPLOADS == [], UPLOADS)
    check("refused: the screen still gets the verdict", (job.get("result") or {}).get("status") == "refused", job)

    # And a good result through the real runner files exactly one record.
    sent, job = run_real('print(\'WIPE_RESULT {"status":"wiped","method":"m","device":"/dev/sda"}\')')
    check("wiped through the real job runner: one record", len(UPLOADS) == 1 and
          UPLOADS[0]["dataWipeStatus"] == "wiped", UPLOADS)
    check("real job runner: no wipe marker left behind by any of these", pending() == [],
          pending())
finally:
    shutil.rmtree(TMP, ignore_errors=True)

print("")
print("%d passed, %d failed" % (PASS[0], len(FAIL)))
sys.exit(1 if FAIL else 0)
