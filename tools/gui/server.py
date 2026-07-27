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
import shutil
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
IMAGES_LOCAL = _find("images")      # image folder carried on the stick itself
IMAGE_MOUNT = "/mnt/als-images"     # where a shared image library is mounted

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

# Drives are wiped concurrently, so each gets its own job keyed by device.
def wipe_kind(device):
    return "wipe:" + device


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

    err = write_boot_file(CONF_PATH, "".join(out))
    if err:
        return err
    STATE["conf"] = load_conf()
    return None


def mount_point(path):
    """The mount point the given path lives on (e.g. /run/archiso/bootmnt)."""
    p = os.path.abspath(path)
    while p != os.path.dirname(p) and not os.path.ismount(p):
        p = os.path.dirname(p)
    return p


def remount(mp, mode):
    try:
        r = subprocess.run(["mount", "-o", "remount," + mode, mp],
                           capture_output=True, text=True, timeout=25)
        return r.returncode == 0
    except Exception:  # noqa: BLE001
        return False


def write_boot_file(path, text):
    """Write a file that lives on the boot media.

    SystemRescue mounts the USB read-only, which used to make the Settings
    screen useless: an operator could type the Wi-Fi details but never save
    them without dropping to a terminal. So if the plain write fails, remount
    the stick read-write, write, flush, and put it back read-only.
    Returns None on success or a human-readable error."""
    try:
        with open(path, "w") as fh:
            fh.write(text)
        try:
            os.sync()
        except AttributeError:
            pass
        return None
    except OSError as first:
        mp = mount_point(path)
        if not remount(mp, "rw"):
            return ("Could not save: %s is mounted read-only and could not be "
                    "remounted read-write (%s). Run the GUI as root, or edit "
                    "audit.conf on the stick from another machine." % (mp, first))
        try:
            with open(path, "w") as fh:
                fh.write(text)
            try:
                os.sync()
            except AttributeError:
                pass
            return None
        except OSError as exc:
            return "Could not save even after remounting %s read-write: %s" % (mp, exc)
        finally:
            remount(mp, "ro")     # always leave the stick as we found it


# --------------------------------------------------------- offline queue ----
# Warehouse Wi-Fi drops. Rather than lose a unit's record, a failed upload is
# written to disk and retried in the background until it lands.
QUEUE_PATH = "/tmp/als-audit-queue.jsonl"
QUEUE_LOCK = threading.Lock()      # guards the file
FLUSH_LOCK = threading.Lock()      # only one flush at a time, or a record could
                                   # be uploaded twice by two racing threads


def queue_load():
    try:
        with open(QUEUE_PATH, "r", errors="replace") as fh:
            return [json.loads(l) for l in fh if l.strip()]
    except (OSError, ValueError):
        return []


def queue_write(items):
    with QUEUE_LOCK:
        try:
            with open(QUEUE_PATH, "w") as fh:
                for it in items:
                    fh.write(json.dumps(it) + "\n")
        except OSError:
            pass


def queue_add(payload):
    with QUEUE_LOCK:
        try:
            with open(QUEUE_PATH, "a") as fh:
                fh.write(json.dumps(payload) + "\n")
        except OSError:
            pass


def queue_count():
    return len(queue_load())


UPLOAD_LOCK = threading.Lock()


def upload_audit(payload):
    """Send a device record. On failure, queue it for automatic retry.
    Returns (response_or_None, queued_bool, error_message).

    Serialized: two drives in the same machine can finish wiping in the same
    second, and both records carry the same serial. The API finds-or-creates
    by serial, so two simultaneous uploads can race past the find and create
    the device twice. One at a time turns the second into a clean re-audit."""
    try:
        with UPLOAD_LOCK:
            return api("/devices/hardware-audit", "POST", payload, ensure_token()), False, ""
    except Exception as exc:  # noqa: BLE001
        queue_add(payload)
        return None, True, str(exc)


def queue_flush():
    """Retry everything waiting. Kept in order; anything that still fails stays."""
    if not FLUSH_LOCK.acquire(blocking=False):
        return 0                    # another flush is already running
    try:
        return _queue_flush()
    finally:
        FLUSH_LOCK.release()


def _queue_flush():
    items = queue_load()
    if not items:
        return 0
    kept, sent = [], 0
    for it in items:
        try:
            api("/devices/hardware-audit", "POST", it, ensure_token())
            sent += 1
        except Exception:  # noqa: BLE001
            kept.append(it)
    queue_write(kept)
    return sent


def queue_worker():
    while True:
        time.sleep(45)
        try:
            if queue_count():
                queue_flush()
        except Exception:  # noqa: BLE001
            pass


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
                              capture_output=True, text=True, timeout=90)
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
        # Attach SMART health to the profile so it is stored on the asset record
        # (profile is kept verbatim as JSONB, so this needs no API change).
        if isinstance(STATE["profile"], dict):
            STATE["profile"]["driveHealth"] = [
                {"device": d["device"], "model": d.get("model"), "size": d.get("size"),
                 "health": d.get("health")}
                for d in list_drives()
            ]
        if do_login:
            wifi_msg = connect_network()
            try:
                ensure_token()
                STATE["lots"] = api("/devices/lots", token=STATE["token"]) or []
                # Back online — push anything that was held while offline.
                if queue_count():
                    threading.Thread(target=queue_flush, daemon=True).start()
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

    def nic(s):
        """'Centrino Advanced-N 6205 [Taylor Peak]' -> 'Centrino Advanced-N 6205'.
        Vendor strings carry codenames and boilerplate that wrap onto three
        lines in the hardware panel."""
        s = re.sub(r"\s*[\[(][^\])]*[\])]", "", s or "").strip()
        s = re.sub(r"\s*(Gigabit\s+)?Network Connection\s*$", "", s, flags=re.I)
        s = re.sub(r"\s*(Wireless|Ethernet)\s+(Network\s+)?(Adapter|Controller)\s*$", "", s, flags=re.I)
        return s.strip(" -·")

    # The hardware card shows one line per component; each is assembled here so
    # the UI stays presentation-only.
    cores = joins(["%sC" % c["cores"] if c.get("cores") else "",
                   "%sT" % c["threads"] if c.get("threads") else ""], "/")

    # Worst drive health across the internal disks, shown on the Storage line.
    rank = {"failing": 3, "caution": 2, "healthy": 1}
    worst = ""
    for d in list_drives():
        s = ((d.get("health") or {}).get("status") or "")
        if rank.get(s, 0) > rank.get(worst, 0):
            worst = s
    health_note = (" · Health: %s" % worst.capitalize()) if worst else ""
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
            "storage": (joins([joins([d.get("capacity"), d.get("type")], " ")
                               for d in st], ", ") or "") + health_note,
            "display": joins([dsp.get("size"), dsp.get("resolution")]),
            "optical": "Present" if has_optical() else "Not present",
            "network": joins([nic(net.get("wifi")), nic(net.get("bluetooth")),
                              nic(net.get("ethernet"))]),
            "batteryLine": joins([bat.get("fullChargeCapacity") or bat.get("designCapacity"),
                                  ("Health %s" % bat["health"]) if bat.get("health") else "",
                                  bat.get("status")]),
            "tpm": joins([sec.get("tpm") or "No TPM detected",
                          ("Secure Boot %s" % sec["secureBoot"]) if sec.get("secureBoot") else ""]),
        },
    }


# --------------------------------------------------------------- drives ----
def lsblk_field(line, key):
    m = re.search(r'%s="([^"]*)"' % key, line)
    return m.group(1) if m else ""


DRIVES_CACHE = {"ts": 0.0, "data": []}


def list_drives(force=False):
    """Internal (non-removable, non-USB) whole disks that can be wiped/imaged,
    each with a friendly auto-selected method label for display.

    Cached briefly: the UI polls bootstrap every 1.5s while hardware is being
    detected, and this is called more than once per request — without the cache
    that is several lsblk/smartctl spawns a second on slow hardware."""
    now = time.time()
    if not force and DRIVES_CACHE["data"] and now - DRIVES_CACHE["ts"] < 5:
        return DRIVES_CACHE["data"]
    drives = []
    try:
        # -b gives SIZE in bytes, so the UI can estimate how long a wipe takes.
        # TYPE lets us drop pseudo-devices (see the filter below).
        out = subprocess.run(
            ["lsblk", "-dPb", "-o", "NAME,SIZE,MODEL,TRAN,RM,ROTA,TYPE"],
            capture_output=True, text=True, timeout=8).stdout
    except Exception:
        return drives
    for line in out.splitlines():
        name = lsblk_field(line, "NAME")
        if not name:
            continue
        tran = lsblk_field(line, "TRAN")
        rm = lsblk_field(line, "RM")
        rota = lsblk_field(line, "ROTA")
        # Only real whole disks. Without this, the boot media's SquashFS shows up
        # as /dev/loop0 ("1 GB, unknown model") and — being first alphabetically —
        # becomes the default wipe/install target. Also drops zram, ram and
        # optical devices.
        if lsblk_field(line, "TYPE") != "disk":
            continue
        if re.match(r"^(loop|ram|zram|sr|fd|md|dm-)", name):
            continue
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
            "health": smart_health("/dev/" + name),
        })
    DRIVES_CACHE["ts"], DRIVES_CACHE["data"] = now, drives
    return drives


def human_size(n):
    """512110190592 -> '512 GB' (decimal, matching how drives are sold)."""
    if not n:
        return ""
    if n >= 1_000_000_000_000:
        v = n / 1_000_000_000_000.0
        return ("%.1f" % v).rstrip("0").rstrip(".") + " TB"
    return "%d GB" % round(n / 1_000_000_000.0)


SMART_CACHE = {}     # device -> (timestamp, health dict)
SMART_PENDING = set()  # devices being probed right now, so we probe each once


def _smart_unknown():
    """Probed, but SMART is unavailable/unreadable. Distinct from None (= probe
    still running): the UI shows "Checking..." for None, and if a no-SMART drive
    were cached as None it would say "Checking..." forever."""
    return {"status": "unknown", "reasons": [], "hours": None, "tempC": None,
            "reallocated": None, "pending": None, "mediaErrors": None,
            "percentUsed": None}


def smart_health(dev, block=False):
    """SMART summary for one drive, so a failing disk is flagged BEFORE an
    operator commits to a multi-hour wipe. Handles both ATA and NVMe via
    `smartctl -j`.

    NON-BLOCKING by default: smartctl can take many seconds per disk, and this
    is reached from /api/bootstrap, which the UI polls while the page is
    loading. Blocking here would leave the operator staring at an empty screen,
    so an unprobed drive returns None and is probed on a background thread; the
    next poll picks up the answer."""
    hit = SMART_CACHE.get(dev)
    if hit and time.time() - hit[0] < 300:
        return hit[1]
    if not block:
        if dev not in SMART_PENDING:
            SMART_PENDING.add(dev)
            threading.Thread(target=lambda: smart_health(dev, block=True),
                             daemon=True).start()
        return None
    if not shutil.which("smartctl"):
        health = _smart_unknown()
        SMART_CACHE[dev] = (time.time(), health)
        SMART_PENDING.discard(dev)
        return health
    try:
        out = subprocess.run(["smartctl", "-j", "-H", "-A", dev],
                             capture_output=True, text=True, timeout=12).stdout
        d = json.loads(out)
    except Exception:  # noqa: BLE001
        # Cache the failure too: every terminal state must resolve the probe.
        health = _smart_unknown()
        SMART_CACHE[dev] = (time.time(), health)
        SMART_PENDING.discard(dev)
        return health
    if not isinstance(d, dict) or not d:
        health = _smart_unknown()
        SMART_CACHE[dev] = (time.time(), health)
        SMART_PENDING.discard(dev)
        return health

    passed = (d.get("smart_status") or {}).get("passed")
    hours = (d.get("power_on_time") or {}).get("hours")
    temp = (d.get("temperature") or {}).get("current")
    reallocated = pending = media_err = pct_used = None

    nv = d.get("nvme_smart_health_information_log") or {}
    if nv:
        pct_used = nv.get("percentage_used")
        media_err = nv.get("media_errors")
        hours = hours or nv.get("power_on_hours")
    for a in ((d.get("ata_smart_attributes") or {}).get("table") or []):
        raw = (a.get("raw") or {}).get("value")
        if a.get("id") == 5:
            reallocated = raw
        elif a.get("id") == 197:
            pending = raw

    reasons = []
    if passed is False:
        reasons.append("SMART self-assessment FAILED")
    if reallocated:
        reasons.append("%s reallocated sector%s" % (reallocated, "" if reallocated == 1 else "s"))
    if pending:
        reasons.append("%s pending sector%s" % (pending, "" if pending == 1 else "s"))
    if media_err:
        reasons.append("%s media error%s" % (media_err, "" if media_err == 1 else "s"))
    if isinstance(pct_used, int) and pct_used >= 90:
        reasons.append("%d%% of rated write life used" % pct_used)

    if passed is False:
        status = "failing"
    elif reasons:
        status = "caution"
    elif passed is True:
        status = "healthy"
    else:
        status = "unknown"

    health = {"status": status, "reasons": reasons, "hours": hours,
              "tempC": temp, "reallocated": reallocated, "pending": pending,
              "mediaErrors": media_err, "percentUsed": pct_used}
    SMART_CACHE[dev] = (time.time(), health)
    SMART_PENDING.discard(dev)
    return health


OPTICAL_CACHE = []   # single-item cache; hardware cannot change mid-session


def sync_clock():
    """Set the system clock from the network.

    A live-booted machine with no working RTC can be months out of date, and a
    wrong clock breaks HTTPS: the server's certificate looks "not yet valid",
    so the connection is refused before any data flows — which surfaces as a
    bare "not connected" with no error text. Tries NTP, then falls back to the
    Date header of a PLAIN HTTP request (no certificate needed, so it works
    even when TLS is exactly what's broken)."""
    # --- Layer 1: the offline floor -----------------------------------------
    # Most audited machines are old and their CMOS battery is dead, so they boot
    # believing it is years ago. Before touching the network, refuse to be
    # earlier than the boot media's own files: the stick cannot predate the day
    # it was written. Costs nothing, needs no network, and happens instantly.
    floor = 0.0
    for p in (CONF_PATH, SCRIPT, os.path.join(HERE, "index.html"),
              os.path.join(HERE, "server.py")):
        try:
            floor = max(floor, os.path.getmtime(p))
        except (OSError, TypeError):
            pass
    floor_applied = False
    if floor and time.time() < floor - 60 and shutil.which("date"):
        try:
            r = subprocess.run(["date", "-u", "-s",
                                time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(floor))],
                               capture_output=True, timeout=10)
            floor_applied = r.returncode == 0
        except Exception:  # noqa: BLE001
            pass

    # --- Layer 2: exact time from the internet ------------------------------
    # Tried first because it is ONE fast request when it works. Plain HTTP on
    # purpose: no certificate is involved, so it succeeds even when a wrong
    # clock is breaking TLS.
    true_epoch = None
    for url in ("http://clients3.google.com/generate_204",
                "http://www.msftconnecttest.com/connecttest.txt"):
        try:
            stamp = urllib.request.urlopen(url, timeout=6).headers.get("Date")
            if stamp:
                import email.utils
                parsed = email.utils.parsedate_tz(stamp)
                if parsed:
                    true_epoch = email.utils.mktime_tz(parsed)
                    break
        except Exception:  # noqa: BLE001
            continue

    # --- Layer 3: a time server on the LAN ----------------------------------
    # Only reached when there is no internet — an offline bench. These tools
    # have long timeouts, which is why they are last and never on the fast path.
    if true_epoch is None:
        host = (STATE["conf"].get("TIME_SERVER") or "").strip()
        if not host:
            spec = (STATE["conf"].get("IMAGE_SERVER") or "").strip()
            host = spec.lstrip("/").split(":")[0].split("/")[0] if spec else ""
        if host:
            for cmd in (["sntp", "-Ss", host], ["ntpdate", "-u", host]):
                if not shutil.which(cmd[0]):
                    continue
                try:
                    r = subprocess.run(cmd, capture_output=True, timeout=12)
                    if r.returncode == 0:
                        return True, "synced with the time server at %s" % host
                except Exception:  # noqa: BLE001
                    pass

    if true_epoch is None:
        if floor_applied:
            return True, ("no time source reachable — set from the boot media date "
                          "(approximate, but late enough for HTTPS)")
        return False, "no time source reachable"

    drift = true_epoch - time.time()
    if abs(drift) < 120:
        return True, "clock already correct"

    # Set it explicitly rather than trusting an NTP daemon to have worked: an
    # earlier version inferred success from elapsed wall time, so NTP tools that
    # merely hung looked like a successful sync and the real fix never ran.
    if not shutil.which("date"):
        return False, "clock is out by %d days but `date` is unavailable" % (abs(drift) // 86400)
    stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(true_epoch))
    try:
        r = subprocess.run(["date", "-u", "-s", stamp], capture_output=True,
                           text=True, timeout=10)
        if r.returncode != 0:
            return False, "could not set clock: %s" % ((r.stderr or r.stdout).strip()
                                                       or "permission denied?")
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)
    subprocess.run(["hwclock", "-w"], capture_output=True, timeout=10)   # persist it
    return True, "clock corrected (was out by %d days)" % (abs(drift) // 86400)


def net_check():
    """Diagnose the network layer by layer, so 'not connected' names the actual
    broken step instead of leaving the operator guessing. Runs in the GUI
    because the kiosk grabs the keyboard — there is no terminal to use."""
    def sh(cmd, timeout=8):
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
            return (r.stdout or r.stderr or "").strip(), r.returncode
        except Exception as exc:  # noqa: BLE001
            return "error: %s" % exc, 1

    api_url = (STATE["conf"].get("AUDIT_URL") or "").strip()
    host = ""
    try:
        host = urlparse(api_url).hostname or ""
    except Exception:  # noqa: BLE001
        pass

    ifaces, _ = sh(["ip", "-br", "a"])
    routes, _ = sh(["ip", "route"])
    gw = ""
    for line in routes.splitlines():
        parts = line.split()
        if parts[:1] == ["default"] and len(parts) > 2:
            gw = parts[2]
            break

    servers = []
    try:
        with open("/etc/resolv.conf", errors="replace") as fh:
            servers = [l.split()[1] for l in fh
                       if l.strip().startswith("nameserver") and len(l.split()) > 1]
    except OSError:
        pass

    steps = []
    has_ip = any(("/" in l and "127.0.0.1" not in l and "UP" in l.upper())
                 for l in ifaces.splitlines())
    steps.append(("Network address", has_ip,
                  "an address from the router" if has_ip else "no address — cable or DHCP"))

    steps.append(("Default gateway", bool(gw), gw or "none — cannot leave this network"))

    if gw:
        _, rc = sh(["ping", "-c", "1", "-W", "2", gw])
        steps.append(("Reach the router", rc == 0, gw))

    _, rc = sh(["ping", "-c", "1", "-W", "3", "1.1.1.1"])
    net_ok = rc == 0
    steps.append(("Reach the internet", net_ok, "1.1.1.1 (bypasses DNS)"))

    steps.append(("DNS servers set", bool(servers), ", ".join(servers) or "none in resolv.conf"))

    dns_ok, dns_detail = False, "no API host configured"
    if host:
        try:
            import socket
            dns_detail = socket.gethostbyname(host)
            dns_ok = True
        except Exception as exc:  # noqa: BLE001
            dns_detail = "cannot resolve %s (%s)" % (host, exc)
    steps.append(("Look up the server name", dns_ok, dns_detail))

    # A clock that is days out makes every HTTPS call fail with an empty error.
    now = time.strftime("%a %d %b %Y %H:%M UTC", time.gmtime())
    clock_ok, clock_detail = True, now
    try:
        resp = urllib.request.urlopen("http://clients3.google.com/generate_204", timeout=10)
        real = resp.headers.get("Date")
        if real:
            import email.utils
            drift = abs(time.time() - email.utils.mktime_tz(email.utils.parsedate_tz(real)))
            if drift > 300:
                clock_ok = False
                clock_detail = "%s — WRONG by %d days (breaks HTTPS)" % (now, drift // 86400)
    except Exception:  # noqa: BLE001
        pass
    steps.append(("System clock", clock_ok, clock_detail))

    api_ok, api_detail = False, "no AUDIT_URL set"
    if api_url:
        try:
            urllib.request.urlopen(urllib.request.Request(api_url), timeout=12)
            api_ok, api_detail = True, api_url
        except Exception as exc:  # noqa: BLE001
            api_detail = "%s (%s)" % (api_url, (str(exc) or type(exc).__name__))
    steps.append(("Reach ALS Inventory", api_ok, api_detail))

    # Name the first broken step — that is the thing to fix.
    verdict = "Everything reachable."
    for name, ok, _detail in steps:
        if not ok:
            verdict = "First failure: %s" % name
            break
    return {"steps": [{"name": n, "ok": bool(o), "detail": d} for n, o, d in steps],
            "verdict": verdict, "interfaces": ifaces, "routes": routes}


def tool_check():
    """Which imaging/erase tools this boot media actually has.

    Exists so the operator never has to find a terminal: the kiosk grabs the
    keyboard, so Ctrl+Alt+F2 usually doesn't work, and 'is Clonezilla here?'
    is the question that decides how OS install has to be built."""
    groups = [
        ("OS install (Clonezilla)", ["ocs-sr"]),
        ("OS install (fallback engine)",
         ["partclone.restore", "partclone.ntfs", "partclone.dd", "sfdisk", "ntfsresize"]),
        ("Compression", ["zstd", "pigz", "gzip"]),
        ("Wipe + audit", ["shred", "smartctl", "hdparm", "nvme", "blkdiscard"]),
        ("Kiosk display", ["cage", "xdotool", "xrandr", "firefox-esr", "firefox"]),
        ("Network shares", ["mount.nfs", "mount.cifs"]),
    ]
    out = []
    for label, names in groups:
        out.append({"group": label,
                    "tools": [{"name": n, "present": bool(shutil.which(n))} for n in names]})

    space = ""
    try:
        target = "/run/archiso/bootmnt" if os.path.isdir("/run/archiso/bootmnt") else "/"
        st = os.statvfs(target)
        free = st.f_bavail * st.f_frsize
        total = st.f_blocks * st.f_frsize
        space = "%s free of %s on %s" % (human_size(free), human_size(total), target)
    except Exception:  # noqa: BLE001
        pass

    can_clonezilla = bool(shutil.which("ocs-sr"))
    can_partclone = bool(shutil.which("partclone.restore")) and bool(shutil.which("sfdisk"))
    if can_clonezilla:
        verdict = "Clonezilla is installed — OS install can use it."
    elif can_partclone:
        verdict = ("Clonezilla is NOT installed, but partclone + sfdisk are — "
                   "OS install can be built on those instead.")
    else:
        verdict = ("Neither Clonezilla nor partclone is on this media — OS install "
                   "needs software added to the stick.")
    return {"groups": out, "space": space, "verdict": verdict,
            "clonezilla": can_clonezilla, "partclone": can_partclone}


def has_optical():
    """True if this machine has an optical drive (lsblk type 'rom')."""
    if OPTICAL_CACHE:
        return OPTICAL_CACHE[0]
    try:
        out = subprocess.run(["lsblk", "-dno", "TYPE"], capture_output=True,
                             text=True, timeout=6).stdout
        found = "rom" in out.split()
    except Exception:  # noqa: BLE001
        found = False
    OPTICAL_CACHE.append(found)
    return found


# ----------------------------------------------------------------- OS list ----
# ------------------------------------------------------- shared image library --
# Windows images are 8-15GB each. Carrying them on every stick means big media
# and re-copying on every update, so the library can live on one server on the
# warehouse LAN and each station mounts it read-only. If the server is not
# configured or not reachable we fall back to the stick, so imaging still works
# with no network.
IMAGE_STATE = {"root": None, "source": "usb", "error": "", "checked": 0.0}


def image_mounted():
    return os.path.ismount(IMAGE_MOUNT)


def mount_image_server(force=False):
    """Mount the configured share and return (root, source, error)."""
    spec = (STATE["conf"].get("IMAGE_SERVER") or "").strip()
    now = time.time()
    if not spec:
        IMAGE_STATE.update(root=IMAGES_LOCAL, source="usb", error="", checked=now)
        return IMAGES_LOCAL, "usb", ""
    # Serve the cached verdict - success OR failure - inside the TTL. Without
    # caching failures, a bench whose server is off re-ran `mount` (a multi-
    # second subprocess) on every poll, which is exactly the class of stall
    # that makes the kiosk feel dead. /api/rescan and Settings force a retry.
    if not force and IMAGE_STATE["checked"] and now - IMAGE_STATE["checked"] < 45:
        return (IMAGE_STATE["root"] or IMAGES_LOCAL, IMAGE_STATE["source"],
                IMAGE_STATE["error"])
    if not MOUNT_LOCK.acquire(blocking=False):     # one mount attempt at a time
        return (IMAGE_STATE["root"] or IMAGES_LOCAL, IMAGE_STATE["source"],
                IMAGE_STATE["error"])
    try:
        return _mount_image_server(spec, now)
    finally:
        MOUNT_LOCK.release()


def _mount_image_server(spec, now):
    if image_mounted():
        IMAGE_STATE.update(root=IMAGE_MOUNT, source="server", error="", checked=now)
        return IMAGE_MOUNT, "server", ""

    os.makedirs(IMAGE_MOUNT, exist_ok=True)
    # //host/share is SMB, host:/path is NFS. Read-only and soft-mounted so an
    # unreachable server can never hang the station.
    if spec.startswith("//"):
        cmd = ["mount", "-t", "cifs", "-o", "ro,guest,vers=3.0", spec, IMAGE_MOUNT]
    else:
        cmd = ["mount", "-t", "nfs", "-o", "ro,soft,timeo=50,retrans=2,nolock",
               spec, IMAGE_MOUNT]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        ok = r.returncode == 0
        err = "" if ok else (r.stderr or r.stdout or "").strip().split("\n")[-1]
    except Exception as exc:  # noqa: BLE001
        ok, err = False, str(exc)

    if ok and image_mounted():
        IMAGE_STATE.update(root=IMAGE_MOUNT, source="server", error="", checked=now)
        return IMAGE_MOUNT, "server", ""
    IMAGE_STATE.update(root=IMAGES_LOCAL, source="usb", checked=now,
                       error="Image server %s unavailable (%s) — using the images "
                             "on this stick." % (spec, err or "mount failed"))
    return IMAGES_LOCAL, "usb", IMAGE_STATE["error"]


MOUNT_LOCK = threading.Lock()


def ensure_images_async():
    """Kick a mount attempt in the background if the state is stale/unknown."""
    if IMAGE_STATE["checked"] and time.time() - IMAGE_STATE["checked"] < 45:
        return
    threading.Thread(target=mount_image_server, daemon=True).start()


def images_root():
    # Request-path accessor: NEVER mounts. /api/bootstrap is polled while the
    # page loads, and a mount against an unreachable server blocks for seconds.
    ensure_images_async()
    return IMAGE_STATE["root"] or IMAGES_LOCAL


MANIFEST_CACHE = {"root": None, "ts": 0.0, "data": []}


def list_os_images():
    root = images_root()
    if not root:
        return []
    # Short TTL cache: the manifest may live on the NFS share, and
    # /api/bootstrap is polled - without this, every poll is a network
    # filesystem read.
    now = time.time()
    if MANIFEST_CACHE["root"] == root and now - MANIFEST_CACHE["ts"] < 3:
        return MANIFEST_CACHE["data"]
    manifest = os.path.join(root, "manifest.json")
    if not os.path.isfile(manifest):
        MANIFEST_CACHE.update(root=root, ts=now, data=[])
        return []
    try:
        with open(manifest, "r", errors="replace") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        MANIFEST_CACHE.update(root=root, ts=now, data=[])
        return []
    imgs = []
    for it in data.get("images", []):
        d = it.get("dir") or it.get("id")
        present = bool(d) and os.path.isdir(os.path.join(root, d))
        imgs.append({
            "id": it.get("id"),
            "name": it.get("name", it.get("id")),
            "version": it.get("version", ""),
            "icon": it.get("icon", ""),
            "dir": d,
            "present": present,  # false = listed but image files not on the stick yet
        })
    MANIFEST_CACHE.update(root=root, ts=now, data=imgs)
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
                      "cancelled": False, "seq": 0}
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
                    job["seq"] += 1          # total lines ever produced
                    del job["log"][:-400]    # keep only the tail in memory
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
                "waiting": queue_count(),   # records held offline, retrying
                "imageSource": IMAGE_STATE["source"],   # "server" | "usb"
                "imageError": IMAGE_STATE["error"],
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
            q = parse_qs(u.query)
            kind = (q.get("type") or [""])[0]
            job = JOBS.get(kind)
            if not job:
                return self._send(200, {"running": False, "log": [], "result": None,
                                        "error": None, "elapsed": 0, "idle": 0,
                                        "seq": 0, "logFrom": 0})
            # Serialise a snapshot, not the live dict the worker thread mutates.
            now = time.time()
            snap = dict(job)
            log = list(job.get("log") or [])
            seq = job.get("seq", len(log))
            first = seq - len(log)          # index of the oldest retained line
            # Incremental: a multi-hour wipe is polled thousands of times, so send
            # only lines the client has not seen instead of the whole log each time.
            try:
                since = int((q.get("since") or ["-1"])[0])
            except ValueError:
                since = -1
            if 0 <= since <= seq and since >= first:
                snap["log"] = log[since - first:]
                snap["logFrom"] = since
            else:
                snap["log"] = log
                snap["logFrom"] = first
            snap["seq"] = seq
            snap["elapsed"] = int(now - job.get("startedAt", now))   # seconds running
            snap["idle"] = int(now - job.get("updatedAt", now))      # seconds since output
            return self._send(200, snap)

        if u.path == "/api/health":
            # Deliberately trivial: the launcher polls this to know when the UI
            # can be opened, so it must never touch hardware or the network.
            return self._send(200, {"ok": True})

        if u.path == "/api/toolcheck":
            return self._send(200, tool_check())

        if u.path == "/api/netcheck":
            return self._send(200, net_check())

        if u.path == "/api/settings":
            c = STATE["conf"]
            return self._send(200, {
                "wifiSsid": c.get("WIFI_SSID", ""),
                "serverUrl": c.get("AUDIT_URL", ""),
                "wipeEnabled": c.get("AUDIT_WIPE", "0") == "1",
                "wipeMethod": c.get("AUDIT_WIPE_METHOD", "auto"),
                "imageServer": c.get("IMAGE_SERVER", ""),
            })

        return self._send(404, {"message": "not found"})

    def do_POST(self):  # noqa: N802
        u = urlparse(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}") if length else {}
        except ValueError:
            body = {}

        if u.path == "/api/fixclock":
            ok, msg = sync_clock()
            if ok:
                STATE["token"] = None       # re-login now that TLS can succeed
                threading.Thread(target=refresh, daemon=True).start()
            return self._send(200, {"ok": ok, "message": msg})

        if u.path == "/api/rescan":
            DRIVES_CACHE["ts"] = 0.0        # a rescan must re-read the hardware
            SMART_CACHE.clear()
            del OPTICAL_CACHE[:]
            threading.Thread(target=refresh, daemon=True).start()
            return self._send(200, {"started": True})

        if u.path == "/api/audit":
            if not STATE["profile"]:
                return self._send(400, {"message": "hardware not captured yet"})
            payload = {"lotId": body.get("lotId"), "profile": STATE["profile"]}
            if body.get("subLotId"):
                payload["subLotId"] = body["subLotId"]
            if body.get("notes"):
                payload["notes"] = body["notes"]
            out, queued, err = upload_audit(payload)
            if queued:
                # Never lose the unit: it is on disk and will upload itself.
                return self._send(200, {"queued": True, "waiting": queue_count(),
                                        "message": err})
            return self._send(200, dict(out or {}, queued=False))

        if u.path == "/api/wipe/cancel":
            dev = body.get("device", "")
            ok, msg = cancel_job(wipe_kind(dev) if dev else "wipe")
            return self._send(200, {"ok": ok, "message": msg})

        if u.path == "/api/wipe/start":
            # One or many drives: several disks in the same machine are wiped
            # concurrently, so a dual-disk unit takes as long as its slowest
            # drive instead of the sum of both.
            devices = body.get("devices") or ([body.get("device")] if body.get("device") else [])
            method = body.get("method") or STATE["conf"].get("AUDIT_WIPE_METHOD", "auto")
            lot_id = body.get("lotId")
            sub_lot_id = body.get("subLotId")
            if not SCRIPT:
                return self._send(500, {"message": "engine not found"})
            if not devices:
                return self._send(400, {"message": "no drive selected"})
            for d in devices:
                if not re.match(r"^/dev/[A-Za-z0-9]+$", d or ""):
                    return self._send(400, {"message": "invalid device: %s" % d})

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
                out, queued, err = upload_audit(payload)
                if queued:
                    # The erase itself succeeded; only the upload is pending.
                    result["queued"] = True
                    result["waiting"] = queue_count()
                    result["recordError"] = ("no connection — the wipe record is saved "
                                             "on this machine and will upload automatically")
                    return
                result["recorded"] = bool(out and out.get("assetId"))
                result["recordName"] = (out or {}).get("name")
                result["recordTag"] = (out or {}).get("tag")

            started, busy = [], []
            for d in devices:
                ok = start_job(wipe_kind(d), ["bash", SCRIPT, "--wipe-drive", d, method],
                               "WIPE_RESULT ", d, on_done=record_wipe)
                (started if ok else busy).append(d)
            if not started:
                return self._send(409, {"message": "a wipe is already running on %s"
                                                   % ", ".join(busy)})
            return self._send(200, {"started": started, "busy": busy})

        if u.path == "/api/os/install":
            device = body.get("device", "")
            image = body.get("imageId", "")
            if not re.match(r"^/dev/[A-Za-z0-9]+$", device):
                return self._send(400, {"message": "invalid device"})
            if not re.match(r"^[A-Za-z0-9_.-]+$", image or ""):
                return self._send(400, {"message": "invalid image"})
            # Point the driver at whichever library is active (server share or
            # the stick). This MUST be set before the job starts — it was
            # previously assigned afterwards, so the child never saw it.
            root, source, img_err = mount_image_server()
            if not root:
                return self._send(400, {"message": "no image library available"})
            os.environ["ALS_IMAGES_ROOT"] = root
            started = start_job("install", ["bash", INSTALL_SH, image, device],
                                "INSTALL_RESULT ", device)
            if not started:
                return self._send(409, {"message": "an install is already running"})
            return self._send(200, {"started": True, "imageSource": source,
                                    "imageWarning": img_err})

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
            if "imageServer" in body:
                updates["IMAGE_SERVER"] = body["imageServer"].strip()
                IMAGE_STATE["checked"] = 0.0        # re-evaluate immediately
                threading.Thread(target=lambda: mount_image_server(force=True),
                                 daemon=True).start()
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
    # Correct the clock BEFORE logging in (a wrong date breaks HTTPS), but do it
    # on a background thread: these are network calls with timeouts, and blocking
    # here would stop the web server from listening — the kiosk browser opens
    # within seconds and would show "unable to connect".
    def boot():
        try:
            _ok, msg = sync_clock()
            print("clock: %s" % msg)
        except Exception as exc:  # noqa: BLE001
            print("clock: %s" % exc)
        try:
            mount_image_server(force=True)   # so the first poll already knows
        except Exception:  # noqa: BLE001
            pass
        refresh()
    threading.Thread(target=boot, daemon=True).start()
    threading.Thread(target=queue_worker, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("ALS Audit Station GUI on http://127.0.0.1:%d  (engine: %s)" % (PORT, SCRIPT))
    srv.serve_forever()


if __name__ == "__main__":
    main()
