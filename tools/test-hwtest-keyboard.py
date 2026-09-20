#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""The KEYBOARD hardware test (contract C6), the one region it owns.

The shell (tools/test-hwtest.py) proves the five-state machine, the save and the
carry-forward. This proves the KEYBOARD test that drops into it: pick which kind
of keyboard is on the bench, draw the matching on-screen layout, light each key as
it is PRESSED (keydown, matched by event.code), count what was seen against the
layout, and record exactly one technician-chosen result.

The rules this file pins down:
  1. The runner registers itself (HWT_RUNNERS.keyboard) and matches keys by
     event.code.
  2. THE bug the owner hit on real hardware: F3 opened Find, F5 reloaded, F7 popped
     Caret Browsing - because the old code detected on keyup, after the browser had
     already acted. The fix, proved here: while capturing, a document keydown
     listener preventDefaults AND stopPropagations every press (F3/F5/F7, the
     function row, Tab/Space/Enter/Backspace, the arrows and the nav keys) before
     the browser can act, and lights the key.
  3. That keydown listener exists ONLY while capturing: it is attached on
     capture-start and removed the instant capture stops (Stop capturing, going back
     to the chooser, a verdict, a new run), so it never swallows keys in the notes
     field or the rest of the kiosk.
  4. Three device layouts (Laptop Standard / Laptop Extended / Desktop Extended),
     chosen before the test, data-driven, ISO default with an ISO/ANSI sub-choice,
     with NO network lookup.
  5. Every on-screen key is clickable: a click marks it seen too (touchscreens, and
     keys the browser cannot see). A key the browser never saw is REPORTED in
     missingKeys, NEVER auto-failed.
  6. The two verdicts: "Keyboard is good" -> PASSED (hwPass) with the contract's
     fields; "Keyboard has an issue" -> FAILED (hwFail) with a reason drawn from the
     technician's note. A working notes field, saved in the result. The verdicts are
     disabled AND guarded in code while capturing, so pressing the keys under test
     can never file one.
  7. A station that could not RUN the test is ATTENTION with a reason and an action,
     NEVER FAILED. The region never says "Unknown".

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
check("it matches keys by event.code, not by character", "e.code" in JS, JS[:0])
check("it stores the contract's keyboard fields",
      all(f in JS for f in ("detectedKeys", "expectedKeys", "missingKeys",
                            "layout", "deviceType", "confirmedBy", "notes")))
check("confirmedBy is recorded as the technician", "confirmedBy:'technician'" in JSNS, JS[:0])
check("it offers the three device types the brief names, chosen before the test",
      all(d in JS for d in ("laptop-standard", "laptop-extended", "desktop-extended")))
check("the layouts are data-driven (a device table, not hand-written per layout)",
      "KBD_DEVICES" in JS and "KBD_GROUPS" in JS)
check("the region NEVER says 'Unknown' (owner's §8)", "nknown" not in MINE,
      [m.start() for m in re.finditer("nknown", MINE)])

# THE fix, visible in the source: detection is on a document keydown listener that
# preventDefaults AND stopPropagations, and it is removed again on stop. The old
# too-late keyup detection is gone.
check("THE fix: it captures on a document keydown listener (not keyup, which was too late)",
      "document.addEventListener('keydown'" in JSNS, JS[:0])
check("...and it cancels the browser's default AND stops the event before it acts",
      "preventDefault" in JS and "stopPropagation" in JS, JS[:0])
check("...and removes that keydown listener again, so nothing is left listening",
      "document.removeEventListener('keydown'" in JSNS, JS[:0])
check("it no longer relies on a document keyup handler for detection",
      "document.addEventListener('keyup'" not in JSNS, JS[:0])

# The suppression the owner asks for, visible in the source: the verdicts are
# guarded on KBD.capturing, so pressing the keys under test cannot file one.
check("verdicts are guarded so a keypress cannot fire one while capturing",
      "if(KBD.capturing)return" in JSNS, JS[:0])
check("Continue starts disabled until a device is chosen (the affordance)",
      'id="kbdContinue" disabled' in JS, JS[:0])

# The on-screen keys are clickable, and it is offline-first: no network of any kind.
check("every on-screen key gets a click handler (a click marks it seen too)",
      "b.addEventListener('click'" in JSNS, JS[:0])
check("the region adds no network/fetch (offline-first station)",
      "fetch(" not in JS and "XMLHttpRequest" not in JS and "/api/hwtest/" not in JS, JS[:0])

# ------------------------------------------------ 2. no station-side duty --
print("2. the keyboard test needs no station-side preparation")
# Unlike speaker (unmute), screen (stop blanking) and camera (pre-grant), the
# keyboard test is pure browser input - keydown needs nothing set up at boot. So
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
    focus() {}, select() {}, setAttribute() {}, getAttribute() { return null; },
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
    // A real pointer click reports detail>=1; the keyboard test no longer needs a
    // detail guard (the keydown handler cancels every press while capturing), but
    // the harness keeps click() modelling a mouse click.
    click() { this.dispatch('click', { detail: 1 }); } };
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
// removeEventListener / dispatch - which is what the keyboard test's keydown
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
  HWT_NEEDS_FILING = false; HWT_SAVES = 0; BOOT = {}; SAVED = []; PD = []; SP = [];
  document.createElement = ORIG_CREATE; jpost = STAND_IN;
  for (const k of HWT_KEYS) { delete HWT_UNSAVED[k]; }
  KBD.stopCapture(); KBD.device = ''; KBD.pending = ''; KBD.iso = true;
  KBD.built = null; KBD.seen = new Set(); KBD.keyEls = {}; KBD.resolve = null;
  document.getElementById('hwtDetail_keyboard').innerHTML = '';
  renderHwTest();`);
// Press keys as the browser does: keydown FIRST (which is where the fix acts),
// with spies that record every preventDefault / stopPropagation the handler makes.
const press = (codes) => run(
  "[" + codes.map(c => "'" + c + "'").join(",") + "].forEach(function(code){" +
  " document.dispatch('keydown',{code:code," +
  " preventDefault:function(){PD.push(code);}," +
  " stopPropagation:function(){SP.push(code);}}); });");
const kd = () => run(`document._listeners['keydown'] ? document._listeners['keydown'].length : 0`);

// The runner is registered by the region, at load, and matches by event.code.
out.registered = run(`typeof HWT_RUNNERS.keyboard`);

// ---- A technician "Keyboard is good": the chooser, the guards, the keydown fix.
reset();
let p = run(`runHwTest('keyboard')`);
out.inProgress = run(`HWTEST.keyboard ? HWTEST.keyboard.status : ''`);
out.capturingBeforeChoose = run(`KBD.capturing`);
out.keydownBeforeChoose = kd();
// Continue does NOTHING until a device is chosen (Continue is disabled too, this
// is the matching code guard) - no board, no capture.
run(`document.getElementById('kbdContinue').click();`);
out.deviceAfterEarlyContinue = run(`KBD.device`);
out.capturingAfterEarlyContinue = run(`KBD.capturing`);
// Choose the desktop layout, then Continue.
run(`document.getElementById('kbdDev_desktop-extended').click();`);
out.pending = run(`KBD.pending`);
out.continueEnabled = run(`document.getElementById('kbdContinue').disabled === false`);
run(`document.getElementById('kbdContinue').click();`);
out.device = run(`KBD.device`);
out.capturing0 = run(`KBD.capturing`);
out.isoDefault = run(`KBD.iso`);
out.expected0 = run(`KBD.compute().exp`);
out.goodDisabledCap = run(`document.getElementById('kbdGood').disabled`);
out.notesDisabledCap = run(`document.getElementById('kbdNotes').disabled`);
out.keydownDuringCap = kd();
// Press the very keys the owner reported: F3/F5/F7 and the function/nav keys, plus
// the keys that could file a verdict (Enter/Space). All must be cancelled AND lit.
press(['KeyA', 'F3', 'F5', 'F7', 'F1', 'F12', 'Tab', 'Space', 'Enter', 'Backspace',
       'ArrowUp', 'Home', 'End', 'PageUp', 'PageDown']);
out.pd = run(`PD.slice()`);
out.sp = run(`SP.slice()`);
out.seenCount = run(`KBD.seen.size`);
out.litF3 = run(`!!(KBD.keyEls['F3'] && KBD.keyEls['F3'].classList.contains('kbd-seen'))`);
out.litA = run(`!!(KBD.keyEls['KeyA'] && KBD.keyEls['KeyA'].classList.contains('kbd-seen'))`);
out.statusAfterKeys = run(`HWTEST.keyboard ? HWTEST.keyboard.status : ''`);
// A stray click on a verdict WHILE capturing must record NOTHING (code guard).
run(`document.getElementById('kbdGood').click(); document.getElementById('kbdIssue').click();`);
out.statusAfterStrayClick = run(`HWTEST.keyboard ? HWTEST.keyboard.status : ''`);
// Stop capturing with the mouse: verdicts and notes arm, and the keydown handler
// is handed back at once.
run(`document.getElementById('kbdToggle').click();`);
out.capturingAfterStop = run(`KBD.capturing`);
out.goodDisabledAfterStop = run(`document.getElementById('kbdGood').disabled`);
out.notesDisabledAfterStop = run(`document.getElementById('kbdNotes').disabled`);
out.keydownAfterStop = kd();
// The notes field takes text now the handler is gone (the owner's bug), and it is
// carried into the result.
run(`document.getElementById('kbdNotes').value = 'all keys felt fine';`);
run(`document.getElementById('kbdGood').click();`);
await p;
out.good = run(`HWTEST.keyboard`);
out.goodSaved = run(`SAVED.length`);
out.keydownAfterGood = kd();

// ---- A click on an on-screen key marks it seen (touchscreens / keys the browser
// cannot see). Fresh run so the count is clean.
reset();
p = run(`runHwTest('keyboard')`);
run(`document.getElementById('kbdDev_desktop-extended').click(); document.getElementById('kbdContinue').click();`);
out.clickBefore = run(`KBD.seen.has('F9')`);
run(`KBD.keyEls['F9'].click();`);
out.clickAfter = run(`KBD.seen.has('F9')`);
out.clickDet = run(`KBD.compute().det`);
run(`document.getElementById('kbdToggle').click(); document.getElementById('kbdGood').click();`);
await p;

// ---- The grab must NEVER swallow keys meant for a field the operator is typing
// in. The Settings gear and the restart button live in the always-visible header
// and open by mouse WHILE a sweep is live; their fields (Wi-Fi / server / admin
// PIN, and the sign-in box) are real text inputs. A keydown whose target is a text
// field must pass straight through - not cancelled, not stopped, not marked - so
// those overlays stay typeable. A press with no field focused is still captured.
reset();
p = run(`runHwTest('keyboard')`);
run(`document.getElementById('kbdDev_desktop-extended').click(); document.getElementById('kbdContinue').click();`);
out.fieldSeenBefore = run(`KBD.seen.has('KeyZ')`);
run(`document.dispatch('keydown',{code:'KeyZ',target:{tagName:'INPUT'},
  preventDefault:function(){PD.push('field-KeyZ');},
  stopPropagation:function(){SP.push('field-KeyZ');}});`);
out.fieldInputPd = run(`PD.indexOf('field-KeyZ')>=0`);
out.fieldInputSp = run(`SP.indexOf('field-KeyZ')>=0`);
out.fieldSeenAfter = run(`KBD.seen.has('KeyZ')`);
run(`document.dispatch('keydown',{code:'Enter',target:{tagName:'TEXTAREA'},
  preventDefault:function(){PD.push('field-Enter');},
  stopPropagation:function(){SP.push('field-Enter');}});`);
out.fieldTextareaPd = run(`PD.indexOf('field-Enter')>=0`);
// A normal press (no text field focused) is still cancelled and marked, so the
// sweep itself is untouched by the guard.
run(`document.dispatch('keydown',{code:'KeyM',
  preventDefault:function(){PD.push('board-KeyM');},
  stopPropagation:function(){SP.push('board-KeyM');}});`);
out.boardPd = run(`PD.indexOf('board-KeyM')>=0`);
out.boardSeen = run(`KBD.seen.has('KeyM')`);
run(`document.getElementById('kbdToggle').click(); document.getElementById('kbdGood').click();`);
await p;

// ---- "Keyboard has an issue" -> FAILED, with the reason drawn from the note.
reset();
p = run(`runHwTest('keyboard')`);
run(`document.getElementById('kbdDev_laptop-standard').click(); document.getElementById('kbdContinue').click();`);
press(['KeyA']);
run(`document.getElementById('kbdToggle').click();`);
run(`document.getElementById('kbdNotes').value = 'F7 not responding';`);
run(`document.getElementById('kbdIssue').click();`);
await p;
out.issue = run(`HWTEST.keyboard`);

// ---- The three device layouts, selected correctly, with the right key totals;
// and going back to the chooser removes the keydown listener.
// The ISO/ANSI sub-choice persists within a run, so each count is read with the
// standard forced explicitly (clicking ISO/ANSI), which also exercises the toggle.
reset();
p = run(`runHwTest('keyboard')`);
run(`document.getElementById('kbdDev_laptop-standard').click(); document.getElementById('kbdContinue').click();
     document.getElementById('kbdIso').click();`);
out.expLaptopStdIso = run(`KBD.compute().exp`);
run(`document.getElementById('kbdAnsi').click();`);
out.expLaptopStdAnsi = run(`KBD.compute().exp`);
run(`document.getElementById('kbdBack').click();`);
out.keydownAfterBack = kd();
out.capturingAfterBack = run(`KBD.capturing`);
run(`document.getElementById('kbdDev_laptop-extended').click(); document.getElementById('kbdContinue').click();
     document.getElementById('kbdIso').click();`);
out.expLaptopExt = run(`KBD.compute().exp`);
run(`document.getElementById('kbdBack').click();
     document.getElementById('kbdDev_desktop-extended').click(); document.getElementById('kbdContinue').click();
     document.getElementById('kbdIso').click();`);
out.expDesktopIso = run(`KBD.compute().exp`);
run(`document.getElementById('kbdAnsi').click();`);
out.expDesktopAnsi = run(`KBD.compute().exp`);
run(`document.getElementById('kbdIso').click(); document.getElementById('kbdToggle').click();
     document.getElementById('kbdGood').click();`);
await p;
out.savedDevice = run(`HWTEST.keyboard ? HWTEST.keyboard.deviceType : ''`);
out.savedLayout = run(`HWTEST.keyboard ? HWTEST.keyboard.layout : ''`);

// ---- The station could not draw the layout: ATTENTION with a reason and an
// action, NEVER FAILED. (Runs LAST because it breaks document.createElement.)
reset();
p = run(`runHwTest('keyboard')`);
run(`document.createElement = function () { throw new Error('no DOM here'); };`);
run(`document.getElementById('kbdDev_laptop-standard').click(); document.getElementById('kbdContinue').click();`);
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

    # The chooser comes first: no board, no capture, no keydown handler until a
    # device is chosen and Continue is pressed.
    check("no key is captured, and no keydown handler is bound, on the type chooser",
          o.get("capturingBeforeChoose") is False and o.get("keydownBeforeChoose") == 0,
          (o.get("capturingBeforeChoose"), o.get("keydownBeforeChoose")))
    check("Continue does nothing until a device is chosen (the code guard)",
          o.get("deviceAfterEarlyContinue") == "" and o.get("capturingAfterEarlyContinue") is False,
          (o.get("deviceAfterEarlyContinue"), o.get("capturingAfterEarlyContinue")))
    check("choosing a device sets it pending and enables Continue",
          o.get("pending") == "desktop-extended" and o.get("continueEnabled") is True,
          (o.get("pending"), o.get("continueEnabled")))
    check("Continue starts the test on the chosen device, ISO by default",
          o.get("device") == "desktop-extended" and o.get("capturing0") is True
          and o.get("isoDefault") is True, (o.get("device"), o.get("capturing0"), o.get("isoDefault")))
    check("the desktop-extended ISO layout is the full 105 keys",
          o.get("expected0") == 105, o.get("expected0"))

    # The suppression AND the fix, together: verdicts/notes off while capturing,
    # exactly one keydown handler attached, and every danger key both cancelled and
    # lit rather than acted on by the browser.
    check("the verdict buttons and the notes field are disabled while capturing",
          o.get("goodDisabledCap") is True and o.get("notesDisabledCap") is True,
          (o.get("goodDisabledCap"), o.get("notesDisabledCap")))
    check("exactly one document keydown handler is attached while capturing",
          o.get("keydownDuringCap") == 1, o.get("keydownDuringCap"))
    dangerous = {"F3", "F5", "F7", "F1", "F12", "Tab", "Space", "Enter", "Backspace",
                 "ArrowUp", "Home", "End", "PageUp", "PageDown"}
    pd = set(o.get("pd") or [])
    sp = set(o.get("sp") or [])
    check("THE fix: F3/F5/F7 and the function/nav/edit keys have their default cancelled on keydown",
          dangerous.issubset(pd), sorted(dangerous - pd))
    check("...and the event is stopped as well, before anything downstream can act",
          dangerous.issubset(sp), sorted(dangerous - sp))
    check("each press is seen and lights its key (Press F3 -> F3 lights up)",
          o.get("seenCount") == 15 and o.get("litF3") is True and o.get("litA") is True,
          (o.get("seenCount"), o.get("litF3"), o.get("litA")))
    check("pressing Enter / Space / F-keys records NO verdict - the run is still in progress",
          o.get("statusAfterKeys") == "IN_PROGRESS", o.get("statusAfterKeys"))
    check("a stray click on a verdict WHILE capturing records nothing (the code guard)",
          o.get("statusAfterStrayClick") == "IN_PROGRESS", o.get("statusAfterStrayClick"))
    check("Stop capturing (a mouse click) ends capture and arms the verdicts and notes",
          o.get("capturingAfterStop") is False and o.get("goodDisabledAfterStop") is False
          and o.get("notesDisabledAfterStop") is False,
          (o.get("capturingAfterStop"), o.get("goodDisabledAfterStop"), o.get("notesDisabledAfterStop")))
    check("...and hands the keydown handler back on Stop (so the notes field takes text)",
          o.get("keydownAfterStop") == 0, o.get("keydownAfterStop"))

    gd = o.get("good") or {}
    check("'Keyboard is good' stores PASSED", gd.get("status") == "PASSED", gd)
    check("...with the contract's fields, confirmed by the technician, and the note saved",
          gd.get("detectedKeys") == 15 and gd.get("expectedKeys") == 105
          and isinstance(gd.get("missingKeys"), list) and len(gd.get("missingKeys")) == 90
          and gd.get("layout") == "ISO" and gd.get("confirmedBy") == "technician"
          and gd.get("notes") == "all keys felt fine"
          and "Desktop" in (gd.get("deviceType") or "") and "Extended" in (gd.get("deviceType") or ""),
          gd)
    check("a good result is saved through the shell (hwSave ran)", o.get("goodSaved", 0) >= 1, o.get("goodSaved"))
    check("the keydown handler is gone once the test ends", o.get("keydownAfterGood") == 0,
          o.get("keydownAfterGood"))

    check("an on-screen key that was not pressed is not seen until it is clicked",
          o.get("clickBefore") is False, o.get("clickBefore"))
    check("clicking an on-screen key marks it seen (mouse/touch fallback)",
          o.get("clickAfter") is True and o.get("clickDet") == 1,
          (o.get("clickAfter"), o.get("clickDet")))

    # The grab stands down for a key aimed at a text field, so a modal opened by
    # mouse mid-sweep (Settings gear / restart / sign-in) stays typeable - the key
    # is neither cancelled, stopped, nor marked. A press with nothing focused is
    # still captured, so the sweep works unchanged.
    check("a key meant for a text field is NOT swallowed (Settings/sign-in stay typeable)",
          o.get("fieldSeenBefore") is False and o.get("fieldInputPd") is False
          and o.get("fieldInputSp") is False and o.get("fieldSeenAfter") is False,
          (o.get("fieldInputPd"), o.get("fieldInputSp"), o.get("fieldSeenAfter")))
    check("a textarea keystroke is let through too (multi-line fields stay typeable)",
          o.get("fieldTextareaPd") is False, o.get("fieldTextareaPd"))
    check("a normal press (no field focused) is still captured, so the sweep is unaffected",
          o.get("boardPd") is True and o.get("boardSeen") is True,
          (o.get("boardPd"), o.get("boardSeen")))

    iss = o.get("issue") or {}
    check("'Keyboard has an issue' stores FAILED (the technician's own answer)",
          iss.get("status") == "FAILED", iss)
    check("...with the fault drawn from the note, and the note carried in the result",
          "F7 not responding" in (iss.get("reason") or "")
          and iss.get("notes") == "F7 not responding" and iss.get("detectedKeys") == 1, iss)

    check("Laptop Standard is ~84 keys (ISO 85 / ANSI 84), no numpad",
          o.get("expLaptopStdIso") == 85 and o.get("expLaptopStdAnsi") == 84,
          (o.get("expLaptopStdIso"), o.get("expLaptopStdAnsi")))
    check("going back to the chooser removes the keydown listener and stops capture",
          o.get("keydownAfterBack") == 0 and o.get("capturingAfterBack") is False,
          (o.get("keydownAfterBack"), o.get("capturingAfterBack")))
    check("Laptop Extended adds a numpad (~99; ISO 102 here)",
          o.get("expLaptopExt") == 102, o.get("expLaptopExt"))
    check("Desktop Extended is the full 105 (ISO) / 104 (ANSI)",
          o.get("expDesktopIso") == 105 and o.get("expDesktopAnsi") == 104,
          (o.get("expDesktopIso"), o.get("expDesktopAnsi")))
    check("the recorded device type and standard are the ones on screen at the end",
          "Desktop" in (o.get("savedDevice") or "") and o.get("savedLayout") == "ISO",
          (o.get("savedDevice"), o.get("savedLayout")))

    cn = o.get("cannot") or {}
    check("a station that could not draw the layout is ATTENTION, NEVER FAILED",
          cn.get("status") == "ATTENTION" and cn.get("status") != "FAILED", cn)
    check("...and it says why and what to do",
          "could not draw the keyboard layout" in (cn.get("reason") or "")
          and "Run the keyboard test again" in (cn.get("action") or ""), cn)

shutil.rmtree(TMP, True)
print("\n%d passed, %d failed" % (PASS[0], len(FAIL)))
sys.exit(1 if FAIL else 0)
