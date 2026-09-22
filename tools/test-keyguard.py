#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""The keys the browser is never offered, and what the station does about them.

Reported from the bench: during the hardware test's keyboard check - where the
technician is told, in as many words, to press EVERY key on the machine - a
Lenovo dropped out of the kiosk and the screen went black.

Three different kinds of key can do that, and only one of them is the page's to
catch:

1. Keys the browser is offered and can cancel: Escape, the F row as browser
   shortcuts, Ctrl+W, Ctrl+R. The page's own guard handles those; they are
   proved in test-hwtest-keyboard.py.
2. Keys the X SERVER acts on before any client sees them: Ctrl+Alt+F1..F12
   switches virtual terminal and the kiosk is simply gone; Ctrl+Alt+Backspace
   ends the session. No web page can cancel either. Disabled per-session in the
   kiosk's own X session, asserted here against the source.
3. Keys the MACHINE acts on in firmware or in the kernel: brightness, display
   output, aeroplane mode. Nothing in userspace is offered a veto at all, so
   the only honest answer is to put the state back afterwards - which is what
   the station's key guard does, and what this file mostly tests.

The rule the guard is held to, and the reason it needs a test of its own: it
writes to the machine. Only volatile state - the backlight and rfkill, both
cleared by a power cycle - never the disk. It restores what it found rather
than what it thinks is right, it never touches a radio the operator had already
turned off, and a sysfs read it could not make is never treated as a reading of
zero. A watchdog that cannot tell "the screen is dark" from "we could not read
the screen" would be the same false-absence bug it exists to survive.

    python3 tools/test-keyguard.py
"""
import importlib.util
import io
import os
import re
import shutil
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SESSION = os.path.join(HERE, "gui", "layer", "als-session.sh")
PAGE = os.path.join(HERE, "gui", "index.html")

spec = importlib.util.spec_from_file_location("als_server_kg", os.path.join(HERE, "gui", "server.py"))
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


def read(path):
    with io.open(path, encoding="utf-8") as fh:
        return fh.read()


TMP = tempfile.mkdtemp(prefix="als-keyguard-")


def sysroot(name, backlights=None, rfkills=None):
    """A fake /sys. backlights: {name: (brightness, max)}; a max of None leaves
    the max_brightness file out. rfkills: {name: soft}."""
    root = os.path.join(TMP, name)
    for dev, vals in (backlights or {}).items():
        d = os.path.join(root, "class", "backlight", dev)
        os.makedirs(d)
        cur, mx = vals
        if cur is not None:
            io.open(os.path.join(d, "brightness"), "w").write("%s\n" % cur)
        if mx is not None:
            io.open(os.path.join(d, "max_brightness"), "w").write("%s\n" % mx)
    for dev, soft in (rfkills or {}).items():
        d = os.path.join(root, "class", "rfkill", dev)
        os.makedirs(d)
        io.open(os.path.join(d, "soft"), "w").write("%s\n" % soft)
    return root


def bl(root, dev):
    return int(read(os.path.join(root, "class", "backlight", dev, "brightness")).strip())


def rf(root, dev):
    return int(read(os.path.join(root, "class", "rfkill", dev, "soft")).strip())


def settle(seconds=2.5):
    """Let the watchdog thread run. It polls at KEYGUARD_POLL_S."""
    time.sleep(seconds)


REAL_SYS = srv.SYS_ROOT
srv.KEYGUARD_POLL_S = 0.05


def arm(root):
    srv.SYS_ROOT = root
    return srv.keyguard_arm()


def disarm():
    acted = srv.keyguard_disarm()
    settle(0.2)
    srv.SYS_ROOT = REAL_SYS
    return acted


print("1. the backlight a key drove to nothing")

root = sysroot("dark", backlights={"intel_backlight": (850, 1000)})
watching = arm(root)
check("arming reports what it is actually watching", watching["backlights"] == 1, watching)
# The key the browser never saw: the panel goes to zero.
io.open(os.path.join(root, "class", "backlight", "intel_backlight", "brightness"), "w").write("0\n")
settle()
check("a backlight driven to zero is put back", bl(root, "intel_backlight") == 850,
      bl(root, "intel_backlight"))
acted = disarm()
check("and the station can say what it did", any("brightness" in a for a in acted), acted)
check("...in words a technician can read, with no sysfs paths in them",
      acted and "/sys" not in acted[0] and "backlight" not in acted[0], acted)

# Restored to what the technician had, never to full: a machine handed over at
# 40% is handed back at 40%.
root = sysroot("dim", backlights={"acpi_video0": (400, 1000)})
arm(root)
io.open(os.path.join(root, "class", "backlight", "acpi_video0", "brightness"), "w").write("2\n")
settle()
check("it restores what it FOUND, not what it thinks is right",
      bl(root, "acpi_video0") == 400, bl(root, "acpi_video0"))
disarm()

# A dim-but-usable screen is the technician's business, not the guard's.
root = sysroot("ok", backlights={"intel_backlight": (900, 1000)})
arm(root)
io.open(os.path.join(root, "class", "backlight", "intel_backlight", "brightness"), "w").write("500\n")
settle()
check("a screen that is merely dimmer is left alone", bl(root, "intel_backlight") == 500,
      bl(root, "intel_backlight"))
disarm()

print("2. a read it could not make is not a screen at zero")

# THE RULE THIS SHARES WITH THE REST OF THE STATION: a failed read must never be
# acted on as a value. A brightness file that will not parse is not a dark
# screen, and writing to the panel because a read failed would be inventing a
# fault on the customer's machine.
root = sysroot("unreadable", backlights={"intel_backlight": (700, 1000)})
arm(root)
io.open(os.path.join(root, "class", "backlight", "intel_backlight", "brightness"), "w").write("junk\n")
settle()
check("a brightness that will not parse is left alone, not 'restored'",
      read(os.path.join(root, "class", "backlight", "intel_backlight", "brightness")).strip() == "junk",
      "")
acted = disarm()
check("and nothing is claimed to have been done", acted == [], acted)

# No max_brightness: there is no scale, so there is no floor and no judgement.
root = sysroot("nomax", backlights={"intel_backlight": (0, None)})
watching = arm(root)
check("a backlight with no scale is not watched at all", watching["backlights"] == 0, watching)
disarm()

# No backlight at all - a desktop. Nothing to watch, and it says so rather than
# implying it is covering something.
root = sysroot("desktop")
watching = arm(root)
check("a machine with no backlight reports none watched",
      watching["backlights"] == 0 and watching["radios"] == 0, watching)
disarm()

print("3. the aeroplane-mode key")

root = sysroot("radio", rfkills={"rfkill0": 0, "rfkill1": 0})
watching = arm(root)
check("both live radios are watched", watching["radios"] == 2, watching)
io.open(os.path.join(root, "class", "rfkill", "rfkill0", "soft"), "w").write("1\n")
settle()
check("a radio switched off by a key is switched back on", rf(root, "rfkill0") == 0,
      rf(root, "rfkill0"))
acted = disarm()
check("and the station can say so", any("radio" in a for a in acted), acted)

# A radio the OPERATOR had already turned off is theirs. Turning it back on
# would be this tool making a decision nobody asked it to make.
root = sysroot("operator-off", rfkills={"rfkill0": 1})
watching = arm(root)
check("a radio already off before the test is not watched", watching["radios"] == 0, watching)
settle(0.3)
check("...and is left off", rf(root, "rfkill0") == 1, rf(root, "rfkill0"))
disarm()

print("4. it lets go")

root = sysroot("release", backlights={"intel_backlight": (800, 1000)})
arm(root)
disarm()
io.open(os.path.join(root, "class", "backlight", "intel_backlight", "brightness"), "w").write("0\n")
settle()
check("once disarmed it stops touching the machine", bl(root, "intel_backlight") == 0,
      bl(root, "intel_backlight"))

# A browser that goes away must not leave a root thread writing to the machine
# for the rest of the day.
check("it has an absolute timeout, so a page that vanishes cannot leave it armed",
      isinstance(srv.KEYGUARD_MAX_S, int) and 0 < srv.KEYGUARD_MAX_S <= 2 * 3600,
      srv.KEYGUARD_MAX_S)
root = sysroot("expired", backlights={"intel_backlight": (800, 1000)})
arm(root)
srv.KEYGUARD["until"] = time.time() - 1       # as if the deadline had passed
settle()
io.open(os.path.join(root, "class", "backlight", "intel_backlight", "brightness"), "w").write("0\n")
settle()
check("an expired guard stops writing", bl(root, "intel_backlight") == 0,
      bl(root, "intel_backlight"))
check("...and marks itself off", srv.KEYGUARD["on"] is False, srv.KEYGUARD["on"])
disarm()

# Arming twice must not leave two threads writing to the same panel.
root = sysroot("twice", backlights={"intel_backlight": (800, 1000)})
before = len([t for t in __import__("threading").enumerate() if t.is_alive()])
arm(root)
arm(root)
after = len([t for t in __import__("threading").enumerate() if t.is_alive()])
check("arming twice starts one watcher, not two", after - before <= 1, (before, after))
disarm()

print("5. the machine's disk is never touched")

kg = read(os.path.join(HERE, "gui", "server.py"))
block = kg[kg.index("the hardware test's key guard"):kg.index("OPTICAL_CACHE = []")]
writes = [l.strip() for l in block.splitlines() if re.search(r'open\([^)]*"w"', l)]
check("the guard's only writes go through one helper", len(writes) == 1, writes)
check("...and that helper is _kg_write_int, so every write is one sysfs integer",
      len(writes) == 1
      and re.search(r"def _kg_write_int\(path, value\):\s*\n\s*try:\s*\n\s*with open\(path, \"w\"\)",
                    block) is not None, writes)
# Every call site of it, so a second writer cannot be added without this failing.
callers = sorted(set(re.findall(r"_kg_write_int\(os\.path\.join\((\w+), \"([^\"]+)\"\)", block)))
check("the only things ever written are brightness and rfkill soft",
      [c[1] for c in callers] == ["brightness", "soft"], callers)
paths = re.findall(r'os\.path\.join\(SYS_ROOT, "([^"]+)"', block)
check("it only ever addresses /sys/class/backlight and /sys/class/rfkill",
      set(paths) == {"class"}, sorted(set(paths)))
# The disk, a device node, and anything that could run a command or remove a
# file. ("block" on its own would match the word soft-blocked in a comment, so
# the sysfs disk tree is named as the path it would actually be.)
for forbidden in ("/dev/", '"block"', "/sys/block", "subprocess", "os.remove",
                  "os.unlink", "shutil", "mount"):
    check("the guard never reaches for %s" % forbidden, forbidden not in block, forbidden)

print("6. the X server's own keys (the kiosk session, needs a layer rebuild)")

ses = read(SESSION)
check("the kiosk session disables the VT-switch keys (Ctrl+Alt+F1..F12)",
      "srvrkeys:none" in ses, "")
# There is no "terminate:none" to ask for - terminate is the option GROUP and
# ctrl_alt_bksp its only member - so zap is cleared by wiping the machine's
# existing options first. An empty -option before srvrkeys:none is what does it,
# and it has to come first or it would wipe the one we just set.
opts = re.findall(r"setxkbmap((?:\s+-option\s+(?:''|[\w:]+))+)", ses)
check("...and the zap key (Ctrl+Alt+Backspace), by clearing the inherited options",
      opts and opts[0].split().index("''") < opts[0].split().index("srvrkeys:none"),
      opts)
check("it is guarded, so a machine without setxkbmap still boots",
      "command -v setxkbmap" in ses, "")
check("...and says in the log when it could not do it",
      re.search(r"setxkbmap not present", ses) is not None, "")
# Contract 1 of that file: with the kiosk off, the session behaves exactly as
# Ubuntu does. So the key options must sit BELOW the off switch.
off = ses.index('if [ "$KIOSK" != "on" ]')
check("the key options only apply when the kiosk is actually on",
      ses.index("srvrkeys:none") > off, "")

print("7. the page arms and releases it with the board")

page = read(PAGE)
check("the page arms the guard when the keyboard board appears",
      re.search(r"jpost\('/api/keyguard',\{on:true\}\)", page) is not None, "")
check("...and releases it when the panel goes",
      re.search(r"jpost\('/api/keyguard',\{on:false\}\)", page) is not None, "")
check("a station that cannot arm it still runs the test",
      re.search(r"try\{\s*jpost\('/api/keyguard',\{on:true\}\)", page) is not None, "")
# The technician is told what the software cannot do for them - contract C6 §17,
# no pretending the browser can control hardware it cannot.
check("the instructions say which keys the laptop itself handles",
      "handled by the laptop itself" in page, "")
check("...and what to do if one of them dims the screen",
      "brightness-up" in page and "Nothing is lost" in page, "")

shutil.rmtree(TMP, ignore_errors=True)
print("\n%d passed, %d failed" % (PASS[0], len(FAIL)))
for f in FAIL:
    print("  FAILED: %s" % f)
sys.exit(1 if FAIL else 0)
