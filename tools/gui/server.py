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
import urllib.error
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
# Jobs that must not run at the same time as each other, in the order they
# were asked for: key -> [(token, device), ...], head = the one allowed to run.
# Used for the namespaces of one NVMe drive (plan step 36): each is wiped, but
# one after the other. Guarded by LOCK through QUEUE_COND, and filled in the
# SAME critical section that registers the job in JOBS, so two overlapping
# requests cannot both see an empty queue and both start.
DRIVE_QUEUES = {}
QUEUE_COND = threading.Condition(LOCK)
# Guards job["log"]/job["seq"] as a PAIR. Two threads now append to a running
# job's log (the engine reader and the disk-write watchdog), and the /api/job
# incremental protocol derives the client's window from seq - len(log) — so a
# torn read there would silently skip or repeat lines on the operator's screen.
LOG_LOCK = threading.Lock()

# Drives are wiped concurrently, so each gets its own job keyed by device.
def wipe_kind(device):
    return "wipe:" + device


# ---------------------------------------------------------------- config ----
# Whether audit.conf has been read successfully at least once in this process,
# and whether the LAST attempt failed. operator_gate reads it: a station that
# has never managed to read its conf cannot know whether operators must sign
# in, so it refuses rather than guess "no".
CONF_READ = {"ok": False, "failed": False}


def load_conf():
    """audit.conf as a dict. A read error keeps the settings last read.

    refresh() re-reads the conf on every Rescan. Returning {} on a read error
    (the stick hiccups, its mount is briefly gone) used to switch every setting
    off until the next good read - AUDIT_OPERATOR_SIGNIN included, so one bad
    read opened the sign-in gate and a wipe could start with nobody signed in,
    filed under a typed name. What the station last read successfully is still
    the best statement of how it is meant to run; a successful read that
    changes a setting is what changes it."""
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
        CONF_READ["failed"] = True
        if CONF_READ["ok"] and isinstance(STATE.get("conf"), dict):
            return dict(STATE["conf"])
        return conf
    CONF_READ["ok"], CONF_READ["failed"] = True, False
    return conf


# AUDIT_OPERATOR_SIGNIN (audit.conf) - operators sign in at the station with
# their OWN account (plan step 27, owner decision D27, reversible).
#
#   unset / "0"  (the default)  exactly as before: the stick logs in as the ONE
#                shared account in AUDIT_EMAIL / AUDIT_PASSWORD, and the person
#                at the bench types a free-text name ("Operator: ...") that the
#                certificate can only print as self-declared.
#   "1"          nobody can wipe, audit or restore until a person signs in on
#                the screen with their own email and password, which go to the
#                API's normal /auth/login. Every record is then filed under
#                THAT account (the API sets auditedById from the token) and
#                names them as the operator. The shared account is never used
#                for anything while the flag is on - not as a fallback when a
#                token expires, not to flush the offline queue - and
#                AUDIT_EMAIL / AUDIT_PASSWORD can be deleted from the stick.
#
# Built behind a flag so it ships inert: the owner turns it on after trying it
# on the station. See the OPERATOR section below for how the session works.
def operator_signin_on():
    v = str((STATE.get("conf") or {}).get("AUDIT_OPERATOR_SIGNIN", "")).strip().lower()
    return v in ("1", "yes", "true", "on")


def conf_value_problem(val):
    """Why `val` cannot be written into audit.conf as one KEY="value" line, or
    None when it can.

    A value is written verbatim between double quotes, one setting per line.
    A newline in it (the Wi-Fi name box accepts a pasted one) therefore
    started a NEW line - a new setting. Settings needs no admin PIN for
    Wi-Fi when the stick has none, and save_conf reloads the conf at once, so
    a network name of  Warehouse<newline>AUDIT_URL="https://evil.example"
    <newline>AUDIT_OPERATOR_SIGNIN="0"  pointed the station at another server
    (past allowed_api_url, which guards only the server-address box) and
    switched the operator sign-in gate off: the next login sent the station's
    account password there. So: no line breaks, and no other control
    character (NUL, tab, escape...), in any value. Quotes, $, backticks and
    backslashes are fine: load_conf and the engine's als_read_conf both take
    everything between the outer quotes literally, and a Wi-Fi password may
    legitimately contain them."""
    s = str(val if val is not None else "")
    for ch in s:
        if ord(ch) < 0x20 or ord(ch) == 0x7F:
            return ("A setting cannot contain a line break or other control character "
                    "(found %r). Nothing was saved." % ch)
    return None


def save_conf(updates):
    """Rewrite the given KEY="value" lines in audit.conf, preserving the rest.
    The USB usually mounts read-only, so this returns a clear error if it can't
    write (the operator can remount rw, or set values from the admin console).
    A value conf_value_problem refuses is never written (nothing is saved)."""
    for key, val in updates.items():
        if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", str(key)):
            return "Refusing to write a setting named %r." % (key,)
        why = conf_value_problem(val)
        if why:
            return why
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


# One place that decides how this backend becomes root, used by the remount
# below, by the boot-media write, and by the audit engine. Returns the command
# untouched when we already ARE root, so nothing here changes if the backend is
# ever started with sudo.
def elevate(cmd):
    if os.geteuid() != 0 and shutil.which("sudo"):
        return ["sudo", "-n", *cmd]
    return list(cmd)


def is_readonly(mp):
    """Whether mp is mounted read-only right now. None if we cannot tell.

    Asked BEFORE touching the mount, so a stick that arrived writable is left
    writable. The old code remounted read-only unconditionally in a finally:,
    which meant one failed save turned a perfectly writable USB drive into a
    read-only one for the rest of the session - and made the next person to
    look at it diagnose the wrong problem."""
    try:
        return bool(os.statvfs(mp).f_flag & os.ST_RDONLY)
    except (OSError, AttributeError, ValueError):
        return None


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
    cmd = elevate(["mount", "-o", "remount," + mode, mp])
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=25)
        return r.returncode == 0
    except Exception:  # noqa: BLE001
        return False


# Only one thread at a time may run the remount/write/remount sequence. Until
# now this did not matter, because on Ubuntu the sequence always FAILED. With
# it working, save_conf() (no lock) and the background queue writer (QUEUE_LOCK)
# can both reach it, and one caller's "put it back read-only" would close the
# mount under the other's open().
MEDIA_LOCK = threading.Lock()


def atomic_write(path, text):
    """Write via a temp file and a rename, so a failure cannot leave a stub.

    The medium is a USB stick an operator may pull, and the write is followed
    immediately by a remount. open(path, "w") truncates before it knows whether
    the write will succeed: half a write to audit-queue.jsonl destroys audits
    that have not been uploaded, and half a write to audit.conf leaves a file
    load_conf() parses quite happily - it skips lines it cannot read - silently
    dropping AUDIT_URL and the stored credentials with no error at all."""
    tmp = path + ".new"
    with open(tmp, "w") as fh:
        fh.write(text)
        fh.flush()
        try:
            os.fsync(fh.fileno())
        except OSError:
            pass
    os.replace(tmp, path)


def write_as_root(path, text):
    """Write a boot-media file through a short-lived root helper.

    Remounting read-write is NECESSARY but NOT SUFFICIENT, which is the whole
    bug this exists to fix. FAT stores no owner and no permissions; Linux
    invents them when the filesystem is mounted, from whoever did the mounting
    - casper, as root, in the initramfs, before any desktop user exists. So
    every file on /cdrom presents as root-owned and not writable by anyone
    else. This backend runs as the DESKTOP user on purpose, because the browser
    can only attach to that user's display, so its open() is refused with
    EACCES (errno 13) even on a read-write mount.

    Nothing about the mount can fix that. vfat's remount handler only syncs and
    flips the read-only flag - it does not re-read uid=/gid=/umask=, so
    `mount -o remount,rw,uid=1000` exits 0 and changes nothing at all. chown and
    chmod are refused outright by the driver. Only a root writer gets through.

    sudo elevates the WRITE here, where the old code elevated only the mount -
    a root helper that flipped a flag and exited, leaving the caller exactly as
    unprivileged as before. Returns None on success, or a short reason."""
    base = os.path.dirname(CONF_PATH) if CONF_PATH else None
    if not base or os.path.dirname(os.path.abspath(path)) != base:
        # This process answers HTTP. It hands root a path, so the path is
        # pinned to the stick root rather than trusted.
        return "refusing to write outside the boot media"
    tmp = path + ".new"
    cmd = elevate(["sh", "-c", 'cat > "$1" && mv -f "$1" "$2" && sync',
                   "sh", tmp, path])
    try:
        r = subprocess.run(cmd, input=text, capture_output=True,
                           text=True, timeout=25)
    except Exception as exc:  # noqa: BLE001
        return str(exc)
    if r.returncode == 0:
        return None
    # sudo's own refusal comes back here, so a locked-down sudoers fails loudly
    # instead of looking like a filesystem problem.
    return (r.stderr or "").strip() or "exit %d" % r.returncode


def write_boot_file(path, text):
    """Write a file that lives on the boot media.

    The stick is mounted read-only, which used to make the Settings screen
    useless: an operator could type the Wi-Fi details but never save them
    without dropping to a terminal. So if the plain write fails, remount the
    stick read-write, write, flush, and put it back as we found it.

    There are TWO separate gates on that write, and for years this handled only
    the first. "The filesystem is read-only" (EROFS) is lifted by the remount.
    "You may not write this file" (EACCES) is not, and on a FAT boot medium it
    always applies to a non-root process - see write_as_root.
    Returns None on success or a human-readable error."""
    try:
        atomic_write(path, text)
        try:
            os.sync()
        except AttributeError:
            pass
        return None
    except OSError as first:
        mp = mount_point(path)
        with MEDIA_LOCK:
            was_ro = is_readonly(mp)
            remounted = False
            # Never touch the mount flags of "/" - mount_point() falls back to
            # it when nothing above the path is a mountpoint (a dev checkout,
            # or a stick whose tools are not on their own mount). The finally:
            # below would then remount the running system's root filesystem
            # read-only under a live desktop session.
            if mp != "/" and was_ro is not False:
                if not remount(mp, "rw"):
                    return ("Could not save: %s is mounted read-only and could "
                            "not be remounted read-write (%s). Edit the file on "
                            "the stick from another machine." % (mp, first))
                remounted = True
            try:
                atomic_write(path, text)
                try:
                    os.sync()
                except AttributeError:
                    pass
                return None
            except OSError as exc:
                # The media is writable now, so this is not "read-only
                # filesystem" - it is the permission check. Elevate the write
                # itself, down the same sudo channel the remount just used.
                why = write_as_root(path, text)
                if why is None:
                    return None
                return ("Could not save %s. The media is writable, but this "
                        "account may not write that file (%s), and the "
                        "elevated write failed too: %s" % (path, exc, why))
            finally:
                if remounted:
                    remount(mp, "ro")   # leave the stick as we found it


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
    _durable_jsonl_write(queue_path(), QUEUE_FALLBACK, items)


def _durable_jsonl_write(path, fallback, items):
    """Write a JSON-lines file on the stick, falling back to RAM. Shared by the
    offline queue and the in-progress wipe markers; the caller holds the lock."""
    text = "".join(json.dumps(it) + "\n" for it in items)
    err = None
    try:
        # Atomic, like every other write to the stick: these are audits that
        # have not reached the server yet, and a half-written queue file loses
        # the ones that were already in it.
        atomic_write(path, text)
        try:
            os.sync()
        except AttributeError:
            pass
    except OSError:
        # The stick is normally mounted read-only; this is the same remount
        # dance audit.conf already uses.
        err = write_boot_file(path, text)

    if err is None and path != fallback:
        # The stick copy is authoritative now. Drop any RAM copy, or the same
        # record would be counted — and re-uploaded — twice.
        try:
            if os.path.exists(fallback):
                os.remove(fallback)
        except OSError:
            pass
        return
    if err:
        # Never lose a record because the stick would not take it. RAM is worse
        # than the stick, and far better than nowhere.
        try:
            with open(fallback, "w") as fh:
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


# ------------------------------------------------- wipes in progress ----
# A wipe's record used to exist only in memory until its upload finished:
# JOBS held the result, on_done filed it, and only a FAILED upload reached
# the disk. But the engine runs in its own session (start_new_session), so it
# outlives this process - a backend restart or an OOM kill mid-wipe left the
# engine erasing the drive, its WIPE_RESULT going to a dead pipe, and no record
# at all, not even a failed one. A power cut during the upload (up to the 25 s
# api timeout, before queue_add) lost a finished wipe the same way. Either way
# the drive was erased, or half erased, and the system had no trace of it.
#
# So every wipe writes a marker to the stick BEFORE its engine starts, with
# everything needed to file a record without this process: the profile, lot,
# operator, drive and start time. When the wipe's record is built the marker
# is replaced by that exact payload, and it is removed once the record has
# been uploaded or queued. At startup a leftover marker is filed:
#   - with its final payload, if the wipe had finished (at worst a duplicate
#     of a record that did reach the server - never a lost one);
#   - otherwise as FAILED, "outcome unknown": the station cannot know what the
#     engine did after it lost sight of it, and the honest record of a drive
#     that may be half overwritten is a failed wipe, to be wiped again.
PENDING_FALLBACK = "/tmp/als-wipe-pending.jsonl"
PENDING_LOCK = threading.Lock()
PENDING_RESTART_REASON = ("the station restarted while this wipe was running, so "
                          "its outcome is unknown - wipe the drive again")


def pending_path():
    """Beside the offline queue on the stick, so a marker survives a power cut."""
    base = os.path.dirname(CONF_PATH) if CONF_PATH else None
    return os.path.join(base, "wipe-pending.jsonl") if base else PENDING_FALLBACK


def _pending_load_unlocked():
    path = pending_path()
    items = _read_jsonl(path)
    if path != PENDING_FALLBACK:
        items += _read_jsonl(PENDING_FALLBACK)
    return [it for it in items if isinstance(it, dict) and it.get("id")]


def _pending_update(fn):
    """Read-modify-write the markers under the lock. Never raises: a marker
    that cannot be written must not stop a wipe or lose its record."""
    try:
        with PENDING_LOCK:
            _durable_jsonl_write(pending_path(), PENDING_FALLBACK,
                                 fn(_pending_load_unlocked()))
    except Exception:  # noqa: BLE001
        pass


def pending_add(entry):
    entry = dict(entry, id=os.urandom(8).hex())
    _pending_update(lambda items: items + [entry])
    return entry["id"]


def pending_finalize(pid, payload):
    _pending_update(lambda items: [dict(it, final=payload) if it["id"] == pid else it
                                   for it in items])


def pending_remove(pid):
    _pending_update(lambda items: [it for it in items if it["id"] != pid])


def pending_failed_payload(entry):
    """The record for a wipe whose outcome was lost: FAILED, with why."""
    dev = entry.get("device") or ""
    started = entry.get("startedEpoch")
    started = started if isinstance(started, (int, float)) else None
    # The time it was found, but never earlier than it started - a machine
    # with a dead RTC can boot believing it is years ago.
    fin = max(time.time(), started or 0)
    result = {"status": "failed", "method": "none", "device": dev,
              "reason": PENDING_RESTART_REASON, "finishedAt": utc_iso(fin)}
    return build_wipe_payload(entry.get("base") or {}, result, dev,
                              entry.get("drive") or {}, entry.get("method"),
                              started, bool(entry.get("clockAtStart")))


def recover_pending_wipes():
    """File a record for every wipe a previous run of this process started and
    never recorded. Runs at startup, before the first capture - and so before
    any new wipe can start, since /api/wipe/start refuses without a profile.
    Removes only the markers it filed, all the same. Returns how many."""
    with PENDING_LOCK:
        items = _pending_load_unlocked()
    filed = []
    for it in items:
        try:
            final = it.get("final")
            payload = final if isinstance(final, dict) else pending_failed_payload(it)
        except Exception:  # noqa: BLE001
            continue            # unreadable marker: leave it for a person to see
        # Queued BEFORE the marker goes: a crash between the two files the
        # record twice rather than not at all.
        queue_add(payload)
        filed.append(it["id"])
    if filed:
        _pending_update(lambda cur: [it for it in cur if it["id"] not in filed])
    return len(filed)


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
    if operator_signin_on():
        # The signed-in account, never the free-text name: with sign-in on,
        # the person IS the account (the API also sets auditedById from the
        # token this record is sent under). The tag says whose token that must
        # be - see OPERATOR_TAG. Nobody signed in: no name and no tag, and the
        # callers refuse before a record can be made that way.
        who = operator_identity()
        if who:
            if who.get("name"):
                payload["operatorName"] = who["name"][:120]
            payload[OPERATOR_TAG] = who
        return payload
    op = (STATE.get("operator") or "").strip()
    if op:
        payload["operatorName"] = op[:120]
    return payload


# Which code produced a record. Bumped by hand when the kiosk or the engine
# changes what a wipe does or reports; the engine carries the same constant
# (ALS_TOOL_VERSION in hardware-audit.sh). A certificate that cannot say which
# tool erased the drive cannot be checked against that tool's known faults -
# and this project has already had to withdraw certificates (TRIM "wipes")
# made by one particular version.
ALS_TOOL_NAME = "als-audit-station"
ALS_TOOL_VERSION = "2026.09.19"
STICK_VERSION_FILE = os.path.join(HERE, ".stick-version")


def stick_commit(path=None):
    """The git commit the stick was synced from, or None.

    sync-usb.ps1 (Write-Stamp) writes gui/.stick-version from Windows:
        commit 7eda9ea          (or "commit 7eda9ea-dirty", or "commit unknown")
        synced 2026-09-19T10:00:00
    PowerShell 5.1's Out-File -Encoding utf8 puts a byte-order mark in front and
    ends lines with CRLF, and a hand-copied stick may have no stamp at all.
    Anything that is not a plausible short hash reads as None - the record then
    simply omits toolCommit rather than carrying junk."""
    try:
        with open(path or STICK_VERSION_FILE, "rb") as fh:
            raw = fh.read(4096)
    except OSError:
        return None
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        text = raw.decode("utf-16", errors="replace")
    else:
        text = raw.decode("utf-8-sig", errors="replace")
    for line in text.splitlines():
        m = re.match(r"^\s*commit\s+([0-9a-fA-F]{4,40}(?:-dirty)?)\s*$", line.lstrip("﻿"))
        if m:
            return m.group(1).lower()
    return None


def stamp_tool(payload, result=None):
    """toolName / toolVersion / toolCommit on a wipe record (contract C2).
    All three are optional on the API, so an older server simply ignores them.

    The version the ENGINE reports in its WIPE_RESULT wins over this file's:
    the engine is the code that actually erased the drive. The two only differ
    on a half-synced stick, and then the eraser's version is the one a
    certificate needs. An engine that predates the field falls back to ours."""
    payload["toolName"] = ALS_TOOL_NAME
    ver = (result or {}).get("toolVersion")
    ok = isinstance(ver, str) and re.match(r"^[A-Za-z0-9._+-]{1,64}$", ver)
    payload["toolVersion"] = ver if ok else ALS_TOOL_VERSION
    commit = stick_commit()
    if commit:
        payload["toolCommit"] = commit
    return payload


ISO_UTC = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$")


def utc_iso(epoch=None):
    """'2026-09-19T10:01:07Z' - the station clock, UTC, second precision."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ",
                         time.gmtime(time.time() if epoch is None else epoch))


def _text(v, limit=255):
    """A non-empty, trimmed string, or None. The engine omits a field rather
    than send an empty one (contract C1), and so does this side."""
    if isinstance(v, str) and v.strip():
        return v.strip()[:limit]
    return None


def wipe_record_fields(result, device, drive=None, method=None,
                       started_epoch=None, clock_at_start=False):
    """The per-drive fields of a wipe record (contract C2), from the engine's
    WIPE_RESULT plus what the station itself saw when it started the job.

    Every C1 field is OPTIONAL: an engine that predates them sends only
    status/method/device/reason, and then the station's own observations fill
    in what they can - the job's start and end on this clock, and the drive as
    lsblk showed it at start. Where the engine does report something it wins,
    because the engine is what touched the drive.

    Built BEFORE upload_audit on purpose: a record that cannot upload is queued
    as-is, so wipedAt has to be in it already. Before this, a record queued
    offline and flushed hours later took the upload time as its wipe date.

    Returns (fields, notes) - notes are human-readable lines for the record."""
    result = result or {}
    drive = drive or {}
    out, notes = {}, []

    fin, st = result.get("finishedAt"), result.get("startedAt")
    out["wipedAt"] = fin if isinstance(fin, str) and ISO_UTC.match(fin) else utc_iso()
    if isinstance(st, str) and ISO_UTC.match(st):
        out["wipeStartedAt"] = st
    elif started_epoch:
        out["wipeStartedAt"] = utc_iso(started_epoch)
    # "network" only when the clock was network-set for the WHOLE job: a
    # correction that lands mid-wipe leaves the start time on the old clock.
    out["wipedAtClock"] = "network" if (clock_at_start and CLOCK["network"]) else "unsynced"

    # The drive: the station's view at start, overlaid by the engine's report.
    wd = {}
    if _text(drive.get("serial"), 128):
        wd["serialNumber"] = _text(drive.get("serial"), 128)
    model = _text(drive.get("model"), 128)
    if model and model != "Unknown model":      # list_drives' placeholder
        wd["model"] = model
    if isinstance(drive.get("bytes"), int) and drive["bytes"] > 0:
        wd["sizeBytes"] = drive["bytes"]
    if _text(drive.get("transport"), 32):
        wd["transport"] = _text(drive.get("transport"), 32)
    if isinstance(drive.get("rotational"), bool):
        wd["rotational"] = drive["rotational"]
    eng = result.get("drive") if isinstance(result.get("drive"), dict) else {}
    eng_serial = _text(eng.get("serialNumber"), 128)
    if eng_serial and wd.get("serialNumber") and eng_serial != wd["serialNumber"]:
        # A new engine refuses this before writing anything, so seeing it on a
        # wiped/failed result means the engine did not check. Record both.
        notes.append("The drive reported serial %s; the station expected %s."
                     % (eng_serial, wd["serialNumber"]))
    for key, limit in (("serialNumber", 128), ("model", 128), ("transport", 32), ("wwn", 128)):
        v = _text(eng.get(key), limit)
        if v:
            wd[key] = v
    size = eng.get("sizeBytes")
    if isinstance(size, int) and not isinstance(size, bool) and size > 0:
        wd["sizeBytes"] = size
    if isinstance(eng.get("rotational"), bool):
        wd["rotational"] = eng["rotational"]
    wd["devicePath"] = device
    out["wipedDrive"] = wd
    if not wd.get("serialNumber"):
        # Owner decision D18 (reversible): a drive with no readable serial is
        # still wiped, and recorded as identity unknown - keyed by device path.
        notes.append("Drive %s did not report a serial number; recorded by device "
                     "path (identity unknown)." % device)

    req = _text(result.get("methodRequested"), 32) or _text(method, 32)
    if req:
        out["methodRequested"] = req
    for key, limit in (("methodAttempted", 255), ("fallbackReason", 255),
                       ("sanitisationLevel", 16), ("verification", 16),
                       ("hiddenAreas", 32)):
        v = _text(result.get(key), limit)
        if v:
            out[key] = v
    lim = result.get("limitations")
    if isinstance(lim, list):
        out["wipeLimitations"] = [x.strip()[:500] for x in lim
                                  if isinstance(x, str) and x.strip()][:50]
    smart = result.get("smart")
    if isinstance(smart, dict):
        out["wipeSmart"] = {k: v for k, v in smart.items()
                            if isinstance(k, str) and (v is None or (
                                isinstance(v, (int, float)) and not isinstance(v, bool)))}
    return out, notes


def bios_locked(profile):
    """The API's single biosLocked boolean, from the lock report the capture
    already holds (profile.locks, written by lock-checks.sh's lock_json), or
    None to leave the field out. Plan step 38.

    The text-mode flow has always sent it (hardware-audit.sh, lock_bios_locked);
    the kiosk never did, so every kiosk wipe record had it NULL. Same meaning:
    true when any check's STATUS is LOCKED. Read from the status field only,
    never the row text - lock_status learnt that a PASS row whose detail
    merely contained "|LOCKED|" flipped the verdict.

    False only when the checks RAN and found nothing locked (roll-up CLEAR or
    WARNING, and no check UNKNOWN). UNVERIFIED, or any single check UNKNOWN
    - some checks could not complete - leaves the field
    out rather than asserting "not locked" on an unproven machine; the API
    derives lock_status from the same report and keeps that distinction."""
    locks = (profile or {}).get("locks") if isinstance(profile, dict) else None
    if not isinstance(locks, dict):
        return None
    checks = locks.get("checks") if isinstance(locks.get("checks"), list) else []
    sts = [str(c.get("status") or "").strip().upper() for c in checks if isinstance(c, dict)]
    roll = str(locks.get("status") or "").strip().upper()
    if "LOCKED" in sts or roll == "LOCKED":
        return True
    if "UNKNOWN" in sts:
        # A check that did not complete, whatever the roll-up says:
        # lock_status ranks DETECTED/WARNING above UNKNOWN, so a WARNING
        # roll-up can hide an unfinished BIOS-password check.
        return None
    if roll in ("CLEAR", "WARNING"):
        return False
    return None


def build_wipe_payload(base, result, dev, drive, method, started_epoch, clock_at_start):
    """One drive's wipe record: `base` (profile, lot, operator) plus the wipe
    fields. Shared by the live path (record_wipe) and startup recovery of a
    wipe whose outcome was lost, so the two can never file different shapes."""
    fields, notes = wipe_record_fields(
        result, dev, drive=drive, method=method,
        started_epoch=started_epoch, clock_at_start=clock_at_start)
    payload = dict(base)
    payload["dataWipeStatus"] = result.get("status")
    payload["dataWipeMethod"] = result.get("method") or "none"
    payload.update(fields)
    locked = bios_locked(payload.get("profile"))
    if locked is not None:
        payload["biosLocked"] = locked
    # Record WHY a wipe failed, so the audit trail explains itself instead of
    # just saying "Failed".
    reason = (result.get("reason") or "").strip()
    if reason and result.get("status") == "failed":
        notes.insert(0, "Wipe failed on %s: %s" % (dev, reason))
    if notes:
        payload["notes"] = "\n".join(notes)
    stamp_tool(payload, result)
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
            return post_record(payload), False, ""
    except Exception as exc:  # noqa: BLE001
        queue_add(payload)
        return None, True, str(exc)


def post_record(item):
    """POST one record (live or from the queue) under the identity it belongs
    to, or raise. The operator tag is the station's own bookkeeping and never
    goes to the API.

    Flag off: an untagged record goes under the shared account, as it always
    has. Flag on: a record goes only under the token of the operator it is
    tagged with (held_reason). Either way a record that belongs to someone
    else stays in the queue - it is never re-attributed."""
    why = held_reason(item)
    if why:
        raise RuntimeError(why)
    # held_reason is only a first look: the person signed in can change
    # before the token is read, or while the request is in flight. `owner`
    # makes authed_api re-check, under the same lock it reads the token with,
    # that the token IS this record's operator's ("" = the shared account).
    tag = item.get(OPERATOR_TAG) if isinstance(item, dict) else None
    owner = str(tag.get("id")) if isinstance(tag, dict) and tag.get("id") else ""
    body = {k: v for k, v in item.items() if k != OPERATOR_TAG}
    return authed_api("/devices/hardware-audit", "POST", body, owner=owner)


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
    done, sent = [], 0
    for it in items:
        try:
            # UPLOAD_LOCK, the same lock upload_audit holds: a queued record and
            # a live one for the same machine (a second drive finishing while
            # the first drive's queued record flushes) otherwise race past the
            # API's find-by-serial and create the device twice.
            # A record another operator made is skipped here, not sent under
            # whoever is signed in now (post_record raises; it stays queued).
            if held_reason(it):
                continue
            with UPLOAD_LOCK:
                post_record(it)
            sent += 1
            done.append(it)
        except Exception:  # noqa: BLE001
            pass
    # Remove what was sent from the queue AS IT IS NOW, rather than writing
    # back the list read before the uploads. A record queued while this flush
    # was running (upload_audit failing in another thread) was not in `items`,
    # and writing `items minus sent` back would have deleted it silently.
    with QUEUE_LOCK:
        current = _queue_load_unlocked()
        for it in done:
            try:
                current.remove(it)
            except ValueError:
                pass
        _queue_write_unlocked(current)
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


def server_reachable(timeout=15):
    """Raise unless the API answers at all. Any HTTP status counts as an
    answer - this asks "is the server there", not "am I allowed in"."""
    base = STATE["conf"].get("AUDIT_URL", "").rstrip("/")
    if not base:
        raise RuntimeError("AUDIT_URL is not set in audit.conf")
    try:
        urllib.request.urlopen(urllib.request.Request(base + "/"), timeout=timeout).close()
    except urllib.error.HTTPError:
        pass


def login():
    """The SHARED station account (flag off only)."""
    if operator_signin_on():
        # Never the shared account while operators sign in themselves - not
        # even as a fallback for an expired operator session (plan step 27).
        raise SignInRequired(SIGNIN_NEEDED)
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
    if operator_signin_on():
        return operator_token()
    return STATE["token"] or login()


class OperatorChanged(RuntimeError):
    """The record's operator is not the one signed in now; it stays queued."""


def operator_token_for(owner):
    """operator_token(), but only if the signed-in operator is `owner` (a user
    id); raises OperatorChanged otherwise. The identity and the token are read
    under ONE hold of OPERATOR_LOCK, so nobody can sign in between the check
    and the read. A refresh inside operator_token cannot change hands either
    (_operator_set's expect_id)."""
    with OPERATOR_LOCK:
        if OPERATOR.get("token") and OPERATOR.get("id") != owner:
            raise OperatorChanged(
                "made by another operator than the one signed in now; it is sent "
                "only under their own sign-in")
        return operator_token()


# The 403s that mean "this SESSION is over", not "this account may not do
# that". The API authenticates the token (JwtAuthGuard, 401 when it is
# expired or forged) and THEN PermissionsGuard re-reads the account from the
# database on every call (apps/api/src/auth/guards/permissions.guard.ts). The
# token itself is still valid there, so a disabled account, a deleted one, or
# a token minted before the account's password was changed are refused with
# 403, not 401, with exactly these messages:
#   "This account has been disabled."
#   "This account no longer exists."
#   "Your password was changed. Please sign in again."
#   "Not authenticated."            (a token that names no user)
# Every OTHER 403 ("You don't have permission to do this.", "You do not have
# access to this lot.") is about the request, and the session stays.
SESSION_ENDED_403 = ("has been disabled", "no longer exists", "password was changed",
                     "not authenticated")


def server_ended_session(exc):
    """The server's own message when `exc` is a 403 that ends the session
    (SESSION_ENDED_403), else None. Reads the error body once and keeps it on
    the exception, so a caller further up can still ask."""
    if getattr(exc, "code", None) != 403:
        return None
    msg = getattr(exc, "als_message", None)
    if msg is None:
        msg = ""
        try:
            data = json.loads(exc.read().decode(errors="replace") or "{}")
            m = data.get("message") if isinstance(data, dict) else None
            msg = m.strip() if isinstance(m, str) else ""
        except Exception:  # noqa: BLE001 - no body, not JSON: not a session end
            msg = ""
        try:
            exc.als_message = msg
        except Exception:  # noqa: BLE001
            pass
    low = msg.lower()
    return msg if msg and any(k in low for k in SESSION_ENDED_403) else None


def _ended_text(msg):
    return "The server ended your session: %s%s" % (
        msg.rstrip(".") + ".",
        "" if "sign in again" in msg.lower() else " Sign in again, or ask an administrator.")


def authed_api(path, method="GET", body=None, owner=None, timeout=25):
    """api() with the station's current identity. With operator sign-in on, a
    401 (the token expired early, or the account's sessions were revoked) gets
    ONE refresh and retry; if that fails the operator is signed out and must
    sign in again. A 403 that the API uses to END a session - the account
    was disabled or deleted, or its password was changed (SESSION_ENDED_403)
    - signs the operator out straight away, with the server's reason: a
    refresh cannot help there (the API refuses it too), and staying "signed
    in" left every upload failing with an unexplained HTTP 403. Flag off:
    the old api(..., ensure_token()), except that such a 403 drops the
    shared account's cached token, so the next call signs in afresh (with
    the password audit.conf holds by then) instead of failing until a
    restart.

    `owner`, for a record (post_record): whose record it is - an operator's
    user id, or "" for the shared account. It is then sent only under that
    identity, checked when the token is taken AND again before the 401 retry:
    A's upload can come back 401 after A signed out and B signed in (A's token
    ran out across a suspend the monotonic countdown did not see, or A's
    sessions were revoked), and retrying with "the current token" would have
    filed A's erasure under B's account. None (lots, lookups): whoever is
    signed in, as before."""
    on = operator_signin_on()
    if owner is not None and bool(owner) != on:
        # The flag changed between held_reason and here: an operator's record
        # never goes under the shared account, nor the reverse.
        raise OperatorChanged("operator sign-in was switched %s while this record was "
                              "being sent; it stays queued" % ("on" if on else "off"))
    if not on:
        tok = ensure_token()
        try:
            return api(path, method=method, body=body, token=tok, timeout=timeout)
        except urllib.error.HTTPError as exc:
            if server_ended_session(exc) and STATE.get("token") == tok:
                STATE["token"] = None
            raise

    def call(tok):
        try:
            return api(path, method=method, body=body, token=tok, timeout=timeout)
        except urllib.error.HTTPError as exc:
            why = server_ended_session(exc)
            if not why:
                raise
            with OPERATOR_LOCK:
                # Only the session that was refused. If the person signed out
                # (and someone else in) while this was in flight, the new
                # session is not theirs to end.
                if OPERATOR.get("token") == tok:
                    operator_signout(_ended_text(why))
            raise SignInRequired(_ended_text(why))

    tok = operator_token() if owner is None else operator_token_for(owner)
    try:
        return call(tok)
    except urllib.error.HTTPError as exc:
        if exc.code != 401:
            raise
        with OPERATOR_LOCK:
            if owner is not None and OPERATOR.get("id") != owner:
                # Someone else is signed in now (or nobody): do not refresh
                # their session for this, and do not send it under them.
                raise OperatorChanged(
                    "its operator signed out while it was being sent; it is sent "
                    "only under their own sign-in")
            if OPERATOR.get("token") == tok:
                OPERATOR["expiresMono"] = 0.0      # force the refresh below
            tok = operator_token() if owner is None else operator_token_for(owner)
        return call(tok)


# ------------------------------------------------------------- OPERATOR ----
# Operator sign-in (AUDIT_OPERATOR_SIGNIN=1, see operator_signin_on).
#
# The session lives in this dict and NOWHERE else: not in STATE (which is
# shown, in part, to the page), not on the stick, not in any log. A reboot or
# a backend restart signs everyone out - which is the point: the station is a
# shared bench, and a session that outlived its person would file the next
# person's work under their name.
#
# The password is used for exactly one request (operator_signin) and is not
# kept: no reference to it survives the call. Python cannot promise to zero
# the bytes of a str - they stay in freed memory until reused - but nothing in
# this process can reach them again, and nothing writes them anywhere.
#
# Expiry. The API's access token lasts 12 hours and its refresh token 7 days
# (apps/api/src/config/configuration.ts). The shared-account path never
# refreshed at all: ensure_token handed out the same token until it died, and
# every upload after that failed and queued. Here the expiry is read from the
# token itself as a DURATION (exp - iat, both the server's clock) and counted
# on this machine's monotonic clock from when the token arrived, so a station
# whose clock is years out (a dead CMOS battery - common on this bench) still
# knows when its token runs out. Near the end it is renewed with the refresh
# token; if the server refuses that, the operator is signed out and asked to
# sign in again. Nothing ever falls back to the shared account.
OPERATOR = {}
OPERATOR_LOCK = threading.RLock()
# Key on a queued record naming the operator whose token it must be sent
# under: {"id", "name", "email"}. Stripped before the record is POSTed.
OPERATOR_TAG = "_alsOperator"
TOKEN_MARGIN = 120          # renew this many seconds before the token expires
SIGNIN_NEEDED = ("Sign in with your own account first (Sign in, at the top of the "
                 "screen). Nothing is wiped, audited or restored at this station "
                 "until someone is signed in.")


class SignInRequired(RuntimeError):
    """Nobody is signed in, or the session ended and needs a fresh sign-in."""


def _jwt_lifetime(token):
    """Seconds an access token is valid for (exp - iat), or None."""
    import base64
    try:
        part = token.split(".")[1]
        part += "=" * (-len(part) % 4)
        claims = json.loads(base64.urlsafe_b64decode(part.encode()).decode())
        life = float(claims["exp"]) - float(claims.get("iat", claims["exp"] - 12 * 3600))
        return life if life > 0 else None
    except Exception:  # noqa: BLE001
        return None


def _operator_set(out, expect_id=None):
    """Adopt a login/refresh response as the session. Returns the identity."""
    out = out if isinstance(out, dict) else {}
    tok = out.get("accessToken")
    u = out.get("user") if isinstance(out.get("user"), dict) else {}
    uid = str(u.get("id") or "").strip()
    if not tok or not uid:
        raise RuntimeError("The server's sign-in answer had no token or no user.")
    if expect_id and uid != expect_id:
        # A refresh must renew THIS person's session, never become someone else.
        raise SignInRequired("The session changed hands - sign in again.")
    # The API's own 12 hours when the token does not say.
    life = _jwt_lifetime(tok) or 12 * 3600.0
    OPERATOR.clear()
    OPERATOR.update({
        "token": tok, "refresh": out.get("refreshToken") or None,
        "expiresMono": time.monotonic() + life,
        "id": uid, "name": (u.get("name") or "").strip()[:120],
        "email": (u.get("email") or "").strip()[:200],
    })
    # The same account-derived state the shared login sets: header name,
    # role and permissions (which decide the workflows this person may file).
    STATE["userName"] = OPERATOR["name"]
    STATE["role"] = u.get("role") or ""
    perms = u.get("permissions")
    STATE["permissions"] = perms if isinstance(perms, list) else None
    wfs = allowed_workflows()
    if STATE.get("workflow") not in wfs:
        STATE["workflow"] = wfs[0] if len(wfs) == 1 else ""
    return operator_identity()


def operator_identity():
    """{"id","name","email"} of the signed-in operator, or None."""
    with OPERATOR_LOCK:
        if not OPERATOR.get("id"):
            return None
        return {"id": OPERATOR["id"], "name": OPERATOR.get("name") or "",
                "email": OPERATOR.get("email") or ""}


def operator_signout(reason=None):
    """End the session: forget the tokens and every account-derived setting.
    `reason`, when given, is kept to tell the NEXT screen why."""
    with OPERATOR_LOCK:
        OPERATOR.clear()
        if reason:
            OPERATOR["endedWhy"] = reason
    STATE["userName"] = ""
    STATE["role"] = ""
    STATE["permissions"] = None
    STATE["workflow"] = ""
    STATE["lots"] = []


def operator_token():
    """The signed-in operator's access token, renewed when it is near expiry.
    Raises SignInRequired when nobody is signed in or the session cannot be
    renewed (the server said no); raises RuntimeError when the renewal could
    not reach the server - the session is kept then, to renew later."""
    with OPERATOR_LOCK:
        if not OPERATOR.get("token"):
            raise SignInRequired(OPERATOR.get("endedWhy") or SIGNIN_NEEDED)
        if time.monotonic() < OPERATOR["expiresMono"] - TOKEN_MARGIN:
            return OPERATOR["token"]
        refresh_tok, uid = OPERATOR.get("refresh"), OPERATOR["id"]
        if not refresh_tok:
            operator_signout("Your sign-in has expired - sign in again.")
            raise SignInRequired(OPERATOR["endedWhy"])
        try:
            out = api("/auth/refresh", "POST", {"refreshToken": refresh_tok})
        except urllib.error.HTTPError as exc:
            if exc.code in (400, 401, 403):
                operator_signout("Your sign-in has expired - sign in again.")
                raise SignInRequired(OPERATOR["endedWhy"])
            raise RuntimeError("Your sign-in needs renewing and the server "
                               "answered HTTP %d - try again shortly." % exc.code)
        except Exception:  # noqa: BLE001
            raise RuntimeError("Your sign-in needs renewing, and the server cannot be "
                               "reached to renew it. Reconnect the network.")
        try:
            _operator_set(out, expect_id=uid)
        except SignInRequired as exc:
            operator_signout(str(exc))
            raise
        return OPERATOR["token"]


def operator_signin(email, password):
    """Sign an operator in with their own account (/auth/login). Returns the
    identity, or raises with a message fit for the screen. Offline this can
    only fail: there is no offline sign-in (plan step 27), because a session
    nobody could check is exactly the free-text name this replaces."""
    email = (email or "").strip()
    if not email or not password:
        raise ValueError("Enter your email and password.")
    body = {"email": email, "password": password}
    password = None          # noqa: F841 - the one other reference, dropped
    try:
        out = api("/auth/login", "POST", body, timeout=20)
    except urllib.error.HTTPError as exc:
        msg = ""
        try:
            data = json.loads(exc.read().decode(errors="replace") or "{}")
            msg = data.get("message") if isinstance(data.get("message"), str) else ""
        except Exception:  # noqa: BLE001
            pass
        if exc.code in (400, 401):
            # "disabled" is worth repeating (the person can do something about
            # it); anything else is the plain "not accepted".
            raise ValueError(msg if "disabled" in msg.lower()
                             else "Email or password not accepted.")
        raise ValueError("The server refused the sign-in (HTTP %d)." % exc.code)
    except (urllib.error.URLError, OSError, RuntimeError) as exc:
        raise ValueError("Cannot reach the server, and signing in needs it - there is "
                         "no offline sign-in. Nothing can be wiped until someone signs "
                         "in. Check the network (Settings). (%s)"
                         % getattr(exc, "reason", exc))
    finally:
        body.clear()         # drop the password with the request body
    with OPERATOR_LOCK:
        who = _operator_set(out)
    # Now that someone may use the server: the batches, and any records this
    # person left queued earlier.
    def after():
        try:
            STATE["lots"] = api("/devices/lots", token=operator_token()) or []
        except Exception:  # noqa: BLE001
            pass
        try:
            if queue_count():
                queue_flush()
        except Exception:  # noqa: BLE001
            pass
    threading.Thread(target=after, daemon=True).start()
    return who


def held_reason(item):
    """Why this record may NOT be sent now, or None if it may.

    A record goes to the API only under the identity that made it:
      flag on  - tagged with operator X: only while X is signed in. Untagged
                 (made under the shared account before the flag was turned on):
                 held - sending it under whoever is signed in would name them
                 on work they did not do; turn the flag off once to send it.
      flag off - untagged: the shared account, as always. Tagged (made by a
                 signed-in operator, flag since turned off): held for the same
                 reason, until the flag is on and X signs in."""
    tag = item.get(OPERATOR_TAG) if isinstance(item, dict) else None
    tag = tag if isinstance(tag, dict) and tag.get("id") else None
    if not operator_signin_on():
        if tag:
            return ("made by %s while operator sign-in was on; it is sent when they "
                    "sign in again" % (tag.get("name") or tag.get("email") or "an operator"))
        return None
    if not tag:
        return ("made under the shared station account; it is sent once operator "
                "sign-in is turned off again")
    who = operator_identity()
    if who and who["id"] == tag["id"]:
        return None
    return ("made by %s; it is sent only under their own sign-in"
            % (tag.get("name") or tag.get("email") or "another operator"))


def queue_held_count():
    return sum(1 for it in queue_load() if held_reason(it))


def signin_state():
    """What the page needs to draw the sign-in controls."""
    on = operator_signin_on()
    who = operator_identity() if on else None
    with OPERATOR_LOCK:
        why = OPERATOR.get("endedWhy") or ""
    return {"required": on, "signedIn": bool(who),
            "name": (who or {}).get("name", ""), "email": (who or {}).get("email", ""),
            "message": why if on and not who else ""}


def operator_gate():
    """None when records may be made now, else (http_code, message). Flag
    off: always None. Flag on: a signed-in operator whose session is still
    valid (renewed now if it is near expiry). audit.conf never read (it
    exists but every read so far failed): refused - fail closed, since the
    station cannot tell whether sign-in is required (see load_conf)."""
    if CONF_PATH and CONF_READ["failed"] and not CONF_READ["ok"]:
        return 503, ("audit.conf on the boot stick could not be read, so this station "
                     "cannot tell whether operators must sign in. Nothing is wiped, "
                     "audited or restored until it can: re-seat the stick and press Rescan.")
    if not operator_signin_on():
        return None
    try:
        operator_token()
        return None
    except SignInRequired as exc:
        msg = str(exc)
        if STATE.get("error") and not operator_identity():
            msg += (" This station is not connected to the server right now, and "
                    "signing in needs the network - there is no offline sign-in.")
        return 401, msg
    except Exception as exc:  # noqa: BLE001
        return 503, str(exc)


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
    return elevate(base)


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
    return parse_profile(proc.stdout or "")


# The engine prints this line, then the profile on the line after it
# (hardware-audit.sh, the AUDIT_DEBUG=1 exit). A line that starts with
# AUDIT_PROFILE and a space carries the profile on the same line - the
# engine may add that form later; both are accepted, the prefixed one first.
PROFILE_HEADER = "--- captured JSON (debug; not uploaded) ---"
PROFILE_PREFIX = "AUDIT_PROFILE "


def parse_profile(out):
    """Pick the hardware profile out of the engine's stdout. Returns
    (profile, summary) or raises RuntimeError saying what was wrong.

    This used to take the LAST line anywhere in the output that began with {
    and ended with }. Everything the engine runs shares that stdout, so one
    stray one-line object printed after the profile - a tool's JSON status, a
    debug echo - silently became "the profile": no identification, serial None,
    and every wipe after it was filed under a machine with no identity. The
    profile is now read from exactly one place, the line the engine marks, and
    it must look like a profile (a dict with an identification dict) or the
    capture fails out loud instead of guessing."""
    lines = out.split("\n")
    raw, used = None, set()
    for i, line in enumerate(lines):
        if line.strip().startswith(PROFILE_PREFIX):
            raw, used = line.strip()[len(PROFILE_PREFIX):].strip(), {i}
            break
    if raw is None:
        for i, line in enumerate(lines):
            if line.strip() == PROFILE_HEADER:
                used = {i}
                # The first non-blank line after the marker; a blank line is
                # not a reason to give up, anything else is taken as-is and
                # must parse.
                for j in range(i + 1, len(lines)):
                    if lines[j].strip():
                        raw = lines[j].strip()
                        used.add(j)
                        break
                break
    if raw is None:
        raise RuntimeError("Could not read the hardware profile from the engine: "
                           "its output has no profile marker (the engine may have "
                           "stopped early - check Show details, then Rescan).")
    try:
        profile = json.loads(raw)
    except ValueError:
        # Most likely cause: the profile came out pretty-printed or cut short,
        # so the one line we read is only its first line ("{").
        raise RuntimeError("Could not read the hardware profile from the engine: "
                           "the line after the profile marker is not a complete "
                           "JSON object (pretty-printed or truncated output?).")
    if not isinstance(profile, dict) or \
            not isinstance(profile.get("identification"), dict):
        raise RuntimeError("Could not read the hardware profile from the engine: "
                           "what it printed has no identification section, so "
                           "this machine cannot be recorded.")
    summary = [l for k, l in enumerate(lines) if k not in used]
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
        try:
            prof, summ = capture()
        except Exception:
            # Forget the previous machine. Keeping it looked harmless - the
            # screen still showed something - but every wipe started after a
            # failed re-capture was then filed under whatever machine was on
            # the bench LAST. No profile makes /api/wipe/start refuse instead.
            STATE["profile"], STATE["summary"] = None, ""
            raise
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
            # The boot-time sync_clock runs BEFORE this - before the station
            # has joined Wi-Fi, which it does itself just above - so on any
            # bench whose network is not up in the first seconds it found no
            # time source and CLOCK["network"] stayed False all session. Every
            # wipe was then filed wipedAtClock "unsynced", correctly dated or
            # not, until someone pressed the fix-clock button. Now that the
            # network is up, try again. Only while unsynced: once set, it is
            # not re-probed on every Rescan. Also before the login, since a
            # wrong clock is exactly what breaks HTTPS.
            if not CLOCK["network"]:
                try:
                    sync_clock()
                except Exception:  # noqa: BLE001
                    pass
            try:
                if operator_signin_on() and not operator_identity():
                    # Nobody signed in yet: nothing to fetch as anyone, and
                    # that is not an error. Still check the server answers,
                    # so the header says honestly whether signing in can work.
                    server_reachable()
                else:
                    STATE["lots"] = authed_api("/devices/lots") or []
                # Back online — push anything that was held while offline.
                if queue_count():
                    threading.Thread(target=queue_flush, daemon=True).start()
            except SignInRequired:
                # The operator's session ended (the sign-in panel says why).
                # That is not a network fault, so no "Not connected" banner.
                pass
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


_LSBLK_ESC = re.compile(rb"\\x([0-9a-fA-F]{2})")


def drive_serial(value):
    """A drive serial in the ONE form the station and the engine agree on
    (contract C1's expected-serial argument): lsblk's escapes decoded, NULs
    dropped, surrounding whitespace trimmed.

    `lsblk -P` prints a quote, backslash, `$`, backtick or any non-printable
    byte inside a value as \\xNN (a backslash itself is \\x5c, so every
    backslash in its output starts one of these). The engine's als_lsblk_val
    decodes them with printf %b before it compares the drive's own serial with
    the one it was given, and bash cannot hold a NUL at all. This side used to
    pass the serial still escaped, so a drive whose serial contained any such
    character - "ABC$123" arrives as ABC\\x24123 - was refused by the engine as
    an identity mismatch every time and could never be wiped here.

    Applied to BOTH sides of the profile check too: the profile's
    storage[].serialNumber is the raw lsblk value (the engine's pval does not
    decode), so decoding only one side would refuse the same drive here instead.

    surrogateescape keeps a byte that is not valid UTF-8 as itself, so the
    value handed to the engine as an argument is exactly the drive's bytes."""
    if not isinstance(value, str):
        return ""
    if "\\x" in value:
        raw = _LSBLK_ESC.sub(lambda m: bytes([int(m.group(1), 16)]),
                             value.encode("utf-8", "surrogateescape"))
        value = raw.decode("utf-8", "surrogateescape")
    # POSIX [[:space:]] - what the engine's sed trims - not str.strip()'s
    # wider Unicode idea of whitespace.
    return value.replace("\x00", "").strip(" \t\n\r\v\f")


DRIVES_CACHE = {"ts": 0.0, "data": []}

# Where sysfs is. Only ever changed by tests (tools/test-wipe-gate.py builds a
# fake tree in a temp folder) - nothing on the station sets it.
SYS_ROOT = "/sys"


def nvme_controller(name):
    """Which NVMe drive a namespace belongs to: "nvme0" (the controller) or
    "nvme-subsys0" (the subsystem, on kernels with native NVMe multipath, which
    Ubuntu's is). None for anything that is not an NVMe namespace.

    Why the kiosk cares (plan step 36, owner decision D36): an NVMe drive can
    expose several namespaces - nvme0n1, nvme0n2 - and each shows up here as its
    own disk. But the engine's sanitize is a command to the CONTROLLER, and it
    erases every namespace on it. Two namespaces of one drive ticked together
    would start two erases on the same controller at once - the second one
    fails or aborts the first. So /api/wipe/start runs them one after the other
    (each still wiped and recorded on its own: the engine's format and
    overwrite cover only the namespace they are given), and the confirm dialog
    says so, and that a sanitize takes every namespace, ticked or not.

    Read from sysfs, not guessed from the name: /sys/block/nvme0n1 resolves to
    .../nvme/nvme0/nvme0n1 (or .../nvme-subsystem/nvme-subsys0/nvme0n1 with
    multipath), and that path is the kernel's own statement of which controller
    or subsystem owns the namespace. Only when sysfs says nothing (not Linux, a
    test) does it fall back to the name, where nvme<N>n<M> shares <N> with
    every other namespace of the same controller (or subsystem) anyway."""
    if not re.match(r"^nvme\d+n\d+$", name or ""):
        return None
    try:
        real = os.path.realpath(os.path.join(SYS_ROOT, "block", name))
    except (OSError, ValueError):
        real = ""
    parts = real.replace("\\", "/").split("/")
    # The subsystem wins when there is one: it is the unit a sanitize covers
    # (the NVMe spec's sanitize acts on the whole NVM subsystem).
    for p in parts:
        if re.match(r"^nvme-subsys\d+$", p):
            return p
    # Nearest controller above the namespace node itself.
    for p in reversed(parts[:-1]):
        if re.match(r"^nvme\d+$", p):
            return p
    return re.match(r"^(nvme\d+)n\d+$", name).group(1)


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
            # SERIAL is what /api/wipe/start checks against the captured
            # profile, so a drive that was not there at capture is never wiped
            # under this machine's name.
            ["lsblk", "-dPb", "-o", "NAME,SIZE,MODEL,TRAN,RM,ROTA,TYPE,SERIAL"],
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
            # Not "TRIM": TRIM is not an erase and is no longer used. An SSD
            # whose own erase is refused (usually a BIOS freeze) is overwritten.
            method = "ATA secure erase, else overwrite (SSD)"
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
            # Decoded (see drive_serial): the form the engine compares against
            # when it is handed this as the expected serial. "" = the drive
            # reported none.
            "serial": drive_serial(lsblk_field(line, "SERIAL")),
            "transport": tran,
            "method": method,
            "health": smart_health("/dev/" + name),
            # The NVMe controller (or subsystem) this namespace sits on; None
            # for SATA/SAS disks. See nvme_controller.
            "controller": nvme_controller(name),
        })
    # Every namespace of the same NVMe drive, on each of them (a one-element
    # list for the usual single-namespace drive, [] for non-NVMe). The confirm
    # dialog warns from this when it is longer than one (D36): they are wiped
    # in turn, a sanitize of any of them takes all of them, and a namespace
    # left unticked is neither wiped by format/overwrite nor recorded.
    for d in drives:
        ctrl = d.get("controller")
        d["namespaces"] = [x["device"] for x in drives
                           if ctrl and x.get("controller") == ctrl]
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


# Whether the station clock has been set from a network time source this boot
# (HTTP Date header or a LAN time server) - as opposed to never, or only lifted
# to the boot media's file date, which is "late enough for HTTPS" but can be
# weeks out. Every wipe record says which (wipedAtClock), because its wipedAt
# is only as good as this clock.
CLOCK = {"network": False}


def sync_clock():
    ok, msg, network = _sync_clock()
    if network:
        CLOCK["network"] = True
    return ok, msg


def _sync_clock():
    """Set the system clock from the network. Returns (ok, message, network):
    network is True only when the clock is now right by a network source.

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
                        return True, "synced with the time server at %s" % host, True
                except Exception:  # noqa: BLE001
                    pass

    if true_epoch is None:
        if floor_applied:
            return True, ("no time source reachable — set from the boot media date "
                          "(approximate, but late enough for HTTPS)"), False
        return False, "no time source reachable", False

    drift = true_epoch - time.time()
    if abs(drift) < 120:
        return True, "clock already correct", True

    # Set it explicitly rather than trusting an NTP daemon to have worked: an
    # earlier version inferred success from elapsed wall time, so NTP tools that
    # merely hung looked like a successful sync and the real fix never ran.
    if not shutil.which("date"):
        return False, "clock is out by %d days but `date` is unavailable" % (abs(drift) // 86400), False
    stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(true_epoch))
    try:
        r = subprocess.run(["date", "-u", "-s", stamp], capture_output=True,
                           text=True, timeout=10)
        if r.returncode != 0:
            return False, "could not set clock: %s" % ((r.stderr or r.stdout).strip()
                                                       or "permission denied?"), False
    except Exception as exc:  # noqa: BLE001
        return False, str(exc), False
    subprocess.run(["hwclock", "-w"], capture_output=True, timeout=10)   # persist it
    return True, "clock corrected (was out by %d days)" % (abs(drift) // 86400), True


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
        rows = authed_api("/assets?batchId=%s&search=%s"
                          % (lot_id, urllib.parse.quote(serial))) or []
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
        audits = authed_api("/assets/%s/audits" % match["id"]) or []
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


ELIGIBILITY_KEYS = ("available", "reason", "verdict", "drives")


def certificate_eligibility(asset_id):
    """Does this asset have a Certificate of Data Erasure now? Asked of the API
    (contract C4, GET /assets/:id/certificate-eligibility) rather than worked
    out here: the rule - every drive of the machine wiped, the D11 mixed-result
    guard, legacy rows - lives on the server, and a second copy in the kiosk
    would drift from it. The screen used to announce "certificate available"
    after ANY recorded wipe, including one where another drive of the same
    machine had just failed.

    Always answers 200 with {"known": bool, ...}. known=False means "cannot
    tell" - no asset id, offline, or an API older than C4 (a 404) - and the
    screen then says only what it saw itself, never "available"."""
    if not re.match(r"^[A-Za-z0-9-]{1,64}$", asset_id or ""):
        return {"known": False, "why": "no asset id"}
    try:
        out = authed_api("/assets/%s/certificate-eligibility" % asset_id, timeout=10)
    except urllib.error.HTTPError as exc:
        # 404 = an API that predates C4 (or an asset this account cannot see).
        # Both are "unknown", by contract - not "no certificate".
        return {"known": False, "why": "server did not answer (HTTP %s)" % exc.code}
    except Exception as exc:  # noqa: BLE001 - offline, timeout, bad JSON
        return {"known": False, "why": str(exc) or "server unreachable"}
    if not isinstance(out, dict) or not isinstance(out.get("available"), bool):
        return {"known": False, "why": "unexpected answer from the server"}
    ans = {k: out.get(k) for k in ELIGIBILITY_KEYS}
    ans["known"] = True
    return ans


# --------------------------------------------------------------- boot timing --
# Nobody has ever measured this stick's boot. Every opinion about why it is slow
# - including mine - has been a guess, because the operator has no terminal and
# the one person who could read a number cannot see the screen. So the numbers
# come to the screen the operator already photographs.
#
# What this DOES tell us: where the time goes after the kernel starts, how fast
# the USB link negotiated, and how the layers are compressed.
# What it CANNOT tell us: the black-screen phase before the kernel - firmware
# POST, USB enumeration, and GRUB reading the kernel through firmware drivers.
# No software running on this machine can see time that passed before it existed.
# That gap is (wall-clock from pressing power) minus (uptime shown here), which
# is why the instruction is to film one boot on a phone.

SQUASH_COMP = {1: "gzip", 2: "lzma", 3: "lzo", 4: "xz", 5: "lz4", 6: "zstd"}


def squashfs_info(path):
    """Compressor and block size, read straight from the superblock.

    Deliberately not `unsquashfs -s`: squashfs-tools is not guaranteed to be on
    a live image, and the superblock is a fixed little-endian layout - magic
    'hsqs', block size at 12, compression id at 20. Reading 24 bytes cannot fail
    in a way that matters, and needs nothing installed."""
    try:
        with open(path, "rb") as fh:
            head = fh.read(24)
        if len(head) < 24 or head[:4] != b"hsqs":
            return None
        import struct
        block = struct.unpack_from("<I", head, 12)[0]
        comp = struct.unpack_from("<H", head, 20)[0]
        return {"comp": SQUASH_COMP.get(comp, "id %d" % comp),
                "block": block,
                "size": os.path.getsize(path)}
    except OSError:
        return None


def mount_device(mp):
    """The block device behind a mountpoint, from /proc/mounts."""
    try:
        with open("/proc/mounts") as fh:
            for line in fh:
                parts = line.split()
                if len(parts) >= 2 and parts[1] == mp.replace(" ", "\\040"):
                    return parts[0]
    except OSError:
        pass
    return None


def usb_link_speed(dev):
    """The negotiated USB speed of the device backing the boot medium.

    This is the single most valuable number here. A USB 3 stick in a USB 2
    socket runs at roughly a quarter speed and says nothing about it - and
    front-panel sockets on second-hand desktops are very often USB 2. Free to
    fix if that is what this reports, which is why it is worth showing."""
    if not dev:
        return "unknown"
    name = os.path.basename(dev).rstrip("0123456789")   # sdb1 -> sdb
    try:
        # /sys/class/block/sdb -> ../../devices/.../usb1/1-1/1-1:1.0/host4/...
        node = os.path.realpath("/sys/class/block/%s" % name)
    except OSError:
        return "unknown"
    # Walk up to the USB device node, which is the one carrying "speed".
    for _ in range(12):
        spd = os.path.join(node, "speed")
        if os.path.isfile(spd):
            try:
                with open(spd) as fh:
                    mbps = float(fh.read().strip())
            except (OSError, ValueError):
                break
            if mbps >= 10000:
                return "USB 3.1 Gen2 (%g Mbps)" % mbps
            if mbps >= 5000:
                return "USB 3.0 (%g Mbps)" % mbps
            if mbps >= 480:
                return "USB 2.0 (%g Mbps) - SLOW, try a socket on the BACK" % mbps
            return "USB 1.x (%g Mbps) - very slow" % mbps
        parent = os.path.dirname(node)
        if parent == node or parent == "/sys":
            break
        node = parent
    return "not a USB device (or speed not reported)"


def _analyze(args, timeout=8):
    try:
        r = subprocess.run(["systemd-analyze"] + args, capture_output=True,
                           text=True, timeout=timeout)
    except Exception as exc:  # noqa: BLE001
        return "systemd-analyze unavailable: %s" % exc
    if r.returncode != 0:
        # The usual reason is a boot that has not finished - systemd-analyze
        # refuses until the startup transaction completes. Say so rather than
        # printing an empty box.
        return (r.stderr or r.stdout or "").strip() or "no output"
    return (r.stdout or "").strip()


# two-step will not load a theme whose ImageDir lacks any of these - see
# plymouth_state. Kept in step with TWO_STEP_REQUIRES in boot/make-splash.py.
TWO_STEP_REQUIRES = ("lock.png", "entry.png", "bullet.png")
PLY_THEMES = "/usr/share/plymouth/themes"


def plymouth_state(themes=PLY_THEMES):
    """Why the shutdown splash is Ubuntu's and not ours - each link of the chain.

    SETTLED 2026-09-19, from plymouth's own source and this stick's own layer.
    two-step refuses any theme whose ImageDir lacks lock.png, entry.png or
    bullet.png (two-step/plugin.c show_splash_screen; ply-entry.c
    ply_entry_load) - the password-prompt images, required even on a machine
    that never prompts. The als theme shipped without them, so it never loaded
    anywhere. plymouthd fell through to bgrt: OURS in the boot archive, which is
    why the boot splash looked right, and Ubuntu's stock one in the real root,
    which is what shutdown draws - the Dell logo and the Ubuntu wordmark.

      conf      - our plymouthd.conf names als
      theme     - als is present AND complete enough for two-step to load
      module    - two-step.so exists
      fallback  - whose bgrt the real root falls back to if als still fails
      pivot     - whether systemd pivots into /run/initramfs to shut down.
                  /run/initramfs exists on EVERY Ubuntu boot - it is
                  initramfs-tools' 0700 log directory - so its existence proves
                  nothing. Only /run/initramfs/shutdown means a pivot. The
                  previous version of this check got that wrong, and blamed it.
    """
    out = {}

    conf = "/etc/plymouth/plymouthd.conf"
    try:
        with open(conf, errors="replace") as fh:
            body = fh.read()
        theme = ""
        for line in body.splitlines():
            if line.strip().lower().startswith("theme="):
                theme = line.split("=", 1)[1].strip()
        out["conf"] = "Theme=%s" % (theme or "(not set)")
    except OSError as exc:
        out["conf"] = "unreadable: %s" % exc

    als = os.path.join(themes, "als")
    if not os.path.isfile(os.path.join(als, "als.plymouth")):
        out["theme"] = "MISSING from the running root"
    else:
        lacking = [f for f in TWO_STEP_REQUIRES if not os.path.isfile(os.path.join(als, f))]
        out["theme"] = ("present and complete - two-step can load it" if not lacking else
                        "present but INCOMPLETE - no %s, so two-step refuses it and "
                        "shutdown falls back to bgrt. Rebuild the layer." % ", ".join(lacking))

    mods = sorted(os.path.basename(m) for m in
                  glob.glob("/usr/lib/*/plymouth/*.so") + glob.glob("/lib/*/plymouth/*.so"))
    out["module"] = ("two-step.so present" if "two-step.so" in mods
                     else "two-step.so MISSING - als cannot load")
    out["modules"] = ", ".join(mods) or "none found"

    try:
        alt = os.path.realpath("/etc/alternatives/default.plymouth")
        out["default_alt"] = alt if os.path.exists(alt) else "%s (dangling)" % alt
    except OSError:
        out["default_alt"] = "unknown"

    try:
        with open(os.path.join(themes, "bgrt", "bgrt.plymouth"), errors="replace") as fh:
            ours = "ALS audit station" in fh.read()
        out["fallback"] = ("bgrt is OURS - even a failed als looks right" if ours else
                           "bgrt is Ubuntu's stock theme - a failed als shows the Ubuntu logo")
    except OSError:
        out["fallback"] = "no bgrt theme in the running root"

    try:
        os.stat("/run/initramfs/shutdown")
        out["pivot"] = "/run/initramfs/shutdown exists - systemd pivots there to shut down"
    except FileNotFoundError:
        out["pivot"] = "none - no /run/initramfs/shutdown, so shutdown draws from the real root"
    except PermissionError:
        try:
            r = subprocess.run(elevate(["test", "-e", "/run/initramfs/shutdown"]),
                               capture_output=True, timeout=5)
            out["pivot"] = ("/run/initramfs/shutdown exists - systemd pivots there"
                            if r.returncode == 0 else
                            "none - no /run/initramfs/shutdown, so shutdown draws from the real root")
        except Exception:  # noqa: BLE001
            out["pivot"] = "unknown (/run/initramfs is root-only)"
    except OSError as exc:
        out["pivot"] = "unknown (%s)" % exc

    return out


# What the APP waited on, as opposed to what graphical.target waited on. The two
# differ: critical-chain answered "snapd.seeded, 95s" for graphical.target, but
# the app was up at 82s - before seeding finished - so the chain alone cannot say
# where the operator's 82 seconds went. First matching journal line for each.
TIMELINE_MARKS = (
    ("display manager started", r"Started gdm\.service|Started GNOME Display Manager"),
    ("kiosk session running", r" als-autostart\[\d+\]: "),
    ("backend starting", r" als-autostart\[\d+\]: starting backend"),
    ("browser launched", r" als-autostart\[\d+\]: kiosk: "),
    ("firefox snap mounted", r"Mounted snap-firefox"),
    ("snap seeding finished", r"Finished snapd\.seeded\.service"),
    ("graphical.target reached", r"Reached target graphical\.target"),
)


def _timeline(journal_text, marks=TIMELINE_MARKS):
    """[(seconds, label)] from `journalctl -o short-monotonic`, in time order."""
    found = {}
    pats = [(label, re.compile(rx)) for label, rx in marks]
    for line in journal_text.splitlines():
        m = re.match(r"\s*\[\s*(\d+\.\d+)\]", line)
        if not m:
            continue
        for label, rx in pats:
            if label not in found and rx.search(line):
                found[label] = float(m.group(1))
    return sorted((t, label) for label, t in found.items())


def boot_timeline():
    try:
        r = subprocess.run(elevate(["journalctl", "-b", "-o", "short-monotonic",
                                    "--no-pager", "-q"]),
                           capture_output=True, text=True, timeout=20)
    except Exception as exc:  # noqa: BLE001
        return ["journal unavailable: %s" % exc]
    if r.returncode != 0 and not r.stdout:
        return ["journal unavailable: %s" % (r.stderr.strip() or "no output")]
    rows = _timeline(r.stdout)
    if APP_READY["uptime"]:
        rows = sorted(rows + [(APP_READY["uptime"], "APP READY (page served)")])
    return ["%6.1fs  %s" % (t, label) for t, label in rows] or ["no markers found"]


def _layer_chain(cmdline):
    """The squashfs files casper ACTUALLY mounts, lowest first.

    casper strips one dot-component at a time off layerfs-path (see
    make-als-layer.sh), so minimal.standard.live.als.squashfs means four
    layers. The stick carries forty more - languages, secure-boot variants -
    that this boot never opens; listing them all buried the four that count."""
    m = re.search(r"(?:^|\s)layerfs-path=(\S+)", cmdline or "")
    top = m.group(1) if m else "minimal.standard.live.squashfs"
    if top.endswith(".squashfs"):
        top = top[:-len(".squashfs")]
    parts = top.split(".")
    return [".".join(parts[:i + 1]) + ".squashfs" for i in range(len(parts))]


def _bytes(n):
    for unit, size in (("GB", 1e9), ("MB", 1e6), ("KB", 1e3)):
        if n >= size:
            return ("%.2f" % (n / size)).rstrip("0").rstrip(".") + " " + unit
    return "%d bytes" % n


def boot_timing():
    out = {}

    try:
        with open("/proc/uptime") as fh:
            out["uptime"] = float(fh.read().split()[0])
    except (OSError, ValueError, IndexError):
        out["uptime"] = None

    out["total"] = _analyze(["time"])
    blame = _analyze(["blame"])
    out["blame"] = [l.strip() for l in blame.splitlines() if l.strip()][:10] \
        if not blame.startswith("systemd-analyze unavailable") else []
    chain = _analyze(["critical-chain"])
    out["chain"] = [l.rstrip() for l in chain.splitlines() if l.strip()][:12] \
        if not chain.startswith("systemd-analyze unavailable") else []

    mp = mount_point(CONF_PATH) if CONF_PATH else None
    dev = mount_device(mp) if mp else None
    out["device"] = dev or "unknown"
    out["usb"] = usb_link_speed(dev)

    # How the layers are packed. xz is the slowest to decompress by a wide
    # margin, and every byte the machine reads off the stick goes through it.
    layers = []
    if mp:
        try:
            with open("/proc/cmdline") as fh:
                cmdline = fh.read()
        except OSError:
            cmdline = ""
        for name in _layer_chain(cmdline):
            info = squashfs_info(os.path.join(mp, "casper", name))
            layers.append("%s - %s, %d KiB blocks, %s" % (
                name, info["comp"], info["block"] // 1024, _bytes(info["size"]))
                if info else "%s - NOT FOUND on the stick" % name)
    out["layers"] = layers
    out["timeline"] = boot_timeline()

    try:
        out["plymouth"] = plymouth_state()
    except Exception as exc:  # noqa: BLE001
        out["plymouth"] = {"conf": "check failed: %s" % exc}
    return out


# --------------------------------------------------------------- boot report --
# Every boot writes its own timing onto the stick.
#
# The loop until now was: boot, photograph a screen, send the photo, read tiny
# text off it, guess. Photos of the wrong screen, numbers too small to read, and
# every answer costing a round trip. The stick comes back to Windows to be synced
# anyway, so it can carry the answer: boot-report.txt is the last boot in full,
# boot-history.csv is one line per boot across every machine it has been in.
# That second file is what answers "how many of our machines are USB 2?" -
# which decides whether a faster drive is worth buying at all.
#
# APP READY is the number that matters to the operator: seconds from the kernel
# starting to the moment the app page was actually served to the browser.
# Firmware and the boot menu happen before the kernel and cannot be seen from
# here - add roughly the pause between power-on and the splash.

APP_READY = {"uptime": None}

# The report used to be written only once systemd declared the boot finished,
# with a ten-minute ceiling. That is minutes on a live system, and the normal
# workflow is: app appears, audit, wipe, power off. So on the very boots it was
# built to measure it would never have been written - silently. It now writes
# TWICE: an early report the moment the app is first served, carrying the
# numbers that matter most and exist already (app-ready time, USB link, whether
# the self-check is running), and a final one if the machine stays up long
# enough for systemd's own accounting. Whichever the operator allows, something
# is on the stick. The history gets exactly one row per boot, from the early one.
REPORT_LOCK = threading.Lock()
REPORT_STATE = {"history_written": False}

# Where a boot report may be written. Only onto the medium this station booted
# from - never into a repository checkout because someone ran the backend on a
# development machine and opened the page.
BOOT_MEDIA_MOUNTS = ("/cdrom", "/run/archiso/bootmnt", "/isodevice", "/mnt/als-media")


def on_boot_media():
    if not CONF_PATH or not os.path.exists("/proc/uptime"):
        return False
    mp = mount_point(CONF_PATH)
    return mp in BOOT_MEDIA_MOUNTS or mp.startswith("/media/")


def mark_app_ready():
    """First time the UI is served. That is the operator's "it's up"."""
    if APP_READY["uptime"] is not None:
        return
    try:
        with open("/proc/uptime") as fh:
            APP_READY["uptime"] = float(fh.read().split()[0])
    except (OSError, ValueError, IndexError):
        APP_READY["uptime"] = -1.0
    # Straight away, in the background - never on the request that serves the
    # page. The browser must not wait on a remount and a write to the stick.
    threading.Thread(target=report_now, args=(False,), daemon=True).start()


def _machine_name():
    parts = []
    for f in ("sys_vendor", "product_name"):
        try:
            with open("/sys/class/dmi/id/" + f, errors="replace") as fh:
                v = fh.read().strip()
            if v and v not in parts:
                parts.append(v)
        except OSError:
            pass
    return " ".join(parts) or "unknown machine"


MD5_UNIT_PROPS = ("LoadState", "ActiveState", "SubState", "Result",
                  "ConditionResult", "ConditionTimestampMonotonic",
                  "ExecMainStartTimestampMonotonic", "ExecMainExitTimestampMonotonic")
MD5_RESULT_FILE = "/run/casper-md5check.json"


def _md5_verdict(kv, result, now_us):
    """Turn systemd's view of casper-md5check (+ its own result file) into words.

    The first version of this read ConditionResult=no as "skipped" - but that is
    also the DEFAULT for a unit systemd has not got round to yet, so the early
    report said SKIPPED and the final one, minutes later, said RUNNING for a unit
    that had long since exited (ActiveState=active covers SubState=exited for a
    oneshot with RemainAfterExit). Both readings were wrong. The duration is what
    settles it: standing down for fsck.mode=skip takes well under a second;
    actually re-reading 5.9 GB takes a minute even on USB 3."""
    if kv.get("LoadState") == "not-found":
        return "no such unit on this image"

    def us(key):
        try:
            return int(kv.get(key) or 0)
        except ValueError:
            return 0

    start, end = us("ExecMainStartTimestampMonotonic"), us("ExecMainExitTimestampMonotonic")
    act, sub = kv.get("ActiveState", "?"), kv.get("SubState", "?")

    if result == "skip":
        return "SKIPPED - it started and stood down (fsck.mode=skip honoured)"
    if result == "fail":
        return "RAN and FAILED - files on the stick do not match their checksums"

    if act == "activating" or (start and not end and act == "active" and sub == "start"):
        return "RUNNING for %.0fs so far - re-reading 5.9 GB of the stick" % (
            max(0, now_us - start) / 1e6)
    if start and end >= start:
        took = (end - start) / 1e6
        if result == "pass" or took >= 5:
            return "RAN - re-read the stick in %.0fs (fsck.mode=skip NOT honoured)" % took
        return "SKIPPED - it exited in %.1fs without reading the stick" % took
    if kv.get("ConditionResult") == "no" and us("ConditionTimestampMonotonic"):
        return "SKIPPED - its unit condition declined to start it"
    if act == "inactive" and not start:
        return "NOT STARTED YET - it is ordered after the desktop comes up"
    return "%s/%s result=%s" % (act, sub, kv.get("Result", "?"))


def md5check_state():
    """Whether Ubuntu's 5.9 GB disc self-check ran, is running, or was skipped.

    Asked of systemd directly rather than read from `systemd-analyze blame`,
    because blame refuses to answer until the boot has finished - and the early
    report is written before that. casper-md5check also leaves its own verdict
    in /run/casper-md5check.json (the installer reads it to warn about a bad
    stick); when that exists it is the better witness and is preferred."""
    try:
        r = subprocess.run(
            ["systemctl", "show", "casper-md5check.service"]
            + [a for p in MD5_UNIT_PROPS for a in ("-p", p)],
            capture_output=True, text=True, timeout=5)
    except Exception as exc:  # noqa: BLE001
        return "unknown (%s)" % exc
    kv = dict(l.split("=", 1) for l in r.stdout.splitlines() if "=" in l)
    result = None
    try:
        with open(MD5_RESULT_FILE) as fh:
            result = str(json.load(fh).get("result") or "").lower() or None
    except (OSError, ValueError, AttributeError):
        pass
    return _md5_verdict(kv, result, int(time.monotonic() * 1e6))


def _md5check_blame(blame):
    for line in blame:
        if "casper-md5check" in line:
            return line.split()[0]
    return ""


def report_now(final):
    """Write boot-report.txt now. final=False is the early report."""
    if not on_boot_media():
        return
    with REPORT_LOCK:
        b = boot_timing()
        ready = APP_READY["uptime"]
        ready_txt = ("%.0fs after the kernel started" % ready) if ready and ready > 0 \
            else "not reached (the page was never served)"
        try:
            with open("/proc/cmdline") as fh:
                cmdline = fh.read().strip()
        except OSError:
            cmdline = "unknown"
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        machine = _machine_name()
        md5 = md5check_state()
        took = _md5check_blame(b.get("blame") or [])
        if took:
            md5 = "%s (took %s)" % (md5, took)
        ply = b.get("plymouth") or {}
        stage = ("final - systemd has finished the boot" if final else
                 "EARLY - written the moment the app appeared; systemd may "
                 "still be finishing, so its numbers below can be incomplete")

        lines = [
            "ALS Audit Station - boot report",
            "written   : %s" % stamp,
            "stage     : %s" % stage,
            "machine   : %s" % machine,
            "",
            "APP READY : %s" % ready_txt,
            "systemd   : %s" % b.get("total", "?"),
            "USB link  : %s  (%s)" % (b.get("usb", "?"), b.get("device", "?")),
            "self-check: %s" % md5,
            "cmdline   : %s" % cmdline,
            "",
            "--- slowest units ---",
        ] + ["  " + l for l in (b.get("blame") or ["(not available until the boot finishes)"])] + [
            "",
            "--- what graphical.target waited on (NOT the same as the app) ---",
        ] + ["  " + l for l in (b.get("chain") or ["(not available until the boot finishes)"])] + [
            "",
            "--- timeline: seconds after the kernel started ---",
        ] + ["  " + l for l in (b.get("timeline") or ["(not available)"])] + [
            "",
            "--- layers this boot mounted, lowest first ---",
        ] + ["  " + l for l in (b.get("layers") or [])] + [
            "",
            "--- shutdown splash ---",
        ] + ["  %s: %s" % (k, ply.get(k)) for k in
             ("conf", "theme", "module", "fallback", "default_alt", "pivot") if ply.get(k)] + [""]

        base = os.path.dirname(CONF_PATH)
        err = write_boot_file(os.path.join(base, "boot-report.txt"), "\n".join(lines))
        print("boot report (%s): %s" % ("final" if final else "early", err or "written"))

        # One history row per boot. Written with the early report, because the
        # early one is the one that is guaranteed to happen.
        if REPORT_STATE["history_written"]:
            return
        hist = os.path.join(base, "boot-history.csv")
        try:
            with open(hist, errors="replace") as fh:
                old = fh.read()
        except OSError:
            old = ""
        if not old.startswith("when,"):
            old = "when,machine,app_ready_s,usb_link,self_check,systemd\n" + old
        row = '%s,"%s",%s,"%s","%s","%s"\n' % (
            stamp, machine.replace('"', "'"),
            ("%.0f" % ready) if ready and ready > 0 else "",
            (b.get("usb") or "").replace('"', "'"),
            md5.replace('"', "'"),
            (b.get("total") or "").replace('"', "'"))
        keep = (old + row).splitlines(True)
        if len(keep) > 501:                     # the last 500 boots
            keep = keep[:1] + keep[-500:]
        if write_boot_file(hist, "".join(keep)) is None:
            REPORT_STATE["history_written"] = True


def write_boot_report():
    """The FINAL report, if the machine stays up long enough for systemd."""
    for _ in range(120):
        t = _analyze(["time"])
        if t.startswith("Startup finished"):
            break
        if t.startswith("systemd-analyze unavailable"):
            return          # not a live system - write nothing
        time.sleep(5)
    else:
        return              # never finished in 10 min; the early report stands
    report_now(True)


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
        ("Wipe + audit", ["shred", "smartctl", "hdparm", "nvme"]),
        ("Kiosk display", ["cage", "xdotool", "xrandr", "firefox-esr", "firefox"]),
        ("Network shares", ["mount.nfs", "mount.cifs"]),
    ]
    out = []
    for label, names in groups:
        out.append({"group": label,
                    "tools": [{"name": n, "present": bool(shutil.which(n))} for n in names]})

    space = ""
    try:
        # Whichever medium the tools actually came off. This was pinned to
        # archiso's mountpoint, so on an Ubuntu stick it fell through to "/" and
        # reported the live RAM overlay - "4 GB free of 4 GB" - under the
        # heading "Boot media", while the 28 GB stick went unmentioned.
        if CONF_PATH:
            target = mount_point(CONF_PATH)
        elif os.path.isdir("/run/archiso/bootmnt"):
            target = "/run/archiso/bootmnt"
        else:
            target = "/"
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
    boot = {}
    try:
        boot = boot_timing()
    except Exception as exc:  # noqa: BLE001
        # Diagnostics must never take the panel down with them.
        boot = {"error": str(exc)}

    return {"groups": out, "space": space, "verdict": verdict,
            "clonezilla": can_clonezilla, "partclone": can_partclone,
            "boot": boot}


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
              watch_writes=False, noun="process", hint="",
              record_on_no_result=False, queue_key=None, on_start=None):
    """Run a long command in the background, streaming its stdout into a rolling
    log and parsing the final `<PREFIX> {json}` line into `result`. `on_done`
    (given the parsed result) runs after the process ends and before the job is
    marked finished — used to upload the wipe record. `watch_writes` adds a
    kernel-level disk-write heartbeat for engines that go quiet (see
    _write_watchdog); `noun`/`hint` word the message shown if it dies without
    a verdict.

    `record_on_no_result` (wipes only): if the job ends with no result line at
    all - the engine crashed, was killed, was cancelled, printed an unreadable
    result - on_done still runs, with a synthesized status "failed" result.
    Before this a wipe whose job died filed NOTHING: a drive that may be half
    overwritten left no trace on the asset, which kept whatever wipe status it
    had before. A failed record is the honest one.

    `queue_key`: jobs sharing a key run one at a time, in the order they were
    started (see DRIVE_QUEUES). A job behind another is registered and
    `running` at once - so the screen can follow it and a second request for
    the same device is refused as usual - but its command does not start until
    the one ahead has ended; until then job["waiting"] says what it waits for.
    Stopped while waiting, it ends "refused": nothing was written.

    `on_start`: called just before the command is launched (after any wait),
    so a caller can note when the work REALLY began."""
    now = time.time()
    token = object()
    with LOCK:
        cur = JOBS.get(kind)
        if cur and cur.get("running"):
            return False
        ahead = []
        if queue_key:
            q = DRIVE_QUEUES.setdefault(queue_key, [])
            ahead = [dev for _t, dev in q]
            q.append((token, device))
        JOBS[kind] = {"running": True, "log": [], "result": None, "error": None,
                      "device": device, "startedAt": now, "updatedAt": now,
                      "cancelled": False, "seq": 0,
                      # None = not being watched; the UI needs to tell "quiet but
                      # writing" apart from "genuinely stopped".
                      "writeBytes": 0, "writeStalled": None,
                      "waiting": _waiting_text(ahead, queue_key)}
    job = JOBS[kind]
    released = [not queue_key]

    def release():
        """Let the next job with this key go. Idempotent."""
        if released[0]:
            return
        released[0] = True
        with QUEUE_COND:
            rest = [e for e in DRIVE_QUEUES.get(queue_key, []) if e[0] is not token]
            if rest:
                DRIVE_QUEUES[queue_key] = rest
            else:
                DRIVE_QUEUES.pop(queue_key, None)
            QUEUE_COND.notify_all()

    def wait_turn():
        """Block until this job is at the head of its queue, or is stopped.
        Returns True when it may run."""
        with QUEUE_COND:
            while True:
                q = DRIVE_QUEUES.get(queue_key, [])
                idx = next((i for i, e in enumerate(q) if e[0] is token), 0)
                if idx == 0 or job.get("cancelled"):
                    job["waiting"] = None
                    return not job.get("cancelled")
                job["waiting"] = _waiting_text([dev for _t, dev in q[:idx]], queue_key)
                # Waiting is not hanging: keep `idle` low so the screen does
                # not warn "no new output" about a job that has not begun.
                job["updatedAt"] = time.time()
                QUEUE_COND.wait(1.0)

    def worker():
        proc = None
        stop_watch = threading.Event()
        try:
            if queue_key and not wait_turn():
                # Stopped before its turn came: the command never ran, so
                # nothing touched the drive. "refused" is exactly that (and a
                # wipe's on_done does not file it); "failed" would put a
                # failed wipe on a record for a drive nobody wrote to.
                job["result"] = {"status": "refused", "method": "none", "device": device,
                                 "reason": "Stopped before it started, while it was waiting "
                                           "its turn - nothing was written to the drive."}
                return
            if queue_key:
                job["startedAt"] = job["updatedAt"] = time.time()
            if on_start:
                on_start()
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
                        parsed = json.loads(line[len(result_prefix):].strip())
                    except ValueError:
                        parsed = None
                    # Only an object is a verdict. Anything else (a bare
                    # string, a list) would crash on_done's .get() and the
                    # recordError write below it, in a finally: that must
                    # always clear `running`.
                    if isinstance(parsed, dict):
                        job["result"] = parsed
                    else:
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
            # The command has ended (or never started): the next job with the
            # same key may begin. Before on_done, so a slow upload of this
            # record does not hold up the next drive's erase.
            release()
            if on_done and record_on_no_result and not job.get("result"):
                job["result"] = {"status": "failed", "method": "none", "device": device,
                                 "reason": job.get("error") or
                                 "the %s ended without a result" % noun}
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


def _waiting_text(ahead, key):
    """What a queued job tells the screen while it waits (None = not waiting)."""
    if not ahead:
        return None
    return ("Waiting for %s to finish - it is on the same NVMe drive (%s), and two "
            "erases cannot run on one drive at once. This one starts next."
            % (", ".join(ahead), key))


def cancel_job(kind):
    """Stop a running job and everything it spawned. Returns a status message."""
    job = JOBS.get(kind)
    proc = PROCS.get(kind)
    # Still waiting its turn (start_job queue_key): nothing to kill. The worker
    # wakes, sees `cancelled` and ends without running anything. Decided under
    # the queue's lock, the same one wait_turn clears `waiting` under, so a
    # job that has just been let go is never told "stopped before it started".
    with QUEUE_COND:
        if job and job.get("running") and job.get("waiting") and not proc:
            job["cancelled"] = True
            QUEUE_COND.notify_all()
            return True, "Stopped before it started - nothing was written to the drive."
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
# ------------------------------------------------------- which server, and who
# The kiosk may point AUDIT_URL at exactly two hosts: the production API, and
# whatever audit.conf named when the station started. Changing audit.conf means
# taking the stick to a Windows PC - that is the trust boundary. The kiosk
# screen is not: anyone who walks up to it can type into it.
#
# This exists because the station logs in with a password stored on the stick.
# Point AUDIT_URL at a server you control, and the next login hands you that
# password. Before this, a stick with no admin PIN let anyone at the screen do
# exactly that.
PROD_API_HOST = "als-inventory-software-production.up.railway.app"
BOOT_API_HOST = {"host": None}      # set once in main(), never on a reload


def allowed_api_url(url):
    """(True, "") if the kiosk may switch AUDIT_URL to this, else (False, why)."""
    try:
        p = urlparse((url or "").strip())
    except ValueError:
        return False, "That is not a valid server address."
    if p.scheme != "https":
        return False, "The server address must start with https://."
    host = (p.hostname or "").lower()
    allowed = {PROD_API_HOST, (BOOT_API_HOST["host"] or "").lower()} - {""}
    if host not in allowed:
        return False, ("This station can only be pointed at the ALS server (%s). "
                       "To use a different one, edit audit.conf on the stick "
                       "from Windows." % PROD_API_HOST)
    return True, ""


def local_hosts(port=None):
    """The Host header values a request to THIS server carries: the kiosk
    opens http://127.0.0.1:PORT (als-autostart.sh, start-gui.sh), and
    localhost:PORT is what a person would type."""
    port = PORT if port is None else port
    hosts = {"127.0.0.1:%d" % port, "localhost:%d" % port}
    if port == 80:
        hosts |= {"127.0.0.1", "localhost"}
    return hosts


def request_problem(headers, method):
    """(code, message) when a request did not come from this station's own
    page, else None.

    The server listens on 127.0.0.1 only, which keeps other MACHINES out but
    not other WEB PAGES: any page the station's browser loads can send a
    request to http://127.0.0.1:8800. Two ways that mattered:
      - a "simple" cross-origin POST (Content-Type text/plain, no preflight)
        to /api/wipe/start, /api/settings or /api/operator/signin. do_POST
        parses the body as JSON whatever the Content-Type, so a hostile page
        could start a wipe with no confirmation dialog, filed under whoever is
        signed in, or rewrite settings. The 'full' autostart mode is a normal
        browser window with an address bar, so such a page is one mistyped
        address away;
      - DNS rebinding: a page on attacker.example whose name then resolves to
        127.0.0.1 is "same origin" with itself and can READ our answers -
        /api/wipe/eligibility (drive serials fetched with the operator's
        token), /api/bootstrap (the signed-in operator's email).
    So:
      - Host must be this server's own (127.0.0.1:PORT or localhost:PORT). A
        rebinding page's requests carry ITS hostname. Every browser sends
        Host; a request without one is not from a browser and is let through.
      - Origin, when present, must be this server's own. Browsers send it on
        every cross-origin request and on every POST; our own page's fetches
        are same-origin.
      - a POST's Content-Type, when present, must be application/json, which
        is all index.html ever sends (jpost) and which a cross-origin page
        cannot send without a CORS preflight this server never answers.
    `headers` is the request's header mapping (anything with .get)."""
    get = getattr(headers, "get", None)
    if get is None:
        return None
    host = (get("Host") or "").strip().lower()
    if host and host not in local_hosts():
        return 403, "This station's service answers only its own screen (Host %s refused)." % host[:80]
    origin = get("Origin")
    if origin is not None:
        o = origin.strip().lower().rstrip("/")
        if o not in {"http://" + h for h in local_hosts()}:
            return 403, "This station's service answers only its own screen (Origin %s refused)." % o[:80]
    if method == "POST":
        ctype = get("Content-Type")
        if ctype is not None and ctype.split(";")[0].strip().lower() != "application/json":
            return 415, "Requests to this station's service must be JSON."
    return None


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
        bad = request_problem(self.headers, "GET")
        if bad:
            return self._send(bad[0], {"message": bad[1]})
        u = urlparse(self.path)
        if u.path in ("/", "/index.html"):
            mark_app_ready()
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
                "wipeMethod": STATE["conf"].get("AUDIT_WIPE_METHOD", "auto"),
                "server": STATE["conf"].get("AUDIT_URL", ""),
                # Flag on: the signed-in person, never the shared account's
                # address (which may well still be in audit.conf).
                "currentUser": ((STATE.get("userName") or "Signed in")
                                if operator_identity() else "Not signed in")
                if operator_signin_on() else
                (STATE.get("userName") or STATE["conf"].get("AUDIT_EMAIL", "") or "Operator"),
                "operator": STATE.get("operator", ""),
                "signin": signin_state(),
                # Of `waiting`, how many belong to someone other than whoever
                # may send right now (see held_reason). Shown, never sent.
                "waitingHeld": queue_held_count(),
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
                subs = authed_api("/lots?batchId=" + urllib.parse.quote(batch, safe="")) or []
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

        if u.path == "/api/wipe/eligibility":
            asset = (parse_qs(u.query).get("assetId") or [""])[0]
            return self._send(200, certificate_eligibility(asset))

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
                "wipeMethod": c.get("AUDIT_WIPE_METHOD", "auto"),
                "imageServer": c.get("IMAGE_SERVER", ""),
            })

        return self._send(404, {"message": "not found"})

    def do_POST(self):  # noqa: N802
        bad = request_problem(self.headers, "POST")
        if bad:
            # Read (and drop) the body first: closing a socket with unread
            # bytes in it makes the OS reset the connection, and the sender
            # then gets a reset instead of the refusal.
            try:
                n = min(int(self.headers.get("Content-Length") or 0), 1 << 20)
                if n > 0:
                    self.rfile.read(n)
            except (ValueError, OSError):
                pass
            return self._send(bad[0], {"message": bad[1]})
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
            if operator_signin_on():
                # The operator is whoever signed in; a typed name next to a
                # signed-in account could only contradict it.
                return self._send(409, {"message": "Operators sign in at this station - "
                                                   "use Sign in instead of typing a name."})
            # Session-scoped, not PIN-gated: it is a name label on the records
            # this station files, reversible, and a fresh boot clears it.
            STATE["operator"] = (body.get("name") or "").strip()[:120]
            return self._send(200, {"ok": True, "operator": STATE["operator"]})

        if u.path == "/api/operator/signin":
            # The password is in `body` (the parsed request) and nowhere else.
            # It goes to the API once and is dropped here whatever happens; it
            # is never logged (log_message is silenced), never in an error.
            if not isinstance(body, dict):
                return self._send(400, {"message": "Enter your email and password."})
            try:
                if not operator_signin_on():
                    return self._send(409, {"message": "Operator sign-in is not switched "
                                                       "on for this station."})
                if operator_identity():
                    return self._send(409, {"message": "%s is signed in. Sign out first."
                                                       % (operator_identity()["name"]
                                                          or "Someone")})
                try:
                    who = operator_signin(body.get("email"), body.get("password"))
                except ValueError as exc:
                    return self._send(401, {"message": str(exc)})
                except Exception:  # noqa: BLE001
                    return self._send(502, {"message": "Sign-in failed unexpectedly."})
                return self._send(200, {"ok": True, "name": who.get("name", ""),
                                        "email": who.get("email", "")})
            finally:
                body.clear()

        if u.path == "/api/operator/signout":
            if not operator_signin_on():
                return self._send(409, {"message": "Operator sign-in is not switched on."})
            # A wipe still running keeps the operator who STARTED it (stamped
            # at start). If they have signed out by the time it finishes, its
            # record waits in the queue for their next sign-in - it is never
            # sent under whoever signs in after them.
            operator_signout()
            return self._send(200, {"ok": True})

        if u.path == "/api/audit":
            if not STATE["profile"]:
                return self._send(400, {"message": "hardware not captured yet"})
            gate = operator_gate()
            if gate:
                return self._send(gate[0], {"message": gate[1]})
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
            # Screen grade, same treatment and for the same reason: validated
            # against the enum here and DROPPED if it is anything else, because a
            # 400 cannot be told apart from a network outage by the retry queue
            # and one bad value would wedge every later upload behind it.
            screen = (body.get("screenGrade") or "").strip()
            if screen in GRADES:
                payload["screenGrade"] = screen
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
            # The regex above is an injection guard, nothing more - "/dev/sdb"
            # satisfies it whether sdb is the machine's disk or the stick this
            # station booted from. The install handler learned this already and
            # checks against the enumerated disks; the wipe handler never did.
            # list_drives() excludes USB and removable devices, so this makes the
            # offered list the gate rather than just the dropdown. Device names
            # also shift when something is plugged or unplugged, so a name the
            # screen showed a minute ago is not proof of anything now.
            #
            # force=True: re-read lsblk now, not a list cached up to 5 s ago -
            # the serial check below is only as fresh as this read.
            offered = {x.get("device"): x for x in (list_drives(force=True) or [])}
            for d in devices:
                if d not in offered:
                    return self._send(400, {"message": "%s is not an internal disk this "
                                                       "station can wipe" % d})
            # Namespaces of one NVMe drive (plan step 36, owner decision D36):
            # nvme0n1 and nvme0n2 are listed as two disks but sit on ONE
            # controller. They are both accepted and each is wiped and filed
            # on its own, but one after the other - start_job's queue_key
            # below - never at the same time: a sanitize is a command to the
            # whole controller, and a second erase started while it runs is
            # refused by the drive or aborts it.
            #
            # Not refused, and not "merged" into one erase: an earlier version
            # refused both and told the operator the wipe of one "covers the
            # other as well". Only a SANITIZE does. The engine tries a
            # per-namespace `nvme format` first, and its overwrite (the
            # fallback, and AUDIT_WIPE_METHOD=overwrite/zero) shreds only the
            # namespace it is handed - so the unticked namespace kept its data
            # while the screen said the machine was clean. Wiping each one is
            # right whichever method the engine ends up using; when it does
            # sanitize, the second pass only repeats an erase already done.
            # The queue also holds across requests: a sibling asked for while
            # one is running waits behind it, decided in the same critical
            # section that registers the job, so two overlapping requests
            # (double tap, two tabs) cannot both start at once.
            # No machine identity, no erase. This check used to live in
            # record_wipe, AFTER the drive was already destroyed - so a wipe
            # with no profile erased the data and then filed nothing, leaving
            # no record that it ever happened. A capture in progress counts as
            # no identity too: the profile on screen is about to be replaced.
            #
            # No PERSON, no erase either, when operators sign in (plan step
            # 27): a wipe nobody is signed in for could only be filed under
            # nobody. Checked here, before anything is written, and it renews
            # a session near expiry now - not hours later at record time.
            # Offline and not signed in = refused: there is no offline sign-in.
            gate = operator_gate()
            if gate:
                return self._send(gate[0], {"message": gate[1]})
            if STATE.get("capturing"):
                return self._send(409, {"message": "The hardware is still being read. "
                                                   "Wait for it to finish, then start the wipe."})
            profile = STATE["profile"]
            if not profile:
                return self._send(409, {"message": "No hardware profile - this machine has "
                                                   "not been identified, so a wipe could not be "
                                                   "recorded. Press Rescan and wait for the "
                                                   "hardware to be read before wiping."})
            # Only drives that were IN that profile. A drive hot-plugged (or
            # swapped) after the capture used to be wiped and filed under this
            # machine's serial, so its certificate named a laptop it was never
            # in. Every drive that reports a serial must match one the capture
            # saw. A drive that reports NO serial is allowed (owner decision
            # D18, reversible) and recorded as identity unknown - refusing it
            # would leave such drives unwipeable at this station.
            # Both sides through drive_serial: the profile holds the raw lsblk
            # value, list_drives the decoded one.
            known = {drive_serial(s.get("serialNumber"))
                     for s in (profile.get("storage") or []) if isinstance(s, dict)} - {""}
            for d in devices:
                serial = drive_serial(offered[d].get("serial"))
                if serial and serial not in known:
                    return self._send(409, {"message": (
                        "%s (serial %s) was not in the hardware profile captured for "
                        "this machine - it may have been plugged in or swapped since. "
                        "Press Rescan so the station re-reads the hardware, then try "
                        "again." % (d, serial))})

            # After the erase, record it against the device/batch: upload the
            # captured profile + the wipe status/method, ONE record per drive
            # with that drive's identity and dates. This creates/updates the
            # device record and produces the erasure certificate. The profile
            # is the one checked above, captured here and not re-read at the
            # end: a wipe can take hours, and a Rescan in that time must not
            # change what this erase is filed under.
            clock_at_start = CLOCK["network"]

            base = {"profile": profile}
            if lot_id:
                base["lotId"] = lot_id
            if sub_lot_id:
                base["subLotId"] = sub_lot_id
            # With operator sign-in, WHO wiped is fixed when the wipe starts:
            # the person signed in now. Stamping at the end (as the free-text
            # path still does) would name whoever happened to be signed in
            # hours later, and send the record under their token.
            signed_base = stamp_provenance(dict(base)) if operator_signin_on() else None

            def make_recorder(dev, drive, started, pid):
                def record_wipe(result):
                    # "refused" = the engine wrote nothing to the drive (wrong
                    # serial, USB, boot disk...). Filing it would put a failed
                    # wipe on an asset whose drive was never touched.
                    if result.get("status") not in ("wiped", "failed"):
                        pending_remove(pid)
                        return
                    # started["epoch"]: when the engine really began - a
                    # namespace that waited its turn did not start when the
                    # request came in.
                    if signed_base is not None:
                        payload = build_wipe_payload(signed_base, result, dev, drive, method,
                                                     started["epoch"], clock_at_start)
                    else:
                        payload = build_wipe_payload(base, result, dev, drive, method,
                                                     started["epoch"], clock_at_start)
                        stamp_provenance(payload)
                    # On disk before the upload starts: a power cut during the
                    # POST now files this record at the next boot.
                    pending_finalize(pid, payload)
                    held = held_reason(payload)
                    out, queued, err = upload_audit(payload)
                    # Uploaded or queued - either way it is no longer only in
                    # this process's memory.
                    pending_remove(pid)
                    if queued:
                        # Only the upload is pending; the record, dates and
                        # all, is on disk and uploads itself later.
                        result["queued"] = True
                        result["waiting"] = queue_count()
                        # Asked again: the operator can change hands DURING
                        # the upload (post_record then keeps it queued), and
                        # "no connection" would send them to the network.
                        held = held or held_reason(payload)
                        result["recordError"] = (
                            ("the wipe record is saved on this machine; it was " + held)
                            if held else
                            ("no connection — the wipe record is saved "
                             "on this machine and will upload automatically"))
                        return
                    result["recorded"] = bool(out and out.get("assetId"))
                    result["recordName"] = (out or {}).get("name")
                    result["recordTag"] = (out or {}).get("tag")
                    # The asset the record landed on: the screen asks the API
                    # (contract C4, /api/wipe/eligibility) whether THAT asset
                    # now has a certificate, instead of assuming it does.
                    result["recordAssetId"] = (out or {}).get("assetId")
                return record_wipe

            started, busy = [], []
            for d in devices:
                serial = drive_serial(offered[d].get("serial"))
                # The expected serial goes to the engine as gui_wipe_one's 3rd
                # argument (contract C1): it re-reads the drive's own serial
                # immediately before writing and refuses on a mismatch, which
                # closes the gap between this check and the erase. An engine
                # that predates the argument ignores it. No serial, no argument.
                argv = audit_cmd("--wipe-drive", d, method, *([serial] if serial else []))
                started_epoch = time.time()
                drive = {k: offered[d].get(k) for k in
                         ("serial", "model", "bytes", "transport", "rotational")}
                # The marker goes to the stick BEFORE the engine starts - see
                # recover_pending_wipes. Provenance is stamped now: after a
                # restart there is no operator in memory to stamp it from.
                pid = pending_add({"device": d, "drive": drive, "method": method,
                                   "startedEpoch": started_epoch,
                                   "clockAtStart": clock_at_start,
                                   "base": (signed_base if signed_base is not None
                                            else stamp_provenance(dict(base)))})
                began = {"epoch": started_epoch}
                ok = start_job(wipe_kind(d), argv,
                               "WIPE_RESULT ", d,
                               on_done=make_recorder(d, drive, began, pid),
                               noun="wipe", record_on_no_result=True,
                               hint="The drive may be failing or was disconnected.",
                               # One NVMe controller, one erase at a time (see
                               # above). None for SATA/SAS: no queue.
                               queue_key=offered[d].get("controller"),
                               on_start=lambda b=began: b.update(epoch=time.time()))
                if not ok:
                    pending_remove(pid)     # never started: nothing to record
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
            # A restore files a record too, so with operator sign-in it needs
            # a signed-in person, fixed now for the same reason as a wipe's.
            gate = operator_gate()
            if gate:
                return self._send(gate[0], {"message": gate[1]})
            install_who = stamp_provenance({}) if operator_signin_on() else None
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
                if install_who is not None:
                    # The person who STARTED the restore (stamped above, at
                    # start), not whoever is signed in when it ends.
                    payload.pop("operatorName", None)
                    payload.pop(OPERATOR_TAG, None)
                    payload.update(install_who)
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
            # NOT every setting is equally dangerous, so this does not simply
            # refuse everything when no PIN is set. Wi-Fi is what an operator
            # legitimately changes at a new site. Three settings can do real
            # harm from the screen, and those now FAIL CLOSED - no PIN on the
            # stick means they cannot be changed here at all:
            #   server address - point it anywhere and the stored login follows
            #   image server   - the source of every OS installed on a machine
            #                    you then sell; a rogue share ships someone
            #                    else's Windows to your customers
            #   wipe method    - quietly weakens every erasure after it
            # Only a CHANGE counts. The form resubmits every field on each
            # save, so an unchanged value must not trip the lock.
            c = STATE["conf"]
            pin_want = str(c.get("AUDIT_ADMIN_PIN") or "")
            pin_ok = bool(pin_want) and body.get("pin") is not None \
                and str(body.get("pin")) == pin_want

            def norm(v):
                return str(v or "").strip().rstrip("/")

            risky = []
            if body.get("serverUrl") and norm(body["serverUrl"]) != norm(c.get("AUDIT_URL")):
                risky.append("server address")
            if "imageServer" in body and norm(body["imageServer"]) != norm(c.get("IMAGE_SERVER")):
                risky.append("image server")
            # An unset method is shown on screen as "auto", so "auto" coming
            # back against an empty setting is not a change.
            if body.get("wipeMethod") and \
                    norm(body["wipeMethod"]) != norm(c.get("AUDIT_WIPE_METHOD") or "auto"):
                risky.append("wipe method")
            # No "wipeEnabled" here any more, on purpose. AUDIT_WIPE switched on
            # the text-mode (non-kiosk) wipe, which is retired (owner decision
            # D9, reversible): it duplicated the whole erase ladder and merged
            # every drive into one result, so it could not say which drive was
            # wiped how. Wiping is done from this screen, one record per drive.
            # A stale page that still sends the field is ignored, not obeyed.

            if pin_want and not pin_ok:
                return self._send(403, {"message": "Admin PIN required."})
            if risky and not pin_want:
                return self._send(403, {"message": (
                    "Changing the %s needs an admin PIN, and this stick has none. "
                    "Set AUDIT_ADMIN_PIN in audit.conf on the stick, from Windows."
                    % " and ".join(risky))})
            if "server address" in risky:
                ok, why = allowed_api_url(body["serverUrl"])
                if not ok:
                    return self._send(400, {"message": why})
            updates = {}
            if "wifiSsid" in body:
                updates["WIFI_SSID"] = body["wifiSsid"]
            if body.get("wifiPassword"):
                updates["WIFI_PASSWORD"] = body["wifiPassword"]
            if "serverUrl" in body and body["serverUrl"]:
                updates["AUDIT_URL"] = body["serverUrl"]
            # AUDIT_WIPE_METHOD stays: it is the default method /api/wipe/start
            # uses when the screen does not name one.
            if body.get("wipeMethod"):
                updates["AUDIT_WIPE_METHOD"] = body["wipeMethod"]
            if "imageServer" in body:
                updates["IMAGE_SERVER"] = str(body["imageServer"] or "").strip()
            # Checked BEFORE anything is written or re-mounted: a value with a
            # line break would add settings of its own (conf_value_problem).
            # A 400 with the reason, and nothing saved - not a 500.
            for val in updates.values():
                why = conf_value_problem(val)
                if why:
                    return self._send(400, {"message": why})
            if "IMAGE_SERVER" in updates:
                IMAGE_STATE["checked"] = 0.0        # re-evaluate immediately
                threading.Thread(target=lambda: mount_image_server(force=True),
                                 daemon=True).start()
            err = save_conf(updates)
            if err:
                return self._send(500, {"message": err})
            return self._send(200, {"saved": True})

        if u.path == "/api/power":
            # Deliberately NOT fail-closed. Shutting down at the end of a job
            # is an operator's normal action, and a stick with no PIN must keep
            # its power button. The PIN here is only extra friction when one is
            # configured - it is not the security boundary settings are.
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
    # Once, here - never on the reloads after each save, or one allowed change
    # would widen what the kiosk may switch to next.
    BOOT_API_HOST["host"] = urlparse(STATE["conf"].get("AUDIT_URL", "") or "").hostname
    # Correct the clock BEFORE logging in (a wrong date breaks HTTPS), but do it
    # on a background thread: these are network calls with timeouts, and blocking
    # here would stop the web server from listening — the kiosk browser opens
    # within seconds and would show "unable to connect".
    def boot():
        # First, before the capture that makes a new wipe possible: file any
        # wipe the previous run of this process started and never recorded.
        # queue_worker / the login in refresh() upload them.
        try:
            n = recover_pending_wipes()
            if n:
                print("recovered %d wipe record(s) left by a restart" % n)
        except Exception as exc:  # noqa: BLE001
            print("wipe recovery: %s" % exc)
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
    threading.Thread(target=write_boot_report, daemon=True).start()
    threading.Thread(target=queue_worker, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("ALS Audit Station GUI on http://127.0.0.1:%d  (engine: %s)" % (PORT, SCRIPT))
    srv.serve_forever()


if __name__ == "__main__":
    main()
