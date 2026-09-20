#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""The trackpad hardware test (contract C6), the fifth runner filled into
index.html.

The shell owns the state machine, the save and the summary; this file exercises
ONLY the trackpad runner in its region. What it proves is the contract for this
one component (owner's §17 and the trackpad brief):

  - the runner registers itself (HWT_RUNNERS.trackpad is a function);
  - the station observes what the browser actually CAN see: real pointer
    movement (a delta over a few pixels, across more than one event - not a
    single stray event), a left-button press and a right-button press, and it
    lights each check in WORDS as well as colour;
  - the right-click fix, the same class as the keyboard's F-key fix: while the
    test is active a contextmenu handler preventDefaults Firefox's own menu AND
    reads the event as the right button, and every listener is scoped to the pad
    and REMOVED on stop / verdict / teardown, so nothing survives to swallow a
    click elsewhere in the kiosk;
  - the technician's verdict is the only thing that records: "Trackpad works" ->
    PASSED with the fields, "Trackpad has an issue" -> FAILED with the note, and
    "No trackpad on this machine" -> a BENIGN N/A, stored as PASSED with
    notApplicable so the worst-wins overall treats it as satisfied, shown neutral
    as N/A, never a green "Passed" and never dragging the unit to needs-attention;
  - the region takes NO keydown handler (the shell forbids that outside the
    keyboard region), and never prints the word this module is forbidden to print.

The runner uses pointer/mouse/contextmenu/wheel events on a pad element, so those
are stood in for under node the way tools/test-hwtest.py and the other per-test
files stand in for the DOM. Without node the browser-driven section SKIPs and
passes, unless ALS_REQUIRE_NODE=1 (set in CI).

    python3 tools/test-hwtest-trackpad.py
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PAGE = os.path.join(HERE, "gui", "index.html")

PASS, FAIL = [0], []


def check(name, cond, detail=""):
    if cond:
        PASS[0] += 1
        print("  ok   %s" % name)
    else:
        FAIL.append(name)
        print("  FAIL %s   %s" % (name, detail))


with open(PAGE, encoding="utf-8") as fh:
    HTML = fh.read()


def region(kind):
    """The text between a pair of trackpad markers, so a claim about 'the
    trackpad region' is checked against that region alone, not the whole page."""
    start = {"CSS": "/* HWTEST:TRACKPAD:CSS:START */", "JS": "/* HWTEST:TRACKPAD:JS:START */",
             "markup": "<!-- HWTEST:TRACKPAD:START -->"}[kind]
    end = {"CSS": "/* HWTEST:TRACKPAD:CSS:END */", "JS": "/* HWTEST:TRACKPAD:JS:END */",
           "markup": "<!-- HWTEST:TRACKPAD:END -->"}[kind]
    i, j = HTML.find(start), HTML.find(end)
    return HTML[i:j] if 0 <= i < j else ""


# ------------------------------------------------------ 1. the region itself --
print("1. the trackpad region is present, closed once, and self-contained")
for kind in ("CSS", "JS", "markup"):
    start = {"CSS": "/* HWTEST:TRACKPAD:CSS:START */", "JS": "/* HWTEST:TRACKPAD:JS:START */",
             "markup": "<!-- HWTEST:TRACKPAD:START -->"}[kind]
    end = {"CSS": "/* HWTEST:TRACKPAD:CSS:END */", "JS": "/* HWTEST:TRACKPAD:JS:END */",
           "markup": "<!-- HWTEST:TRACKPAD:END -->"}[kind]
    check("the trackpad %s region exists exactly once and closes" % kind,
          HTML.count(start) == 1 and HTML.count(end) == 1 and 0 <= HTML.find(start) < HTML.find(end),
          (HTML.count(start), HTML.count(end)))

JS = region("JS")
MK = region("markup")
check("the runner is registered on HWT_RUNNERS.trackpad", "HWT_RUNNERS.trackpad" in JS)
check("the markup row carries the three ids the shell writes into, and a Test button",
      'id="hwtStat_trackpad"' in MK and 'id="hwtWhy_trackpad"' in MK
      and 'id="hwtDetail_trackpad"' in MK and "runHwTest('trackpad')" in MK, MK[:200])
check("it records through the shell's helpers, not by hand",
      "hwPass('trackpad'" in JS and "hwFail('trackpad'" in JS and "hwCannotRun('trackpad'" in JS)
check("the benign N/A is stored as notApplicable, not as a fault", "notApplicable" in JS)
# The right-click fix: the menu is cancelled AND the listener is removable.
check("a right-click on the pad has its context menu preventDefaulted",
      "contextmenu" in JS and "preventDefault" in JS)
check("the contextmenu listener is paired with a removeEventListener (added on start, removed on stop)",
      "addEventListener('contextmenu'" in JS and "removeEventListener('contextmenu'" in JS)
# Every scoped listener the test adds must come off again.
for ev in ("pointermove", "pointerdown", "mousemove", "mousedown", "wheel", "contextmenu"):
    add = "addEventListener('%s'" % ev
    rem = "removeEventListener('%s'" % ev
    check("the %s listener is added and removed, so nothing survives the test" % ev,
          add in JS and rem in JS, ev)
# The shell forbids a global keydown handler; the trackpad needs none.
check("the trackpad region takes NO keydown handler",
      "addEventListener('keydown'" not in JS and 'addEventListener("keydown"' not in JS
      and "onkeydown" not in JS)
check("the trackpad region never prints 'Unknown'",
      "Unknown" not in JS and "Unknown" not in region("CSS") and "Unknown" not in MK,
      "Unknown appears in a trackpad region")


# --------------------------------------------------- 2. the runner, in a page --
print("2. the runner, driven under node with a pointer stand-in")
node = shutil.which("node")
if not node:
    if os.environ.get("ALS_REQUIRE_NODE") == "1":
        check("node is installed (ALS_REQUIRE_NODE=1)", False)
    else:
        print("  SKIP running the trackpad runner under node (node not installed)")
else:
    TMP = tempfile.mkdtemp(prefix="als-hwt-tp-")
    blocks = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", HTML, re.S | re.I)
    js = os.path.join(TMP, "page.js")
    with open(js, "w", encoding="utf-8") as fh:
        fh.write("\n;\n".join(blocks))
    harness = os.path.join(TMP, "h.js")
    # The stand-in provides just enough of a browser to run the trackpad runner:
    # a DOM whose elements remember their listeners (so a pointer/contextmenu
    # event can be fired at the pad, and so a removed listener is provably gone),
    # a window that remembers pagehide handlers, and a getBoundingClientRect so
    # the dot can be positioned. A fired contextmenu event records whether its
    # preventDefault was called - that is how "the menu never appears" is proved.
    body = r"""
const vm = require('vm'), fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');

// --- fake DOM / window ---------------------------------------------------
const els = {};
function mk(id) {
  const handlers = {};
  const e = { id, style: {}, _cls: '', textContent: '', innerHTML: '', value: '',
    disabled: false, options: [], selectedOptions: [], firstElementChild: { style: {} },
    focus() {}, select() {},
    getAttribute() { return null; }, setAttribute() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 460, height: 260 }; },
    addEventListener(t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
    removeEventListener(t, fn) { const a = handlers[t]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } },
    _fire(t, ev) { (handlers[t] || []).slice().forEach(fn => fn(ev || {})); },
    _count(t) { return (handlers[t] || []).length; },
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
const WIN = {};
const window = {
  addEventListener(t, fn) { (WIN[t] = WIN[t] || []).push(fn); },
  removeEventListener(t, fn) { const a = WIN[t]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } },
  URL: { createObjectURL() { return 'blob:fake'; } } };
function fireWindow(t) { (WIN[t] || []).slice().forEach(fn => { try { fn(); } catch (e) {} }); }

const ctx = vm.createContext({ document, window, console, prompt: () => null,
  screen: {}, innerWidth: 0, innerHeight: 0, fetch: () => new Promise(() => {}),
  setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 40)), clearTimeout: (id) => clearTimeout(id),
  setInterval: () => 0 });
vm.runInContext(src, ctx, { filename: 'index.html<script>' });
const run = (c) => vm.runInContext(c, ctx);
const el = (id) => document.getElementById(id);

// A station stand-in so hwSave completes: it merges what it is sent and hands
// the whole object back, so the runner's recorded result reaches SAVED.
run(`SAVED=[]; HELD={};
  jpost=async(u,b)=>{ SAVED.push({u:u,b:JSON.parse(JSON.stringify(b))});
    HELD=Object.assign({technician:'Tester',testedAt:'2026-09-20T12:00:00Z',clockWasNetwork:true},HELD,b);
    return {ok:true,status:200,data:{hardwareTest:JSON.parse(JSON.stringify(HELD)),
      hwtestMachine:'HOST1',hwtestNeedsFiling:false}}; };`);
const reset = () => run(`HWTEST={}; HELD={}; SAVED=[]; HWT_RUNNING=false; HWT_MACHINE=''; HWT_NOTE='';
  HWT_NEEDS_FILING=false; HWT_SAVES=0; BOOT={}; TP.reset();
  for(const k of HWT_KEYS){ delete HWT_UNSAVED[k]; } renderHwTest();`);

function scenario() {
  // A fresh DOM per scenario: in the real page each run rebuilds
  // hwtDetail_trackpad, so old nodes and the listeners on them are gone.
  for (const k in els) delete els[k];
  for (const k in WIN) delete WIN[k];
  reset();
}
// Fire a pointer move at the pad with a real delta (movementX/Y), the way a
// finger dragged across the trackpad arrives.
function move(dx, dy) { el('tpPad')._fire('pointermove', { clientX: 100 + dx, clientY: 80 + dy, movementX: dx, movementY: dy }); }
function down(button) { el('tpPad')._fire('pointerdown', { clientX: 120, clientY: 90, button: button }); }
function ctxmenu() { var ev = { button: 2, clientX: 130, clientY: 95, _pd: false, _sp: false,
  preventDefault() { this._pd = true; }, stopPropagation() { this._sp = true; } }; el('tpPad')._fire('contextmenu', ev); return ev; }
function readTrackpad() {
  return run(`(function(){ var t=HWTEST.trackpad||{};
    return {status:t.status, moved:t.moved, leftClick:t.leftClick, rightClick:t.rightClick,
      scrolled:t.scrolled, confirmedBy:t.confirmedBy, notApplicable:t.notApplicable,
      reason:t.reason, notes:t.notes,
      badge:document.getElementById('hwtStat_trackpad').textContent,
      badgeCls:document.getElementById('hwtStat_trackpad').className,
      why:document.getElementById('hwtWhy_trackpad').textContent,
      saved:(SAVED.length?SAVED[SAVED.length-1].b.trackpad:null)}; })()`);
}

const out = {};
out.registered = run(`typeof HWT_RUNNERS.trackpad`);

// WORKS: a finger moved, a left click and a right click, then "Trackpad works".
// Movement needs two events over the threshold; a single move must NOT light it.
scenario();
run(`TPP = runHwTest('trackpad')`);
out.oneMoveMoved = (function(){ move(100, 0); return run(`TP.moved`); })();   // one event only
move(20, 0); move(20, 0);                                                     // two real moves
out.movedAfterTwo = run(`TP.moved`);
down(0);                                                                      // left button
const ev1 = ctxmenu();                                                        // right button via context menu
out.ctxPrevented = ev1._pd === true;
out.checksLit = run(`[TP.moved, TP.leftClick, TP.rightClick]`);
run(`document.getElementById('tpWorks')._fire('click', {})`);
await run(`TPP`);
out.works = readTrackpad();

// The contextmenu listener is GONE after the verdict: firing it again does not
// call preventDefault, and the pad holds no listeners at all.
const ev2 = ctxmenu();
out.ctxAfterStop = ev2._pd === false;
out.padListenersAfter = run(`['pointermove','pointerdown','mousemove','mousedown','wheel','contextmenu']
  .reduce((n,t)=>n+document.getElementById('tpPad')._count(t),0)`);
out.panelBlanked = run(`document.getElementById('hwtDetail_trackpad').innerHTML===''`);

// A single stray event never lights movement on its own.
scenario();
run(`TPP = runHwTest('trackpad')`);
out.strayMoved = (function(){ move(200, 0); return run(`TP.moved`); })();
run(`document.getElementById('tpWorks')._fire('click', {})`);   // finish the run
await run(`TPP`);

// A right-click that arrives as a mousedown (button 2), not a contextmenu.
scenario();
run(`TPP = runHwTest('trackpad')`);
run(`document.getElementById('tpPad')._fire('mousedown',{button:2,clientX:120,clientY:90})`);
out.rightViaMouse = run(`TP.rightClick`);
run(`document.getElementById('tpWorks')._fire('click', {})`);
await run(`TPP`);

// A two-finger scroll (a wheel event) lights the optional check.
scenario();
run(`TPP = runHwTest('trackpad')`);
run(`document.getElementById('tpPad')._fire('wheel',{deltaY:40})`);
out.scrolled = run(`TP.scrolled`);
run(`document.getElementById('tpWorks')._fire('click', {})`);
await run(`TPP`);
out.scrolledResult = readTrackpad();

// ISSUE: the technician types what is wrong and clicks "Trackpad has an issue".
scenario();
run(`TPP = runHwTest('trackpad')`);
run(`document.getElementById('tpNote').value = 'left button sticks'`);
run(`document.getElementById('tpIssue')._fire('click', {})`);
await run(`TPP`);
out.issue = readTrackpad();

// NO TRACKPAD: a desktop legitimately has none. A benign N/A, stored as PASSED
// with notApplicable, shown neutral, and it must NOT worsen the overall.
scenario();
run(`TPP = runHwTest('trackpad')`);
run(`document.getElementById('tpNone')._fire('click', {})`);
await run(`TPP`);
out.none = readTrackpad();

// The page torn down mid-decision: the pad listeners come off even though no
// verdict was recorded, so nothing is left grabbing pointer events.
scenario();
run(`TPP = runHwTest('trackpad')`);
fireWindow('pagehide');
out.pagehideListeners = run(`['pointermove','pointerdown','wheel','contextmenu']
  .reduce((n,t)=>n+document.getElementById('tpPad')._count(t),0)`);
run(`document.getElementById('tpWorks')._fire('click', {})`);   // let it finish so the harness ends
await run(`TPP`);

process.stdout.write(JSON.stringify(out));
"""
    with open(harness, "w", encoding="utf-8") as fh:
        fh.write("(async () => {\n" + body +
                 "\n})().catch(e => { console.error(e); process.exit(3); });\n")
    r = subprocess.run([node, harness, js], capture_output=True)
    try:
        o = json.loads(r.stdout.decode("utf-8"))
    except ValueError:
        o = {}
        print(r.stderr.decode("utf-8", "replace")[-3000:])
    check("the page's script runs and the runner drives", bool(o),
          r.stderr.decode("utf-8", "replace")[-800:])

    check("HWT_RUNNERS.trackpad is a function", o.get("registered") == "function", o.get("registered"))

    # Movement: a real journey, not one stray event.
    check("a single move event does NOT light 'Movement seen'", o.get("oneMoveMoved") is False, o.get("oneMoveMoved"))
    check("a real drag across the pad (more than one event, enough pixels) does",
          o.get("movedAfterTwo") is True, o.get("movedAfterTwo"))
    check("a single stray event never lights movement on its own",
          o.get("strayMoved") is False, o.get("strayMoved"))

    # The right-click fix.
    check("a right-click on the pad has Firefox's context menu preventDefaulted",
          o.get("ctxPrevented") is True, o.get("ctxPrevented"))
    check("movement, left and right are all seen before the verdict",
          o.get("checksLit") == [True, True, True], o.get("checksLit"))
    check("a right-click can also arrive as a mousedown (button 2)",
          o.get("rightViaMouse") is True, o.get("rightViaMouse"))

    w = o.get("works") or {}
    check("'Trackpad works' stores PASSED with the fields the contract wants",
          w.get("status") == "PASSED" and w.get("moved") is True and w.get("leftClick") is True
          and w.get("rightClick") is True and w.get("confirmedBy") == "technician"
          and w.get("badge") == "Passed", w)
    check("...and the same fields reach the station (not whitelisted away)",
          (w.get("saved") or {}).get("status") == "PASSED"
          and (w.get("saved") or {}).get("leftClick") is True, w.get("saved"))

    # The listener discipline: nothing survives the verdict.
    check("after the verdict, firing the context menu again does NOT preventDefault - the listener is gone",
          o.get("ctxAfterStop") is True, o.get("ctxAfterStop"))
    check("after the verdict, the pad holds no listeners at all",
          o.get("padListenersAfter") == 0, o.get("padListenersAfter"))
    check("...and the panel is blanked so it takes no more input",
          o.get("panelBlanked") is True, o.get("panelBlanked"))
    check("a page torn down mid-decision still takes the pad listeners off",
          o.get("pagehideListeners") == 0, o.get("pagehideListeners"))

    sc = o.get("scrolledResult") or {}
    check("a two-finger scroll (wheel) lights the optional check and is recorded",
          o.get("scrolled") is True and sc.get("scrolled") is True, (o.get("scrolled"), sc))

    iss = o.get("issue") or {}
    check("'Trackpad has an issue' stores FAILED with the note as the reason",
          iss.get("status") == "FAILED" and "left button sticks" in (iss.get("reason") or "")
          and iss.get("badge") == "Failed", iss)

    na = o.get("none") or {}
    check("'No trackpad on this machine' is a benign N/A: PASSED with notApplicable, NEVER FAILED",
          na.get("status") == "PASSED" and na.get("notApplicable") is True, na)
    check("...shown neutral in words as N/A, never a green 'Passed'",
          na.get("badge") == "N/A" and "na" in (na.get("badgeCls") or "")
          and "ok" not in (na.get("badgeCls") or ""), (na.get("badge"), na.get("badgeCls")))
    check("...and the row says why in plain English (no trackpad fitted), never 'Unknown'",
          "no trackpad fitted" in (na.get("why") or "") and "Unknown" not in (na.get("why") or ""),
          na.get("why"))

    # The whole rule, restated: only a person's "issue" is ever a FAILED.
    check("nothing but the technician's 'issue' verdict is ever recorded as FAILED",
          (o.get("works") or {}).get("status") != "FAILED"
          and (o.get("none") or {}).get("status") != "FAILED"
          and (o.get("scrolledResult") or {}).get("status") != "FAILED", o.get("none"))

    shutil.rmtree(TMP, True)

print("\n%d passed, %d failed" % (PASS[0], len(FAIL)))
sys.exit(1 if FAIL else 0)
