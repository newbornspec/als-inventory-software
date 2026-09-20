#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""The KEYBOARD hardware test (contract C6), the one region it owns.

The shell (tools/test-hwtest.py) proves the five-state machine, the save and the
carry-forward. This proves the KEYBOARD test that drops into it: draw an on-screen
layout, light each key as it is released (keyup, matched by event.code), count what
was seen against the layout, and record exactly one technician-chosen result.

The rules this file pins down:
  1. The runner registers itself (HWT_RUNNERS.keyboard) and matches keys by
     event.code.
  2. A technician PASS stores PASSED with the contract's fields
     (detectedKeys, expectedKeys, missingKeys, layout, confirmedBy, notes).
  3. "Some keys don't work" stores ATTENTION with a plain-English reason and an
     action; a FAIL stores FAILED - only the human's click sets the state.
  4. THE rule that keeps the module honest, twice over here:
       a) a key the browser never saw is REPORTED (missingKeys), NEVER
          auto-failed - the runner records nothing on its own; and
       b) a station that could not RUN the test is ATTENTION with a reason and an
          action, NEVER FAILED.
  5. THE suppression the owner demands (§3): while capturing, the verdict buttons
     are disabled AND guarded in code, so pressing the very keys under test (P, F,
     Enter, Space) can never file a verdict. Verdicts arm only after Stop
     capturing, which is a mouse click.
  6. This is the one place that takes a document-level key handler, and it gives
     it back on Stop and on a verdict - nothing is left listening. The region
     never says "Unknown".

Sections 3+ need node and drive index.html under a DOM stand-in, the way
tools/test-hwtest.py and tools/test-hwtest-screen.py do. Without node it says SKIP
and passes, unless ALS_REQUIRE_NODE=1 (set in CI).

    python3 tools/test-hwtest-keyboard.py
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


def region(start, end):
    i, j = HTML.find(start), HTML.find(end)
    return HTML[i:j] if (i >= 0 and j > i) else ""


CSS = region("/* HWTEST:KEYBOARD:CSS:START */", "/* HWTEST:KEYBOARD:CSS:END */")
MARKUP = region("<!-- HWTEST:KEYBOARD:START -->", "<!-- HWTEST:KEYBOARD:END -->")
JS = region("/* HWTEST:KEYBOARD:JS:START */", "/* HWTEST:KEYBOARD:JS:END */")
MINE = CSS + "\n" + MARKUP + "\n" + JS
JSNS = JS.replace(" ", "")

# ------------------------------------------------------ 1. the region text --
print("1. the keyboard region, read straight out of index.html")
check("all three keyboard regions are present and close", bool(CSS) and bool(MARKUP) and bool(JS),
      (len(CSS), len(MARKUP), len(JS)))
check("the runner registers itself", "HWT_RUNNERS.keyboard=asyncfunction" in JSNS, JS[:200])
check("it matches keys by event.code, not by character", "e&&e.code" in JSNS or "e.code" in JSNS, JS[:0])
check("it stores the contract's keyboard fields",
      all(f in JS for f in ("detectedKeys", "expectedKeys", "missingKeys",
                            "layout", "confirmedBy", "notes")))
check("confirmedBy is recorded as the technician", "confirmedBy:'technician'" in JSNS, JS[:0])
check("it offers both layouts the contract names (iso-105 default, ansi-104)",
      "iso-105" in JS and "ansi-104" in JS)
check("the region NEVER says 'Unknown' (owner's §8)", "nknown" not in MINE,
      [m.start() for m in re.finditer("nknown", MINE)])

# The suppression the owner asks for, visible in the source: the verdicts are
# guarded on KBD.capturing, and the global handler preventDefaults so a key press
# cannot activate anything while the technician is pressing the keys under test.
check("verdicts are guarded so a keypress cannot fire one while capturing",
      "if(KBD.capturing)return" in JSNS, JS[:0])
check("the capturing handler preventDefaults every press", "preventDefault" in JS, JS[:0])

# It takes the ONE global key handler the kiosk allows (keyup, never a keydown
# handler - the shell forbids that and tools/test-hwtest.py enforces it), and it
# gives it back again.
check("it takes NO global keydown handler (the shell's rule)",
      "addEventListener('keydown'" not in JSNS and "onkeydown" not in JS, JS[:0])
check("it captures with a document-level keyup handler",
      "document.addEventListener('keyup'" in JSNS, JS[:0])
check("...and gives it up again (removeEventListener), so nothing is left listening",
      "document.removeEventListener('keyup'" in JSNS, JS[:0])

# ------------------------------------------------ 2. no station-side duty --
print("2. the keyboard test needs no station-side preparation")
# Unlike speaker (unmute), screen (stop blanking) and camera (pre-grant), the
# keyboard test is pure browser input - keyup needs nothing set up at boot. So
# it ships with the page alone, and must NOT reach for a station endpoint or a
# boot-time command (which would drag in a duty this test does not have).
check("the region calls no station audio/prep endpoint", "/api/hwtest/" not in JS, "")
check("the region runs no boot-time station command (wpctl/amixer/xset/pw-cli)",
      not any(t in JS for t in ("wpctl", "amixer", "xset", "pw-cli")), "")

# --------------------------------------------------- 3. the runner on node --
print("3. the runner, driven under node")
node = shutil.which("node")
TMP = tempfile.mkdtemp(prefix="als-hwt-keyboard-")
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
    // innerHTML like a real browser: replacing markup DETACHES the old subtree
    // (so getElementById can no longer find those ids) and registers the ids the
    // new markup declares. This makes the runner's final panel-blank actually
    // bite, exactly as the screen test relies on.
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
// The document itself is an mk node, so it carries real addEventListener /
// removeEventListener / dispatch - which is what the keyboard test's global key
// handler needs, and what lets this test feed it synthetic keydowns.
const document = mk('__document__');
document.getElementById = (id) => els[id] || (els[id] = mk(id));
document.createElement = (tag) => { const e = mk(''); e.tagName = String(tag || '').toUpperCase(); return e; };
document.querySelectorAll = () => [];
document.activeElement = null; document.hidden = false;
document.body = mk('__body__');
document.documentElement = mk('__html__');
const ctx = vm.createContext({ document, navigator: {}, console, prompt: () => null, screen: {},
  innerWidth: 0, innerHeight: 0, fetch: () => new Promise(() => {}), setTimeout: () => 0,
  clearTimeout() {}, setInterval() {} });
vm.runInContext(src, ctx, { filename: 'index.html<script>' });
const run = (c) => vm.runInContext(c, ctx);
const out = {};

// A stand-in station service so hwSave settles instead of hanging on a fetch.
run(`ORIG_CREATE = document.createElement; SAVED = [];
  STAND_IN = async (u, b) => { SAVED.push(u);
    const held = Object.assign({ technician: 'Tester', testedAt: '2026-09-20T12:00:00Z',
      clockWasNetwork: true }, JSON.parse(JSON.stringify(b)));
    return { ok: true, status: 200, data: { hardwareTest: held, hwtestMachine: 'HOST1',
      hwtestNeedsFiling: false } }; };
  jpost = STAND_IN;`);
const reset = () => run(`HWTEST = {}; HWT_RUNNING = false; HWT_MACHINE = ''; HWT_NOTE = '';
  HWT_NEEDS_FILING = false; HWT_SAVES = 0; BOOT = {}; SAVED = [];
  document.createElement = ORIG_CREATE; jpost = STAND_IN;
  for (const k of HWT_KEYS) { delete HWT_UNSAVED[k]; }
  KBD.stopCapture(); KBD.seen = new Set(); KBD.layout = 'iso-105'; KBD.keyEls = {}; KBD.resolve = null;
  document.getElementById('hwtDetail_keyboard').innerHTML = '';
  renderHwTest();`);
const press = (codes) => run(
  "[" + codes.map(c => "'" + c + "'").join(",") + "].forEach(function(code){" +
  " document.dispatch('keydown',{code:code,preventDefault:function(){}});" +
  " document.dispatch('keyup',{code:code,preventDefault:function(){}}); });");

// The runner is registered by the region, at load, and matches by event.code.
out.registered = run(`typeof HWT_RUNNERS.keyboard`);

// ---- A technician PASS, with the suppression guards exercised along the way.
reset();
let p = run(`runHwTest('keyboard')`);
out.inProgress = run(`HWTEST.keyboard ? HWTEST.keyboard.status : ''`);
out.layout0 = run(`KBD.layout`);
out.expected0 = run(`KBD.compute().exp`);
out.capturing0 = run(`KBD.capturing`);
out.passDisabledCap = run(`document.getElementById('kbdPass').disabled`);
// Press the danger keys among others: P, F, Enter and Space are exactly the keys
// that must NOT trigger a verdict while the technician is testing them.
press(['KeyA', 'KeyP', 'KeyF', 'Enter', 'Space']);
out.seenCount = run(`KBD.seen.size`);
out.litA = run(`!!(KBD.keyEls['KeyA'] && KBD.keyEls['KeyA'].classList.contains('kbd-seen'))`);
out.detDuringCap = run(`KBD.compute().det`);
out.statusAfterKeys = run(`HWTEST.keyboard ? HWTEST.keyboard.status : ''`);
// A stray click on a verdict while capturing must record NOTHING (code guard).
run(`document.getElementById('kbdPass').click(); document.getElementById('kbdFail').click();`);
out.statusAfterStrayClick = run(`HWTEST.keyboard ? HWTEST.keyboard.status : ''`);
out.listenersDuringCap = run(`document._listeners['keyup'] ? document._listeners['keyup'].length : 0`);
// Stop capturing with the mouse, and only now do the verdicts arm.
run(`document.getElementById('kbdToggle').click();`);
out.capturingAfterStop = run(`KBD.capturing`);
out.passDisabledAfterStop = run(`document.getElementById('kbdPass').disabled`);
out.listenersAfterStop = run(`document._listeners['keyup'] ? document._listeners['keyup'].length : 0`);
run(`document.getElementById('kbdNotes').value = 'all keys felt fine';`);
run(`document.getElementById('kbdPass').click();`);
await p;
out.pass = run(`HWTEST.keyboard`);
out.passSaved = run(`SAVED.length`);
out.listenersAfterPass = run(`document._listeners['keyup'] ? document._listeners['keyup'].length : 0`);

// ---- "Some keys don't work": ATTENTION with a plain-English reason and action.
reset();
p = run(`runHwTest('keyboard')`);
press(['KeyA']);
run(`document.getElementById('kbdToggle').click();`);
run(`document.getElementById('kbdAttn').click();`);
await p;
out.attn = run(`HWTEST.keyboard`);

// ---- A FAIL is the technician's own answer, and the only way to FAILED. Here
// the whole keyboard is dead: nothing lit, but that is not what fails it - the
// human's click is.
reset();
p = run(`runHwTest('keyboard')`);
run(`document.getElementById('kbdToggle').click();`);
run(`document.getElementById('kbdFail').click();`);
await p;
out.fail = run(`HWTEST.keyboard`);

// ---- Switching layout mid-run keeps the keys already seen and recomputes the
// expected total against the new layout.
reset();
p = run(`runHwTest('keyboard')`);
press(['KeyA']);
out.expIso = run(`KBD.compute().exp`);
run(`document.getElementById('kbdAnsi').click();`);
out.layoutAnsi = run(`KBD.layout`);
out.expAnsi = run(`KBD.compute().exp`);
out.seenKept = run(`KBD.seen.has('KeyA')`);
run(`document.getElementById('kbdToggle').click(); document.getElementById('kbdPass').click();`);
await p;
out.switchLayout = run(`HWTEST.keyboard ? HWTEST.keyboard.layout : ''`);

// ---- The station could not build the panel: ATTENTION with a reason and an
// action, NEVER FAILED.
reset();
run(`document.createElement = function () { throw new Error('no DOM here'); };`);
p = run(`runHwTest('keyboard')`);
await p;
out.cannot = run(`HWTEST.keyboard`);
run(`document.createElement = ORIG_CREATE;`);

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

    check("HWT_RUNNERS.keyboard is a function", o.get("registered") == "function", o.get("registered"))
    check("the shell sets the row to IN_PROGRESS before the runner records",
          o.get("inProgress") == "IN_PROGRESS", o.get("inProgress"))
    check("the default layout is ISO-105 (the UK/EU laptop default)",
          o.get("layout0") == "iso-105", o.get("layout0"))
    check("...and its expected total is 105 keys", o.get("expected0") == 105, o.get("expected0"))
    check("capture starts at once so keys can be pressed straight away",
          o.get("capturing0") is True, o.get("capturing0"))

    # The suppression: verdicts are OFF while capturing, and pressing the danger
    # keys neither activates a verdict nor is auto-recorded.
    check("the verdict buttons are disabled while capturing (the affordance)",
          o.get("passDisabledCap") is True, o.get("passDisabledCap"))
    check("key releases are seen and light their key while capturing",
          o.get("seenCount") == 5 and o.get("litA") is True and o.get("detDuringCap") == 5,
          (o.get("seenCount"), o.get("litA"), o.get("detDuringCap")))
    check("pressing P / F / Enter / Space records NO verdict - the run is still in progress",
          o.get("statusAfterKeys") == "IN_PROGRESS", o.get("statusAfterKeys"))
    check("a stray click on a verdict WHILE capturing records nothing (the code guard)",
          o.get("statusAfterStrayClick") == "IN_PROGRESS", o.get("statusAfterStrayClick"))
    check("exactly one document key handler is attached while capturing",
          o.get("listenersDuringCap") == 1, o.get("listenersDuringCap"))
    check("Stop capturing (a mouse click) ends capture and arms the verdicts",
          o.get("capturingAfterStop") is False and o.get("passDisabledAfterStop") is False,
          (o.get("capturingAfterStop"), o.get("passDisabledAfterStop")))
    check("...and hands the global key handler back on Stop",
          o.get("listenersAfterStop") == 0, o.get("listenersAfterStop"))

    ps = o.get("pass") or {}
    check("a technician PASS stores PASSED", ps.get("status") == "PASSED", ps)
    check("...with the contract's fields, confirmed by the technician",
          ps.get("detectedKeys") == 5 and ps.get("expectedKeys") == 105
          and isinstance(ps.get("missingKeys"), list) and len(ps.get("missingKeys")) == 100
          and ps.get("layout") == "iso-105" and ps.get("confirmedBy") == "technician"
          and ps.get("notes") == "all keys felt fine", ps)
    check("a PASS is saved through the shell (hwSave ran)", o.get("passSaved", 0) >= 1, o.get("passSaved"))
    check("the global key handler is gone once the test ends", o.get("listenersAfterPass") == 0,
          o.get("listenersAfterPass"))

    at = o.get("attn") or {}
    check("'some keys don't work' is ATTENTION, not a failure", at.get("status") == "ATTENTION", at)
    check("...with a plain-English reason and an action, and the unseen keys carried",
          "some keys do not work" in (at.get("reason") or "")
          and bool(at.get("action")) and at.get("detectedKeys") == 1
          and len(at.get("missingKeys") or []) == 104, at)

    fl = o.get("fail") or {}
    check("a technician FAIL stores FAILED (only a human's click can)", fl.get("status") == "FAILED", fl)
    check("...and a dead keyboard is FAILED by the human, not auto-failed by absence",
          "does not work" in (fl.get("reason") or "") and fl.get("detectedKeys") == 0
          and fl.get("expectedKeys") == 105, fl)

    check("switching to ANSI keeps the keys already seen", o.get("seenKept") is True, o.get("seenKept"))
    check("...and recomputes the expected total (105 -> 104)",
          o.get("expIso") == 105 and o.get("layoutAnsi") == "ansi-104" and o.get("expAnsi") == 104,
          (o.get("expIso"), o.get("layoutAnsi"), o.get("expAnsi")))
    check("...and the recorded layout is the one that was on screen at the end",
          o.get("switchLayout") == "ansi-104", o.get("switchLayout"))

    cn = o.get("cannot") or {}
    check("a station that could not build the panel is ATTENTION, NEVER FAILED",
          cn.get("status") == "ATTENTION" and cn.get("status") != "FAILED", cn)
    check("...and it says why and what to do",
          "could not build the keyboard test panel" in (cn.get("reason") or "")
          and "Run the keyboard test again" in (cn.get("action") or ""), cn)

shutil.rmtree(TMP, True)
print("\n%d passed, %d failed" % (PASS[0], len(FAIL)))
sys.exit(1 if FAIL else 0)
