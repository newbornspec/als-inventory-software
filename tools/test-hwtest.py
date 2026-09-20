#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""The hardware functional test (contract C6), station side, end to end.

Four components - speaker, keyboard, camera, screen - tested in the kiosk on
the machine being audited, confirmed by a technician, and carried on that
machine's audit record as profile.hardwareTest (inside the hardware profile:
no migration, no new column).

This proves the FOUNDATION: the four tests themselves are written later, one
region each, and this is the shell they drop into.

1. THE STATE MACHINE. The overall verdict is DERIVED by the contract's
   worst-wins rule, in server.py's hwtest_overall() and in the page's
   hwOverall() - two sides, one rule, so both are driven with ALL 625
   combinations of the five states across the four tests and must agree with
   each other and with the contract. The rules asserted by name: a run that is
   not finished never reports a verdict (only "2 / 4 completed"), four PASSED
   is the only way to reach PASSED, and any FAILED beats any ATTENTION.
2. THE RULE THAT KEEPS IT HONEST. A test the station could not RUN is
   ATTENTION with a reason and an action - NEVER FAILED. Checked on the page
   (no runner registered, a runner that throws, a runner that records nothing)
   and on the server (an ATTENTION with no reason is refused, so a result
   nobody can act on cannot reach the report). FAILED comes only from a
   person's answer.
3. WHAT MAY BE STORED. server.py cleans one component's result without
   whitelisting field names - the four tests bring their own fields later, and
   a whitelist is exactly how those would vanish - but refuses an unknown
   state, a test still running, a non-pass with no reason, and anything too
   big to carry on a record.
4. THE SHELL ON SCREEN. Under node, with a small stand-in for the DOM (the
   way tools/test-drive-health.py drives index.html): four "Not tested" rows
   with their own detail areas, the count, the verdict only once all four are
   in, words as well as colour, never "Unknown", and a result that could not
   be saved says so instead of looking saved.
5. THE ENDPOINTS. The REAL Handler on a real port: save, read back, the
   technician taken from whoever the station says is at it, a retest keeping
   what it replaced, and /api/audit's payload - rebuilt from a FIXED key set -
   still carrying the test inside the profile.
6. THE RE-AUDIT HAZARD. refresh() itself, with the capture stubbed: a Rescan
   must not destroy a test run before it, and must not carry one onto a
   machine that is provably a different one.

Needs node for section 4. Without it that section says SKIP and passes, unless
ALS_REQUIRE_NODE=1 (set in CI).

    python3 tools/test-hwtest.py
"""
import copy
import http.client
import importlib.util
import itertools
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
PAGE = os.path.join(HERE, "gui", "index.html")
SERVER = os.path.join(HERE, "gui", "server.py")

PASS, FAIL = [0], []


def check(name, cond, detail=""):
    if cond:
        PASS[0] += 1
        print("  ok   %s" % name)
    else:
        FAIL.append(name)
        print("  FAIL %s   %s" % (name, detail))


spec = importlib.util.spec_from_file_location("als_server_hwt", SERVER)
srv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(srv)

TESTS = list(srv.HWTEST_TESTS)
STATES = list(srv.HWTEST_STATES)
DONE = ("PASSED", "ATTENTION", "FAILED")
TMP = tempfile.mkdtemp(prefix="als-hwt-")
# The station keeps the test in progress on the stick, beside audit.conf
# (hwtest_remember). Both of its paths are pointed into the temp directory
# before the FIRST save: without this the file lands beside the audit.conf in
# tools/, dropping a stray file into the checkout, and the fallback would be a
# real /tmp - which on Windows does not exist, sending the write through
# write_boot_file's remount of the boot medium.
srv.CONF_PATH = None
srv.HWTEST_FALLBACK = os.path.join(TMP, "hwtest-fallback.jsonl")

with open(PAGE, encoding="utf-8") as fh:
    HTML = fh.read()


def combo_object(combo):
    """A hardwareTest object with those four statuses and nothing else."""
    return {name: {"status": status} for name, status in zip(TESTS, combo)}


def contract_overall(combo):
    """Contract C6's rule, written out here so the two implementations are
    checked against the CONTRACT and not just against each other."""
    done = [s for s in combo if s in DONE]
    if len(done) == len(TESTS):
        status = ("FAILED" if "FAILED" in combo
                  else "ATTENTION" if "ATTENTION" in combo else "PASSED")
    elif "IN_PROGRESS" in combo or done:
        status = "IN_PROGRESS"
    else:
        status = "NOT_TESTED"
    return {"status": status, "completed": len(done), "total": len(TESTS)}


# ------------------------------------------------------- 1. state machine --
print("1. the overall verdict is derived, worst wins, and never guessed")
COMBOS = list(itertools.product(STATES, repeat=len(TESTS)))
check("the five states are exactly the contract's",
      STATES == ["NOT_TESTED", "IN_PROGRESS", "PASSED", "ATTENTION", "FAILED"], STATES)
check("all %d combinations of the five states across the four tests are covered"
      % (len(STATES) ** len(TESTS)), len(COMBOS) == 625, len(COMBOS))

PY = [srv.hwtest_overall(combo_object(c)) for c in COMBOS]
WANT = [contract_overall(c) for c in COMBOS]
bad = [(c, g, w) for c, g, w in zip(COMBOS, PY, WANT) if g != w]
check("server.py's hwtest_overall matches the contract in every combination",
      not bad, bad[:4])

partial = [(c, g) for c, g in zip(COMBOS, PY)
           if g["completed"] < g["total"] and g["status"] in DONE]
check("a part-finished run NEVER reports a verdict - only 'N / 4 completed'",
      not partial, partial[:4])
wrong_pass = [(c, g) for c, g in zip(COMBOS, PY)
              if g["status"] == "PASSED" and list(c) != ["PASSED"] * 4]
check("four PASSED is the only way to reach PASSED", not wrong_pass, wrong_pass[:4])
wrong_fail = [(c, g) for c, g in zip(COMBOS, PY)
              if "FAILED" in c and g["completed"] == g["total"] and g["status"] != "FAILED"]
check("one FAILED beats any number of ATTENTIONs", not wrong_fail, wrong_fail[:4])
attn = [(c, g) for c, g in zip(COMBOS, PY)
        if g["completed"] == g["total"] and "FAILED" not in c and "ATTENTION" in c
        and g["status"] != "ATTENTION"]
check("any ATTENTION beats a pass", not attn, attn[:4])
check("a component this station has never heard of counts as not tested, not as a fault",
      srv.hwtest_overall({"speaker": {"status": "MAYBE"}, "camera": None})
      == {"status": "NOT_TESTED", "completed": 0, "total": 4})
check("the derivation is one function, not a status the sender can set",
      srv.hwtest_overall(dict(combo_object(("PASSED",) * 4), status="FAILED"))["status"]
      == "PASSED")

# ---------------------------------------------- 2 + 3. what may be stored --
print("2. a test the station could not RUN is ATTENTION with a reason, never FAILED")
part = srv.hwtest_component("camera", {
    "status": "ATTENTION", "reason": "this machine has no camera the station can open",
    "action": "Check the camera is not switched off by a key or in the BIOS, then test again."})
check("a could-not-run result is stored as ATTENTION with its reason and action",
      part["status"] == "ATTENTION" and part["reason"].startswith("this machine has no camera")
      and part["action"].startswith("Check the camera"), part)
check("it is stamped with the station's clock, not the browser's",
      srv.ISO_UTC.match(part["testedAt"] or ""), part.get("testedAt"))
for status in ("ATTENTION", "FAILED"):
    try:
        srv.hwtest_component("speaker", {"status": status})
        why = None
    except ValueError as exc:
        why = str(exc)
    check("a %s with no reason is refused - the report would have nothing to act on"
          % srv.HWTEST_WORDS[status], why and "reason" in why, why)
check("the refusal is a sentence an operator can read", why and why.startswith("The speaker test"), why)

print("3. what one component may carry into the record")
try:
    srv.hwtest_component("screen", {"status": "BROKEN"})
    why = None
except ValueError as exc:
    why = str(exc)
check("a state this station does not know is refused, not stored", why and "NOT_TESTED" in why, why)
try:
    srv.hwtest_component("screen", {"status": "IN_PROGRESS"})
    why = None
except ValueError as exc:
    why = str(exc)
check("a test still running has no result to save", why and "still running" in why, why)
try:
    srv.hwtest_component("screen", "passed")
    why = None
except ValueError as exc:
    why = str(exc)
check("a result that is not a set of fields is refused", why and "run the test again" in why.lower(), why)

# The fields the four tests bring later must survive: a whitelist here is
# exactly how they would disappear.
rich = srv.hwtest_component("speaker", {
    "status": "PASSED", "left": "PASSED", "right": "PASSED",
    "mixer": "unmuted Master and Speaker, set to 80%",
    "sink": "Built-in Audio Analogue Stereo", "notes": "quiet but clear",
    "detectedKeys": 104, "missingKeys": ["F13", "F14"], "confirmedBy": "technician",
    "deadPixels": 0, "coloursShown": ["black", "white"], "levels": {"left": 0.8}})
check("a test's own fields are carried through, not whitelisted away",
      rich["left"] == "PASSED" and rich["mixer"].startswith("unmuted")
      and rich["missingKeys"] == ["F13", "F14"] and rich["detectedKeys"] == 104
      and rich["levels"] == {"left": 0.8} and rich["coloursShown"] == ["black", "white"], rich)
check("a pass needs no reason, and carries none", rich["reason"] is None and rich["notes"] == "quiet but clear")
junk = srv.hwtest_component("screen", {"status": "PASSED", "nan": float("nan"),
                                       "inf": float("inf"), "deep": {"a": {"b": {"c": 1}}},
                                       "long": "x" * 900, "list": list(range(80))})
check("values a JSONB column could not take are dropped, not stored",
      "nan" not in junk and "inf" not in junk and junk["deep"] == {"a": {}}
      and len(junk["long"]) == 500 and len(junk["list"]) == 50, junk)

srv.STATE["hwtest"] = None
srv.STATE["hwtestMachine"] = ""
try:
    srv.hwtest_save({"speaker": {"status": "PASSED", "notes": "y" * 400,
                                 "big": ["w" * 500] * 50}})
    why = None
except ValueError as exc:
    why = str(exc)
check("an oversized result is refused with what to do about it, not stored",
      why is None or "shorten" in why.lower(), why)
srv.STATE["hwtest"] = None
try:
    srv.hwtest_save({"speaker": {"status": "PASSED"}, "junk": {"status": "PASSED"}})
    named = srv.STATE["hwtest"]
except ValueError as exc:
    named = str(exc)
check("a key that is not one of the four tests is ignored, not stored",
      isinstance(named, dict) and "junk" not in named, named)
try:
    srv.hwtest_save({"nothing": 1})
    why = None
except ValueError as exc:
    why = str(exc)
check("a save that names none of the four tests says so", why and "none of the four" in why, why)

# ------------------------------------------------------------ 4. the page --
print("4. the shell on screen")
check("index.html: a hardware test card, not a sidebar", 'id="hwtCard"' in HTML)
for name in TESTS:
    up = name.upper()
    for kind, start, end in (("markup", "<!-- HWTEST:%s:START -->" % up, "<!-- HWTEST:%s:END -->" % up),
                             ("CSS", "/* HWTEST:%s:CSS:START */" % up, "/* HWTEST:%s:CSS:END */" % up),
                             ("JS", "/* HWTEST:%s:JS:START */" % up, "/* HWTEST:%s:JS:END */" % up)):
        i, j = HTML.find(start), HTML.find(end)
        check("index.html: the %s test has its own %s region, once, and it closes"
              % (name, kind),
              i >= 0 and j > i and HTML.count(start) == 1 and HTML.count(end) == 1, (i, j))
# Disjoint regions, or two agents filling two of them meet in one place.
spans = []
for name in TESTS:
    up = name.upper()
    for start, end in (("<!-- HWTEST:%s:START -->" % up, "<!-- HWTEST:%s:END -->" % up),
                       ("/* HWTEST:%s:CSS:START */" % up, "/* HWTEST:%s:CSS:END */" % up),
                       ("/* HWTEST:%s:JS:START */" % up, "/* HWTEST:%s:JS:END */" % up)):
        spans.append((HTML.find(start), HTML.find(end) + len(end), "%s %s" % (name, start)))
spans.sort()
overlap = [(a, b) for a, b in zip(spans, spans[1:]) if a[1] >= b[0]]
check("the twelve regions never overlap", not overlap, overlap)
check("every test row has its own status, reason and detail area",
      all(('id="hwtStat_%s"' % n) in HTML and ('id="hwtWhy_%s"' % n) in HTML
          and ('id="hwtDetail_%s"' % n) in HTML for n in TESTS))
check("the shared code sits outside every region",
      "function hwOverall" in HTML
      and all(m not in HTML[HTML.find("function hwOverall"):HTML.find("function hwOverall") + 4000]
              for m in ("HWTEST:SPEAKER:JS:START", "HWTEST:CAMERA:JS:START")))
check("index.html never says 'Unknown' about a hardware test",
      "Unknown" not in HTML.replace("d.model!=='Unknown model'", ""))
# The keyboard test (contract C6) needs ONE keydown listener, and only while it
# is actively capturing keys: detection has to be on keydown, not keyup, or the
# browser acts on F3/F5/F7 (Find, reload, caret browsing) before the page can
# cancel them. That listener is allowed ONLY inside the keyboard region, added on
# capture-start and removed the instant capture stops, so it never becomes an
# always-on global key grab that swallows keys in the sign-in box, the notes field
# and the rest of the kiosk. So the rule now has two halves: NO keydown handler may
# be bound anywhere OUTSIDE the keyboard region (the sign-in field's inline Enter
# handler stays the one allowed inline onkeydown), and the one INSIDE the region
# must be paired with a removeEventListener (added on start, removed on stop).
_KBD_JS = HTML[HTML.find("/* HWTEST:KEYBOARD:JS:START */"):HTML.find("/* HWTEST:KEYBOARD:JS:END */")]
_OUTSIDE = HTML.replace(_KBD_JS, "")
_OUTSIDE_NO_SIGNIN = _OUTSIDE.replace('onkeydown="if(event.key===\'Enter\')doSignIn()"', "")
check("no global keydown handler is bound outside the keyboard test region",
      "addEventListener('keydown'" not in _OUTSIDE
      and 'addEventListener("keydown"' not in _OUTSIDE
      and "onkeydown" not in _OUTSIDE_NO_SIGNIN)
check("the keyboard region's keydown listener is paired with a removeEventListener "
      "(added on capture-start, removed on capture-stop)",
      ("addEventListener('keydown'" not in _KBD_JS)
      or ("removeEventListener('keydown'" in _KBD_JS))

node = shutil.which("node")
if not node:
    if os.environ.get("ALS_REQUIRE_NODE") == "1":
        check("node is installed (ALS_REQUIRE_NODE=1)", False)
    else:
        print("  SKIP page rendering under node (node not installed)")
    JS_OVERALL = None
else:
    blocks = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", HTML, re.S | re.I)
    js = os.path.join(TMP, "page.js")
    with open(js, "w", encoding="utf-8") as fh:
        fh.write("\n;\n".join(blocks))
    harness = os.path.join(TMP, "h.js")
    # Wrapped in an async function on purpose: node reads a .js file with a
    # top-level await as an ES module, and then require() is gone.
    body = r"""
const vm = require('vm'), fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const els = {};
function mk(id) {
  const e = { id, style: {}, _cls: '', textContent: '', innerHTML: '', value: '',
    disabled: false, options: [], selectedOptions: [], firstElementChild: { style: {} },
    focus() {}, select() {},
    get className() { return this._cls; }, set className(v) { this._cls = String(v); } };
  const set = () => new Set(e._cls.split(' ').filter(Boolean));
  const put = (s) => { e._cls = Array.from(s).join(' '); };
  e.classList = { add(...c) { const s = set(); c.forEach(x => s.add(x)); put(s); },
    remove(...c) { const s = set(); c.forEach(x => s.delete(x)); put(s); },
    toggle(c, f) { const s = set(); const on = f === undefined ? !s.has(c) : !!f;
      if (on) s.add(c); else s.delete(c); put(s); return on; },
    contains(c) { return set().has(c); } };
  return e;
}
const document = { getElementById: (id) => els[id] || (els[id] = mk(id)), addEventListener() {},
  querySelectorAll: () => [], activeElement: null, hidden: false };
const ctx = vm.createContext({ document, console, prompt: () => null, screen: {}, innerWidth: 0,
  innerHeight: 0, fetch: () => new Promise(() => {}), setTimeout: () => 0, clearTimeout() {},
  setInterval() {} });
vm.runInContext(src, ctx, { filename: 'index.html<script>' });
const run = (c) => vm.runInContext(c, ctx);
const el = (id) => document.getElementById(id);
const out = {};
const IN = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
ctx.IN = IN;

// A stand-in station service: it answers the way server.py does - it MERGES
// what it is sent into what it holds, and hands the whole object back, with
// the machine it holds it for and whether a record already filed for that
// machine is missing it - so hwSave adopts an answer instead of hanging on a
// fetch that never settles. REFUSE names tests it will not accept, which is
// how the "on screen but not saved" path is driven.
run(`SAVED=[]; HELD={}; MACHINE='HOST1'; NEEDS=false; REFUSE={};
  STAND_IN=async(u,b)=>{SAVED.push({u:u,b:JSON.parse(JSON.stringify(b))});
    const k=Object.keys(b)[0];
    if(REFUSE[k])return {ok:false,status:400,data:{message:REFUSE[k]}};
    HELD=Object.assign({technician:'Ann Operator',testedAt:'2026-09-20T12:00:00Z',
      clockWasNetwork:true},HELD,b);
    return {ok:true,status:200,data:{hardwareTest:JSON.parse(JSON.stringify(HELD)),
      hwtestMachine:MACHINE,hwtestNeedsFiling:NEEDS}};};
  jpost=STAND_IN;`);
const reset = () => run(`HWTEST={}; HELD={}; SAVED=[]; REFUSE={}; jpost=STAND_IN;
  HWT_RUNNING=false; HWT_MACHINE=''; HWT_NOTE=''; HWT_NEEDS_FILING=false; HWT_SAVES=0;
  MACHINE='HOST1'; NEEDS=false; BOOT={};
  for (const k of HWT_KEYS) { delete HWT_RUNNERS[k]; delete HWT_UNSAVED[k]; }
  renderHwTest();`);

// The shell before anything has been tested.
reset();
out.rows = run(`HWT_KEYS.map(k=>({name:k,badge:document.getElementById('hwtStat_'+k).textContent,
  cls:document.getElementById('hwtStat_'+k).className,
  why:document.getElementById('hwtWhy_'+k).textContent,
  btn:document.getElementById('hwtRun_'+k).textContent}))`);
out.emptySummary = el('hwtSummary').innerHTML;
out.emptyCls = el('hwtSummary').className;

// hwOverall, for every combination python sent.
out.overall = run(`IN.combos.map(c=>{const t={};HWT_KEYS.forEach((k,i)=>{t[k]={status:c[i]};});
  return hwOverall(t);})`);

// No runner registered (the shell build): the station could not run it.
reset();
await run(`runHwTest('camera')`);
out.noRunner = run(`HWTEST.camera`);
out.noRunnerBadge = el('hwtStat_camera').textContent;
out.noRunnerWhy = el('hwtWhy_camera').textContent;
out.noRunnerSaved = run(`SAVED.length`);

// A runner that throws, and one that records nothing: neither is a failure.
reset();
run(`HWT_RUNNERS.speaker=async()=>{throw new Error('no audio sink on this machine');};
     HWT_RUNNERS.keyboard=async()=>{};`);
await run(`runHwTest('speaker')`);
await run(`runHwTest('keyboard')`);
out.threw = run(`HWTEST.speaker`);
out.silent = run(`HWTEST.keyboard`);

// A technician's answers: pass, needs-attention, fail.
reset();
run(`hwPass('speaker',{left:'PASSED',right:'PASSED',mixer:'unmuted Master and Speaker, set to 80%'});
     hwPass('keyboard',{detectedKeys:104,expectedKeys:104,missingKeys:[]});`);
out.partial = { html: el('hwtSummary').innerHTML, cls: el('hwtSummary').className };
run(`hwAttention('screen','1 bright pixel reported by the technician',null,{deadPixels:1});`);
out.three = el('hwtSummary').innerHTML;
run(`hwPass('camera',{device:'Integrated Camera'});`);
out.fourAttention = { html: el('hwtSummary').innerHTML, cls: el('hwtSummary').className };
run(`hwFail('camera','the technician found the picture is black');`);
out.fourFailed = { html: el('hwtSummary').innerHTML, cls: el('hwtSummary').className };
reset();
run(`for(const k of HWT_KEYS) hwPass(k,{});`);
out.fourPassed = { html: el('hwtSummary').innerHTML, cls: el('hwtSummary').className };
out.passedRows = run(`HWT_KEYS.map(k=>document.getElementById('hwtStat_'+k).textContent+'|'+
  document.getElementById('hwtStat_'+k).className)`);

// Run all tests: every test in order, each one saved as it finishes.
reset();
run(`ORDER=[]; SAVED=[]; for(const k of HWT_KEYS) HWT_RUNNERS[k]=async()=>{ORDER.push(k);hwPass(k,{});};`);
await run(`runAllHwTests()`);
out.order = run(`ORDER`);
out.saves = run(`SAVED.length`);
out.lastSaveBody = run(`SAVED[SAVED.length-1].b`);
out.saveKeys = run(`SAVED.map(s=>Object.keys(s.b))`);
out.buttonsBack = run(`!document.getElementById('hwtRunAll').disabled &&
  !document.getElementById('hwtRun_screen').disabled`);

// The station service refuses the save: the result is on screen and says so.
reset();
run(`REFUSE={screen:'The screen test was recorded as "needs attention" with no reason.'};
     hwPass('screen',{});`);
await run(`hwSave('screen')`);
out.saveFailed = { msg: el('hwtSaveMsg').textContent,
  shown: !el('hwtSaveMsg').classList.contains('hidden') };

// ...and the NEXT test saving does not quietly erase it. The station's copy
// says "not tested" for the one it refused, so taking that object wholesale
// put the technician's answer back to Not tested and hid the warning with it.
reset();
run(`REFUSE={speaker:'The speaker test was recorded as "failed" with no reason.'};
     hwFail('speaker','the technician heard nothing from either speaker');`);
await run(`hwSave('speaker')`);
run(`hwPass('camera',{device:'Integrated Camera'});`);
await run(`hwSave('camera')`);
out.afterOther = { speaker: el('hwtStat_speaker').textContent,
  camera: el('hwtStat_camera').textContent, summary: el('hwtSummary').innerHTML,
  msg: el('hwtSaveMsg').textContent,
  shown: !el('hwtSaveMsg').classList.contains('hidden') };

// A result is protected from the moment it is recorded, but nothing is said
// until the station has actually refused it - otherwise every ordinary save
// would flash "NOT saved" on its way past.
reset();
run(`hwPass('keyboard',{});`);
out.justRecorded = { msgShown: !el('hwtSaveMsg').classList.contains('hidden') };
run(`adoptHwTest(null,'HOST1',false)`);
out.justRecorded.kept = el('hwtStat_keyboard').textContent;

// One test at a time, from EITHER entry point: a second tap on Test while a
// test is in flight must not start the same runner again underneath it.
reset();
run(`STARTS=0; RELEASE=null; HOLD=new Promise(r=>{RELEASE=r;});
     HWT_RUNNERS.speaker=async()=>{STARTS++; await HOLD; hwPass('speaker',{});};`);
const running = run(`runHwTest('speaker')`);
out.lock = { started: run(`STARTS`),
  rowDisabled: run(`document.getElementById('hwtRun_speaker').disabled`),
  allDisabled: run(`document.getElementById('hwtRunAll').disabled`) };
run(`runHwTest('speaker'); runAllHwTests();`);
out.lock.startsWhileRunning = run(`STARTS`);
run(`RELEASE()`);
await running;
out.lock.startsAfter = run(`STARTS`);
out.lock.buttonsBack = run(`!document.getElementById('hwtRun_speaker').disabled &&
  !document.getElementById('hwtRunAll').disabled`);

// A different machine on the bench. The station drops its copy (carry_forward)
// and names the machine it now holds one for; the card must follow it down
// rather than keeping a completed verdict for hardware never tested.
const fourPasses = () => {
  reset();
  run(`for(const k of HWT_KEYS) HWT_RUNNERS[k]=async()=>{hwPass(k,{});};`);
  return run(`runAllHwTests()`);
};
await fourPasses();
out.beforeSwap = { summary: el('hwtSummary').innerHTML, machine: run(`HWT_MACHINE`) };
run(`adoptHwTest(null,'HOST2',false)`);
out.swapped = { summary: el('hwtSummary').innerHTML,
  speaker: el('hwtStat_speaker').textContent, msg: el('hwtSaveMsg').textContent,
  shown: !el('hwtSaveMsg').classList.contains('hidden') };

// The station SERVICE restarted: the same machine, but its copy is gone - the
// test is in its memory only. The card must not keep claiming 4 / 4.
await fourPasses();
run(`adoptHwTest(null,'HOST1',false)`);
out.restarted = { summary: el('hwtSummary').innerHTML, msg: el('hwtSaveMsg').textContent };

// An answer that was already in flight when the last save landed carries the
// older copy: dropped, or a saved result would read as Not tested.
await fourPasses();
run(`adoptHwTest(null,'HOST1',false,HWT_SAVES-1)`);
out.stalePoll = el('hwtSummary').innerHTML;

// A result the station REFUSED is not dropped by an adopt either: the station
// has not got it to hand back.
reset();
run(`REFUSE={screen:'The station service is busy.'}; hwPass('screen',{});`);
await run(`hwSave('screen')`);
run(`adoptHwTest(null,'HOST1',false)`);
out.unsavedKept = { screen: el('hwtStat_screen').textContent,
  msg: el('hwtSaveMsg').textContent };

// Saved here, but the audit was already filed without it.
reset();
run(`NEEDS=true; HWT_RUNNERS.camera=async()=>{hwPass('camera',{});};`);
await run(`runHwTest('camera')`);
out.needsFiling = { msg: el('hwtSaveMsg').textContent,
  shown: !el('hwtSaveMsg').classList.contains('hidden') };

// No technician name: the message must name the control that is ON SCREEN -
// renderSignin hides the Operator field whenever sign-in is on.
reset();
run(`BOOT={signin:{required:true}}; hwPass('camera',{});`);
out.noNameSignin = el('hwtSummary').innerHTML;
run(`BOOT={signin:{required:false}}; renderHwTest();`);
out.noNameOperator = el('hwtSummary').innerHTML;

// What the station already holds is shown on a reloaded screen, but never
// painted over a run in progress.
reset();
run(`adoptHwTest(IN.stored)`);
out.adopted = { summary: el('hwtSummary').innerHTML, speaker: el('hwtStat_speaker').textContent,
  why: el('hwtWhy_speaker').textContent };
run(`hwPass('camera',{}); adoptHwTest(IN.stored);`);
out.notClobbered = run(`HWTEST.camera.status`);

out.cardText = run(`HWT_KEYS.map(k=>document.getElementById('hwtStat_'+k).textContent+' '+
  document.getElementById('hwtWhy_'+k).textContent).join(' ')`) + ' ' + el('hwtSummary').innerHTML;
process.stdout.write(JSON.stringify(out));
"""
    with open(harness, "w", encoding="utf-8") as fh:
        fh.write("(async () => {\n" + body +
                 "\n})().catch(e => { console.error(e); process.exit(3); });\n")
    stored = {"status": "ATTENTION", "completed": 4, "total": 4, "technician": "Ann Operator",
              "testedAt": "2026-09-20T12:00:00Z", "clockWasNetwork": True,
              "speaker": {"status": "ATTENTION",
                          "reason": "the station could not unmute this machine",
                          "action": "Turn the volume up on the machine itself, then test again.",
                          "notes": ""},
              "keyboard": {"status": "PASSED", "reason": None, "action": None, "notes": ""},
              "camera": {"status": "PASSED", "reason": None, "action": None, "notes": ""},
              "screen": {"status": "PASSED", "reason": None, "action": None, "notes": ""},
              "history": []}
    inp = os.path.join(TMP, "in.json")
    with open(inp, "w", encoding="utf-8") as fh:
        json.dump({"combos": COMBOS, "stored": stored}, fh)
    r = subprocess.run([node, harness, js, inp], capture_output=True)
    try:
        o = json.loads(r.stdout.decode("utf-8"))
    except ValueError:
        o = {}
        print(r.stderr.decode("utf-8", "replace")[-3000:])
    check("the page's script runs at all", bool(o), r.stderr.decode("utf-8", "replace")[-800:])

    # The page returns the same three fields plus what only a screen needs
    # (the "N / 4 completed" line, and an empty verdict while the run is not
    # finished); the rule itself is those three.
    JS_OVERALL = [{k: v for k, v in x.items() if k in ("status", "completed", "total")}
                  for x in (o.get("overall") or [])]
    disagree = [(c, a, b) for c, a, b in zip(COMBOS, JS_OVERALL, WANT) if a != b]
    check("the page's hwOverall agrees with the contract in all 625 combinations",
          JS_OVERALL and not disagree, disagree[:4])

    rows = o.get("rows") or []
    check("the shell shows four tests, each 'Not tested' in words and in colour",
          len(rows) == 4 and all(x["badge"] == "Not tested" and "na" in x["cls"] for x in rows), rows)
    check("each row says what the test will do before it is run",
          all(x["why"].startswith("Not run yet.") for x in rows), rows)
    check("before anything is tested the summary is '0 / 4 completed' with NO verdict",
          "0 / 4 completed" in o.get("emptySummary", "")
          and not any(w in o.get("emptySummary", "") for w in ("Passed", "Failed", "Needs attention"))
          and "na" in o.get("emptyCls", ""), (o.get("emptySummary"), o.get("emptyCls")))

    nr = o.get("noRunner") or {}
    check("a test this build cannot run is ATTENTION with a reason and an action, never FAILED",
          nr.get("status") == "ATTENTION" and "does not include the camera test" in (nr.get("reason") or "")
          and "sync-usb.ps1" in (nr.get("action") or ""), nr)
    check("and it is said in words on the row", o.get("noRunnerBadge") == "Needs attention"
          and "camera test" in (o.get("noRunnerWhy") or ""), o.get("noRunnerWhy"))
    check("a result is saved the moment the test ends, not at the end of the run",
          o.get("noRunnerSaved") == 1, o.get("noRunnerSaved"))
    check("a test that throws is ATTENTION with what happened, never FAILED",
          (o.get("threw") or {}).get("status") == "ATTENTION"
          and "no audio sink" in ((o.get("threw") or {}).get("reason") or ""), o.get("threw"))
    check("a test that records nothing does not leave the row stuck on 'Testing…'",
          (o.get("silent") or {}).get("status") == "ATTENTION"
          and "without recording a result" in ((o.get("silent") or {}).get("reason") or ""), o.get("silent"))

    check("two tests done: '2 / 4 completed' and still no verdict",
          "2 / 4 completed" in (o.get("partial") or {}).get("html", "")
          and "Passed" not in (o.get("partial") or {}).get("html", "")
          and "na" in (o.get("partial") or {}).get("cls", ""), o.get("partial"))
    check("three done is still no verdict", "3 / 4 completed" in o.get("three", "")
          and "Needs attention" not in o.get("three", ""), o.get("three"))
    check("all four with one ATTENTION: 'Needs attention', in words and amber",
          "4 / 4 completed — Needs attention" in (o.get("fourAttention") or {}).get("html", "")
          and "warn" in (o.get("fourAttention") or {}).get("cls", ""), o.get("fourAttention"))
    check("one FAILED wins, in words and red",
          "4 / 4 completed — Failed" in (o.get("fourFailed") or {}).get("html", "")
          and "bad" in (o.get("fourFailed") or {}).get("cls", ""), o.get("fourFailed"))
    check("four passes: 'Passed', in words and green",
          "4 / 4 completed — Passed" in (o.get("fourPassed") or {}).get("html", "")
          and "ok" in (o.get("fourPassed") or {}).get("cls", ""), o.get("fourPassed"))
    check("the rows say Passed in words too", o.get("passedRows")
          and all(x.startswith("Passed|hwtb ok") for x in o["passedRows"]), o.get("passedRows"))
    # "20 Sep 2026" or "20 Sept 2026" - the month's short name is the
    # browser's, and node's and Firefox's differ.
    check("the summary names the technician and when it was tested",
          "Ann Operator" in (o.get("adopted") or {}).get("summary", "")
          and re.search(r"20 Sept? 2026", (o.get("adopted") or {}).get("summary", "")),
          o.get("adopted"))

    check("Run all tests runs all four, in order", o.get("order") == TESTS, o.get("order"))
    check("each one is saved as it finishes", o.get("saves") == 4, o.get("saves"))
    # One test per save: the station treats everything it is sent as a NEW
    # result, so re-sending the three that have not changed would file three
    # retests that never happened, every time.
    check("a save names only the test that has just run, and sets no verdict of its own",
          isinstance(o.get("lastSaveBody"), dict)
          and list(o["lastSaveBody"].keys()) == ["screen"], o.get("lastSaveBody"))
    check("every save names exactly one test", o.get("saveKeys") == [[k] for k in TESTS],
          o.get("saveKeys"))
    check("the controls come back when the run ends", o.get("buttonsBack") is True)

    sf = o.get("saveFailed") or {}
    check("a result that could not be saved says so, instead of looking saved",
          sf.get("shown") is True and "NOT saved" in sf.get("msg", "")
          and "needs attention" in sf.get("msg", ""), sf)

    ao = o.get("afterOther") or {}
    check("a refused result is still on screen after the NEXT test saves fine",
          ao.get("speaker") == "Failed" and ao.get("camera") == "Passed", ao)
    check("...and the warning is still up, naming only what is still unsaved",
          ao.get("shown") is True and "NOT saved" in ao.get("msg", "")
          and "speaker" in ao.get("msg", "") and "camera" not in ao.get("msg", ""), ao)
    check("...and the count says two tests are done, not one",
          "2 / 4 completed" in ao.get("summary", ""), ao.get("summary"))

    jr = o.get("justRecorded") or {}
    check("a result just recorded is protected from the station's copy without "
          "putting a warning on screen for every ordinary save",
          jr.get("msgShown") is False and jr.get("kept") == "Passed", jr)

    lk = o.get("lock") or {}
    check("a test in flight disables both its own row and Run all",
          lk.get("rowDisabled") is True and lk.get("allDisabled") is True, lk)
    check("pressing Test or Run all again does NOT start a second run of the same test",
          lk.get("started") == 1 and lk.get("startsWhileRunning") == 1, lk)
    check("and the controls come back when that single test ends",
          lk.get("startsAfter") == 1 and lk.get("buttonsBack") is True, lk)

    check("four passes, saved, belong to the machine the station names",
          "4 / 4 completed — Passed" in (o.get("beforeSwap") or {}).get("summary", "")
          and (o.get("beforeSwap") or {}).get("machine") == "HOST1", o.get("beforeSwap"))
    sw = o.get("swapped") or {}
    check("a Rescan onto a DIFFERENT machine clears the card instead of keeping the verdict",
          "0 / 4 completed" in sw.get("summary", "") and "Passed" not in sw.get("summary", "")
          and sw.get("speaker") == "Not tested", sw)
    check("...and says why, rather than the rows just changing under the technician",
          sw.get("shown") is True and "machine on the bench changed" in sw.get("msg", ""), sw)
    rs = o.get("restarted") or {}
    check("the station losing its copy (a service restart) clears the card too",
          "0 / 4 completed" in rs.get("summary", "") and "Passed" not in rs.get("summary", ""), rs)
    check("...and says the station no longer holds it, so it is not on the record",
          "no longer holds" in rs.get("msg", "") and "again" in rs.get("msg", ""), rs)
    check("an answer already in flight when a save landed is dropped, not painted back",
          "4 / 4 completed — Passed" in (o.get("stalePoll") or ""), o.get("stalePoll"))
    uk = o.get("unsavedKept") or {}
    check("a result the station refused survives an adopt - it has none to hand back",
          uk.get("screen") == "Passed" and "NOT saved" in uk.get("msg", ""), uk)

    nf = o.get("needsFiling") or {}
    check("a test saved after the audit was filed says the record does not carry it",
          nf.get("shown") is True and "not on the machine" in nf.get("msg", "")
          and "Start audit again" in nf.get("msg", ""), nf)
    check("with sign-in on, an unnamed technician is told to SIGN IN",
          "sign in at the top" in (o.get("noNameSignin") or ""), o.get("noNameSignin"))
    check("with it off, they are told to set Operator - the control that is on screen",
          "set Operator at the top" in (o.get("noNameOperator") or ""), o.get("noNameOperator"))

    ad = o.get("adopted") or {}
    check("a reloaded screen shows what the station already holds",
          ad.get("speaker") == "Needs attention"
          and "could not unmute" in ad.get("why", "")
          and "4 / 4 completed — Needs attention" in ad.get("summary", ""), ad)
    check("but the station's older copy is never painted over a result just recorded here",
          o.get("notClobbered") == "PASSED", o.get("notClobbered"))
    check("nothing on the card ever says 'Unknown'",
          "nknown" not in (o.get("cardText") or "x"), o.get("cardText"))

# -------------------------------------------------------- 5. the endpoints --
print("5. the station's own service")
srv.CONF_PATH = None
srv.STATE["conf"] = {"AUDIT_URL": "https://als-inventory-software-production.up.railway.app"}
srv.STATE["hwtest"] = None
srv.STATE["hwtestMachine"] = ""
srv.STATE["operator"] = "Ann Operator"
srv.STATE["userName"] = ""
srv.STATE["profile"] = {"identification": {"manufacturer": "Dell", "model": "Latitude 7490",
                                           "serialNumber": "HOST1"},
                        "storage": [], "cpu": {}, "memory": {}}
srv.report_now = lambda *a, **k: None
srv.list_drives = lambda *a, **k: []
srv.list_os_images = lambda *a, **k: []
srv.queue_status = lambda *a, **k: {"waiting": 0, "waitingHeld": 0, "waitingRejected": 0,
                                    "waitingRejectedWipes": 0, "rejected": [], "queueDurable": True}
srv.operator_gate = lambda *a, **k: None
UPLOADED = []
srv.upload_audit = lambda payload: (UPLOADED.append(copy.deepcopy(payload))
                                    or ({"assetId": "a-1"}, False, ""))

httpd = ThreadingHTTPServer(("127.0.0.1", 0), srv.Handler)
PORT = httpd.server_address[1]
srv.PORT = PORT
threading.Thread(target=httpd.serve_forever, daemon=True).start()


def call(method, path, body=None):
    c = http.client.HTTPConnection("127.0.0.1", PORT, timeout=10)
    raw = json.dumps(body).encode() if body is not None else b""
    headers = {"Content-Type": "application/json"} if method == "POST" else {}
    c.request(method, path, raw if method == "POST" else None, headers)
    r = c.getresponse()
    data = r.read()
    c.close()
    try:
        return r.status, json.loads(data or b"{}")
    except ValueError:
        return r.status, data


try:
    code, ans = call("GET", "/api/hwtest")
    check("nothing tested yet reads back as nothing, not as a verdict",
          code == 200 and ans["hardwareTest"] is None and ans["tests"] == TESTS, (code, ans))
    code, ans = call("POST", "/api/hwtest", {"speaker": {
        "status": "PASSED", "left": "PASSED", "right": "PASSED",
        "mixer": "unmuted Master and Speaker, set to 80%",
        "sink": "Built-in Audio Analogue Stereo"}})
    saved = (ans or {}).get("hardwareTest") or {}
    check("one test saved: the other three are 'not tested', and there is NO verdict",
          code == 200 and saved.get("completed") == 1 and saved.get("status") == "IN_PROGRESS"
          and saved["camera"]["status"] == "NOT_TESTED", (code, saved))
    check("the station stamps who tested it - the Operator named in the header",
          saved.get("technician") == "Ann Operator", saved.get("technician"))
    check("and when, with the same clock caveat every wipe record carries",
          srv.ISO_UTC.match(saved.get("testedAt") or "")
          and isinstance(saved.get("clockWasNetwork"), bool), saved)
    check("the result goes straight into the profile, where the record will carry it",
          srv.STATE["profile"].get("hardwareTest") == saved)

    code, ans = call("GET", "/api/hwtest")
    check("it reads back exactly as it was stored", code == 200 and ans["hardwareTest"] == saved)

    code, boot = call("GET", "/api/bootstrap")
    check("every bootstrap carries it, so a reloaded screen is not a blank test",
          code == 200 and boot.get("hardwareTest") == saved, code)

    code, ans = call("POST", "/api/hwtest", {"speaker": {
        "status": "FAILED", "reason": "the technician heard nothing from the right speaker"}})
    saved2 = (ans or {}).get("hardwareTest") or {}
    check("a retest replaces the result but never deletes it (owner's §12)",
          saved2["speaker"]["status"] == "FAILED" and len(saved2["history"]) == 1
          and saved2["history"][0]["test"] == "speaker"
          and saved2["history"][0]["status"] == "PASSED", saved2.get("history"))
    check("one test failed, three not tested: still no overall verdict",
          saved2["status"] == "IN_PROGRESS" and saved2["completed"] == 1, saved2["status"])

    code, ans = call("POST", "/api/hwtest", {"keyboard": {"status": "PASSED"}})
    saved3 = (ans or {}).get("hardwareTest") or {}
    check("saving the next test does not touch the one before it, or its history",
          saved3["speaker"] == saved2["speaker"] and len(saved3["history"]) == 1,
          (saved3.get("speaker"), saved3.get("history")))

    code, ans = call("POST", "/api/hwtest", {"camera": {"status": "ATTENTION"}})
    check("the service refuses a non-pass with no reason, in plain English",
          code == 400 and "reason" in (ans.get("message") or ""), (code, ans))
    code, ans = call("POST", "/api/hwtest", {"camera": {"status": "MAYBE"}})
    check("and a state it does not know", code == 400 and "NOT_TESTED" in (ans.get("message") or ""),
          (code, ans))
    check("a refused save leaves what was already stored alone",
          srv.STATE["hwtest"]["speaker"]["status"] == "FAILED")

    # Who the technician is, when operators sign in with their own account.
    real_on, real_who = srv.operator_signin_on, srv.operator_identity
    srv.operator_signin_on = lambda: True
    srv.operator_identity = lambda: {"id": "u-1", "name": "Bea Signed-In", "email": "bea@als.test"}
    try:
        code, ans = call("POST", "/api/hwtest", {"keyboard": {"status": "PASSED"}})
        check("with operator sign-in on, the technician is the signed-in account",
              ans["hardwareTest"]["technician"] == "Bea Signed-In", ans.get("hardwareTest"))
    finally:
        srv.operator_signin_on, srv.operator_identity = real_on, real_who

    # The audit payload is rebuilt from a FIXED key set - the test must still
    # reach the API, inside the profile.
    UPLOADED[:] = []
    code, ans = call("POST", "/api/audit", {"lotId": "lot-1"})
    sent = UPLOADED[0] if UPLOADED else {}
    check("/api/audit still carries the hardware test, inside the profile",
          code == 200 and sent.get("profile", {}).get("hardwareTest") == srv.STATE["hwtest"],
          (code, sorted(sent.keys()) if sent else ans))

    # WHERE the result actually is. Saving a test sends it nowhere: it waits
    # inside the profile until an audit or a wipe files it. Start audit sits
    # ABOVE the hardware test card, so testing after filing is the natural
    # order - and until this said so, the card claimed the result was on the
    # machine's record when nothing had carried it there.
    srv.STATE["recordFiled"], srv.STATE["hwtestFiled"] = False, False
    code, ans = call("POST", "/api/hwtest", {"screen": {"status": "PASSED"}})
    check("a save names the machine the station is holding the test for",
          ans.get("hwtestMachine") == "HOST1", ans.get("hwtestMachine"))
    check("a test run before the audit has nothing to warn about",
          ans.get("hwtestNeedsFiling") is False, ans)
    call("POST", "/api/audit", {"lotId": "lot-1"})
    code, ans = call("GET", "/api/hwtest")
    check("filing the audit puts it on the record, so there is nothing left to do",
          ans.get("hwtestNeedsFiling") is False, ans)
    code, ans = call("POST", "/api/hwtest", {"camera": {"status": "PASSED"}})
    check("a test run AFTER the audit was filed says the record does not carry it",
          ans.get("hwtestNeedsFiling") is True, ans)
    code, boot = call("GET", "/api/bootstrap")
    check("and every bootstrap says so too, so a reloaded screen still warns",
          boot.get("hwtestNeedsFiling") is True and boot.get("hwtestMachine") == "HOST1", boot)
    call("POST", "/api/audit", {"lotId": "lot-1"})
    code, ans = call("GET", "/api/hwtest")
    check("pressing Start audit again is what clears it",
          ans.get("hwtestNeedsFiling") is False, ans)

    # Operator sign-in on, nobody signed in. /api/hwtest is deliberately not
    # gated, so this is reachable - and the shared account this stick logged in
    # with names a stick, not a person.
    srv.STATE["conf"]["AUDIT_EMAIL"] = "station-stick@als.test"
    srv.operator_signin_on = lambda: True
    srv.operator_identity = lambda: None
    try:
        code, ans = call("POST", "/api/hwtest", {"keyboard": {"status": "PASSED"}})
        check("with sign-in on and nobody signed in, the test is NOT stamped with the "
              "shared stick account or the hidden Operator field",
              ans["hardwareTest"]["technician"] == "", ans["hardwareTest"].get("technician"))
    finally:
        srv.operator_signin_on, srv.operator_identity = real_on, real_who
finally:
    httpd.shutdown()

# Every place that sends a profile to the API has to go through the one
# function that puts the test inside it, or the field silently vanishes again.
with open(SERVER, encoding="utf-8") as fh:
    code_lines = [l for l in fh.read().splitlines() if '"profile":' in l]
missed = [l.strip() for l in code_lines
          if "attach_hardware_test" not in l and '"profile": None' not in l]
check("every record that sends a profile goes through attach_hardware_test",
      not missed, missed)

# --------------------------------------------------- 6. the re-audit hazard --
print("6. a Rescan must not destroy a hardware test")
SAME = {"identification": {"manufacturer": "Dell", "model": "Latitude 7490",
                           "serialNumber": "HOST1"}, "storage": []}
OTHER = {"identification": {"manufacturer": "HP", "model": "EliteBook",
                            "serialNumber": "HOST2"}, "storage": []}
NONAME = {"identification": {"manufacturer": "Whitebox", "model": "PC"}, "storage": []}

srv.STATE["hwtest"] = None
srv.STATE["hwtestMachine"] = ""
srv.STATE["profile"] = copy.deepcopy(SAME)
srv.hwtest_save({"screen": {"status": "ATTENTION", "reason": "1 bright pixel reported by the technician",
                            "notes": "One bright pixel, top right", "deadPixels": 1}})
KEPT = copy.deepcopy(srv.STATE["hwtest"])


def rescan_with(profile):
    """A real Rescan: refresh() with the capture stubbed, so the test covers
    the line in refresh() and not just the helper under it."""
    srv.capture = (lambda: (copy.deepcopy(profile), "summary")) if profile is not None \
        else (lambda: (_ for _ in ()).throw(RuntimeError("the engine found no hardware")))
    srv.refresh(do_login=False)


real_capture = srv.capture
try:
    rescan_with(SAME)
    check("the same machine re-scanned keeps its hardware test, inside the new profile",
          (srv.STATE["profile"] or {}).get("hardwareTest") == KEPT,
          (srv.STATE["profile"] or {}).get("hardwareTest"))
    check("the test itself is unchanged by a re-capture", srv.STATE["hwtest"] == KEPT)

    rescan_with(None)
    check("a failed capture forgets the machine but not the test",
          srv.STATE["profile"] is None and srv.STATE["hwtest"] == KEPT, srv.STATE["error"])
    rescan_with(SAME)
    check("and the test is back in the profile once a capture works again",
          (srv.STATE["profile"] or {}).get("hardwareTest") == KEPT)

    rescan_with(NONAME)
    check("a machine that reports no serial is not proof of a DIFFERENT machine, "
          "so the test is kept", srv.STATE["hwtest"] == KEPT
          and (srv.STATE["profile"] or {}).get("hardwareTest") == KEPT, srv.STATE["hwtest"])

    rescan_with(OTHER)
    check("a different machine's serial DOES drop it - a test must never be filed "
          "against hardware it was not run on",
          srv.STATE["hwtest"] is None
          and "hardwareTest" not in (srv.STATE["profile"] or {}), srv.STATE["hwtest"])

    # And the whole point of it: the record filed after a Rescan still has it.
    srv.STATE["hwtest"] = None
    srv.STATE["hwtestMachine"] = ""
    srv.STATE["profile"] = copy.deepcopy(SAME)
    srv.hwtest_save({"camera": {"status": "PASSED", "device": "Integrated Camera"}})
    after = copy.deepcopy(srv.STATE["hwtest"])
    rescan_with(SAME)
    payload = {"lotId": "lot-1", "profile": srv.attach_hardware_test(srv.STATE["profile"])}
    check("a record uploaded after a Rescan still carries the test that was run before it",
          payload["profile"].get("hardwareTest") == after, payload["profile"].get("hardwareTest"))
finally:
    srv.capture = real_capture

# --------------------------------------------- 7. what survives a restart --
# The test lived only in this process's memory, and server.py is started ONCE
# per boot with no restart loop - so a laptop that slept, a dud battery, or the
# keyboard test landing on a power combination took the work with it and said
# nothing. It is kept beside the audit queue now, by the STRICTER rule: across
# a reboot the stick has usually been carried to the next machine, so the test
# is only restored onto a machine that positively proves it is the same one.
print("7. a restart must not lose the test, and must not hand it to another machine")
srv.CONF_PATH = os.path.join(TMP, "audit.conf")
try:
    srv.STATE["hwtest"], srv.STATE["hwtestMachine"] = None, ""
    srv.STATE["hwtestPending"] = None
    srv.STATE["profile"] = copy.deepcopy(SAME)
    srv.hwtest_save({"keyboard": {"status": "PASSED", "detectedKeys": 104}})
    ON_DISK = copy.deepcopy(srv.STATE["hwtest"])
    check("a saved result is written to the stick, beside the audit queue",
          os.path.exists(srv.hwtest_path()), srv.hwtest_path())

    def reboot_with(profile):
        """A fresh boot: nothing in memory, the file still on the stick, and
        then the first capture of whatever machine this stick is now in."""
        srv.STATE["hwtest"], srv.STATE["hwtestMachine"] = None, ""
        srv.STATE["hwtestPending"] = None
        srv.STATE["hwtestFiled"], srv.STATE["recordFiled"] = True, True
        srv.hwtest_restore()
        rescan_with(profile)

    reboot_with(SAME)
    check("the same machine gets its test back after a restart",
          srv.STATE["hwtest"] == ON_DISK, srv.STATE["hwtest"])
    check("and it is back inside the profile the next record will carry",
          (srv.STATE["profile"] or {}).get("hardwareTest") == ON_DISK)
    check("a restored test is on no record this run has filed, and says so",
          srv.STATE["hwtestFiled"] is False and srv.STATE["recordFiled"] is False)

    reboot_with(NONAME)
    check("a machine that cannot PROVE it is the same one does not get it - across a "
          "boot the stick has usually been moved to the next machine",
          srv.STATE["hwtest"] is None
          and "hardwareTest" not in (srv.STATE["profile"] or {}), srv.STATE["hwtest"])
    check("and the stale copy is deleted rather than waiting for the next machine",
          not os.path.exists(srv.hwtest_path()))

    srv.STATE["profile"] = copy.deepcopy(SAME)
    srv.hwtest_save({"camera": {"status": "PASSED"}})
    reboot_with(OTHER)
    check("a different serial does not get it either",
          srv.STATE["hwtest"] is None and not os.path.exists(srv.hwtest_path()),
          srv.STATE["hwtest"])

    srv.STATE["profile"] = copy.deepcopy(SAME)
    srv.STATE["hwtestMachine"] = ""
    srv.hwtest_save({"screen": {"status": "PASSED"}})
    srv.STATE["hwtestFiled"], srv.STATE["recordFiled"] = True, True
    rescan_with(OTHER)
    check("swapping machines mid-session deletes the stored copy as well, so the next "
          "boot cannot find it", srv.STATE["hwtest"] is None
          and not os.path.exists(srv.hwtest_path()))
    check("and what was filed for the machine that left is not held against the new one",
          srv.STATE["recordFiled"] is False and srv.hwtest_needs_filing() is False)
    # The same, with no test held at all: the audit filed for the previous
    # machine must not make the next one's first test read as "already filed
    # without it".
    srv.STATE["hwtest"], srv.STATE["hwtestMachine"] = None, "HOST1"
    srv.STATE["hwtestFiled"], srv.STATE["recordFiled"] = True, True
    rescan_with(OTHER)
    srv.hwtest_save({"camera": {"status": "PASSED"}})
    check("a first test on the next machine does not claim an audit was filed without it",
          srv.hwtest_needs_filing() is False, srv.STATE["recordFiled"])

    # ----------------------------- 8. the test on a wipe record -----------
    # A wipe pins its profile at the start (a wipe takes hours, and a Rescan in
    # the middle must not change what the erase is filed under). The hardware
    # test is the exception: it describes the MACHINE, not the erase event.
    print("8. a wipe record carries the test as it is now, not as it was at wipe start")
    srv.STATE["hwtest"], srv.STATE["hwtestMachine"] = None, ""
    srv.STATE["profile"] = copy.deepcopy(SAME)
    srv.hwtest_save({"speaker": {"status": "PASSED"}})
    pinned = {"profile": srv.attach_hardware_test(srv.STATE["profile"]), "auditKind": "goods_in"}
    HALF = copy.deepcopy(pinned["profile"]["hardwareTest"])
    # The Rescan mid-wipe: STATE["profile"] becomes a NEW object, so everything
    # tested afterwards attaches to that one and never to the pinned copy.
    rescan_with(SAME)
    srv.hwtest_save({"camera": {"status": "PASSED"}})
    check("the pinned profile is left holding the half-done test (this is the hazard)",
          pinned["profile"]["hardwareTest"] == HALF)
    built = srv.hwtest_refresh(pinned)
    check("the record built from it carries the tests finished DURING the wipe",
          built["profile"]["hardwareTest"] == srv.STATE["hwtest"]
          and built["profile"]["hardwareTest"]["completed"] == 2,
          built["profile"].get("hardwareTest"))
    check("everything else stays pinned exactly as it was at wipe start",
          {k: v for k, v in built["profile"].items() if k != "hardwareTest"}
          == {k: v for k, v in pinned["profile"].items() if k != "hardwareTest"})
    check("and the pinned profile itself is not changed under the running wipe",
          pinned["profile"]["hardwareTest"] == HALF)

    # A machine swapped in mid-wipe: the station now holds ANOTHER machine's
    # test, and it must not land on this record.
    rescan_with(OTHER)
    srv.hwtest_save({"screen": {"status": "PASSED"}})
    built = srv.hwtest_refresh(pinned)
    check("a test for the machine now on the bench never reaches an earlier machine's "
          "wipe record", built["profile"]["hardwareTest"] == HALF,
          built["profile"].get("hardwareTest"))
finally:
    srv.capture = real_capture

shutil.rmtree(TMP, True)
print("\n%d passed, %d failed" % (PASS[0], len(FAIL)))
sys.exit(1 if FAIL else 0)
