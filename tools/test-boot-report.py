#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Every boot leaves its timing on the stick - what it writes, when, and when
it must write nothing.

The report exists because the feedback loop was photographs of a screen. The
first version only wrote once systemd declared the boot finished, which on a
live system can be minutes - and the normal workflow is app up, audit, wipe,
power off. On a real boot it would never have been written, silently. These
tests pin the fix: an EARLY report the moment the app appears, a FINAL one only
if systemd finishes, and exactly one history row per boot either way.

Stubs only the edges (systemd, the timing collector, the stick write) and runs
the real report code.

    python3 tools/test-boot-report.py
"""
import importlib.util
import io
import os
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


EARLY_TIMING = {    # before systemd finishes: no blame, no chain yet
    "total": "Bootup is not yet finished. Please try again later.",
    "usb": "USB 2.0 (480 Mbps) - SLOW, try a socket on the BACK",
    "device": "/dev/sdb1", "blame": [], "chain": [],
    "layers": ["minimal.squashfs - xz, 128 KB blocks, 1.65 GB"],
    "plymouth": {"conf": "Theme=als", "theme": "present"},
}
FINAL_TIMING = dict(EARLY_TIMING,
                    total="Startup finished in 8.1s (kernel) + 41.6s (userspace) = 49.7s",
                    blame=["12.1s snapd.seeded.service"], chain=["graphical.target @41.6s"])


class Stick:
    """A temp dir standing in for /cdrom, recording every write."""

    def __init__(self):
        self.dir = tempfile.mkdtemp()
        self.writes = []

    def write(self, path, text):
        self.writes.append(os.path.basename(path))
        with open(path, "w") as fh:
            fh.write(text)
        return None

    def read(self, name):
        try:
            with open(os.path.join(self.dir, name)) as fh:
                return fh.read()
        except OSError:
            return ""


def setup(stick, timing, md5="SKIPPED (fsck.mode=skip honoured)", on_media=True):
    srv.CONF_PATH = os.path.join(stick.dir, "audit.conf")
    srv.write_boot_file = stick.write
    srv.boot_timing = lambda: timing
    srv.md5check_state = lambda: md5
    srv.on_boot_media = lambda: on_media
    srv.time.sleep = lambda s: None
    srv.REPORT_STATE["history_written"] = False
    srv.APP_READY["uptime"] = 58.4


ORIG = (srv.CONF_PATH, srv.write_boot_file, srv.boot_timing, srv.md5check_state,
        srv.on_boot_media, srv.time.sleep, srv._analyze)

print("early report - the one that must always happen")
st = Stick()
setup(st, EARLY_TIMING)
srv.report_now(False)
rep = st.read("boot-report.txt")
check("written at app-ready, before systemd finishes", bool(rep))
check("says it is the EARLY report", "stage     : EARLY" in rep, rep[:400])
check("leads with APP READY", "APP READY : 58s after the kernel started" in rep)
check("carries the USB link", "USB 2.0 (480 Mbps)" in rep)
check("says whether the self-check was skipped", "self-check: SKIPPED (fsck.mode=skip honoured)" in rep)
check("is honest that blame is not available yet", "(not available until the boot finishes)" in rep)
check("never contains credentials", "PASSWORD" not in rep.upper() and "TOKEN" not in rep.upper())
hist = [r for r in st.read("boot-history.csv").splitlines() if r.strip()]
check("history: header plus one row", len(hist) == 2 and hist[0].startswith("when,machine"), hist)
check("history row has app-ready seconds", len(hist) == 2 and ",58," in hist[1], hist)

print("final report - only if the machine stays up")
srv.boot_timing = lambda: FINAL_TIMING
srv.report_now(True)
rep = st.read("boot-report.txt")
check("replaces the early report", "stage     : final" in rep, rep[:300])
check("now carries systemd's accounting", "snapd.seeded.service" in rep and "Startup finished" in rep)
hist2 = [r for r in st.read("boot-history.csv").splitlines() if r.strip()]
check("history NOT duplicated by the final report", len(hist2) == 2, hist2)

print("the case this rewrite exists for")
# Powered off before systemd finished: write_boot_report() polls, never sees
# "Startup finished", and must NOT overwrite the early report with a partial
# one - nor append a second history row.
st2 = Stick()
setup(st2, EARLY_TIMING)
srv.report_now(False)                    # the early report, from mark_app_ready
before = st2.read("boot-report.txt")
st2.writes.clear()
srv._analyze = lambda args, timeout=8: "Bootup is not yet finished."
srv.write_boot_report()                  # ten minutes of polling, stubbed
check("never finished: the early report still stands", st2.read("boot-report.txt") == before and "EARLY" in before)
check("never finished: nothing further written", st2.writes == [], st2.writes)

print("where it must write nothing")
st3 = Stick()
setup(st3, EARLY_TIMING, on_media=False)
srv.report_now(False)
srv.report_now(True)
check("not on boot media (a dev checkout): nothing written", st3.writes == [], st3.writes)
srv._analyze = lambda args, timeout=8: "systemd-analyze unavailable: [WinError 2]"
srv.on_boot_media = lambda: True
srv.write_boot_report()
check("no systemd at all: the final path writes nothing", st3.writes == [], st3.writes)

print("the self-check line tells the story")
st4 = Stick()
setup(st4, EARLY_TIMING, md5="RUNNING - re-reading 5.9 GB of the stick right now")
srv.report_now(False)
check("a running self-check is called out", "RUNNING - re-reading 5.9 GB" in st4.read("boot-report.txt"))

print("app-ready is the FIRST serve, and fires one early report")
spawned = []
real_thread = srv.threading.Thread


class FakeThread:
    def __init__(self, target=None, args=(), daemon=None):
        spawned.append((target, args))

    def start(self):
        pass


srv.threading.Thread = FakeThread
orig_open = open


def fake_open(path, *a, **k):
    if path == "/proc/uptime":
        return io.StringIO("42.5 100.0")
    return orig_open(path, *a, **k)


srv.open = fake_open
try:
    srv.APP_READY["uptime"] = None
    srv.mark_app_ready()
    srv.mark_app_ready()        # a reload
    srv.mark_app_ready()        # another
finally:
    del srv.open
    srv.threading.Thread = real_thread
check("records the first serve only", srv.APP_READY["uptime"] == 42.5, srv.APP_READY)
check("fires exactly one early report", len(spawned) == 1 and spawned[0][1] == (False,), spawned)

(srv.CONF_PATH, srv.write_boot_file, srv.boot_timing, srv.md5check_state,
 srv.on_boot_media, srv.time.sleep, srv._analyze) = ORIG

print("")
print("%d passed, %d failed" % (PASS[0], len(FAIL)))
sys.exit(1 if FAIL else 0)
