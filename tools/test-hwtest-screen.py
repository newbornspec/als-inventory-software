#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""The SCREEN hardware test (contract C6), the one region it owns.

The shell (tools/test-hwtest.py) proves the five-state machine, the save and
the carry-forward. This proves the SCREEN test that drops into it: paint the
whole viewport one colour at a time, let the technician hunt for dead pixels,
and record exactly one result.

The rules this file pins down:
  1. The runner registers itself (HWT_RUNNERS.screen).
  2. A technician PASS stores PASSED with the contract's fields
     (deadPixels, coloursShown, notes).
  3. "Needs attention" stores ATTENTION with a plain-English reason, and a FAIL
     stores FAILED - only the human's choice sets the state.
  4. THE rule that keeps the module honest: a test the station could not RUN is
     ATTENTION with a reason and an action - NEVER FAILED.
  5. The colour overlay is escapable: Escape takes it down without recording
     anything, so a technician is never trapped on a colour. (The visible Close
     is the real safety hatch on a machine whose keyboard is dead; the same
     handler backs both.)
  6. The region never says "Unknown", and never binds a global key handler.

Section 5 needs node and drives index.html under a DOM stand-in, the way
tools/test-hwtest.py and tools/test-drive-health.py do. Without node it says
SKIP and passes, unless ALS_REQUIRE_NODE=1 (set in CI).

    python3 tools/test-hwtest-screen.py
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
AUTOSTART = os.path.join(HERE, "gui", "als-autostart.sh")

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


def region(start, end):
    i, j = HTML.find(start), HTML.find(end)
    return HTML[i:j] if (i >= 0 and j > i) else ""


CSS = region("/* HWTEST:SCREEN:CSS:START */", "/* HWTEST:SCREEN:CSS:END */")
MARKUP = region("<!-- HWTEST:SCREEN:START -->", "<!-- HWTEST:SCREEN:END -->")
JS = region("/* HWTEST:SCREEN:JS:START */", "/* HWTEST:SCREEN:JS:END */")
MINE = CSS + "\n" + MARKUP + "\n" + JS

# ------------------------------------------------------ 1. the region text --
print("1. the screen region, read straight out of index.html")
check("all three screen regions are present and close", bool(CSS) and bool(MARKUP) and bool(JS),
      (len(CSS), len(MARKUP), len(JS)))
check("the runner registers itself", "HWT_RUNNERS.screen=asyncfunction" in JS.replace(" ", ""),
      JS[:200])
check("it stores the contract's screen fields (deadPixels, coloursShown, notes)",
      "deadPixels" in JS and "coloursShown" in JS and "notes" in JS)
check("it paints all five colours the contract names",
      all(c in JS for c in ("black", "white", "red", "green", "blue")), JS[:400])
check("the region NEVER says 'Unknown' (owner's §8)", "nknown" not in MINE,
      [m.start() for m in re.finditer("nknown", MINE)])
# The screen overlay may not take a global key handler - only the keyboard test
# may, and it gives it up again. An Escape on the overlay ELEMENT via keyup is
# how this test stays out of that rule while still being escapable.
check("the region binds no keydown handler (it uses keyup on the overlay)",
      "keydown" not in JS and "onkeydown" not in MINE, JS[:0])
check("the overlay's Escape is a keyup bound to the element",
      "addEventListener('keyup'" in JS.replace('"', "'"), JS[:0])
check("there is a visible Close, so a keyboard-less machine is never trapped",
      "scr-x" in CSS and "scr-x" in JS and "Close the colours" in JS, "")
check("Escape and Close both call the same close(), which records nothing",
      "SCR.close()" in JS and "SCR.onKey" in JS, "")
check("a could-not-run goes through hwCannotRun, never hwFail",
      "hwCannotRun('screen'" in JS, JS[:0])

# ------------------------------------------------ 2. the station-side duty --
print("2. the station stops the screen blanking (als-autostart.sh, synced)")
with open(AUTOSTART, encoding="utf-8") as fh:
    boot = fh.read()
check("als-autostart.sh turns the screensaver off (xset s off)", re.search(r"xset\s+s\s+off", boot) is not None)
check("...and stops it blanking (xset s noblank)", re.search(r"xset\s+s\s+noblank", boot) is not None)
check("...and turns DPMS power-saving off (xset -dpms)", re.search(r"xset\s+-dpms", boot) is not None)
check("the duty is guarded so a missing xset or display is a no-op, not a boot-stopper",
      "command -v xset" in boot and "DISPLAY" in boot, "")
check("the duty actually runs before the kiosk browser opens",
      boot.find("stop_screen_blanking()") >= 0
      and boot.count("stop_screen_blanking") >= 2, boot.count("stop_screen_blanking"))
# It must be in the SYNCED autostart, never the baked layer session, or shipping
# it would need a layer rebuild (contract C6 shipping note).
check("the duty is NOT put in the baked layer session (that would force a rebuild)",
      not os.path.exists(os.path.join(HERE, "gui", "layer", "als-session.sh"))
      or "stop_screen_blanking" not in open(os.path.join(HERE, "gui", "layer", "als-session.sh"),
                                            encoding="utf-8").read(), "")

# --------------------------------------------------- 3. the runner on node --
print("3. the runner, driven under node")
node = shutil.which("node")
TMP = tempfile.mkdtemp(prefix="als-hwt-screen-")
if not node:
    if os.environ.get("ALS_REQUIRE_NODE") == "1":
        check("node is installed (ALS_REQUIRE_NODE=1)", False)
    else:
        print("  SKIP the runner under node (node not installed)")
else:
    blocks = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", HTML, re.S | re.I)
    js = os.path.join(TMP, "page.js")
    with open(js, "w", encoding="utf-8") as fh:
        fh.write("\n;\n".join(blocks))
    harness = os.path.join(TMP, "h.js")
    body = r"""
const vm = require('vm'), fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const els = {};
function mk(id) {
  const e = { style: {}, _id: id || '', _cls: '', _text: '', _html: '',
    _declaredIds: [], _declaredEls: {}, value: '',
    disabled: false, tabIndex: 0, type: '', tagName: '', children: [], parentNode: null,
    _listeners: {}, options: [], selectedOptions: [], firstElementChild: { style: {} },
    focus() {}, select() {}, setAttribute() {},
    get id() { return this._id; },
    set id(v) { this._id = String(v); if (this._id) els[this._id] = this; },
    // innerHTML like a real browser, not the inert string property it used to be:
    // replacing an element's markup DETACHES the old subtree (so getElementById
    // can no longer find those ids) and registers the ids the new markup declares.
    // The screen runner reads the dead-pixel count and notes out of #scrDead /
    // #scrNotes, which live inside the panel it clears; an inert innerHTML let
    // those still resolve after the clear and hid a real bug where the result was
    // read from an already-blanked panel. This makes that clear actually bite.
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      (this._declaredIds || []).forEach(cid => {
        if (els[cid] === this._declaredEls[cid]) delete els[cid];
      });
      this._declaredIds = []; this._declaredEls = {};
      this._html = String(v == null ? '' : v);
      let m; const re = /id=["']([^"']+)["']/g;
      while ((m = re.exec(this._html))) {
        const cid = m[1], child = mk(cid);
        els[cid] = child; this._declaredIds.push(cid); this._declaredEls[cid] = child;
      }
    },
    get className() { return this._cls; }, set className(v) { this._cls = String(v); },
    get textContent() { return this._text; }, set textContent(v) { this._text = String(v == null ? '' : v); },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1);
      if (c) c.parentNode = null; return c; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    addEventListener(t, f) { (this._listeners[t] = this._listeners[t] || []).push(f); },
    removeEventListener(t, f) { const a = this._listeners[t]; if (!a) return;
      const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); },
    dispatch(t, ev) { (this._listeners[t] || []).slice().forEach(f => f(ev)); },
    click() { this.dispatch('click', {}); } };
  const set = () => new Set(e._cls.split(' ').filter(Boolean));
  const put = (s) => { e._cls = Array.from(s).join(' '); };
  e.classList = { add(...c) { const s = set(); c.forEach(x => s.add(x)); put(s); },
    remove(...c) { const s = set(); c.forEach(x => s.delete(x)); put(s); },
    toggle(c, f) { const s = set(); const on = f === undefined ? !s.has(c) : !!f;
      if (on) s.add(c); else s.delete(c); put(s); return on; },
    contains(c) { return set().has(c); } };
  return e;
}
const document = { getElementById: (id) => els[id] || (els[id] = mk(id)),
  createElement: (tag) => { const e = mk(''); e.tagName = String(tag || '').toUpperCase(); return e; },
  addEventListener() {}, querySelectorAll: () => [], activeElement: null, hidden: false };
document.body = mk('__body__');
document.documentElement = mk('__html__');
const ctx = vm.createContext({ document, navigator: {}, console, prompt: () => null, screen: {},
  innerWidth: 0, innerHeight: 0, fetch: () => new Promise(() => {}), setTimeout: () => 0,
  clearTimeout() {}, setInterval() {} });
vm.runInContext(src, ctx, { filename: 'index.html<script>' });
const run = (c) => vm.runInContext(c, ctx);
const el = (id) => document.getElementById(id);
const out = {};

// A stand-in station service: it accepts the save and hands the object back so
// hwSave settles instead of hanging on a fetch that never resolves.
run(`ORIG_CREATE = document.createElement; SAVED = [];
  STAND_IN = async (u, b) => { SAVED.push(u);
    const held = Object.assign({ technician: 'Tester', testedAt: '2026-09-20T12:00:00Z',
      clockWasNetwork: true }, JSON.parse(JSON.stringify(b)));
    return { ok: true, status: 200, data: { hardwareTest: held, hwtestMachine: 'HOST1',
      hwtestNeedsFiling: false } }; };
  jpost = STAND_IN;`);
const reset = () => run(`HWTEST = {}; HWT_RUNNING = false; HWT_MACHINE = ''; HWT_NOTE = '';
  HWT_NEEDS_FILING = false; HWT_SAVES = 0; BOOT = {}; SAVED = [];
  SCR.overlay = null; SCR.onKey = null; SCR.wake = null; SCR.idx = 0; SCR.shown = []; SCR.resolve = null;
  document.createElement = ORIG_CREATE; jpost = STAND_IN;
  for (const k of HWT_KEYS) { delete HWT_UNSAVED[k]; }
  document.getElementById('hwtDetail_screen').innerHTML = '';
  renderHwTest();`);

// The runner is registered by the region, at load.
out.registered = run(`typeof HWT_RUNNERS.screen`);

// A technician PASS, after stepping through every colour.
reset();
let p = run(`runHwTest('screen')`);
out.inProgress = run(`HWTEST.screen ? HWTEST.screen.status : ''`);
run(`SCR.open(); SCR.step(1); SCR.step(1); SCR.step(1); SCR.step(1);`);
out.shownAll = run(`SCR.shown.slice()`);
out.nameLabel = run(`document.getElementById('scrName').textContent`);
run(`SCR.close();
  document.getElementById('scrDead').value = '0';
  document.getElementById('scrNotes').value = 'clean';
  SCR.pass();`);
await p;
out.pass = run(`HWTEST.screen`);
out.passSaved = run(`SAVED.length`);

// "Needs attention" with a dead pixel: ATTENTION with a plain-English reason.
reset();
p = run(`runHwTest('screen')`);
run(`SCR.open();
  document.getElementById('scrDead').value = '1';
  document.getElementById('scrNotes').value = 'one bright pixel, top-right';
  SCR.close(); SCR.attention();`);
await p;
out.attn = run(`HWTEST.screen`);

// A FAIL is the technician's own answer, and the only way to FAILED.
reset();
p = run(`runHwTest('screen')`);
run(`SCR.open();
  document.getElementById('scrDead').value = '40';
  document.getElementById('scrNotes').value = 'huge crack across the panel';
  SCR.close(); SCR.fail();`);
await p;
out.fail = run(`HWTEST.screen`);

// Escape takes the overlay down WITHOUT recording - the technician is never
// trapped on a colour, and no answer is fabricated for them.
reset();
p = run(`runHwTest('screen')`);
run(`SCR.open();`);
out.escOpened = run(`!!SCR.overlay`);
out.escBodyBefore = run(`document.body.children.length`);
run(`SCR.onKey({ key: 'Escape' });`);
out.escOverlayAfter = run(`SCR.overlay`);
out.escBodyAfter = run(`document.body.children.length`);
out.escStatusAfter = run(`HWTEST.screen ? HWTEST.screen.status : 'NOT_TESTED'`);
// ...and the technician can still finish afterwards, from the panel.
run(`document.getElementById('scrDead').value = '0'; SCR.pass();`);
await p;
out.escThenPass = run(`HWTEST.screen ? HWTEST.screen.status : ''`);

// The station could not open the overlay: could-not-run is ATTENTION with a
// reason and an action, NEVER FAILED.
reset();
p = run(`runHwTest('screen')`);
run(`document.createElement = function () { throw new Error('no DOM here'); };`);
run(`SCR.open();`);
await p;
out.cannot = run(`HWTEST.screen`);

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
    check("the page's script runs at all", bool(o), r.stderr.decode("utf-8", "replace")[-800:])

    check("HWT_RUNNERS.screen is a function", o.get("registered") == "function", o.get("registered"))
    check("the shell sets the row to IN_PROGRESS before the runner records",
          o.get("inProgress") == "IN_PROGRESS", o.get("inProgress"))

    ps = o.get("pass") or {}
    check("a technician PASS stores PASSED", ps.get("status") == "PASSED", ps)
    check("...with the contract's screen fields (deadPixels, coloursShown, notes)",
          ps.get("deadPixels") == 0 and ps.get("notes") == "clean"
          and ps.get("coloursShown") == ["black", "white", "red", "green", "blue"], ps)
    check("stepping Next walks every colour, in order",
          o.get("shownAll") == ["black", "white", "red", "green", "blue"], o.get("shownAll"))
    check("the colour label is words as well as colour ('Blue — 5 of 5')",
          o.get("nameLabel") == u"Blue — 5 of 5", o.get("nameLabel"))
    check("a PASS is saved through the shell (hwSave ran)", o.get("passSaved", 0) >= 1, o.get("passSaved"))

    at = o.get("attn") or {}
    check("a dead pixel is ATTENTION, not a failure", at.get("status") == "ATTENTION", at)
    check("...with a plain-English reason and the count carried",
          "1 dead pixel reported by the technician" == at.get("reason")
          and at.get("deadPixels") == 1 and "bright pixel" in (at.get("notes") or ""), at)

    fl = o.get("fail") or {}
    check("a technician FAIL stores FAILED", fl.get("status") == "FAILED", fl)
    check("...with a reason and the count still recorded",
          "unusable" in (fl.get("reason") or "") and fl.get("deadPixels") == 40, fl)

    check("Escape opens then dismisses the overlay (the layer is removed)",
          o.get("escOpened") is True and o.get("escBodyBefore") == 1
          and o.get("escOverlayAfter") is None and o.get("escBodyAfter") == 0,
          (o.get("escOpened"), o.get("escBodyBefore"), o.get("escBodyAfter")))
    check("Escape records NOTHING - the technician is not trapped and no answer is invented",
          o.get("escStatusAfter") == "IN_PROGRESS", o.get("escStatusAfter"))
    check("...and the test can still be finished from the panel afterwards",
          o.get("escThenPass") == "PASSED", o.get("escThenPass"))

    cn = o.get("cannot") or {}
    check("a station that could not open the colours is ATTENTION, NEVER FAILED",
          cn.get("status") == "ATTENTION" and cn.get("status") != "FAILED", cn)
    check("...and it says why and what to do",
          "could not open the full-screen colour" in (cn.get("reason") or "")
          and "Run the screen test again" in (cn.get("action") or ""), cn)

shutil.rmtree(TMP, True)
print("\n%d passed, %d failed" % (PASS[0], len(FAIL)))
sys.exit(1 if FAIL else 0)
