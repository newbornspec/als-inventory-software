#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Every boot leaves its timing on the stick - check what it writes, and when
it must write nothing.

The report exists because the feedback loop was photographs of a screen: the
wrong screen, text too small to read, a round trip per question. The stick
comes back to Windows to be synced anyway, so it carries the numbers instead.

Stubs only the edges - systemd-analyze, the timing collector and the stick
write - and runs the real write_boot_report().

    python3 tools/test-boot-report.py
"""
import importlib.util
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


TIMING = {
    "total": "Startup finished in 8.1s (kernel) + 41.6s (userspace) = 49.7s",
    "usb": "USB 2.0 (480 Mbps) - SLOW, try a socket on the BACK",
    "device": "/dev/sdb1",
    "blame": ["177.004s casper-md5check.service", "12.1s snapd.seeded.service"],
    "chain": ["graphical.target @41.6s"],
    "layers": ["minimal.squashfs - xz, 128 KB blocks, 1.65 GB"],
    "plymouth": {"conf": "Theme=als", "theme": "present",
                 "module": "two-step.so present",
                 "initramfs": "/run/initramfs does not exist"},
}


def run(analyze_reply, ready):
    tmp = tempfile.mkdtemp()
    written = {}

    def fake_write(path, text):
        written[os.path.basename(path)] = text
        with open(path, "w") as fh:
            fh.write(text)
        return None

    saved = (srv._analyze, srv.boot_timing, srv.write_boot_file, srv.CONF_PATH,
             srv.time.sleep, dict(srv.APP_READY))
    try:
        srv._analyze = lambda args, timeout=8: analyze_reply
        srv.boot_timing = lambda: TIMING
        srv.write_boot_file = fake_write
        srv.CONF_PATH = os.path.join(tmp, "audit.conf")
        srv.time.sleep = lambda s: None
        srv.APP_READY["uptime"] = ready
        srv.write_boot_report()
        return written, tmp
    finally:
        (srv._analyze, srv.boot_timing, srv.write_boot_file, srv.CONF_PATH,
         srv.time.sleep, apr) = saved
        srv.APP_READY.clear()
        srv.APP_READY.update(apr)


print("boot report")

w, tmp = run("Startup finished in 8.1s (kernel) + 41.6s (userspace) = 49.7s", 58.4)
rep = w.get("boot-report.txt", "")
check("writes boot-report.txt", bool(rep))
check("leads with APP READY in seconds", "APP READY : 58s after the kernel started" in rep, rep[:300])
check("carries the USB link", "USB 2.0 (480 Mbps)" in rep)
check("names the self-check and its cost", "md5check  : 177.004s" in rep, rep)
check("includes the slowest units", "snapd.seeded.service" in rep)
check("includes the splash diagnosis", "Theme=als" in rep)
check("never contains credentials", "PASSWORD" not in rep.upper() and "TOKEN" not in rep.upper())

hist = w.get("boot-history.csv", "")
rows = [r for r in hist.splitlines() if r.strip()]
check("history gets a header and one row", len(rows) == 2 and rows[0].startswith("when,machine"), rows)
check("history row carries app-ready seconds", len(rows) == 2 and ",58," in rows[1], rows)

# A second boot appends; it does not overwrite the history.
with open(os.path.join(tmp, "boot-history.csv"), "w") as fh:
    fh.write(hist)
saved_conf = srv.CONF_PATH


def second():
    written = {}

    def fake_write(path, text):
        written[os.path.basename(path)] = text
        return None
    old = (srv._analyze, srv.boot_timing, srv.write_boot_file, srv.CONF_PATH, srv.time.sleep)
    try:
        srv._analyze = lambda args, timeout=8: "Startup finished in 1s"
        srv.boot_timing = lambda: TIMING
        srv.write_boot_file = fake_write
        srv.CONF_PATH = os.path.join(tmp, "audit.conf")
        srv.time.sleep = lambda s: None
        srv.APP_READY["uptime"] = 31.0
        srv.write_boot_report()
    finally:
        (srv._analyze, srv.boot_timing, srv.write_boot_file, srv.CONF_PATH, srv.time.sleep) = old
    return written


w2 = second()
rows2 = [r for r in w2.get("boot-history.csv", "").splitlines() if r.strip()]
check("second boot appends a row, keeps the first", len(rows2) == 3 and ",58," in rows2[1] and ",31," in rows2[2], rows2)

# Not a live system (a dev checkout on Windows): write NOTHING. Without the
# guard it waited ten minutes, then wrote a report into the repository.
w, _ = run("systemd-analyze unavailable: [WinError 2]", 10.0)
check("dev machine: writes nothing at all", w == {}, list(w))

# The page never loaded - report it plainly rather than as a zero.
w, _ = run("Startup finished in 1s", None)
check("app never served: says so, not 0s",
      "not reached (the page was never served)" in w.get("boot-report.txt", ""), w.get("boot-report.txt", "")[:200])

# mark_app_ready keeps the FIRST time the page was served. Every later reload
# must not move it, or a browser refresh would rewrite the boot time.
srv.APP_READY["uptime"] = None
orig_open = open


def fake_uptime(path, *a, **k):
    if path == "/proc/uptime":
        import io
        return io.StringIO("42.5 100.0")
    return orig_open(path, *a, **k)


srv.open = fake_uptime
try:
    srv.mark_app_ready()
    first = srv.APP_READY["uptime"]
    srv.mark_app_ready()
    srv.mark_app_ready()
finally:
    del srv.open
check("app-ready records the first serve only", first == 42.5 and srv.APP_READY["uptime"] == 42.5,
      srv.APP_READY)

print("")
print("%d passed, %d failed" % (PASS[0], len(FAIL)))
sys.exit(1 if FAIL else 0)
