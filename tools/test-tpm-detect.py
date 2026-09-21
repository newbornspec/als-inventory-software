#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""The TPM line, and the difference between "no TPM" and "no TPM device".

A TPM that is switched off in the firmware is never handed to the operating
system, so it is missing from /sys in precisely the way a machine with no TPM
at all is. The bench panel used to print "No TPM detected" for both - a claim
about the CUSTOMER'S MACHINE assembled out of the absence of a device node on
the station. On second-hand business stock a disabled fTPM is not a corner
case, it is a common configuration, and calling it "no TPM" writes a wrong
answer into the asset record and can cost a Windows 11-eligible machine its
grade.

What tells the two apart is the firmware's own ACPI tables: TPM2 (or TCPA for a
1.2 part) is the platform DECLARING the chip, whether or not it then hands it
over. So there are four honest answers, and this drives the real block - sliced
out of hardware-audit.sh between its TPM-DETECT markers - against a fake /sys
for each one:

1. A TPM the kernel handed over: the version, and nothing else needed.
2. Declared in firmware, not handed over: present, and most likely off in the
   BIOS. This is the one the old code got wrong.
3. Not handed over and not declared: the only case that may say "no TPM", and
   even then it says what else it might be.
4. Nothing to look at - no TPM subsystem on this kernel, or no readable ACPI
   tables. Could not check, which is not an answer about the machine.

Plus the rule that ties it to the record: system.tpmVersion stays a VERSION and
never carries prose, while security.tpm is the operator-facing line and is
never left empty for the panel to fill in with a guess.

    python3 tools/test-tpm-detect.py
"""
import io
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
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
m = re.search(r"^# --- TPM-DETECT-BEGIN.*?\n(.*?)^# --- TPM-DETECT-END", engine_src, re.S | re.M)
BLOCK = m.group(1) if m else None
check("the TPM-DETECT block can be sliced out of hardware-audit.sh", bool(BLOCK))
if not BLOCK:
    sys.exit(1)

TMP = tempfile.mkdtemp(prefix="als-tpm-test-")


def sysroot(name, tpm=None, tables=None):
    """A fake /sys. tpm=None means no TPM subsystem at all; tpm={} means the
    subsystem is there with no device in it; tables=None means the ACPI table
    directory is not readable."""
    root = os.path.join(TMP, name)
    if tpm is not None:
        d = os.path.join(root, "sys", "class", "tpm")
        os.makedirs(d)
        for dev, fields in tpm.items():
            dd = os.path.join(d, dev)
            os.makedirs(dd)
            for k, v in (fields or {}).items():
                with io.open(os.path.join(dd, k), "w", encoding="utf-8", newline="\n") as fh:
                    fh.write(v)
    if tables is not None:
        d = os.path.join(root, "sys", "firmware", "acpi", "tables")
        os.makedirs(d)
        for t in tables:
            with io.open(os.path.join(d, t), "w", encoding="utf-8", newline="\n") as fh:
                fh.write(t)
    return root.replace("\\", "/")


def run(root):
    """Run the block with LOCK_SYSROOT pointed at a fake /sys."""
    script = os.path.join(TMP, "case.sh")
    body = "\n".join([
        "set -u",
        'LOCK_SYSROOT="%s"' % root,
        BLOCK,
        'printf "VER=%s\\n" "$TPM_VER"',
        'printf "ABSENT=%s\\n" "$TPM_ABSENT"',
        # The line the record actually carries, assembled the way the engine
        # assembles it - so a change to one and not the other is caught here.
        'printf "FIELD=%s\\n" "${TPM_VER:-$TPM_ABSENT}"',
    ])
    with io.open(script, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(body + "\n")
    r = subprocess.run([BASH, script], capture_output=True, timeout=120,
                       encoding="utf-8", errors="replace")
    out = {"VER": "", "ABSENT": "", "FIELD": ""}
    for line in r.stdout.splitlines():
        k, _, v = line.partition("=")
        if k in out:
            out[k] = v
    check("the case ran cleanly (rc=%d)" % r.returncode,
          r.returncode == 0 and not r.stderr.strip(), r.stderr.strip()[:300])
    return out


print("1. a TPM the kernel handed over")

r = run(sysroot("tpm2", tpm={"tpm0": {"tpm_version_major": "2\n"}}, tables=["TPM2"]))
check("a TPM 2.0 device reads as 2.0", r["VER"] == "2.0", r)
check("a TPM that answered needs no explanation", r["ABSENT"] == "", r)
check("the recorded field is the version", r["FIELD"] == "2.0", r)

r = run(sysroot("tpm12", tpm={"tpm0": {"tpm_version_major": "1\n"}}, tables=["TCPA"]))
check("a TPM 1.2 device reads as 1.0 from its own version file", r["VER"] == "1.0", r)

# A device with no version file: present is all we know, and all we say.
r = run(sysroot("tpm-noversion", tpm={"tpm0": {}}, tables=["TPM2"]))
check("a TPM with no version file reads 'present', not a guessed version",
      r["VER"] == "present", r)


print("2. THE ONE THAT WAS WRONG: declared in firmware, not handed over")

r = run(sysroot("disabled2", tpm={}, tables=["DSDT", "FACP", "TPM2"]))
check("a declared-but-absent TPM 2.0 is never 'No TPM detected'",
      "No TPM detected" not in r["FIELD"], r)
check("a declared-but-absent TPM 2.0 says it is present in firmware",
      r["FIELD"].startswith("Present in firmware but not available"), r)
check("a declared-but-absent TPM 2.0 names the BIOS as the likely cause",
      "BIOS" in r["FIELD"], r)
check("a declared-but-absent TPM 2.0 says WHICH table said so",
      "ACPI TPM2" in r["FIELD"], r)
check("a declared-but-absent TPM leaves the VERSION field empty",
      r["VER"] == "", r)

r = run(sysroot("disabled12", tpm={}, tables=["DSDT", "TCPA"]))
check("a declared-but-absent TPM 1.2 is never 'No TPM detected'",
      "No TPM detected" not in r["FIELD"], r)
check("a declared-but-absent TPM 1.2 names its own table",
      "ACPI TCPA" in r["FIELD"], r)

# Both tables present is still one machine, and the 2.0 answer is the one that
# matters for Windows 11 eligibility.
r = run(sysroot("both", tpm={}, tables=["TPM2", "TCPA"]))
check("a machine declaring both tables is reported as the 2.0 it is",
      "ACPI TPM2" in r["FIELD"], r)


print("3. the only case that may say there is no TPM")

r = run(sysroot("none", tpm={}, tables=["DSDT", "FACP"]))
check("no device and no declaration may say no TPM was detected",
      r["FIELD"].startswith("No TPM detected"), r)
check("and even then it does not claim the machine HAS no TPM",
      "declares none" in r["FIELD"], r)


print("4. nothing to look at is not an answer about the machine")

# No TPM subsystem on this kernel at all: the station cannot see a TPM on ANY
# machine, so the absence says nothing about the one in front of it.
r = run(sysroot("nokernel", tpm=None, tables=["TPM2"]))
check("no TPM subsystem is never read as 'no TPM'",
      "No TPM detected" not in r["FIELD"], r)
check("no TPM subsystem says the STATION could not check",
      r["FIELD"].startswith("Could not check for a TPM"), r)
check("no TPM subsystem blames the station's kernel, not the machine",
      "this station's kernel" in r["FIELD"], r)

# Subsystem present, device absent, and no ACPI tables to arbitrate: we know
# the OS was given no TPM and we cannot say why.
r = run(sysroot("notables", tpm={}, tables=None))
check("unreadable ACPI tables are never read as 'no TPM'",
      "No TPM detected" not in r["FIELD"], r)
check("unreadable ACPI tables say the two cases could not be told apart",
      "could not be read" in r["FIELD"], r)
check("unreadable ACPI tables still report what IS known",
      r["FIELD"].startswith("No TPM was handed to the operating system"), r)


print("5. the field is never empty, and never prose in the version")

for name, kw in [("handed over", dict(tpm={"tpm0": {"tpm_version_major": "2\n"}}, tables=["TPM2"])),
                 ("declared only", dict(tpm={}, tables=["TPM2"])),
                 ("neither", dict(tpm={}, tables=[])),
                 ("no subsystem", dict(tpm=None, tables=None))]:
    r = run(sysroot("field-" + name.replace(" ", "-"), **kw))
    check("the recorded TPM line is never empty (%s)" % name, bool(r["FIELD"].strip()), r)
    check("the VERSION field never carries a sentence (%s)" % name,
          len(r["VER"]) <= 8, r)


print("6. the engine and the panel, asserted against the source")

# system.tpmVersion is a version. security.tpm is the line, and it is the one
# that falls back to the sentence - the web card and the bench panel both read
# it that way, so this pins the pairing rather than the wording.
check("system.tpmVersion is written from the VERSION variable alone",
      re.search(r"o_s tpmVersion \"\$TPM_VER\"", engine_src) is not None)
check("security.tpm falls back to the sentence when there is no version",
      re.search(r"o_s tpm \"\$\{TPM_VER:-\$TPM_ABSENT\}\"", engine_src) is not None)

# THE RULE THIS SHARES WITH THE LICENCE CHECK: an ACPI table is tested for by
# name and never opened. MSDM carries a working product key at a fixed offset,
# so a reader pointed at that directory is a credential leak waiting to happen.
block_lines = [l.strip() for l in BLOCK.splitlines()
               if l.strip() and not l.strip().startswith("#")]
readers = [l for l in block_lines
           if re.search(r"(?<![\w-])(cat|head|tail|dd|xxd|od|strings|grep|awk|sed)\s", l)
           and "acpi" in l]
check("no reader is ever pointed at an ACPI table", not readers, readers)
acpi_lines = [l for l in block_lines if "acpi" in l]
check("the ACPI tables are only ever tested for by filename",
      acpi_lines and all(re.match(r"^elif \[ (!\s+)?-[de] ", l) for l in acpi_lines), acpi_lines)

# And the house rule.
check("the TPM block never prints the word Unknown",
      not re.search(r"\bunknown\b", BLOCK, re.I), BLOCK)

# The sysroot prefix is what makes every branch above testable; without it the
# block reads the STATION's own /sys and this file proves nothing.
check("every /sys path in the block goes through the sysroot prefix",
      not [l for l in block_lines if re.search(r'["\s]/sys/', l)],
      [l for l in block_lines if re.search(r'["\s]/sys/', l)])


shutil.rmtree(TMP, ignore_errors=True)
print("\n%d passed, %d failed" % (PASS[0], len(FAIL)))
for f in FAIL:
    print("  FAILED: %s" % f)
sys.exit(1 if FAIL else 0)
