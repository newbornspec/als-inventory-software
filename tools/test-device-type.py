#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Laptop or desktop, and what happens when the battery cannot be measured.

The chassis type out of DMI settles this on most machines. When it is blank -
and on white-box and re-badged stock it often is - the battery decides, and it
used to decide on the battery's HEALTH PERCENTAGE. A laptop whose battery is
flat, removed, swollen, or reporting a design capacity of zero produces no
percentage, so it was filed as a Desktop.

That is not one wrong word in a field. Two things hang off it:

  * The asset record says Desktop, and a laptop sold as a desktop is a
    complaint, not a typo.
  * The built-in display capture below runs for laptops ONLY, so the machine
    also lost its screen size and resolution - and the operator sees a blank
    Display line rather than anything that says why.

The fix is to decide on the battery DEVICE being there, which is a fact about
the machine, rather than on a number that four ordinary conditions suppress.
This drives the real block, sliced out of hardware-audit.sh between its
DEVTYPE markers, against a fake /sys.

    python3 tools/test-device-type.py
"""
import io
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.join(HERE, "hardware-audit.sh")

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


def find_bash():
    cands = []
    if os.environ.get("ALS_BASH"):
        cands.append(os.environ["ALS_BASH"])
    found = shutil.which("bash")
    if found:
        cands.append(found)
    cands += [r"C:\Program Files\Git\bin\bash.exe",
              r"C:\Program Files (x86)\Git\bin\bash.exe"]
    for c in cands:
        if not c or not os.path.exists(c):
            continue
        try:
            r = subprocess.run([c, "-c", "echo ok"], capture_output=True, text=True, timeout=30)
        except Exception:  # noqa: BLE001
            continue
        if r.returncode == 0 and "ok" in r.stdout:
            return c
    return None


BASH = find_bash()
if not BASH:
    print("no working bash found - cannot drive the engine's shell block")
    sys.exit(1)

engine_src = read(ENGINE)
m = re.search(r"^# --- DEVTYPE-BEGIN.*?\n(.*?)^# --- DEVTYPE-END", engine_src, re.S | re.M)
BLOCK = m.group(1) if m else None
check("the DEVTYPE block can be sliced out of hardware-audit.sh", bool(BLOCK))
if not BLOCK:
    sys.exit(1)

TMP = tempfile.mkdtemp(prefix="als-devtype-test-")


def sysroot(name, batteries=None):
    """A fake /sys. batteries is a dict of BATn -> {file: contents}; None means
    the power_supply directory has no battery in it at all."""
    root = os.path.join(TMP, name)
    d = os.path.join(root, "sys", "class", "power_supply")
    os.makedirs(d)
    for bat, files in (batteries or {}).items():
        bd = os.path.join(d, bat)
        os.makedirs(bd)
        for k, v in files.items():
            with io.open(os.path.join(bd, k), "w", encoding="utf-8", newline="\n") as fh:
                fh.write(v)
    return root.replace("\\", "/")


def run(root, chassis=""):
    script = os.path.join(TMP, "case.sh")
    body = "\n".join([
        "set -u",
        'LOCK_SYSROOT="%s"' % root,
        'DEVICE_TYPE="%s"' % chassis,
        BLOCK,
        'printf "TYPE=%s\\n" "$DEVICE_TYPE"',
        'printf "HEALTH=%s\\n" "$BAT_HEALTH"',
        'printf "PRESENT=%s\\n" "$BAT_PRESENT"',
        'printf "STATUS=%s\\n" "$BAT_STATUS"',
    ])
    with io.open(script, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(body + "\n")
    r = subprocess.run([BASH, script], capture_output=True, timeout=120,
                       encoding="utf-8", errors="replace")
    out = {"TYPE": "", "HEALTH": "", "PRESENT": "", "STATUS": ""}
    for line in r.stdout.splitlines():
        k, _, v = line.partition("=")
        if k in out:
            out[k] = v
    check("the case ran cleanly (rc=%d)" % r.returncode,
          r.returncode == 0 and not r.stderr.strip(), r.stderr.strip()[:300])
    return out


HEALTHY = {"BAT0": {"energy_full": "45000000", "energy_full_design": "50000000",
                    "status": "Discharging", "cycle_count": "212"}}

print("1. a battery that answers")

r = run(sysroot("healthy", HEALTHY))
check("a healthy battery gives a percentage", r["HEALTH"] == "90%", r)
check("and the machine is a laptop", r["TYPE"] == "Laptop", r)

print("2. THE ONES THAT WERE CALLED DESKTOPS")

# Flat/worn out: design capacity reported as zero, so no percentage. Common on
# a machine that has been sitting in a pile for a year.
r = run(sysroot("zero-design", {"BAT0": {"energy_full": "0", "energy_full_design": "0",
                                         "status": "Unknown"}}))
check("a battery reporting zero capacity is still a laptop", r["TYPE"] == "Laptop", r)
check("and no percentage is invented for it", r["HEALTH"] == "", r)

# The bay is wired up and the pack is out. sysfs keeps the device.
r = run(sysroot("no-numbers", {"BAT0": {"status": "Unknown"}}))
check("a battery bay with no readable numbers is still a laptop",
      r["TYPE"] == "Laptop", r)
check("the battery is recorded as present even with nothing to measure",
      r["PRESENT"] == "1", r)

# Only the design capacity readable: a percentage needs both.
r = run(sysroot("half", {"BAT0": {"energy_full_design": "50000000"}}))
check("a half-readable battery is still a laptop", r["TYPE"] == "Laptop", r)
check("a half-readable battery yields no percentage", r["HEALTH"] == "", r)

# charge_* rather than energy_*: the other units sysfs uses.
r = run(sysroot("charge-units", {"BAT0": {"charge_full": "3000000",
                                          "charge_full_design": "4000000"}}))
check("a battery reporting charge_* instead of energy_* is measured too",
      r["HEALTH"] == "75%", r)
check("and is a laptop", r["TYPE"] == "Laptop", r)

print("3. a real desktop is still a desktop")

r = run(sysroot("desktop", None))
check("no battery device at all is a desktop", r["TYPE"] == "Desktop", r)
check("and nothing claims a battery is present", r["PRESENT"] == "", r)

# A UPS or a wireless mouse hangs off power_supply too, and is not a battery
# bay: only BAT* is counted.
r = run(sysroot("ups", {"ACAD": {"online": "1"}, "hidpp_battery_0": {"capacity": "70"}}))
check("a mains adapter and a mouse battery do not make a laptop",
      r["TYPE"] == "Desktop", r)

print("4. the chassis type still wins when it has one")

r = run(sysroot("chassis-desktop", HEALTHY), chassis="Desktop")
check("a chassis that says Desktop is not overruled by a battery",
      r["TYPE"] == "Desktop", r)
r = run(sysroot("chassis-laptop", None), chassis="Laptop")
check("a chassis that says Laptop is not overruled by a missing battery",
      r["TYPE"] == "Laptop", r)
r = run(sysroot("chassis-server", None), chassis="Server")
check("a server keeps its own chassis type", r["TYPE"] == "Server", r)

print("5. the rule, asserted against the source")

check("the device-type fallback is decided by the battery's PRESENCE",
      re.search(r'\[ -n "\$BAT_PRESENT" \] && DEVICE_TYPE="Laptop"', BLOCK) is not None, BLOCK)
check("and never by its health percentage",
      re.search(r'\[ -n "\$BAT_HEALTH" \] && DEVICE_TYPE=', BLOCK) is None, BLOCK)
# The built-in display capture is the thing that silently stopped running when
# this got it wrong, so the dependency is pinned here rather than left implicit.
check("the built-in display capture is the part that depends on this",
      re.search(r'\[ "\$DEVICE_TYPE" = "Laptop" \]', engine_src) is not None)

shutil.rmtree(TMP, ignore_errors=True)
print("\n%d passed, %d failed" % (PASS[0], len(FAIL)))
for f in FAIL:
    print("  FAILED: %s" % f)
sys.exit(1 if FAIL else 0)
