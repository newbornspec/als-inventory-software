#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""LOCAL PREVIEW ONLY - serves the real kiosk page (index.html) against a fake
API, so the screen can be looked at in an ordinary browser on any PC. It never
runs the engine, never touches a disk, never talks to the ALS server, and the
station never starts it (start-gui.sh runs server.py, nothing runs this).

How to run (Windows or Linux, python 3 stdlib only):

    python tools/gui/preview-server.py              # then open http://127.0.0.1:8765/
    python tools/gui/preview-server.py 9000         # another port

Scenario knobs (environment variables, all optional):

    PREVIEW_OUTCOME   mixed (default): the FIRST drive wiped fails, the others
                      wipe, all within a second of each other - the case where
                      the old screen lost the first result under the second
                      toast.
                      wiped: every drive wipes and is recorded.
                      refused: the engine refuses every drive (nothing written).
                      offline: every drive wipes; the record is queued.
    PREVIEW_ELIG      yes (default) | no | 404 - what the certificate-eligibility
                      check (contract C4) answers. 404 = an API older than C4.
    PREVIEW_WORKFLOW  amazon (default) | goods_in | none - the batch is only
                      named in goods_in. none = a dual-permission account that
                      has not chosen: Wipe is disabled, with the reason.
    PREVIEW_QUEUE     rejected: one wipe record sits in the offline queue and
                      the server refused it (the banner that says why).
    PREVIEW_SECONDS   how long each fake wipe "runs" (default 4).
    PREVIEW_NET       what the live connection check (/api/net, the header
                      chip) answers: connected (default, over Wi-Fi) |
                      no-network | server-unreachable | flap (cycles through
                      all three, 12 s each, so the chip can be watched
                      changing - the page polls every 10 s).
    PREVIEW_HEALTH    unreadable: the second drive's health cannot be measured
                      and a storage controller is hiding two more drives - the
                      two rows that must say WHY and WHAT TO DO, and must never
                      say "Unknown". Left unset, every drive has a measured
                      percentage (94% Good and 74% Caution).
    PREVIEW_NAMESPACES  set to 1 to add a second namespace (nvme0n2) of the
                      same NVMe drive, to see the namespace warning (owner
                      decision D36) and the second namespace waiting its
                      turn, as the real server queues it.

Everything here is a stand-in for server.py's answers, shaped like them; when
server.py's responses change, change the matching stub.
"""
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
OUTCOME = os.environ.get("PREVIEW_OUTCOME", "mixed")
ELIG = os.environ.get("PREVIEW_ELIG", "yes")
SECONDS = float(os.environ.get("PREVIEW_SECONDS", "4"))
_WF = os.environ.get("PREVIEW_WORKFLOW", "amazon")
STATE = {"workflow": "" if _WF == "none" else _WF, "operator": "Preview"}
QUEUE = os.environ.get("PREVIEW_QUEUE", "")
NET_MODE = os.environ.get("PREVIEW_NET", "connected")
NET_FLAP = ("connected", "no-network", "server-unreachable")
NET_T0 = time.time()
NET_SEEN = {"state": None, "since": int(NET_T0)}
LOCK = threading.Lock()
JOBS = {}          # "wipe:/dev/x" -> {"start": epoch, "result": {...}, "order": n}

DRIVES = [
    {"device": "/dev/nvme0n1", "name": "nvme0n1", "size": "512 GB", "bytes": 512110190592,
     "rotational": False, "model": "Samsung SSD 980 PRO", "serial": "S5GXNX0T812345",
     "transport": "nvme", "method": "NVMe firmware erase (crypto/secure)",
     # Health as server.py's with_health() hands it over (contract C5).
     "health": {"measured": True, "percent": 94, "status": "good",
                "basis": "life remaining 94% reported by the drive", "reasons": [],
                "source": "nvme", "smartPassed": True, "temperatureC": 38,
                "powerOnHours": 1234, "lifeUsedPct": 6, "selfTest": "none",
                "tool": "smartctl 7.4"},
     "healthView": {"cls": "ok", "title": "94% · Good",
                    "detail": "life remaining 94% reported by the drive · 38 °C · 1,234 h"
                              " · life used 6%"}},
    {"device": "/dev/sda", "name": "sda", "size": "500 GB", "bytes": 500107862016,
     "rotational": True, "model": "WDC WD5000LPLX", "serial": "",
     "transport": "sata", "method": "ATA secure erase / overwrite (HDD)",
     "health": {"measured": True, "percent": 74, "status": "caution",
                "basis": "3 reallocated sectors, 2 uncorrectable sectors; SMART passed",
                "reasons": ["3 reallocated sectors", "2 uncorrectable sectors"],
                "source": "ata-hdd", "smartPassed": True, "temperatureC": 41,
                "powerOnHours": 20111, "reallocatedSectors": 3, "pendingSectors": 0,
                "uncorrectableSectors": 2, "selfTest": "passed", "tool": "smartctl 7.4"},
     "healthView": {"cls": "warn", "title": "74% · Caution",
                    "detail": "3 reallocated sectors, 2 uncorrectable sectors; SMART passed"
                              " · 41 °C · 20,111 h"}},
]
for _d in DRIVES:
    _d["controller"] = "nvme0" if _d["device"].startswith("/dev/nvme") else None
    _d["namespaces"] = [_d["device"]] if _d["controller"] else []

# PREVIEW_HEALTH=unreadable: the branch that is easy to get wrong and hard to
# photograph - a drive whose health CANNOT be measured, and a controller hiding
# drives from Linux entirely. Neither may ever read "Unknown": each says what
# is wrong and what the operator should do about it. Same shape server.py's
# health_view() / drive_health_lines() produce.
HIDDEN_ROWS = []
if os.environ.get("PREVIEW_HEALTH") == "unreadable":
    DRIVES[1]["health"] = {"measured": False,
                           "reason": "the drive does not report health data",
                           "action": "none on this machine — test it on another"
                                     " machine or replace",
                           "source": "ata-hdd"}
    DRIVES[1]["healthView"] = {
        "cls": "na",
        "title": "Not measurable — the drive does not report health data",
        "detail": "none on this machine — test it on another machine or replace"}
    HIDDEN_ROWS = [{"cls": "na",
                    "title": "Not measurable — behind a RAID/Intel RST controller",
                    "detail": "set the storage mode to AHCI in the BIOS, then press Rescan",
                    "drive": "2 drives hidden by the storage controller"}]
if os.environ.get("PREVIEW_NAMESPACES") == "1":
    DRIVES.insert(1, dict(DRIVES[0], device="/dev/nvme0n2", name="nvme0n2", size="1 GB",
                          bytes=1000000000))
    for _d in DRIVES:
        if _d["controller"]:
            _d["namespaces"] = ["/dev/nvme0n1", "/dev/nvme0n2"]


def bootstrap():
    return {
        "ready": True, "capturing": False, "error": None,
        "device": {"name": "Dell Latitude 7490 (preview)",
                   "hw": {"processor": "Intel Core i5-8350U", "memory": "16 GB",
                          "storage": "512 GB NVMe + 500 GB HDD", "display": "14in 1920x1080",
                          "network": "Intel Wi-Fi", "batteryLine": "82% health",
                          "tpm": "2.0"},
                   # server.py's drive_health_lines(): one row per drive (contract C5).
                   "driveHealth": [dict(d["healthView"],
                                        drive="%s %s (%s)" % (d["size"],
                                                              "NVMe" if d["controller"] else "HDD",
                                                              d["name"]))
                                   for d in DRIVES] + HIDDEN_ROWS},
        "lots": [{"id": "lot-1", "batchNumber": "B-0042", "actualUnitCount": 12,
                  "expectedUnitCount": 20, "createdAt": "2026-09-01T09:00:00Z",
                  "createdByName": "Preview"}],
        "drives": DRIVES, "osImages": [], "wipeMethod": "auto",
        "server": "https://preview.invalid", "currentUser": "Preview user",
        "operator": STATE["operator"], "workflow": STATE["workflow"],
        "workflows": ["amazon", "goods_in"], "adminPinSet": False, "launch": "preview",
        "imageSource": "usb", "imageError": None,
        "hardwareTest": HWTEST["test"], **queue_status(),
    }


# The hardware test (contract C6), shaped like server.py's /api/hwtest. Kept in
# memory for the life of the preview, so the panel can be clicked through: the
# preview never runs a test, but the shell's states, counts and verdict are
# the same code on screen.
HWTEST = {"test": None}
# The same seven server.py names, in the same order, so the preview's counts
# ("3 / 7 completed") match what a technician sees on a real station.
HWTEST_TESTS = ("speaker", "keyboard", "camera", "screen", "trackpad",
                "microphone", "usb")
HWTEST_DONE = ("PASSED", "ATTENTION", "FAILED")


def hwtest_save(body):
    """server.py's hwtest_save(), cut down to what the preview needs: merge
    the components sent, keep what they replace, derive the overall verdict."""
    cur = HWTEST["test"] if isinstance(HWTEST["test"], dict) else {}
    history = [h for h in (cur.get("history") or []) if isinstance(h, dict)]
    parts = {}
    for name in HWTEST_TESTS:
        was = cur.get(name)
        if isinstance(body, dict) and isinstance(body.get(name), dict):
            if isinstance(was, dict) and was.get("status") in HWTEST_DONE:
                history.append(dict(was, test=name))
            parts[name] = dict(body[name],
                               testedAt=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
        else:
            parts[name] = was if isinstance(was, dict) else {"status": "NOT_TESTED"}
    done = [p for p in parts.values() if p.get("status") in HWTEST_DONE]
    if len(done) == len(HWTEST_TESTS):
        status = ("FAILED" if any(p["status"] == "FAILED" for p in done)
                  else "ATTENTION" if any(p["status"] == "ATTENTION" for p in done)
                  else "PASSED")
    else:
        status = "IN_PROGRESS" if done else "NOT_TESTED"
    test = {"status": status, "completed": len(done), "total": len(HWTEST_TESTS),
            "technician": STATE["operator"],
            "testedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "clockWasNetwork": True}
    test.update(parts)
    test["history"] = history[-40:]
    HWTEST["test"] = test
    return test


def queue_status():
    """Shaped like server.py's queue_status()."""
    if QUEUE != "rejected":
        return {"waiting": 0, "waitingHeld": 0, "waitingRejected": 0,
                "waitingRejectedWipes": 0, "rejected": [], "queueDurable": True}
    return {"waiting": 1, "waitingHeld": 0, "waitingRejected": 1, "waitingRejectedWipes": 1,
            "rejected": [{"code": 400, "count": 1, "wipes": 1, "reason":
                          "No audit lot selected — pick the lot you are working on "
                          "in Als Inventory first."}],
            "queueDurable": True}


def net_status():
    """Shaped like server.py's net_status() (GET /api/net)."""
    now = time.time()
    st = NET_FLAP[int((now - NET_T0) // 12) % 3] if NET_MODE == "flap" else NET_MODE
    if st not in NET_FLAP:
        st = "connected"
    if st != NET_SEEN["state"]:
        NET_SEEN.update(state=st, since=int(now))
    up = st != "no-network"
    return {"state": st, "via": "wifi" if up else None,
            "ssid": "ALS-Warehouse (preview)" if up else None,
            "checkedAt": int(now), "since": NET_SEEN["since"]}


def result_for(dev, order):
    if OUTCOME == "refused":
        return {"status": "refused", "device": dev, "method": "none",
                "reason": "the drive's serial did not match the one on screen"}
    if OUTCOME == "mixed" and order == 0:
        return {"status": "failed", "device": dev, "method": "none",
                "reason": "NVMe sanitize aborted by the drive (status 0x2)",
                "recorded": True, "recordAssetId": "asset-preview", "recordTag": "ALS-00042"}
    r = {"status": "wiped", "device": dev,
         "method": "NVMe crypto erase — verified (reads as random)" if "nvme" in dev
         else "Overwrite + verify (NIST 800-88 Clear)", "reason": ""}
    if OUTCOME == "offline":
        r.update(queued=True, waiting=order + 1,
                 recordError="no connection — the wipe record is saved on this machine "
                             "and will upload automatically")
    else:
        r.update(recorded=True, recordAssetId="asset-preview", recordTag="ALS-00042")
    return r


def job(kind):
    with LOCK:
        j = JOBS.get(kind)
    if not j:
        return {"running": False, "log": [], "result": None, "error": None,
                "elapsed": 0, "idle": 0, "seq": 0, "logFrom": 0}
    el = time.time() - j["start"]
    # A namespace queued behind another of the same NVMe drive (server.py's
    # start_job queue_key) waits a whole wipe before it starts.
    if el < j["wait"]:
        return {"running": True, "log": [], "logFrom": 0, "seq": 0, "result": None,
                "error": None, "elapsed": int(el), "idle": 0, "writeBytes": 0,
                "writeStalled": None, "waiting": j["waitText"]}
    el -= j["wait"]
    # Staggered by 0.6 s so two drives finish "within a second" of each other.
    end = SECONDS + 0.6 * j["order"]
    running = el < end
    log = ["preview: wiping %s (%d%%)" % (kind[5:], min(100, int(100 * el / end)))]
    return {"running": running, "log": log, "logFrom": 0, "seq": 1,
            "result": None if running else j["result"], "error": None,
            "elapsed": int(el), "idle": 0, "writeBytes": int(el * 4e8), "writeStalled": False,
            "waiting": None}


def eligibility():
    if ELIG == "404":
        return {"known": False, "why": "server did not answer (HTTP 404)"}
    if ELIG == "no":
        return {"known": True, "available": False, "verdict": "incomplete",
                "reason": "another drive of this machine has no wipe on record",
                "drives": [{"key": "S5GXNX0T812345", "serialNumber": "S5GXNX0T812345",
                            "model": "Samsung SSD 980 PRO", "status": "wiped",
                            "method": "NVMe crypto erase", "wipedAt": "2026-09-19T10:01:07Z",
                            "manual": False},
                           {"key": "/dev/sda", "serialNumber": None,
                            "model": "WDC WD5000LPLX", "status": "missing", "method": None,
                            "wipedAt": None, "manual": False}]}
    return {"known": True, "available": True, "verdict": "wiped", "reason": None, "drives": []}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_a):
        pass

    def _send(self, code, payload, ctype="application/json"):
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path in ("/", "/index.html"):
            with open(os.path.join(HERE, "index.html"), "rb") as fh:
                return self._send(200, fh.read(), "text/html; charset=utf-8")
        if u.path == "/api/bootstrap":
            return self._send(200, bootstrap())
        if u.path == "/api/queue":
            return self._send(200, queue_status())
        if u.path == "/api/net":
            return self._send(200, net_status())
        if u.path == "/api/job":
            return self._send(200, job((q.get("type") or [""])[0]))
        if u.path == "/api/wipe/eligibility":
            return self._send(200, eligibility())
        if u.path == "/api/priorAudit":
            return self._send(200, {"found": False})
        if u.path == "/api/settings":
            return self._send(200, {"wifiSsid": "", "serverUrl": "https://preview.invalid",
                                    "wipeMethod": "auto", "imageServer": ""})
        if u.path == "/api/toolcheck":
            return self._send(200, {"verdict": "preview", "groups": [], "clonezilla": True})
        if u.path == "/api/netcheck":
            return self._send(200, {"verdict": "preview", "steps": []})
        if u.path == "/api/hwtest":
            return self._send(200, {"hardwareTest": HWTEST["test"],
                                    "technician": STATE["operator"],
                                    "tests": list(HWTEST_TESTS)})
        if u.path == "/api/hwtest/usb":
            # Shaped like server.py's usb_ports(): one device already on the bus
            # so the USB panel is clickable in the preview. The preview reads no
            # real sysfs - the point here is to see the shell's wording and
            # states, not to test a machine's sockets.
            return self._send(200, {"ok": True, "bootPortKnown": True,
                                    "bootPortExcluded": True,
                                    "devices": [{"port": "1-1",
                                                 "name": "Integrated Camera (preview)",
                                                 "speed": "USB 2.0 (480 Mbps)",
                                                 "hub": False}]})
        return self._send(404, {"message": "not in the preview"})

    def do_POST(self):  # noqa: N802
        u = urlparse(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            body = {}
        if u.path == "/api/wipe/start":
            devs = body.get("devices") or []
            now = time.time()
            ctrl = {x["device"]: x.get("controller") for x in DRIVES}
            ahead = {}
            with LOCK:
                for i, d in enumerate(devs):
                    q = ahead.setdefault(ctrl.get(d), []) if ctrl.get(d) else []
                    text = ("Waiting for %s to finish - it is on the same NVMe drive (%s), "
                            "and two erases cannot run on one drive at once. This one starts "
                            "next." % (", ".join(q), ctrl.get(d))) if q else None
                    JOBS["wipe:" + d] = {"start": now, "order": i, "result": result_for(d, i),
                                         "wait": (SECONDS + 0.6) * len(q), "waitText": text}
                    q.append(d)
            return self._send(200, {"started": devs, "busy": []})
        if u.path == "/api/workflow":
            STATE["workflow"] = body.get("workflow") or STATE["workflow"]
            return self._send(200, {"ok": True})
        if u.path == "/api/operator":
            STATE["operator"] = body.get("name") or ""
            return self._send(200, {"operator": STATE["operator"]})
        if u.path == "/api/hwtest":
            return self._send(200, {"ok": True, "hardwareTest": hwtest_save(body)})
        if u.path == "/api/hwtest/audio-prep":
            # Shaped like server.py's audio_prep(): a plausible mixer/sink so the
            # speaker panel is clickable in the preview. The preview never runs a
            # real mixer, so it always reports success - the point here is to see
            # the shell's states and wording, not to test the hardware.
            return self._send(200, {"ok": True,
                                    "mixer": "unmuted Master and Speaker, set to 80% (preview)",
                                    "sink": "Built-in Audio Analogue Stereo (preview)"})
        return self._send(200, {"ok": True, "message": "preview: nothing done"})


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    # Loopback only: this is a design preview, not something to expose.
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("kiosk preview on http://127.0.0.1:%d/  (outcome=%s, eligibility=%s, workflow=%s, net=%s)"
          % (port, OUTCOME, ELIG, STATE["workflow"], NET_MODE))
    srv.serve_forever()


if __name__ == "__main__":
    main()
