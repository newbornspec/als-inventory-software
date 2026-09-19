#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""HARDWARE-TESTS.md's "check which features the stick carries" block must
search for strings the shipped code actually contains.

The owner runs that PowerShell block on the stick and SKIPS every test whose
line says False. A searched-for string that the code never had (a name from
the plan that the implementation spelled differently, or one a later change
renamed) silently skips a hardware test that should run. So every
`($x -match '<pattern>')` line is checked here against the file its variable
reads, with the pattern taken as the regular expression PowerShell uses
(-match is a case-insensitive regex match).

    python3 tools/test-hardware-tests-doc.py
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DOC = os.path.join(HERE, "HARDWARE-TESTS.md")

PASS, FAIL = [0], []


def check(name, cond, detail=""):
    if cond:
        PASS[0] += 1
        print("  ok   %s" % name)
    else:
        FAIL.append(name)
        print("  FAIL %s   %s" % (name, detail))


with open(DOC, encoding="utf-8") as fh:
    doc = fh.read()
m = re.search(r"### Check which features the stick carries\s.*?```powershell\n(.*?)```", doc, re.S)
check("HARDWARE-TESTS.md has the feature-check block", bool(m))
block = m.group(1) if m else ""

# $e = Get-Content "$s\hardware-audit.sh" -Raw   ->   {"e": "hardware-audit.sh"}
files = {v: p.replace("\\", "/") for v, p in
         re.findall(r'^\$(\w+)\s*=\s*Get-Content\s+"\$s\\([^"]+)"\s+-Raw', block, re.M)}
check("the block reads the engine and the kiosk",
      files.get("e") == "hardware-audit.sh" and files.get("k") == "gui/server.py", files)

lines = re.findall(r'^"([^"]+?)\s*:\s*"\s*\+\s*\(\$(\w+)\s+-match\s+\'([^\']+)\'\)', block, re.M)
check("the block has feature lines", len(lines) >= 6, lines)
for label, var, pattern in lines:
    path = files.get(var)
    if not path:
        check("%s: reads a file the block defines" % label, False, var)
        continue
    with open(os.path.join(HERE, path), encoding="utf-8") as fh:
        text = fh.read()
    try:
        found = re.search(pattern, text, re.I) is not None
    except re.error as exc:
        check("%s: '%s' is a valid pattern" % (label, pattern), False, exc)
        continue
    check("%s: '%s' is in %s" % (label, pattern, path), found)

# The owner docs described behaviour the merged code no longer has: a
# firmware erase accepted on the drive's word ("controller-confirmed", gone
# since plan step 31), and operator sign-in as "not implemented" while the
# kiosk reads AUDIT_OPERATOR_SIGNIN (step 27). Each track merged its own copy
# of the docs, so these sentences survived. None of them may come back.
RETIRED = [
    (r"controller-confirmed", "a firmware erase accepted without a read-back"),
    (r"TODAY THE RESULT IS STILL WIPED|today the result is Wiped anyway",
     "firmware erases recorded as wiped unchecked"),
    (r"NOT YET IMPLEMENTED|NOT implemented yet|No kiosk reads that setting",
     "operator sign-in described as not implemented"),
    (r"no Rescan button on the main screen", "the missing Rescan button"),
    (r"does not\s+yet say so|does NOT\s+say so yet", "no per-drive certificate lines"),
    (r"it is not on the station yet", "the per-drive roll-up described as planned"),
]
docs = ["HARDWARE-AUDIT.md", "USB-SETUP.txt", "HARDWARE-TESTS.md", "audit.conf.example",
        os.path.join("gui", "README-KIOSK.md")]
for rel in docs:
    path = os.path.join(HERE, rel)
    if not os.path.exists(path):
        continue
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    for pattern, what in RETIRED:
        if rel == "HARDWARE-TESTS.md" and pattern == "controller-confirmed":
            continue            # there it is the FAIL marker the owner looks for
        hit = re.search(pattern, text)
        check("%s does not describe %s" % (rel, what), hit is None,
              hit and text[max(0, hit.start() - 60):hit.end() + 60])
with open(os.path.join(HERE, "hardware-audit.sh"), encoding="utf-8") as fh:
    check("the engine has no controller-confirmed branch (step 31)",
          "controller-confirmed" not in fh.read())

print("")
print("%d passed, %d failed" % (PASS[0], len(FAIL)))
sys.exit(1 if FAIL else 0)
