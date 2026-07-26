#!/usr/bin/env python3
"""
ALS Audit Station — kiosk GUI backend.

A small, stdlib-only HTTP server that drives the three core warehouse workflows
from one full-screen interface, so an operator never touches a terminal:

  * AUDIT   — runs hardware-audit.sh to capture the machine's profile (the
              script emits JSON with AUDIT_DEBUG=1) and uploads it to the ALS
              Inventory API.
  * WIPE    — runs `hardware-audit.sh --wipe-drive <dev>` per selected drive
              (the tested erase engine), streaming progress; the boot stick is
              excluded by the engine.
  * INSTALL — restores a Clonezilla OS image to a target drive via the
              pluggable install-os.sh driver (dynamic list from images/manifest).

The bash scripts stay the engines; this is only the frontend driver + a thin
job runner. Long jobs (wipe/install) run in the background and report progress
by polling /api/job.

Run:  python3 server.py   then open http://127.0.0.1:8800
"""
import json
import os
import re
import signal
import subprocess
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("ALS_GUI_PORT", "8800"))

# Where the engine + config + images live (USB root first, then dev checkout).
SEARCH_DIRS = ["/run/archiso/bootmnt", "/cdrom", "/mnt/usb", os.path.dirname(HERE), HERE]


def _find(name):
    for d in SEARCH_DIRS:
        p = os.path.join(d, name)
        if os.path.exists(p):
            return p
    return None


SCRIPT = _find("hardware-audit.sh")
CONF_PATH = _find("audit.conf")
INSTALL_SH = os.path.join(HERE, "install-os.sh")
IMAGES_ROOT = _find("images")

STATE = {
    "profile": None,
    "summary": "",
    "token": None,
    "conf": {},
    "lots": [],
    "error": None,
    "capturing": False,
    "userName": "",
}
# One background job per kind (only one wipe/install runs at a time).
JOBS = {"wipe": None, "install": None}
PROCS = {}          # kind -> Popen, so a running job can be cancelled
LOCK = threading.Lock()


# ---------------------------------------------------------------- config ----
def load_conf():
    conf = {}
    if not CONF_PATH:
        return conf
    try:
        with open(CONF_PATH, "r", errors="replace") as fh:
            for line in fh:
                line = line.strip().lstrip("﻿")
                if not line or line.startswith("#"):
                    continue
                m = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"?(.*?)"?\s*$', line)
                if m:
                    conf[m.group(1)] = m.group(2)
    except OSError as exc:
        STATE["error"] = "Could not read audit.conf: %s" % exc
    return conf


def save_conf(updates):
    """Rewrite the given KEY="value" lines in audit.conf, preserving the rest.
    The USB usually mounts read-only, so this returns a clear error if it can't
    write (the operator can remount rw, or set values from the admin console)."""
    if not CONF_PATH:
        return "audit.conf not found on the boot media."
    try:
        with open(CONF_PATH, "r", errors="replace") as fh:
            lines = fh.readlines()
    except OSError as exc:
        return "Could not read audit.conf: %s" % exc

    remaining = dict(updates)
    out = []
    for line in lines:
        m = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)\s*=', line.strip().lstrip("﻿"))
        key = m.group(1) if m else None
        if key and key in remaining:
            out.append('%s="%s"\n' % (key, remaining.pop(key)))
        else:
            out.append(line if line.endswith("\n") else line + "\n")
    for key, val in remaining.items():  # new keys appended
        out.append('%s="%s"\n' % (key, val))

    try:
        with open(CONF_PATH, "w") as fh:
            fh.writelines(out)
    except OSError as exc:
        return ("Could not write audit.conf (%s). The USB may be read-only — "
                "remount it read-write and try again." % exc)
    STATE["conf"] = load_conf()
    return None


# ------------------------------------------------------------------- API ----
def api(path, method="GET", body=None, token=None, timeout=25):
    base = STATE["conf"].get("AUDIT_URL", "").rstrip("/")
    if not base:
        raise RuntimeError("AUDIT_URL is not set in audit.conf")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode(errors="replace")
    return json.loads(raw) if raw else None


def login():
    conf = STATE["conf"]
    out = api("/auth/login", "POST", {
        "email": conf.get("AUDIT_EMAIL", ""),
        "password": conf.get("AUDIT_PASSWORD", ""),
    })
    tok = (out or {}).get("accessToken")
    if not tok:
        raise RuntimeError("Sign-in failed — check AUDIT_EMAIL / AUDIT_PASSWORD.")
    STATE["token"] = tok
    # Show the operator's real name in the header rather than the login address.
    STATE["userName"] = ((out or {}).get("user") or {}).get("name") or ""
    return tok


def ensure_token():
    return STATE["token"] or login()


# --------------------------------------------------------------- capture ----
def capture():
    if not SCRIPT:
        raise RuntimeError("hardware-audit.sh not found on the boot media.")
    env = dict(os.environ, AUDIT_DEBUG="1")
    proc = subprocess.run(["bash", SCRIPT], env=env, capture_output=True, text=True, timeout=300)
    out = proc.stdout or ""
    profile, summary = None, []
    for line in out.splitlines():
        s = line.strip()
        if s.startswith("{") and s.endswith("}"):
            try:
                profile = json.loads(s)
                continue
            except ValueError:
                pass
        summary.append(line)
    if profile is None:
        raise RuntimeError("Could not read the hardware profile from the engine.")
    return profile, "\n".join(summary).strip()


def connect_network():
    """Bring the network up via the engine. The GUI captures the profile with
    AUDIT_DEBUG=1, which skips the engine's own Wi-Fi step, so we trigger it
    here before hitting the server. Best-effort; login surfaces any remaining
    problem. Returns the engine's last message (useful for the UI)."""
    if not SCRIPT:
        return ""
    try:
        # Generous timeout: the engine tries Ethernet (fast) and then Wi-Fi
        # (association + DHCP + retries). Cutting it short would throw away the
        # diagnostic message that tells the operator what is actually wrong.
        proc = subprocess.run(["bash", SCRIPT, "--connect-wifi"],
                              capture_output=True, text=True, timeout=180)
        lines = [l for l in (proc.stdout or "").splitlines() if l.strip()]
        return " ".join(lines[-2:]) if lines else ""
    except subprocess.TimeoutExpired:
        return ("Network setup timed out. Check that the Ethernet cable is in a live port, "
                "or set this site's Wi-Fi in Settings.")
    except Exception:  # noqa: BLE001
        return ""


def refresh(do_login=True):
    with LOCK:
        STATE["capturing"] = True
        STATE["error"] = None
    try:
        STATE["conf"] = load_conf()
        prof, summ = capture()
        STATE["profile"], STATE["summary"] = prof, summ
        if do_login:
            wifi_msg = connect_network()
            try:
                ensure_token()
                STATE["lots"] = api("/devices/lots", token=STATE["token"]) or []
            except Exception as exc:  # noqa: BLE001
                # Prefer the Wi-Fi hint if the network never came up.
                hint = wifi_msg if wifi_msg and "connected" not in wifi_msg.lower() else ""
                raise RuntimeError(hint or str(exc))
    except Exception as exc:  # noqa: BLE001
        STATE["error"] = str(exc)
    finally:
        with LOCK:
            STATE["capturing"] = False


def launch_info():
    """Which display path start-gui.sh actually used (cage / xinit / session),
    written to /tmp/als-launch by the launcher. Shown in the UI's Display box so
    full-screen problems can be diagnosed from a screenshot."""
    try:
        with open("/tmp/als-launch", "r") as fh:
            return fh.read().strip()
    except OSError:
        return ""


def ident():
    p = STATE["profile"] or {}
    i = p.get("identification", {}) or {}
    cpu = (p.get("cpu") or {}).get("model", "")
    mem = (p.get("memory") or {}).get("totalGb")
    st = p.get("storage") or []
    c = p.get("cpu") or {}
    mm = p.get("memory") or {}
    dsp = p.get("display") or {}
    net = p.get("network") or {}
    bat = p.get("battery") or {}
    sec = p.get("security") or {}

    def joins(parts, sep=" · "):
        return sep.join(str(x) for x in parts if x)

    # The hardware card shows one line per component; each is assembled here so
    # the UI stays presentation-only.
    cores = joins(["%sC" % c["cores"] if c.get("cores") else "",
                   "%sT" % c["threads"] if c.get("threads") else ""], "/")
    return {
        "name": " ".join(x for x in [i.get("manufacturer"), i.get("model")] if x) or "Unknown device",
        "deviceType": i.get("deviceType", ""),
        "serial": i.get("serialNumber", ""),
        "cpu": cpu,
        "ramGb": mem,
        "storage": ", ".join(" ".join(x for x in [d.get("capacity"), d.get("type")] if x) for d in st),
        "drives": st,
        "battery": bat.get("health", ""),
        # --- lines for the hardware panel -------------------------------------
        "hw": {
            "processor": joins([c.get("model"), cores, c.get("maxClock")]),
            "memory": joins([("%s GB" % mm["totalGb"]) if mm.get("totalGb") else "",
                             mm.get("type"), mm.get("speed")]),
            "storage": joins([joins([d.get("capacity"), d.get("type")], " ")
                              for d in st], ", ") or "",
            "display": joins([dsp.get("size"), dsp.get("resolution")]),
            "optical": "Present" if has_optical() else "Not present",
            "network": joins([net.get("wifi"), net.get("bluetooth"), net.get("ethernet")]),
            "batteryLine": joins([bat.get("fullChargeCapacity") or bat.get("designCapacity"),
                                  ("Health %s" % bat["health"]) if bat.get("health") else "",
                                  bat.get("status")]),
            "tpm": joins([sec.get("tpm"),
                          ("Secure Boot %s" % sec["secureBoot"]) if sec.get("secureBoot") else ""]),
        },
    }


# --------------------------------------------------------------- drives ----
def lsblk_field(line, key):
    m = re.search(r'%s="([^"]*)"' % key, line)
    return m.group(1) if m else ""


def list_drives():
    """Internal (non-removable, non-USB) whole disks that can be wiped/imaged,
    each with a friendly auto-selected method label for display."""
    drives = []
    try:
        # -b gives SIZE in bytes, so the UI can estimate how long a wipe takes.
        out = subprocess.run(
            ["lsblk", "-dPb", "-o", "NAME,SIZE,MODEL,TRAN,RM,ROTA"],
            capture_output=True, text=True, timeout=15).stdout
    except Exception:
        return drives
    for line in out.splitlines():
        name = lsblk_field(line, "NAME")
        if not name:
            continue
        tran = lsblk_field(line, "TRAN")
        rm = lsblk_field(line, "RM")
        rota = lsblk_field(line, "ROTA")
        if tran == "usb" or rm == "1":
            continue
        try:
            if open("/sys/block/%s/removable" % name).read().strip() == "1":
                continue
        except OSError:
            pass
        if name.startswith("nvme"):
            method = "NVMe firmware erase (crypto/secure)"
        elif rota == "1":
            method = "ATA secure erase / overwrite (HDD)"
        else:
            method = "TRIM / secure erase (SSD)"
        raw = lsblk_field(line, "SIZE")
        try:
            nbytes = int(raw)
        except (TypeError, ValueError):
            nbytes = 0
        drives.append({
            "device": "/dev/" + name,
            "name": name,
            "size": human_size(nbytes),
            "bytes": nbytes,
            "rotational": rota == "1",
            "model": lsblk_field(line, "MODEL") or "Unknown model",
            "method": method,
        })
    return drives


def human_size(n):
    """512110190592 -> '512 GB' (decimal, matching how drives are sold)."""
    if not n:
        return ""
    if n >= 1_000_000_000_000:
        v = n / 1_000_000_000_000.0
        return ("%.1f" % v).rstrip("0").rstrip(".") + " TB"
    return "%d GB" % round(n / 1_000_000_000.0)


def has_optical():
    """True if this machine has an optical drive (lsblk type 'rom')."""
    try:
        out = subprocess.run(["lsblk", "-dno", "TYPE"], capture_output=True,
                             text=True, timeout=10).stdout
        return "rom" in out.split()
    except Exception:  # noqa: BLE001
        return False


# ----------------------------------------------------------------- OS list ----
def list_os_images():
    if not IMAGES_ROOT:
        return []
    manifest = os.path.join(IMAGES_ROOT, "manifest.json")
    if not os.path.isfile(manifest):
        return []
    try:
        with open(manifest, "r", errors="replace") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return []
    imgs = []
    for it in data.get("images", []):
        d = it.get("dir") or it.get("id")
        present = bool(d) and os.path.isdir(os.path.join(IMAGES_ROOT, d))
        imgs.append({
            "id": it.get("id"),
            "name": it.get("name", it.get("id")),
            "version": it.get("version", ""),
            "icon": it.get("icon", ""),
            "dir": d,
            "present": present,  # false = listed but image files not on the stick yet
        })
    return imgs


# ------------------------------------------------------------- job runner ----
def start_job(kind, argv, result_prefix, device="", on_done=None):
    """Run a long command in the background, streaming its stdout into a rolling
    log and parsing the final `<PREFIX> {json}` line into `result`. `on_done`
    (given the parsed result) runs after the process ends and before the job is
    marked finished — used to upload the wipe record."""
    now = time.time()
    with LOCK:
        cur = JOBS.get(kind)
        if cur and cur.get("running"):
            return False
        JOBS[kind] = {"running": True, "log": [], "result": None, "error": None,
                      "device": device, "startedAt": now, "updatedAt": now,
                      "cancelled": False}
    job = JOBS[kind]

    def worker():
        proc = None
        try:
            # start_new_session puts the engine in its own process group, so a
            # cancel can take down the whole tree (shred/dd keep running
            # otherwise) instead of orphaning a process writing to a disk.
            proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, bufsize=1, start_new_session=True)
            PROCS[kind] = proc
            for line in proc.stdout:
                line = line.rstrip("\n")
                job["updatedAt"] = time.time()
                if line.startswith(result_prefix):
                    try:
                        job["result"] = json.loads(line[len(result_prefix):].strip())
                    except ValueError:
                        job["error"] = "could not parse result line"
                elif line:
                    job["log"].append(line)
                    del job["log"][:-400]
            proc.wait()
            if job["result"] is None and job["error"] is None:
                # The engine died without a verdict. Say so precisely instead of
                # leaving the UI to guess — this is what used to look like a hang.
                if job.get("cancelled"):
                    job["error"] = "Cancelled by the operator."
                else:
                    rc = proc.returncode
                    job["error"] = ("The wipe process ended unexpectedly without a result "
                                    "(exit code %s). The drive may be failing or was "
                                    "disconnected." % rc)
        except Exception as exc:  # noqa: BLE001
            job["error"] = str(exc)
        finally:
            # Post-step (e.g. upload the wipe record). Its own failures attach to
            # the result so the UI can show "wiped but not saved".
            if on_done and job.get("result"):
                try:
                    on_done(job["result"])
                except Exception as exc:  # noqa: BLE001
                    job["result"]["recordError"] = str(exc)
            PROCS.pop(kind, None)
            # ALWAYS clear the running flag, whatever happened above, so the UI
            # can never be left waiting on a job that is no longer alive.
            job["updatedAt"] = time.time()
            job["running"] = False

    threading.Thread(target=worker, daemon=True).start()
    return True


def cancel_job(kind):
    """Stop a running job and everything it spawned. Returns a status message."""
    job = JOBS.get(kind)
    proc = PROCS.get(kind)
    if not job or not job.get("running") or not proc:
        return False, "Nothing is running."
    job["cancelled"] = True
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except Exception:  # noqa: BLE001
        try:
            proc.terminate()
        except Exception:  # noqa: BLE001
            return False, "Could not stop the process."
    # Give it a moment to exit, then insist.
    def _hard_kill():
        time.sleep(8)
        if proc.poll() is None:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception:  # noqa: BLE001
                pass
    threading.Thread(target=_hard_kill, daemon=True).start()
    return True, "Stopping…"


# ---------------------------------------------------------------- server ----
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def _send(self, code, payload, ctype="application/json"):
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _admin_ok(self, pin):
        want = STATE["conf"].get("AUDIT_ADMIN_PIN", "")
        return not want or (pin is not None and str(pin) == str(want))

    def do_GET(self):  # noqa: N802
        u = urlparse(self.path)
        if u.path in ("/", "/index.html"):
            try:
                with open(os.path.join(HERE, "index.html"), "rb") as fh:
                    return self._send(200, fh.read(), "text/html; charset=utf-8")
            except OSError:
                return self._send(500, b"index.html missing", "text/plain")

        if u.path == "/api/bootstrap":
            return self._send(200, {
                "ready": STATE["profile"] is not None,
                "capturing": STATE["capturing"],
                "error": STATE["error"],
                "device": ident() if STATE["profile"] else None,
                "summary": STATE["summary"],
                "lots": STATE["lots"],
                "drives": list_drives(),
                "osImages": list_os_images(),
                "wipeEnabled": STATE["conf"].get("AUDIT_WIPE", "0") == "1",
                "wipeMethod": STATE["conf"].get("AUDIT_WIPE_METHOD", "auto"),
                "server": STATE["conf"].get("AUDIT_URL", ""),
                "currentUser": (STATE.get("userName")
                                or STATE["conf"].get("AUDIT_EMAIL", "") or "Operator"),
                "adminPinSet": bool(STATE["conf"].get("AUDIT_ADMIN_PIN", "")),
                "launch": launch_info(),
            })

        if u.path == "/api/drives":
            return self._send(200, list_drives())

        if u.path == "/api/os/list":
            return self._send(200, list_os_images())

        if u.path == "/api/sublots":
            batch = (parse_qs(u.query).get("batchId") or [""])[0]
            try:
                subs = api("/lots?batchId=" + batch, token=ensure_token()) or []
                return self._send(200, subs)
            except Exception as exc:  # noqa: BLE001
                return self._send(500, {"message": str(exc)})

        if u.path == "/api/job":
            kind = (parse_qs(u.query).get("type") or [""])[0]
            job = JOBS.get(kind)
            if not job:
                return self._send(200, {"running": False, "log": [], "result": None,
                                        "error": None, "elapsed": 0, "idle": 0})
            # Serialise a snapshot, not the live dict the worker thread mutates.
            now = time.time()
            snap = dict(job)
            snap["log"] = list(job.get("log") or [])
            snap["elapsed"] = int(now - job.get("startedAt", now))   # seconds running
            snap["idle"] = int(now - job.get("updatedAt", now))      # seconds since output
            return self._send(200, snap)

        if u.path == "/api/settings":
            c = STATE["conf"]
            return self._send(200, {
                "wifiSsid": c.get("WIFI_SSID", ""),
                "serverUrl": c.get("AUDIT_URL", ""),
                "wipeEnabled": c.get("AUDIT_WIPE", "0") == "1",
                "wipeMethod": c.get("AUDIT_WIPE_METHOD", "auto"),
            })

        return self._send(404, {"message": "not found"})

    def do_POST(self):  # noqa: N802
        u = urlparse(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}") if length else {}
        except ValueError:
            body = {}

        if u.path == "/api/rescan":
            threading.Thread(target=refresh, daemon=True).start()
            return self._send(200, {"started": True})

        if u.path == "/api/audit":
            try:
                payload = {"lotId": body.get("lotId"), "profile": STATE["profile"]}
                if body.get("subLotId"):
                    payload["subLotId"] = body["subLotId"]
                if body.get("notes"):
                    payload["notes"] = body["notes"]
                out = api("/devices/hardware-audit", "POST", payload, ensure_token())
                return self._send(200, out or {})
            except Exception as exc:  # noqa: BLE001
                return self._send(500, {"message": str(exc)})

        if u.path == "/api/wipe/cancel":
            ok, msg = cancel_job("wipe")
            return self._send(200, {"ok": ok, "message": msg})

        if u.path == "/api/wipe/start":
            device = body.get("device", "")
            method = body.get("method") or STATE["conf"].get("AUDIT_WIPE_METHOD", "auto")
            lot_id = body.get("lotId")
            sub_lot_id = body.get("subLotId")
            if not SCRIPT:
                return self._send(500, {"message": "engine not found"})
            if not re.match(r"^/dev/[A-Za-z0-9]+$", device):
                return self._send(400, {"message": "invalid device"})

            # After the erase, record it against the device/batch: upload the
            # captured profile + the wipe status/method, the same shape the
            # text-mode engine uses. This creates/updates the device record and
            # produces the erasure certificate.
            def record_wipe(result):
                if result.get("status") not in ("wiped", "failed"):
                    return
                if not STATE["profile"]:
                    result["recordError"] = "no hardware profile captured — run once from the menu first"
                    return
                payload = {
                    "profile": STATE["profile"],
                    "dataWipeStatus": result.get("status"),
                    "dataWipeMethod": result.get("method"),
                }
                # Record WHY a wipe failed, so the audit trail explains itself
                # instead of just saying "Failed".
                reason = (result.get("reason") or "").strip()
                if reason and result.get("status") == "failed":
                    payload["notes"] = "Wipe failed on %s: %s" % (
                        result.get("device") or "drive", reason)
                if lot_id:
                    payload["lotId"] = lot_id
                if sub_lot_id:
                    payload["subLotId"] = sub_lot_id
                out = api("/devices/hardware-audit", "POST", payload, ensure_token())
                result["recorded"] = bool(out and out.get("assetId"))
                result["recordName"] = (out or {}).get("name")
                result["recordTag"] = (out or {}).get("tag")

            started = start_job("wipe", ["bash", SCRIPT, "--wipe-drive", device, method],
                                "WIPE_RESULT ", device, on_done=record_wipe)
            if not started:
                return self._send(409, {"message": "a wipe is already running"})
            return self._send(200, {"started": True})

        if u.path == "/api/os/install":
            device = body.get("device", "")
            image = body.get("imageId", "")
            if not re.match(r"^/dev/[A-Za-z0-9]+$", device):
                return self._send(400, {"message": "invalid device"})
            if not re.match(r"^[A-Za-z0-9_.-]+$", image or ""):
                return self._send(400, {"message": "invalid image"})
            env_root = IMAGES_ROOT or ""
            started = start_job("install", ["bash", INSTALL_SH, image, device],
                                "INSTALL_RESULT ", device)
            if not started:
                return self._send(409, {"message": "an install is already running"})
            # install-os.sh reads ALS_IMAGES_ROOT from its own search if unset;
            # pass ours explicitly for the dev checkout case.
            os.environ["ALS_IMAGES_ROOT"] = env_root
            return self._send(200, {"started": True})

        if u.path == "/api/settings":
            if not self._admin_ok(body.get("pin")):
                return self._send(403, {"message": "Admin PIN required."})
            updates = {}
            if "wifiSsid" in body:
                updates["WIFI_SSID"] = body["wifiSsid"]
            if body.get("wifiPassword"):
                updates["WIFI_PASSWORD"] = body["wifiPassword"]
            if "serverUrl" in body and body["serverUrl"]:
                updates["AUDIT_URL"] = body["serverUrl"]
            if "wipeEnabled" in body:
                updates["AUDIT_WIPE"] = "1" if body["wipeEnabled"] else "0"
            if body.get("wipeMethod"):
                updates["AUDIT_WIPE_METHOD"] = body["wipeMethod"]
            err = save_conf(updates)
            if err:
                return self._send(500, {"message": err})
            return self._send(200, {"saved": True})

        if u.path == "/api/power":
            if not self._admin_ok(body.get("pin")):
                return self._send(403, {"message": "Admin PIN required."})
            action = body.get("action")
            cmd = {"shutdown": ["poweroff"], "restart": ["reboot"]}.get(action)
            if not cmd:
                return self._send(400, {"message": "unknown action"})
            threading.Thread(target=lambda: subprocess.run(cmd), daemon=True).start()
            return self._send(200, {"ok": True})

        return self._send(404, {"message": "not found"})


def main():
    STATE["conf"] = load_conf()
    threading.Thread(target=refresh, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("ALS Audit Station GUI on http://127.0.0.1:%d  (engine: %s)" % (PORT, SCRIPT))
    srv.serve_forever()


if __name__ == "__main__":
    main()
