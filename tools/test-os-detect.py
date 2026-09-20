#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""The installed operating system, read offline out of the machine's own registry.

The station boots its OWN Linux, so it never sees the installed Windows. The
lock checks already mount that Windows volume READ-ONLY and read its hives with
hivex (that is how Autopilot and BitLocker are found), and hardware-audit.sh now
borrows the same machinery to fill in the asset page's Operating System card.

This drives the real functions - sliced straight out of hardware-audit.sh
between its OS-DETECT markers and run against fixtures - so every honest outcome
is exercised on a machine that has none of them:

1. A READABLE WINDOWS. ProductName/EditionID composed into one name, the feature
   update from DisplayVersion (falling back to ReleaseId), CurrentBuild with the
   UBR appended, the product id, the install epoch turned into a plain date, and
   the architecture out of the SYSTEM hive. Including the registry quirk that
   makes a fully patched Windows 11 call itself "Windows 10 Pro".
2. NO OPERATING SYSTEM. A wiped machine must say so - it is true, and it is the
   thing the operator most wants confirmed - and must say so ONLY when the disks
   were actually examined and carry nothing that could hold a system.
3. BITLOCKER. Windows is there and cannot be read without the recovery key.
4. NO TOOL / NO ROOT / NO lock-checks.sh. Each says what is missing and what to
   do about it, and none of them is ever confused with "no Windows here".
5. A LINUX INSTALL, taken from an already-mounted root's /etc/os-release - and
   never from the station's own "/", which is the one mistake that would report
   our Ubuntu as the customer's operating system.

Plus the two rules that make this safe to point at a customer's disk, asserted
against the source itself: the disk is mounted READ-ONLY and only by
lock-checks.sh, and every read of it runs under a timeout. And the house rule:
the word "Unknown" appears in no output and in no string the operator can see.

The four smaller rows that ship with it are covered here too, because they have
no other way to be proved: the EDID refresh rate (computed field by field from a
base block laid out to the spec), the touchscreen answer (INPUT_PROP_DIRECT, and
NOT a touchpad or a pen), the base clock's source, and the rule that a GPU's
video memory is either read or absent - never taken from a PCI BAR size.

    python3 tools/test-os-detect.py
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ENGINE = os.path.join(HERE, "hardware-audit.sh")
LOCKS = os.path.join(HERE, "lock-checks.sh")
API_TYPE = os.path.join(ROOT, "apps", "api", "src", "devices", "hardware-profile.type.ts")
WEB_CARD = os.path.join(ROOT, "apps", "web", "app", "assets", "[id]", "hardware-section.tsx")

PASS, FAIL = [0], []


def check(name, cond, detail=""):
    if cond:
        PASS[0] += 1
        print("  ok   %s" % name)
    else:
        FAIL.append(name)
        print("  FAIL %s   %s" % (name, detail))


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


# --------------------------------------------------------------------------
# A bash that actually works. On the CI runner this is just "bash"; on a
# Windows dev box "bash" resolves to a WSL stub that cannot execute, so Git
# Bash is located explicitly rather than letting every case fail for a reason
# that has nothing to do with the code.
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
        except Exception:
            continue
        if r.returncode == 0 and "ok" in r.stdout:
            return c
    return None


BASH = find_bash()
if not BASH:
    print("no working bash found - cannot drive the engine's shell functions")
    sys.exit(1)


# --------------------------------------------------------------------------
# The code under test, taken from the engine rather than retyped: a copy here
# would keep passing after the engine changed underneath it.
engine_src = read(ENGINE)

m = re.search(r"^# --- OS-DETECT-BEGIN.*?\n(.*?)^# --- OS-DETECT-END", engine_src, re.S | re.M)
OS_BLOCK = m.group(1) if m else None
check("the OS-DETECT block can be sliced out of hardware-audit.sh", bool(OS_BLOCK))
if not OS_BLOCK:
    sys.exit(1)

m = re.search(r"^pval\(\) \{.*\}$", engine_src, re.M)
PVAL = m.group(0) if m else None
check("pval() (the lsblk -P parser the block reuses) can be sliced out", bool(PVAL))
if not PVAL:
    sys.exit(1)

TMP = tempfile.mkdtemp(prefix="als-os-test-")
BIN = os.path.join(TMP, "bin")
os.makedirs(BIN)


def w(path, text, executable=False):
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    if executable:
        os.chmod(path, 0o755)
    return path


# A stand-in for hivexget that answers from a fixture table instead of a hive:
#   <hive basename>TAB<key>TAB<value>TAB<what hivexget would print>
# Missing rows exit non-zero, exactly as hivexget does for an absent value.
#
# The key path goes in through the ENVIRONMENT, not through `awk -v`: -v runs
# its value through escape processing, so a registry path arrives as
# "MicrosoftWindows NTCurrentVersion" and nothing ever matches.
w(os.path.join(BIN, "hivexget"), """#!/bin/sh
ALS_H=$(basename "$1"); ALS_K="$2"; ALS_V="$3"
export ALS_H ALS_K ALS_V
awk -F '\\t' '
  $1==ENVIRON["ALS_H"] && $2==ENVIRON["ALS_K"] && $3==ENVIRON["ALS_V"] { print $4; found=1 }
  END { exit (found ? 0 : 1) }
' "$ALS_FAKE_HIVE"
""", executable=True)

FIELDS = ["os", "osVersion", "osBuild", "osArchitecture", "osProductId", "osInstalledOn"]


def run_case(setup, hive_rows=None, source_locks=True, hivexget=True):
    """Run als_read_installed_os with `setup` deciding what the machine looks
    like, and return the six fields as a dict."""
    hive_file = os.path.join(TMP, "hive-rows.tsv")
    w(hive_file, "".join("\t".join(r) + "\n" for r in (hive_rows or [])))

    parts = ["set -u", 'export ALS_FAKE_HIVE="%s"' % hive_file.replace("\\", "/")]
    if hivexget:
        # cd/pwd rather than the literal path: on Windows the stub lives at
        # C:/... and bash's PATH needs the /c/... form. This works unchanged on
        # the Linux runner.
        parts.append('PATH="$(cd "%s" && pwd):$PATH"' % BIN.replace("\\", "/"))
    if source_locks:
        parts.append('. "%s"' % LOCKS.replace("\\", "/"))
        # The fixtures ARE the "we can read this" case. Simulate root so the
        # privilege gate does not short-circuit the logic under test; the gate
        # itself is asserted separately below, where it belongs.
        parts.append("LOCK_IS_ROOT=1")
    parts.append(PVAL)
    parts.append(OS_BLOCK)
    parts.append(setup)
    parts.append("als_read_installed_os")
    for f, var in zip(FIELDS, ["OS_NAME", "OS_VERSION", "OS_BUILD", "OS_ARCH",
                               "OS_PRODUCT_ID", "OS_INSTALLED_ON"]):
        parts.append("printf '%%s=%%s\\n' %s \"$%s\"" % (f, var))

    script = w(os.path.join(TMP, "case.sh"), "\n".join(parts) + "\n")
    # encoding, explicitly: the engine's sentences carry em dashes, and decoding
    # them with a Windows console codepage would fail every comparison here for
    # a reason that has nothing to do with the code.
    r = subprocess.run([BASH, script], capture_output=True, timeout=120,
                       encoding="utf-8", errors="replace")
    # Every field defaults to empty, so a case that dies halfway shows up as a
    # wrong ANSWER in the assertion below rather than as a KeyError that hides
    # which rule was actually broken.
    out = dict.fromkeys(FIELDS, "")
    for line in r.stdout.splitlines():
        if "=" in line:
            k, _, v = line.partition("=")
            if k in FIELDS:
                out[k] = v
    out["_stderr"] = r.stderr.strip()
    out["_rc"] = r.returncode
    check("the case script ran cleanly (rc=%d)" % r.returncode,
          r.returncode == 0 and not r.stderr.strip(), r.stderr.strip()[:400])
    return out


ALL_OUTPUT = []


def fields_of(res):
    return [res.get(f, "") for f in FIELDS]


def record(res):
    ALL_OUTPUT.extend(fields_of(res))
    return res


# Two empty files standing in for the hives: als_os_hive checks the hive is
# READABLE before it runs hivexget, and the fake hivexget answers from the
# table, not from the file.
SOFT = w(os.path.join(TMP, "SOFTWARE"), "")
SYSH = w(os.path.join(TMP, "SYSTEM"), "")
HIVES_FOUND = ('lock_locate_hives() { WIN_SOFTWARE="%s"; WIN_SYSTEM="%s"; return 0; }'
               % (SOFT.replace("\\", "/"), SYSH.replace("\\", "/")))
CV = r"Microsoft\Windows NT\CurrentVersion"
ENV_KEY = r"ControlSet001\Control\Session Manager\Environment"


def win(**kw):
    """Fixture rows for a Windows install; only the keys given are present."""
    rows = []
    for key, val in kw.items():
        rows.append(("SOFTWARE", CV, key, val))
    return rows


print("1. a readable Windows install")

WIN11 = win(ProductName="Windows 10 Pro", EditionID="Professional",
            DisplayVersion="23H2", CurrentBuild="22631", UBR="2861",
            ProductId="00330-80000-00000-AA123", InstallDate="1700000000")
WIN11.append(("SYSTEM", ENV_KEY, "PROCESSOR_ARCHITECTURE", "AMD64"))
r = record(run_case(HIVES_FOUND, WIN11))
# Microsoft never updated ProductName for Windows 11; the build is the only
# registry value that says otherwise, and both halves were READ.
check("Windows 11: named 11, not the 10 the registry still calls it",
      r["os"] == "Windows 11 Pro", r)
check("Windows 11: feature update from DisplayVersion", r["osVersion"] == "23H2", r)
check("Windows 11: UBR appended to the build", r["osBuild"] == "22631.2861", r)
check("Windows 11: architecture from the SYSTEM hive", r["osArchitecture"] == "64-bit", r)
check("Windows 11: product id as read", r["osProductId"] == "00330-80000-00000-AA123", r)
check("Windows 11: install epoch converted to a date",
      r["osInstalledOn"] == "2023-11-14", r)

WIN10 = win(ProductName="Windows 10 Pro", EditionID="Professional",
            ReleaseId="22H2", CurrentBuildNumber="19045", UBR="3803")
r = record(run_case(HIVES_FOUND, WIN10))
check("Windows 10: left as Windows 10 (build is below 22000)",
      r["os"] == "Windows 10 Pro", r)
check("Windows 10: ReleaseId used when DisplayVersion is absent",
      r["osVersion"] == "22H2", r)
check("Windows 10: CurrentBuildNumber used when CurrentBuild is absent",
      r["osBuild"] == "19045.3803", r)
check("Windows 10: nothing invented for an architecture we never read",
      r["osArchitecture"] == "", r)
check("Windows 10: no install date invented", r["osInstalledOn"] == "", r)

# The edition is appended only when the product name does not already carry it.
r = record(run_case(HIVES_FOUND, win(ProductName="Windows 10", EditionID="Enterprise",
                                     CurrentBuild="19045")))
check("a bare product name takes the edition from EditionID",
      r["os"] == "Windows 10 Enterprise", r)
r = record(run_case(HIVES_FOUND, win(ProductName="Windows 10 Pro", EditionID="Professional",
                                     CurrentBuild="19045")))
check("an edition already in the product name is not repeated",
      r["os"] == "Windows 10 Pro", r)
r = record(run_case(HIVES_FOUND, win(ProductName="Windows 10", EditionID="Core",
                                     CurrentBuild="19045")))
check("EditionID Core reads as Home, the name Microsoft sells it under",
      r["os"] == "Windows 10 Home", r)
# A server: the product name already says Server, so only the tier is added -
# and here it is already there, so nothing is.
r = record(run_case(HIVES_FOUND, win(ProductName="Windows Server 2019 Standard",
                                     EditionID="ServerStandard", CurrentBuild="17763")))
check("a server is not given a second 'ServerStandard' on the end",
      r["os"] == "Windows Server 2019 Standard", r)
r = record(run_case(HIVES_FOUND, win(ProductName="Windows Server 2019",
                                     EditionID="ServerDatacenter", CurrentBuild="17763")))
check("a server with no tier in its name gets the tier from EditionID",
      r["os"] == "Windows Server 2019 Datacenter", r)
r = record(run_case(HIVES_FOUND, win(ProductName="Windows 10 IoT Enterprise",
                                     EditionID="IoTEnterprise", CurrentBuild="19044")))
check("an edition already spelled in the name, only without spaces, is not repeated",
      r["os"] == "Windows 10 IoT Enterprise", r)

# A build written as a REG_DWORD the older way must not reach the page raw.
r = record(run_case(HIVES_FOUND, win(ProductName="Windows 10 Pro", CurrentBuild="19045",
                                     UBR="dword:00000ecb")))
check("a dword: UBR is decoded, not printed as hivex wrote it",
      r["osBuild"] == "19045.3787", r)
r = record(run_case(HIVES_FOUND, win(ProductName="Windows 10 Pro", CurrentBuild="19045",
                                     UBR="not-a-number")))
check("a UBR that is not a number is dropped, not appended",
      r["osBuild"] == "19045", r)

# Out-of-range install dates: a truncated hive yields exactly these.
for epoch in ("0", "4294967295"):
    r = record(run_case(HIVES_FOUND, win(ProductName="Windows 10 Pro", CurrentBuild="19045",
                                         InstallDate=epoch)))
    check("an impossible install date (%s) is left empty" % epoch,
          r["osInstalledOn"] == "", r)


print("2. a hive that is there but unreadable (truncated or corrupt)")

r = record(run_case(HIVES_FOUND, []))
check("garbage hive: says Windows IS installed",
      r["os"].startswith("Windows is installed but its registry could not be read"), r)
check("garbage hive: tells the operator what to do next",
      "another machine" in r["os"], r)
check("garbage hive: does not claim there is no OS",
      "No operating system" not in r["os"], r)
# A build but no name: the same sentence, and the build is still kept - it is a
# real fact about the machine and a failing hive is no reason to discard it.
r = record(run_case(HIVES_FOUND, win(CurrentBuild="19045", UBR="3803")))
check("a build with no product name: still says Windows is installed",
      r["os"].startswith("Windows is installed but its registry could not be read"), r)
check("a build with no product name: the build that DID read is kept",
      r["osBuild"] == "19045.3803", r)


print("3. no readable Windows: what the disks actually say")

NO_WINDOWS = "lock_locate_hives() { return 1; }\n"

# A wiped machine: one internal disk, only an EFI system partition left.
WIPED = r'''
als_os_volumes() { printf '%s\n' \
  'NAME="/dev/sda" TYPE="disk" FSTYPE="" MOUNTPOINT="" RM="0" TRAN="sata"' \
  'NAME="/dev/sda1" TYPE="part" FSTYPE="vfat" MOUNTPOINT="" RM="0" TRAN="sata"'; }
'''
r = record(run_case(NO_WINDOWS + WIPED))
check("a wiped machine says so in as many words",
      r["os"] == "No operating system installed", r)

# An NTFS volume we could not open is NOT an empty machine.
DATA_NTFS = r'''
als_os_volumes() { printf '%s\n' \
  'NAME="/dev/sda" TYPE="disk" FSTYPE="" MOUNTPOINT="" RM="0" TRAN="sata"' \
  'NAME="/dev/sda2" TYPE="part" FSTYPE="ntfs" MOUNTPOINT="" RM="0" TRAN="sata"'; }
'''
r = record(run_case(NO_WINDOWS + DATA_NTFS))
check("an unopened NTFS volume is 'no Windows found', never 'no OS installed'",
      r["os"] == "No Windows installation found", r)

# No internal disk to look at at all: we have not earned any claim.
r = record(run_case(NO_WINDOWS + "als_os_volumes() { :; }"))
check("no disk to examine: no claim about what is installed",
      r["os"] == "No Windows installation found", r)

# THE ONE THAT WOULD BE WORST: our own live root must never be reported.
OUR_ROOT = r'''
als_os_volumes() { printf '%s\n' \
  'NAME="/dev/sda" TYPE="disk" FSTYPE="" MOUNTPOINT="" RM="0" TRAN="sata"' \
  'NAME="/dev/sda2" TYPE="part" FSTYPE="ext4" MOUNTPOINT="/" RM="0" TRAN="sata"'; }
'''
r = record(run_case(NO_WINDOWS + OUR_ROOT))
check("the station's own mounted root is never read as the machine's OS",
      r["os"] == "No Windows installation found", r)

# The station's boot stick is removable, so it can never be the machine either.
STICK = r'''
als_os_volumes() { printf '%s\n' \
  'NAME="/dev/sda" TYPE="disk" FSTYPE="" MOUNTPOINT="" RM="0" TRAN="sata"' \
  'NAME="/dev/sdb1" TYPE="part" FSTYPE="ext4" MOUNTPOINT="/media/als" RM="1" TRAN="usb"'; }
'''
r = record(run_case(NO_WINDOWS + STICK))
check("a removable USB filesystem is ignored, not taken for the machine",
      r["os"] == "No operating system installed", r)

# A Linux install that happens to be mounted already: free to read, so read it.
LINUX_MNT = os.path.join(TMP, "mnt-linux")
os.makedirs(os.path.join(LINUX_MNT, "etc"))
w(os.path.join(LINUX_MNT, "etc", "os-release"),
  'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 22.04.4 LTS"\nVERSION_ID="22.04"\n')
LINUX = r'''
als_os_volumes() { printf '%%s\n' \
  'NAME="/dev/sda" TYPE="disk" FSTYPE="" MOUNTPOINT="" RM="0" TRAN="sata"' \
  'NAME="/dev/sda2" TYPE="part" FSTYPE="ext4" MOUNTPOINT="%s" RM="0" TRAN="sata"'; }
''' % LINUX_MNT.replace("\\", "/")
r = record(run_case(NO_WINDOWS + LINUX))
check("a mounted Linux root is named from its own PRETTY_NAME",
      r["os"] == "Ubuntu 22.04.4 LTS", r)

# Mounted, but no os-release to read: do not guess a distribution.
NO_RELEASE = LINUX.replace(LINUX_MNT.replace("\\", "/"), os.path.join(TMP, "empty-mnt").replace("\\", "/"))
os.makedirs(os.path.join(TMP, "empty-mnt"))
r = record(run_case(NO_WINDOWS + NO_RELEASE))
check("a Linux root with no os-release is not given an invented name",
      r["os"] == "No Windows installation found", r)


print("4. BitLocker, missing tools, missing privilege")

r = record(run_case('lock_locate_hives() { WIN_ENCRYPTED=1; return 1; }'))
check("BitLocker: says Windows is there and why it cannot be read",
      r["os"] == ("Windows present but encrypted (BitLocker) — "
                  "cannot be read without the recovery key"), r)

NO_HIVEX = ('lock_has() { case "$1" in hivexget) return 1 ;; '
            '*) command -v "$1" >/dev/null 2>&1 ;; esac; }\n' + HIVES_FOUND)
r = record(run_case(NO_HIVEX, WIN11))
check("hivexget missing: says the BUILD could not read it",
      r["os"].startswith("Could not read the installed OS on this build"), r)
check("hivexget missing: says what to do about it",
      "Update the stick" in r["os"], r)
check("hivexget missing: does not claim the machine has no Windows",
      "No Windows" not in r["os"] and "No operating system" not in r["os"], r)

r = record(run_case("LOCK_IS_ROOT=0\n" + HIVES_FOUND, WIN11))
check("not root: refuses to answer rather than guessing from an unopened disk",
      r["os"].startswith("Could not read the installed OS — the audit is not running as root"), r)
check("not root: tells the operator to re-run with sudo", "sudo" in r["os"], r)

# lock-checks.sh absent altogether - the engine's own else-branch.
r = record(run_case("", source_locks=False))
check("lock-checks.sh missing: says the registry reader is missing",
      "registry reader is missing" in r["os"], r)
check("lock-checks.sh missing: says to re-sync the stick",
      "Re-sync the stick" in r["os"], r)


print("5. the house rule: never the word Unknown")


def code_lines(text):
    """Source lines with comments, blank lines and the CONTENTS of quoted
    strings dropped, so a rule is checked against what the code RUNS rather
    than against the English written about it."""
    out = []
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        out.append(re.sub(r"'[^']*'|\"[^\"]*\"", '""', s))
    return out


def sentences(text):
    """Every double-quoted string in the source - the things an operator can
    actually end up reading."""
    return [s for line in text.splitlines() if not line.strip().startswith("#")
            for s in re.findall(r'"([^"]*)"', line)]


bad = [v for v in ALL_OUTPUT if re.search(r"unknown", v, re.I)]
check("no captured value in any outcome contains 'Unknown'", not bad, bad)
check('every outcome names an operating system or says why it cannot',
      all(o for o in [v for i, v in enumerate(ALL_OUTPUT) if i % len(FIELDS) == 0]), ALL_OUTPUT)
bad = [s for s in sentences(OS_BLOCK) if re.search(r"\bunknown\b", s, re.I)]
check("no string the OS block can print contains 'Unknown'", not bad, bad)


print("6. the safety rules, asserted against the source")

os_code = code_lines(OS_BLOCK)

# READ-ONLY. The block must not mount anything itself; the one mount in the
# product is lock-checks.sh's, and that one is read-only.
own_mounts = [l for l in os_code if re.search(r"(?<![\w-])u?mount\s", l)]
check("the OS block never mounts or unmounts anything itself", not own_mounts, own_mounts)
check("the OS block goes through lock-checks.sh's mount",
      any("lock_locate_hives" in l for l in os_code), os_code[:5])

lock_code = code_lines(read(LOCKS))
mounts = [l for l in lock_code if re.search(r"(?<![\w-])mount\s", l)]
check("lock-checks.sh actually mounts something (the fixture of this rule)",
      len(mounts) >= 2, mounts)
# The quoted options survive code_lines' stripping because they carry no
# quotes, so this reads the real flags.
not_ro = [l for l in mounts if not re.search(r"-o\s+ro\b|-o\s+ro,", l)]
check("every mount of a customer disk is READ-ONLY", not not_ro, not_ro)

# TIMEOUT. Every read of the customer's disk runs under one.
check("als_os_to wraps a command in `timeout`",
      any(re.search(r"(?<![\w-])timeout\s", l) for l in code_lines(
          re.search(r"als_os_to\(\) \{.*?\n\}", OS_BLOCK, re.S).group(0))),
      OS_BLOCK)
check("the timeout has a default and is overridable for a slow bench",
      "ALS_OS_TIMEOUT:-" in OS_BLOCK)
untimed = [l for l in os_code
           if re.search(r"(?<![\w-])hivexget\s", l)
           and "als_os_to hivexget" not in l
           and "lock_has hivexget" not in l]
check("every hivexget read of the disk runs under the timeout", not untimed, untimed)
untimed = [l for l in os_code
           if re.search(r"(?<![\w-])lsblk\s", l)
           and "als_os_to lsblk" not in l
           and "lock_has lsblk" not in l]
check("the lsblk scan of the disks runs under the timeout", not untimed, untimed)
untimed = [l for l in code_lines(OS_BLOCK.replace("/etc/os-release", "OSRELEASEPATH"))
           if "OSRELEASEPATH" in l and "als_os_to" not in l]
check("the /etc/os-release read of the disk runs under the timeout", not untimed, untimed)


print("7. the engine writes the new fields, in the right order")

check("system carries the OS name", 'o_s os "$OS_NAME"' in engine_src)
for f, var in [("osVersion", "OS_VERSION"), ("osBuild", "OS_BUILD"),
               ("osArchitecture", "OS_ARCH"), ("osProductId", "OS_PRODUCT_ID"),
               ("osInstalledOn", "OS_INSTALLED_ON")]:
    check("system carries %s" % f, 'o_s %s "$%s"' % (f, var) in engine_src)
check("cpu carries the base clock", 'o_s baseClock "$CPU_BASE"' in engine_src)
check("display carries the refresh rate", 'o_s refreshRate "$DISP_HZ"' in engine_src)
check("display carries the touchscreen answer", 'o_s touchscreen "$DISP_TOUCH"' in engine_src)
check("graphics carries video memory", 'o_s vram "$vram"' in engine_src)
check("an integrated GPU says its memory is shared, never a made-up number",
      'vram="Shared with system memory"' in engine_src)
check("no VRAM is ever taken from a PCI BAR size",
      not re.search(r"size=\d|\[size=", engine_src))

# THE ORDERING HAZARD. lock-checks.sh is sourced before `system` is assembled,
# the OS is read while the volume is still mounted, and the detectors run after.
i_source = engine_src.index('. "$SELF_DIR/lock-checks.sh"')
i_reados = engine_src.index("\n  als_read_installed_os\n")
i_locks = engine_src.index("\n  run_lock_checks\n")
i_system = engine_src.index("SYSTEM=$(o_end)")
check("lock-checks.sh is sourced before the profile's system object is built",
      i_source < i_system, (i_source, i_system))
check("the OS is read after sourcing, so the lock functions exist", i_source < i_reados)
check("the OS is read BEFORE run_lock_checks unmounts the volume", i_reados < i_locks)
check("the lock report still runs, unchanged, from the same block",
      "LOCKS_STATUS=$(lock_status)" in engine_src and "BIOS_LOCKED=$(lock_bios_locked)" in engine_src)
check("the OS is still answered when lock-checks.sh is missing entirely",
      engine_src.count("als_read_installed_os\n") >= 2, engine_src.count("als_read_installed_os\n"))

# The base clock must not come from lscpu's idle floor (400 MHz on most
# laptops), only from the frequency the chip prints in its own model name.
check("the base clock is never taken from lscpu's 'CPU min MHz'",
      "cpu_val 'CPU min MHz'" not in engine_src)
check("the base clock is read out of the CPU's own model name",
      'CPU_BASE=$(printf \'%s\' "$CPU_MODEL"' in engine_src)


print("8. the API type and the asset page")

api = read(API_TYPE)
for f in ("osArchitecture", "osProductId", "osInstalledOn"):
    check("hardware-profile.type.ts declares system.%s" % f, "%s?: string;" % f in api)

card = read(WEB_CARD)
for label, field in [("Architecture", "osArchitecture"),
                     ("Installation date", "osInstalledOn"),
                     ("Product ID", "osProductId")]:
    check("the Operating System card reads %s from system.%s" % (label, field),
          "{ label: '%s', value: text(system.%s) }" % (label, field) in card,
          label)
check("OS name / Version / Build still read their own fields",
      all("text(system.%s)" % f in card for f in ("os", "osVersion", "osBuild")))
check("Base speed reads cpu.baseClock", "text(cpu.baseClock)" in card)
check("Refresh rate reads display.refreshRate", "text(display.refreshRate)" in card)
check("Touchscreen reads display.touchscreen", "text(display.touchscreen)" in card)
check("Video memory reads the GPU's vram", "text(g.vram)" in card)
check("the card no longer hard-codes a dash for the OS rows it can now fill",
      not re.search(r"\{ label: '(Architecture|Installation date|Product ID)', value: DASH \}", card))
check("the page still refuses to print the word Unknown",
      "never the word \u201cUnknown\u201d" in card or "/^unknown$/i" in card)

print("9. the small fields that ship with it")

# The EDID and input-device parsers, sliced out and run the same way: both are
# awk programs inside the engine, and neither has any other way to be proved.


def awk_out(program, stdin):
    prog = w(os.path.join(TMP, "prog.awk"), program + "\n")
    r = subprocess.run([BASH, "-c", 'awk -f "$1"', "x", prog.replace("\\", "/")],
                       input=stdin, capture_output=True, timeout=60,
                       encoding="utf-8", errors="replace")
    return r.stdout.strip(), r.stderr.strip()


m = re.search(r"EOUT=\$\(printf '%s\\n' \"\$EBYTES\" \| awk '(.*?)'\)", engine_src, re.S)
check("the EDID parser can be sliced out of the engine", bool(m))
EDID_AWK = m.group(1) if m else ""


def edid(pclk, hact, hbl, vact, vbl, hmm, vmm, name_descriptor_first=False):
    """A base EDID block laid out field by field, as the spec numbers them."""
    b = [0] * 128
    b[0:8] = [0, 255, 255, 255, 255, 255, 255, 0]
    b[21], b[22] = hmm // 10, vmm // 10
    d = [0] * 18
    d[0], d[1] = pclk & 255, (pclk >> 8) & 255          # pixel clock, 10 kHz units
    d[2], d[3] = hact & 255, hbl & 255
    d[4] = ((hact >> 8) << 4) | (hbl >> 8)
    d[5], d[6] = vact & 255, vbl & 255
    d[7] = ((vact >> 8) << 4) | (vbl >> 8)
    d[12], d[13] = hmm & 255, vmm & 255
    d[14] = ((hmm >> 8) << 4) | (vmm >> 8)
    if name_descriptor_first:
        # A monitor-NAME descriptor in slot 1, the layout the Latitude 3310 uses
        # and the one that used to defeat size detection entirely.
        b[54:72] = [0, 0, 0, 252, 0] + [65] * 13
        b[72:90] = d
    else:
        b[54:72] = d
    return " ".join(str(x) for x in b) + "\n"


# 1920x1080 @ 60 Hz on a 15.6" panel: 148.5 MHz over 2200 x 1125.
out, err = awk_out(EDID_AWK, edid(14850, 1920, 280, 1080, 45, 344, 194))
check("EDID: 1080p60 gives size, resolution AND refresh rate",
      out == '15.6"|1920x1080|60 Hz', (out, err))
# 1366x768 @ 60 Hz: 72.0 MHz over 1500 x 800.
out, _ = awk_out(EDID_AWK, edid(7200, 1366, 134, 768, 32, 310, 174))
check("EDID: a 14\" 768p panel reads 60 Hz", out == '14"|1366x768|60 Hz', out)
# 2560x1440 @ 120 Hz: 483.3 MHz over 2720 x 1481.
out, _ = awk_out(EDID_AWK, edid(48330, 2560, 160, 1440, 41, 344, 194))
check("EDID: a high-refresh panel is not clamped to 60", out.endswith("|120 Hz"), out)
out, _ = awk_out(EDID_AWK, edid(14850, 1920, 280, 1080, 45, 344, 194, True))
check("EDID: a name descriptor in slot 1 does not lose the refresh rate",
      out == '15.6"|1920x1080|60 Hz', out)
# A pixel clock of zero cannot yield a rate, and must not yield a wrong one.
out, _ = awk_out(EDID_AWK, edid(0, 1920, 280, 1080, 45, 344, 194))
check("EDID: no pixel clock means no refresh rate, not a made-up one",
      out.endswith("||") or out.split("|")[-1] == "", out)
out, _ = awk_out(EDID_AWK, "0 0 0\n")
check("EDID: a short read yields nothing at all", out == "", out)

m = re.search(r"DISP_TOUCH=\$\(awk '(.*?)'\s*/proc/bus/input/devices", engine_src, re.S)
check("the touchscreen parser can be sliced out of the engine", bool(m))
TOUCH_AWK = m.group(1) if m else ""

KBD = ('I: Bus=0011 Vendor=0001 Product=0001 Version=ab41\n'
       'N: Name="AT Translated Set 2 keyboard"\n'
       'H: Handlers=sysrq kbd event0 leds\nB: PROP=0\nB: EV=120013\n'
       'B: KEY=402000000 3803078f800d001\n\n')
# PROP=5 is POINTER|BUTTONPAD - a touchPAD, which every laptop already has.
PAD = ('I: Bus=0018 Vendor=06cb Product=7e7e Version=0100\n'
       'N: Name="SYNA8004:00 06CB:CD8B Touchpad"\nH: Handlers=mouse0 event5\n'
       'B: PROP=5\nB: EV=b\nB: ABS=260800000000003\n\n')
# PROP=2 is INPUT_PROP_DIRECT - you touch the thing you point at.
SCREEN = ('I: Bus=0018 Vendor=04f3 Product=2755 Version=0100\n'
          'N: Name="ELAN2514:00 04F3:2755"\nH: Handlers=event7\n'
          'B: PROP=2\nB: EV=1b\nB: ABS=273800000000003\n\n')
PEN = ('I: Bus=0018 Vendor=056a Product=5140 Version=0100\n'
       'N: Name="Wacom HID 5140 Pen"\nH: Handlers=event9\n'
       'B: PROP=2\nB: EV=b\nB: ABS=1000003\n\n')
NOPROP = ('I: Bus=0011 Vendor=0001 Product=0001 Version=ab41\n'
          'N: Name="AT Translated Set 2 keyboard"\nH: Handlers=kbd event0\n'
          'B: EV=120013\n\n')

out, err = awk_out(TOUCH_AWK, KBD + PAD)
check("touch: a touchPAD is not reported as a touchscreen", out == "no", (out, err))
out, _ = awk_out(TOUCH_AWK, KBD + PAD + SCREEN)
check("touch: a real touch digitiser is found next to the touchpad", out == "yes", out)
out, _ = awk_out(TOUCH_AWK, KBD + PEN)
check("touch: a pen-only digitiser is not sold as a touchscreen", out == "no", out)
out, _ = awk_out(TOUCH_AWK, NOPROP)
check("touch: a kernel that publishes no PROP bits gives no answer at all",
      out == "", out)
out, _ = awk_out(TOUCH_AWK, "")
check("touch: an empty input list gives no answer at all", out == "", out)
out, _ = awk_out(TOUCH_AWK, (KBD + SCREEN).rstrip("\n"))
check("touch: the last device is still examined without a trailing blank line",
      out == "yes", out)

shutil.rmtree(TMP, ignore_errors=True)

print("")
print("%d passed, %d failed" % (PASS[0], len(FAIL)))
sys.exit(1 if FAIL else 0)
