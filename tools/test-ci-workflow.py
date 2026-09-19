#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CI keeps running the proofs that only look like they run.

Two kinds of test in this repo pass by SKIPPING when their prerequisite is
missing, and CI is the only place that would notice:

1. The Postgres-backed API specs (apps/api/src/**/*.pg.spec.ts) are
   describe.skip unless ALS_PG_TEST_PORT is set. The api job's "API tests"
   step never set it, so the settle-lock proof (two concurrent wipe ingests
   always leave data_wipe_failed) and the certificate-ledger proofs (the
   trigger refuses UPDATE/DELETE, a one-byte change breaks the chain, guessed
   ids 404) had only ever run on a developer's machine.
2. tools/test-kiosk-ui.py prints SKIP and passes without node, unless
   ALS_REQUIRE_NODE=1. The tools job never set it, so every kiosk-screen proof
   depended on the runner image happening to ship node.

This reads .github/workflows/ci.yml as text (no YAML parser in the stdlib;
the checks are on the lines that matter) and fails if either guard is gone.

    python3 tools/test-ci-workflow.py
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CI = os.path.join(HERE, "..", ".github", "workflows", "ci.yml")

PASS, FAIL = [0], []


def check(name, cond, detail=""):
    if cond:
        PASS[0] += 1
        print("  ok   %s" % name)
    else:
        FAIL.append(name)
        print("  FAIL %s   %s" % (name, detail))


def jobs(text):
    """{job id: its block of lines} for the top-level jobs: mapping."""
    out, cur, in_jobs = {}, None, False
    for line in text.splitlines():
        if re.match(r"^jobs:\s*$", line):
            in_jobs = True
            continue
        if in_jobs and re.match(r"^\S", line):
            in_jobs = False
            cur = None
        if not in_jobs:
            continue
        m = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
        if m:
            cur = m.group(1)
            out[cur] = []
            continue
        if cur:
            out[cur].append(line)
    return out


def steps(lines):
    """The job's steps, each as (name, [its lines]), in order."""
    out, cur = [], None
    for line in lines:
        m = re.match(r"^      - (.*)$", line)
        if m:
            cur = [line]
            out.append(cur)
        elif cur is not None and (line.startswith("        ") or not line.strip()):
            cur.append(line)
        elif cur is not None and re.match(r"^    \S", line):
            cur = None
    named = []
    for block in out:
        text = "\n".join(block)
        m = re.search(r"name:\s*(.+)", text)
        named.append(((m.group(1).strip() if m else ""), text))
    return named


def main():
    if not os.path.exists(CI):
        check(".github/workflows/ci.yml exists", False, CI)
        return
    with open(CI, encoding="utf-8") as fh:
        text = fh.read()
    j = jobs(text)
    check("ci.yml has a tools job and an api job", "tools" in j and "api" in j, sorted(j))
    if "tools" not in j or "api" not in j:
        return

    print("api job: the Postgres specs run")
    api = steps(j["api"])
    names = [n for n, _ in api]
    pg = [(i, t) for i, (n, t) in enumerate(api)
          if re.search(r"ALS_PG_TEST_PORT:\s*'?\d+'?", t) and "jest" in t]
    check("a step runs jest with ALS_PG_TEST_PORT set", len(pg) == 1, names)
    if pg:
        i, t = pg[0]
        port = re.search(r"ALS_PG_TEST_PORT:\s*'?(\d+)'?", t).group(1)
        svc = re.search(r"-\s*(\d+):5432", "\n".join(j["api"]))
        check("... on the port the job's Postgres service publishes",
              svc is not None and port == svc.group(1), (port, svc and svc.group(1)))
        check("... selecting the *.pg.spec.ts files", "pg" in t and "spec" in t, t)
        check("... without --passWithNoTests (a rename must fail, not pass vacuously)",
              "passWithNoTests" not in t, t)
        mig = [k for k, n in enumerate(names) if n.lower().startswith("migration chain")]
        check("... after the migration chain step", mig and i > mig[0], names)
        check("... not by weakening the plain 'API tests' step",
              any(n == "API tests" for n in names), names)

    print("tools job: the kiosk UI test cannot skip")
    tools_text = "\n".join(j["tools"])
    check("the tools job sets ALS_REQUIRE_NODE=1",
          re.search(r"ALS_REQUIRE_NODE:\s*'?1'?", tools_text) is not None, tools_text[-600:])
    check("the tools job installs node itself (not left to the runner image)",
          "actions/setup-node" in tools_text, "")


main()
print("")
print("%d passed, %d failed" % (PASS[0], len(FAIL)))
sys.exit(1 if FAIL else 0)
