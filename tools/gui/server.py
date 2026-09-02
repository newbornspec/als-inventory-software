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
import glob
import os
import re
import shutil
import signal
import subprocess
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import urllib.parse
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("ALS_GUI_PORT", "8800"))

# Where the engine + config + images live (USB root first, then dev checkout).
# archiso keeps the tools at the boot mount; an Ubuntu stick keeps them on a
# separate writable partition, which the live system mounts under /media (or,
# in a bare shell, not at all — start-gui.sh mounts it by label first).
SEARCH_DIRS = (
    ["/run/archiso/bootmnt", "/cdrom", "/isodevice", "/mnt/usb", "/mnt/als-media"]
    + sorted(glob.glob("/media/*/*")) + sorted(glob.glob("/media/*"))
    + [os.path.dirname(HERE), HERE]
)


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
    # The human at the station this session. The stick logs in as ONE shared
    # account, so this is the only place the actual operator's name exists.
    # Deliberately per-boot: a fresh shift starts blank rather than inheriting
    # yesterday's name.
    "operator": "",
    # Which WORKFLOW this session is filing audits into: 'amazon' (standalone,
    # no lot -- lands in the Audit workspace) or 'goods_in' (into the selected
    # batch). The station is a shared tool; the workflow decides the
    # destination. Auto-selected when the account may only do one; an admin
    # (or dual-permission account) chooses in the GUI before starting work.
    "workflow": "",
    # The signed-in account's role/permissions, straight from the login
    # response. None (not []) means the server predates permissions -- treat
    # as legacy and behave exactly like the old lot-coupled station.
    "role": "",
    "permissions": None,
}
# One background job per kind (only one wipe/install runs at a time).
JOBS = {"wipe": None, "install": None}
PROCS = {}          # kind -> Popen, so a running job can be cancelled
LOCK = threading.Lock()
# Guards job["log"]/job["seq"] as a PAIR. Two threads now append to a running
# job's log (the engine reader and the disk-write watchdog), and the /api/job
# incremental protocol derives the client's window from seq - len(log) — so a
# torn read there would silently skip or repeat lines on the operator's screen.
LOG_LOCK = threading.Lock()

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
    """Remount a mountpoint rw or ro, elevating when we are not root.

    This called plain `mount`, which only root may use. Under SystemRescue the
    backend WAS root, so it worked; on Ubuntu the backend runs as the desktop
    user, so every remount failed and Settings could not be saved at all. The
    operator got "could not be remounted read-write" and was told to run the
    whole GUI as root - which is exactly what we cannot do, because the browser
    has to attach to the desktop user's display. sudo is passwordless on the
    live image, and -n keeps it from blocking on a prompt no kiosk can answer.
    """
    cmd = ["mount", "-o", "remount," + mode, mp]
    if os.geteuid() != 0 and shutil.which("sudo"):
        cmd = ["sudo", "-n"] + cmd
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=25)
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
                    "remounted read-write (%s). Restart the backend with "
                    "'sudo python3 <media>/gui/server.py', or edit audit.conf "
                    "on the stick from another machine." % (mp, first))
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


# ------------------------------------------------------------ image names ----
# The operator's own label for each OS image, e.g. "Windows 11 Pro - Standard
# Office". Kept on the stick rather than beside the images because the image
# library is mounted READ-ONLY on purpose — that is what stops a machine being
# imaged from damaging it — so the station cannot write there, and should not
# be able to.

def image_names_path():
    """Beside audit.conf at the stick root."""
    base = os.path.dirname(CONF_PATH) if CONF_PATH else os.path.dirname(HERE)
    return os.path.join(base, "image-names.json")


def load_image_names():
    try:
        with open(image_names_path(), "r", errors="replace") as fh:
            data = json.load(fh)
        return {k: v for k, v in data.items() if isinstance(v, str)} \
            if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_image_name(image_id, name):
    """Set (or clear, when name is blank) one image's label.
    Returns None on success or a human-readable error."""
    names = load_image_names()
    name = (name or "").strip()[:60]
    if name:
        names[image_id] = name
    else:
        names.pop(image_id, None)          # blank restores the manifest name
    err = write_boot_file(image_names_path(),
                          json.dumps(names, indent=2, sort_keys=True) + "\n")
    if err:
        return err
    MANIFEST_CACHE["ts"] = 0.0             # or the rename would not show for 30s
    return None


# --------------------------------------------------------- offline queue ----
# Warehouse Wi-Fi drops. Rather than lose a unit's record, a failed upload is
# written to disk and retried in the background until it lands.
# Condition-grade slugs the API's assets_condition_grade_enum accepts. Mirrors
# AssetConditionGrade in apps/api/src/assets/asset.entity.ts — the kiosk is a
# standalone file with no build step, so this list is duplicated by necessity;
# if that enum ever gains a value, update it here and in index.html too.
GRADES = ("grade_a", "grade_b", "grade_c", "grade_d", "for_parts", "scrap")

# /tmp is a tmpfs on a live USB boot, so the queue used to live in RAM: every
# record still waiting for the network was lost the moment the machine was
# switched off — which is exactly what an operator does with a station that
# cannot reach the server. It now lives on the stick beside audit.conf, and RAM
# is only the fallback for when the stick will not take a write at all.
QUEUE_FALLBACK = "/tmp/als-audit-queue.jsonl"
QUEUE_LOCK = threading.Lock()      # guards the file
FLUSH_LOCK = threading.Lock()      # only one flush at a time, or a record could
                                   # be uploaded twice by two racing threads


def queue_path():
    """Beside audit.conf on the stick, so a queued audit survives a reboot."""
    base = os.path.dirname(CONF_PATH) if CONF_PATH else None
    return os.path.join(base, "audit-queue.jsonl") if base else QUEUE_FALLBACK


def queue_on_stick():
    """Whether the stick is where we would WRITE. Internal plumbing only."""
    return queue_path() != QUEUE_FALLBACK


def queue_durable():
    """Whether everything currently queued would survive a power-off.

    Deliberately not just a path check: a write can fall back to RAM when the
    stick refuses it, and a station that answers "safe to reboot" on the
    strength of its preferred path would then lose the records it promised to
    keep. Derived from what is actually on disk, so it cannot drift."""
    if not queue_on_stick():
        return False
    return not _read_jsonl(QUEUE_FALLBACK)


def _read_jsonl(path):
    try:
        with open(path, "r", errors="replace") as fh:
            return [json.loads(l) for l in fh if l.strip()]
    except (OSError, ValueError):
        return []


def _queue_load_unlocked():
    items = _read_jsonl(queue_path())
    if queue_on_stick():
        # Anything stranded in RAM by an earlier boot, or by a write the stick
        # refused, still counts as waiting.
        items += _read_jsonl(QUEUE_FALLBACK)
    return items


def _queue_write_unlocked(items):
    text = "".join(json.dumps(it) + "\n" for it in items)
    path = queue_path()
    err = None
    try:
        with open(path, "w") as fh:
            fh.write(text)
        try:
            os.sync()
        except AttributeError:
            pass
    except OSError:
        # The stick is normally mounted read-only; this is the same remount
        # dance audit.conf already uses.
        err = write_boot_file(path, text)

    if err is None and queue_on_stick():
        # The stick copy is authoritative now. Drop any RAM copy, or the same
        # record would be counted — and re-uploaded — twice.
        try:
            if os.path.exists(QUEUE_FALLBACK):
                os.remove(QUEUE_FALLBACK)
        except OSError:
            pass
        return
    if err:
        # Never lose a record because the stick would not take it. RAM is worse
        # than the stick, and far better than nowhere.
        try:
            with open(QUEUE_FALLBACK, "w") as fh:
                fh.write(text)
        except OSError:
            pass


def queue_load():
    with QUEUE_LOCK:
        return _queue_load_unlocked()


def queue_write(items):
    with QUEUE_LOCK:
        _queue_write_unlocked(items)


def queue_add(payload):
    # Read-modify-write rather than append: there is no appending through the
    # remount path, and the queue only ever holds a handful of records.
    with QUEUE_LOCK:
        _queue_write_unlocked(_queue_load_unlocked() + [payload])


def queue_count():
    return len(queue_load())


UPLOAD_LOCK = threading.Lock()


def allowed_workflows():
    """Which workflows this account may file. Admin: both. Otherwise the two
    perform_* permissions decide. A legacy server that sends no permissions
    gets ['goods_in'] -- the station behaves exactly as it did before the
    workflow split, which is also what that server expects."""
    if STATE.get("role") == "admin":
        return ["amazon", "goods_in"]
    perms = STATE.get("permissions")
    if perms is None:
        return ["goods_in"]
    out = []
    if "perform_amazon_audit" in perms:
        out.append("amazon")
    if "perform_goods_in_audit" in perms:
        out.append("goods_in")
    return out


def current_workflow():
    wfs = allowed_workflows()
    if STATE.get("workflow") in wfs:
        return STATE["workflow"]
    if len(wfs) == 1:
        return wfs[0]
    return ""   # dual-permission account that has not chosen yet


def stamp_provenance(payload):
    """Phase-5 provenance on every record this station files: the station IS
    the Amazon audit workflow (auditKind), and the operator field names the
    human the shared login cannot. Servers that predate these fields reject
    unknown properties is NOT a concern here -- the API's DTOs ignore extras
    only after validation, so these two are validated, optional fields there.
    """
    wf = current_workflow()
    if wf in ("amazon", "goods_in"):
        payload["auditKind"] = wf
    if wf == "amazon":
        # Standalone audit: no lot, ever. The server ignores a stray lotId on
        # an amazon payload too -- stripping here keeps the record honest at
        # the source.
        payload.pop("lotId", None)
        payload.pop("subLotId", None)
    op = (STATE.get("operator") or "").strip()
    if op:
        payload["operatorName"] = op[:120]
    return payload


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
    u = (out or {}).get("user") or {}
    STATE["userName"] = u.get("name") or ""
    STATE["role"] = u.get("role") or ""
    perms = u.get("permissions")
    STATE["permissions"] = perms if isinstance(perms, list) else None
    # One permitted workflow -> it is simply selected; the GUI shows no
    # chooser (spec: specialised users are not offered the other option).
    wfs = allowed_workflows()
    if len(wfs) == 1:
        STATE["workflow"] = wfs[0]
    return tok


def ensure_token():
    return STATE["token"] or login()


# --------------------------------------------------------------- capture ----
def audit_cmd(*args, env_vars=None):
    """The audit command, elevated when this backend is not already root.

    The GUI has to run as the DESKTOP user, because that is the only account
    whose display the browser can attach to. But nearly everything the audit
    reads needs root: the ACPI tables are mode 0400, efivars is root-only,
    mounting the machine's Windows partition needs root, and so does blkid.

    SystemRescue hid this by logging in as root. Ubuntu's live session does
    not, so without elevating here every device-lock check would report UNKNOWN
    and the GUI would look broken while behaving exactly as designed. sudo is
    passwordless on the live image; -n keeps it from ever blocking on a prompt
    the kiosk has no way to answer.
    """
    base = ["bash", SCRIPT, *args]
    if env_vars:
        # Pass variables through `env`, NOT through the process environment.
        #
        # Ubuntu's sudoers carries `Defaults env_reset`, which wipes the
        # environment before exec'ing the target. So setting AUDIT_DEBUG=1 in
        # subprocess(env=...) reached sudo and died there, and the engine ran
        # its full interactive upload flow instead of printing JSON and
        # exiting - including a `read -rp` lot prompt the GUI cannot answer.
        # It only worked before because SystemRescue ran everything as root and
        # never went through sudo at all.
        base = ["env"] + ["%s=%s" % (k, v) for k, v in env_vars.items()] + base
    if os.geteuid() != 0 and shutil.which("sudo"):
        return ["sudo", "-n", *base]
    return base


def capture():
    if not SCRIPT:
        raise RuntimeError("hardware-audit.sh not found on the boot media.")
    # AUDIT_DEBUG=1 makes the engine print the profile as JSON and exit rather
    # than running the interactive upload flow. It has to survive sudo - see
    # audit_cmd - so it goes in the command, not the environment.
    # 900, not 300. The engine installs its missing packages inside this budget
    # on a first run, and ten packages over warehouse Wi-Fi can exceed five
    # minutes on their own - at which point the operator got "Could not read the
    # hardware profile from the engine", which describes a parsing problem and
    # not the download that actually ran out of time.
    proc = subprocess.run(audit_cmd(env_vars={"AUDIT_DEBUG": "1"}),
                          capture_output=True, text=True, timeout=900)
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
        proc = subprocess.run(audit_cmd("--connect-wifi"),
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


def _dns_query(name):
    """A standard recursive A query — what a resolver actually exists to answer.
    (The first version of this probe asked for the root NS record, which is a
    DNS-amplification vector that some resolvers drop. No reason to invite
    being told a working server is dead.)"""
    q = bytearray(b"\xab\xcd\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00")
    for label in name.split("."):
        q.append(len(label))
        q.extend(label.encode())
    q.append(0)
    q.extend(b"\x00\x01\x00\x01")          # QTYPE=A, QCLASS=IN
    return bytes(q)


def dns_probe(server, name="cloudflare.com", timeout=4):
    """Can this resolver be reached, and over which transport?

    Returns (ok, note). UDP first, because that is what the system resolver
    uses. TCP 53 second, because the difference between the two is the whole
    diagnosis: a site that filters UDP 53 (to force traffic through its own
    resolver) but passes TCP is a network policy, not a dead server, and the
    operator should not be sent hunting for a fault on the station."""
    import socket
    q = _dns_query(name)

    sk = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sk.settimeout(timeout)
    try:
        sk.sendto(q, (server, 53))
        data, _ = sk.recvfrom(512)
        # Match the transaction id so a stray packet cannot pass for an answer.
        if len(data) > 12 and data[0] == 0xAB and data[1] == 0xCD:
            return True, "answers"
    except Exception:  # noqa: BLE001
        pass
    finally:
        try:
            sk.close()
        except Exception:  # noqa: BLE001
            pass

    try:
        st = socket.create_connection((server, 53), timeout=timeout)
        try:
            st.sendall(len(q).to_bytes(2, "big") + q)   # DNS/TCP length prefix
            data = st.recv(514)
        finally:
            st.close()
        if len(data) > 14 and data[2] == 0xAB and data[3] == 0xCD:
            return True, "answers over TCP only (UDP 53 filtered on this network)"
    except Exception:  # noqa: BLE001
        pass

    return False, "SILENT"


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

    # Never judge the internet by one address or one protocol. This site blocks
    # 1.1.1.1 outright — by ICMP and by TCP — while the rest of the internet
    # works fine, and plenty of networks filter ping. Either alone produced a
    # red "First failure" on a station that was uploading audits happily.
    _, rc = sh(["ping", "-c", "1", "-W", "3", "1.1.1.1"])
    net_ok, net_detail = rc == 0, "1.1.1.1 (bypasses DNS)"
    if not net_ok:
        import socket
        for ip, who in (("1.1.1.1", "Cloudflare"), ("8.8.8.8", "Google"), ("9.9.9.9", "Quad9")):
            try:
                socket.create_connection((ip, 443), timeout=4).close()
                net_ok = True
                net_detail = "%s:443 (%s) — ping is filtered on this network" % (ip, who)
                break
            except Exception:  # noqa: BLE001
                continue
        if not net_ok:
            net_detail = "1.1.1.1 / 8.8.8.8 / 9.9.9.9 all unreachable by ping and TCP 443"
    steps.append(("Reach the internet", net_ok, net_detail))

    steps.append(("DNS servers set", bool(servers), ", ".join(servers) or "none in resolv.conf"))

    # "Configured" and "reachable" are different failures with different fixes:
    # unreachable resolvers mean routing/firewall, not DNS.
    if servers:
        probes = [(s,) + dns_probe(s) for s in servers[:3]]
        reach = ["%s %s" % (s, note) for s, _ok, note in probes]
        any_ok = any(ok for _s, ok, _n in probes)
        steps.append(("DNS servers answer", any_ok, ", ".join(reach)))

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

    # Reaching ALS Inventory is the ONLY thing that decides whether this station
    # is usable. Every step above it exists to explain a failure, not to be one:
    # treated as failures in their own right they cried wolf on a working
    # station, and the operator went looking for a network fault that was not
    # there. When the API is reachable, a failed diagnostic is advisory.
    if api_ok:
        verdict = "Everything working — ALS Inventory is reachable."
    else:
        verdict = "Everything reachable."
        for name, ok, _detail in steps:
            if not ok:
                verdict = "First failure: %s" % name
                break
    return {"steps": [{"name": n, "ok": bool(o), "detail": d,
                       "advisory": bool(api_ok and not o)} for n, o, d in steps],
            "verdict": verdict, "ok": bool(api_ok),
            "interfaces": ifaces, "routes": routes}


PRIOR_CACHE = {"key": None, "ts": 0.0, "data": None}


def prior_audit(lot_id):
    """Has the machine currently on the bench already been audited into this
    batch? Matched on serial number, which is how the API identifies a device
    (find-or-create by serial), so this answers the same question the upload
    would. Returns None when unknown - no profile, no serial, or offline.

    Cached briefly and keyed on lot+serial: the UI asks whenever the operator
    changes batch, and this must never become another per-poll network call."""
    prof = STATE.get("profile") or {}
    ident = (prof.get("identification") or {}) if isinstance(prof, dict) else {}
    serial = (ident.get("serialNumber") or "").strip()
    if not serial or not lot_id:
        return None

    key = "%s|%s" % (lot_id, serial)
    now = time.time()
    if PRIOR_CACHE["key"] == key and now - PRIOR_CACHE["ts"] < 20:
        return PRIOR_CACHE["data"]

    try:
        rows = api("/assets?batchId=%s&search=%s" % (lot_id, urllib.parse.quote(serial)),
                   token=ensure_token()) or []
    except Exception:  # noqa: BLE001
        return None                      # offline: stay silent rather than guess

    match = None
    for a in rows if isinstance(rows, list) else []:
        # ILIKE %serial% can match loosely; require an exact serial or tag hit.
        for field in ("serialNumber", "tag"):
            if (a.get(field) or "").strip().lower() == serial.lower():
                match = a
                break
        if match:
            break
    if not match:
        PRIOR_CACHE.update(key=key, ts=now, data={"found": False})
        return PRIOR_CACHE["data"]

    audits = []
    try:
        audits = api("/assets/%s/audits" % match["id"], token=ensure_token()) or []
    except Exception:  # noqa: BLE001
        audits = []
    last = audits[0] if isinstance(audits, list) and audits else None

    data = {
        "found": True,
        "assetId": match.get("id"),
        "name": match.get("name"),
        "tag": match.get("tag"),
        "serial": serial,
        "auditCount": len(audits) if isinstance(audits, list) else 0,
        "lastAuditAt": (last or {}).get("createdAt"),
        "lastWipeStatus": (last or {}).get("dataWipeStatus"),
        "grade": match.get("conditionGrade"),
        "auditStatus": match.get("auditStatus"),
    }
    PRIOR_CACHE.update(key=key, ts=now, data=data)
    return data


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
    # A missing or unreadable manifest is no longer fatal — the directory scan
    # further down finds every restorable image on its own. A library holding
    # images but no manifest.json used to report an empty list, which looks
    # exactly like a library that is not mounted.
    data = {}
    manifest = os.path.join(root, "manifest.json")
    if os.path.isfile(manifest):
        try:
            with open(manifest, "r", errors="replace") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            data = {}
    if not isinstance(data, dict):
        data = {}
    names = load_image_names()
    imgs = []
    listed = set()
    for it in data.get("images", []):
        d = it.get("dir") or it.get("id")
        # "Present" has to mean RESTORABLE, not merely "the folder exists".
        # A capture aborted by a full disk or a thermal shutdown leaves the big
        # payload files but not these three, and it must never be offered as a
        # usable image. IMAGE-SERVER-SETUP.md already promised this behaviour.
        exists = bool(d) and os.path.isdir(os.path.join(root, d))
        present = exists and image_complete(os.path.join(root, d))
        if d:
            listed.add(d)
        imgs.append({
            "id": it.get("id"),
            # The operator's own label. Everything technical (version, build)
            # stays in the record but no longer competes with it for the name:
            # three images all reading "Windows 11 Pro - 23H2 64-bit" told you
            # nothing about which was which.
            "name": names.get(it.get("id")) or it.get("name", it.get("id")),
            "renamed": bool(names.get(it.get("id"))),
            "version": it.get("version", ""),
            "icon": it.get("icon", ""),
            "dir": d,
            "present": present,  # false = listed but image files not on the stick yet
            # Distinguishes "not copied yet" from "copied but the capture never
            # finished", so the UI can say which.
            "incomplete": exists and not present,
            "unlisted": False,
        })

    # Anything restorable sitting in the library but NOT named in the manifest
    # is still offered, under its folder name. Promoting a capture should not
    # require hand-editing JSON before the station will admit the image exists —
    # an image you cannot see is indistinguishable from one that is missing.
    try:
        for d in sorted(os.listdir(root)):
            if d in listed or d.startswith("."):
                continue
            p = os.path.join(root, d)
            if not os.path.isdir(p) or not image_complete(p):
                continue
            imgs.append({"id": d, "name": names.get(d) or d, "version": "",
                         "icon": "", "dir": d, "present": True, "incomplete": False,
                         "unlisted": True, "renamed": bool(names.get(d))})
    except OSError:
        pass

    MANIFEST_CACHE.update(root=root, ts=now, data=imgs)
    return imgs


# ------------------------------------------------------------- job runner ----

def _bytes_short(n):
    """Progress-scale formatter. human_size() rounds to whole GB and returns ""
    for small values, so a 98 MB/s rate would render as "0 GB"."""
    n = float(n or 0)
    for unit, step in (("TB", 1e12), ("GB", 1e9), ("MB", 1e6), ("kB", 1e3)):
        if n >= step:
            return ("%.1f" % (n / step)).rstrip("0").rstrip(".") + " " + unit
    return "%d B" % int(n)


def disk_written_bytes(device):
    """Bytes written to a whole disk since boot, asked of the kernel directly.
    Field 7 of /sys/block/<dev>/stat is sectors written, 512 B each."""
    kname = (device or "").replace("/dev/", "").strip()
    if not kname or "/" in kname:
        return None
    try:
        with open("/sys/block/%s/stat" % kname, "r") as fh:
            return int(fh.read().split()[6]) * 512
    except (OSError, IndexError, ValueError):
        return None


def _write_watchdog(job, device, stop):
    """Heartbeat driven by real disk writes instead of engine chatter.

    Clonezilla hands partclone an ncurses UI and we run it through a pipe with
    no terminal attached, so a perfectly healthy restore prints NOTHING for its
    entire run. That made `idle` a measure of talkativeness rather than
    liveness, and a working restore looked exactly like a dead one. Asking the
    kernel how many bytes actually landed on the drive is engine-independent,
    so it keeps working whatever we restore with later."""
    base = disk_written_bytes(device)
    if base is None:
        return
    last, last_t = base, time.time()
    while not stop.wait(15):
        cur = disk_written_bytes(device)
        if cur is None:
            return
        now = time.time()
        delta = cur - last
        rate = delta / max(0.001, now - last_t)
        job["writeBytes"] = cur - base
        job["writeStalled"] = delta == 0
        last, last_t = cur, now
        if not delta:
            continue                 # nothing moved — let `idle` climb, honestly
        el = int(now - job.get("startedAt", now))
        with LOG_LOCK:
            job["log"].append("    [%02d:%02d:%02d] %s written to %s (%s/s)" % (
                el // 3600, (el % 3600) // 60, el % 60,
                _bytes_short(cur - base), device.replace("/dev/", ""),
                _bytes_short(rate)))
            job["seq"] += 1
            del job["log"][:-400]
        job["updatedAt"] = now


def image_complete(path):
    """A Clonezilla savedisk only counts as finished once these exist. The two
    small metadata files are what a restore reads first, and clonezilla-img is
    the last thing written on a successful save."""
    return all(os.path.isfile(os.path.join(path, f))
               for f in ("disk", "parts", "clonezilla-img"))


def start_job(kind, argv, result_prefix, device="", on_done=None,
              watch_writes=False, noun="process", hint=""):
    """Run a long command in the background, streaming its stdout into a rolling
    log and parsing the final `<PREFIX> {json}` line into `result`. `on_done`
    (given the parsed result) runs after the process ends and before the job is
    marked finished — used to upload the wipe record. `watch_writes` adds a
    kernel-level disk-write heartbeat for engines that go quiet (see
    _write_watchdog); `noun`/`hint` word the message shown if it dies without
    a verdict."""
    now = time.time()
    with LOCK:
        cur = JOBS.get(kind)
        if cur and cur.get("running"):
            return False
        JOBS[kind] = {"running": True, "log": [], "result": None, "error": None,
                      "device": device, "startedAt": now, "updatedAt": now,
                      "cancelled": False, "seq": 0,
                      # None = not being watched; the UI needs to tell "quiet but
                      # writing" apart from "genuinely stopped".
                      "writeBytes": 0, "writeStalled": None}
    job = JOBS[kind]

    def worker():
        proc = None
        stop_watch = threading.Event()
        try:
            # start_new_session puts the engine in its own process group, so a
            # cancel can take down the whole tree (shred/dd keep running
            # otherwise) instead of orphaning a process writing to a disk.
            # stdin=DEVNULL: if any sub-step ever prompts despite -batch, it
            # fails fast instead of blocking forever on a keyboard nobody is at —
            # which is indistinguishable from a hang.
            proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    stdin=subprocess.DEVNULL,
                                    text=True, bufsize=1, start_new_session=True)
            PROCS[kind] = proc
            if watch_writes and device:
                threading.Thread(target=_write_watchdog,
                                 args=(job, device, stop_watch), daemon=True).start()
            for line in proc.stdout:
                line = line.rstrip("\n")
                job["updatedAt"] = time.time()
                if line.startswith(result_prefix):
                    try:
                        job["result"] = json.loads(line[len(result_prefix):].strip())
                    except ValueError:
                        job["error"] = "could not parse result line"
                elif line:
                    with LOG_LOCK:
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
                    # start_job is generic, so this must be too — a failed OS
                    # install used to tell the operator the WIPE had died.
                    job["error"] = ("The %s ended unexpectedly without a result "
                                    "(exit code %s).%s" % (noun, rc,
                                                           " " + hint if hint else ""))
        except Exception as exc:  # noqa: BLE001
            job["error"] = str(exc)
        finally:
            stop_watch.set()             # stop the disk-write heartbeat
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
                "operator": STATE.get("operator", ""),
                "workflow": current_workflow(),
                "workflows": allowed_workflows(),
                "adminPinSet": bool(STATE["conf"].get("AUDIT_ADMIN_PIN", "")),
                "launch": launch_info(),
                "waiting": queue_count(),   # records held offline, retrying
                # False = the stick would not take the write, so the queue is in
                # RAM and a reboot would lose it. The operator needs to know.
                "queueDurable": queue_durable(),
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
            with LOG_LOCK:
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

        if u.path == "/api/priorAudit":
            lot = (parse_qs(u.query).get("lotId") or [""])[0]
            return self._send(200, prior_audit(lot) or {"found": False, "unknown": True})

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

        if u.path == "/api/workflow":
            wf = (body.get("workflow") or "").strip()
            if wf not in allowed_workflows():
                return self._send(403, {"message": "This account cannot record %s audits."
                                                   % ("Amazon" if wf == "amazon" else "Goods In")})
            STATE["workflow"] = wf
            return self._send(200, {"ok": True, "workflow": wf})

        if u.path == "/api/operator":
            # Session-scoped, not PIN-gated: it is a name label on the records
            # this station files, reversible, and a fresh boot clears it.
            STATE["operator"] = (body.get("name") or "").strip()[:120]
            return self._send(200, {"ok": True, "operator": STATE["operator"]})

        if u.path == "/api/audit":
            if not STATE["profile"]:
                return self._send(400, {"message": "hardware not captured yet"})
            payload = {"lotId": body.get("lotId"), "profile": STATE["profile"]}
            if body.get("subLotId"):
                payload["subLotId"] = body["subLotId"]
            if body.get("notes"):
                payload["notes"] = body["notes"]
            # Operator's condition grade. Only forwarded when it is one of the
            # slugs the API's enum accepts — anything else is DROPPED rather than
            # passed through. A rejected payload is queued and retried every 45s
            # forever by upload_audit/queue_worker, which cannot tell a 400 from a
            # network outage, so one bad value would wedge the queue permanently.
            grade = (body.get("cosmeticGrade") or "").strip()
            if grade in GRADES:
                payload["cosmeticGrade"] = grade
            stamp_provenance(payload)
            out, queued, err = upload_audit(payload)
            PRIOR_CACHE["key"] = None       # this device's history just changed
            if queued:
                # Never lose the unit: it is on disk and will upload itself.
                return self._send(200, {"queued": True, "waiting": queue_count(),
                                        "message": err})
            return self._send(200, dict(out or {}, queued=False))

        if u.path == "/api/os/images/name":
            # Deliberately not PIN-gated: this is a label, it is reversible, and
            # a blank value simply restores the manifest name.
            image = (body.get("imageId") or "").strip()
            if not re.match(r"^[A-Za-z0-9_.-]+$", image):
                return self._send(400, {"message": "invalid image"})
            err = save_image_name(image, body.get("name") or "")
            if err:
                return self._send(500, {"message": err})
            # save_image_name already expired the cache, so this rebuilds.
            return self._send(200, {"ok": True, "images": list_os_images()})

        if u.path == "/api/os/install/cancel":
            # Without this the only way out of a wedged restore was rebooting the
            # station: every retry 409s while `running` is set.
            ok, msg = cancel_job("install")
            return self._send(200, {"ok": ok, "message": msg})

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
                stamp_provenance(payload)
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
                ok = start_job(wipe_kind(d), audit_cmd("--wipe-drive", d, method),
                               "WIPE_RESULT ", d, on_done=record_wipe, noun="wipe",
                               hint="The drive may be failing or was disconnected.")
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
            # That regex is only an injection guard — "/dev/nvme0n1p3" satisfies
            # it, and restoring a whole-disk image onto a single partition yields
            # a machine that will not boot. Check against the enumerated whole
            # disks instead, so the dropdown is not the only thing protecting us.
            if device not in {d.get("device") for d in (list_drives() or [])}:
                return self._send(400, {"message": "%s is not an installable whole disk"
                                                   % device})
            if not re.match(r"^[A-Za-z0-9_.-]+$", image or ""):
                return self._send(400, {"message": "invalid image"})
            # Point the driver at whichever library is active (server share or
            # the stick). This MUST be set before the job starts — it was
            # previously assigned afterwards, so the child never saw it.
            root, source, img_err = mount_image_server()
            if not root:
                return self._send(400, {"message": "no image library available"})
            os.environ["ALS_IMAGES_ROOT"] = root

            # After the restore, record the result against the device -- the
            # same shape as record_wipe. Until this existed the install result
            # died in the JOBS dict and a browser banner; the API never learned
            # a restore happened at all.
            image_name = (body.get("imageName") or image or "").strip()
            install_lot = body.get("lotId") or None

            def record_install(result):
                if result.get("status") not in ("installed", "failed"):
                    return
                if not STATE["profile"]:
                    # Common bench case: re-imaging without a fresh capture.
                    # Same rule as record_wipe -- no identity, no record -- but
                    # say so instead of silently recording nothing.
                    result["recordError"] = ("restore finished but was not recorded -- "
                                             "run Start audit first so the device is identified")
                    return
                payload = {
                    "profile": STATE["profile"],
                    "restoreImageStatus": result.get("status"),
                }
                if image_name:
                    payload["restoreImageName"] = image_name[:200]
                if install_lot:
                    payload["lotId"] = install_lot
                stamp_provenance(payload)
                out, queued, err = upload_audit(payload)
                if queued:
                    result["queued"] = True
                    result["waiting"] = queue_count()
                    result["recordError"] = ("no connection -- the restore record is saved "
                                             "on this machine and will upload automatically")
                    return
                result["recorded"] = bool(out and out.get("assetId"))

            started = start_job("install", ["bash", INSTALL_SH, image, device],
                                "INSTALL_RESULT ", device, on_done=record_install,
                                watch_writes=True, noun="restore",
                                hint="Open Show details for Clonezilla's last output.")
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
