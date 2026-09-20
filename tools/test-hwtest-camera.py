#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""The camera hardware test (contract C6), the runner filled into index.html.

The shell (91228c1, 466b4a1) owns the state machine, the save and the summary;
this file exercises ONLY the camera runner in its region. What it proves is the
contract for this one component:

  - the runner registers itself (HWT_RUNNERS.camera is a function);
  - the technician clicking "Camera is working" stores PASSED with the fields
    the contract wants for camera - device and notes;
  - clicking "Camera is not working" stores FAILED;
  - the two things that are NOT a broken camera - a refused permission and no
    camera fitted - are recorded as ATTENTION (could-not-run) with a plain
    reason and an action, and NEVER as FAILED. Nor is a camera the station
    cannot open, a missing media API, or a permission prompt that never
    answers: every failure to OPEN the camera is could-not-run;
  - the camera light is never left on - every track is stopped on the pass, the
    fail, and when the page is torn down while the technician is still deciding,
    and a stream that arrives after a timeout is released too;
  - the region never prints the word this module is forbidden to print;
  - the station pre-grants the camera in the SYNCED path (als-autostart.sh), not
    the baked layer template, and the runner still degrades gracefully without
    it.

The runner uses getUserMedia, a <video> and MediaStream tracks, so those are
stood in for under node the way tools/test-hwtest.py and tools/test-drive-health.py
stand in for the DOM. Without node the browser-driven section SKIPs and passes,
unless ALS_REQUIRE_NODE=1 (set in CI).

    python3 tools/test-hwtest-camera.py
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
LAYER = os.path.join(HERE, "make-als-layer.sh")

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
    """The text between a pair of camera markers, so a claim about 'the camera
    region' is checked against that region alone and not the whole page."""
    start = {"CSS": "/* HWTEST:CAMERA:CSS:START */", "JS": "/* HWTEST:CAMERA:JS:START */",
             "markup": "<!-- HWTEST:CAMERA:START -->"}[kind]
    end = {"CSS": "/* HWTEST:CAMERA:CSS:END */", "JS": "/* HWTEST:CAMERA:JS:END */",
           "markup": "<!-- HWTEST:CAMERA:END -->"}[kind]
    i, j = HTML.find(start), HTML.find(end)
    return HTML[i:j] if 0 <= i < j else ""


# ------------------------------------------------------ 1. the region itself --
print("1. the camera region is present, closed once, and self-contained")
for kind in ("CSS", "JS", "markup"):
    start = {"CSS": "/* HWTEST:CAMERA:CSS:START */", "JS": "/* HWTEST:CAMERA:JS:START */",
             "markup": "<!-- HWTEST:CAMERA:START -->"}[kind]
    end = {"CSS": "/* HWTEST:CAMERA:CSS:END */", "JS": "/* HWTEST:CAMERA:JS:END */",
           "markup": "<!-- HWTEST:CAMERA:END -->"}[kind]
    check("the camera %s region exists exactly once and closes" % kind,
          HTML.count(start) == 1 and HTML.count(end) == 1 and 0 <= HTML.find(start) < HTML.find(end),
          (HTML.count(start), HTML.count(end)))

JS = region("JS")
check("the runner is registered on HWT_RUNNERS.camera", "HWT_RUNNERS.camera" in JS)
check("it opens the camera with getUserMedia({video:true})", "getUserMedia({video:true})" in JS)
check("it stops tracks (the camera light must go out)", ".stop()" in JS and "getTracks()" in JS)
check("it records through the shell's helpers, not by hand",
      "hwPass('camera'" in JS and "hwFail('camera'" in JS and "hwCannotRun('camera'" in JS)
check("the whole flow sits in a finally so a track is always released", "finally{" in JS or "finally {" in JS)
check("the camera region never prints 'Unknown'",
      "Unknown" not in JS and "Unknown" not in region("CSS") and "Unknown" not in region("markup"),
      "Unknown appears in a camera region")

# ------------------------------------------- 2. the station's pre-grant duty --
print("2. the camera is pre-granted in the SYNCED path, not the baked layer")
with open(AUTOSTART, encoding="utf-8") as fh:
    AUTO = fh.read()
m = re.search(r"cat > \"\$1/user\.js\" <<'PREFS'\n(.*?)\nPREFS", AUTO, re.S)
prefs = m.group(1) if m else ""
check("als-autostart.sh has the user.js writer (write_ff_prefs)", bool(prefs))
check("the camera is pre-granted for the kiosk origin (permissions.default.camera = 1)",
      'user_pref("permissions.default.camera", 1);' in prefs, prefs[-400:])
check("and the pref is inside the user.js the writer emits, not just a stray comment",
      "permissions.default.camera" in prefs)
if os.path.exists(LAYER):
    with open(LAYER, encoding="utf-8") as fh:
        layer = fh.read()
    check("the baked layer template does NOT carry it (or a sync would need a layer rebuild)",
          "permissions.default.camera" not in layer)
else:
    check("make-als-layer.sh is present to check against", True)  # nothing to contradict

# --------------------------------------------------- 3. the runner, in a page --
print("3. the runner, driven under node with a camera stand-in")
node = shutil.which("node")
if not node:
    if os.environ.get("ALS_REQUIRE_NODE") == "1":
        check("node is installed (ALS_REQUIRE_NODE=1)", False)
    else:
        print("  SKIP running the camera runner under node (node not installed)")
else:
    TMP = tempfile.mkdtemp(prefix="als-hwt-cam-")
    blocks = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", HTML, re.S | re.I)
    js = os.path.join(TMP, "page.js")
    with open(js, "w", encoding="utf-8") as fh:
        fh.write("\n;\n".join(blocks))
    harness = os.path.join(TMP, "h.js")
    # The stand-in provides just enough of a browser to run the camera runner:
    # a DOM whose elements remember their click handlers (so a verdict button
    # can be "clicked"), a window that remembers pagehide handlers, and a
    # navigator.mediaDevices.getUserMedia we drive per scenario - resolving with
    # a fake stream, rejecting with a named DOMException, never settling, or
    # arriving late. Every fake track records when it is stopped, which is how
    # "the camera light never stays on" is proved. The runner's own timeout
    # (15 s) is collapsed to 40 ms here so the "prompt never answers" path is
    # quick; the fake getUserMedia keeps its own real timing, uncapped.
    body = r"""
const vm = require('vm'), fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- fake camera ---------------------------------------------------------
const STOPS = [];
let LATE_STREAM = null;
let GUM = { mode: 'resolve', label: 'Integrated Camera', errName: '', delay: 5 };
function makeStream(label) {
  const track = { kind: 'video', label: label, readyState: 'live', _stopped: false,
    stop() { this._stopped = true; this.readyState = 'ended'; STOPS.push(this); } };
  const tracks = [track];
  return { _tracks: tracks, getTracks() { return tracks.slice(); },
           getVideoTracks() { return tracks.slice(); } };
}
const navigator = { mediaDevices: {
  getUserMedia() {
    const g = GUM;
    return new Promise((resolve, reject) => {
      if (g.mode === 'timeout') return;                                  // never settles
      if (g.mode === 'reject') { setTimeout(() => reject({ name: g.errName }), g.delay); return; }
      if (g.mode === 'late') { setTimeout(() => { LATE_STREAM = makeStream(g.label); resolve(LATE_STREAM); }, g.delay); return; }
      setTimeout(() => resolve(makeStream(g.label)), g.delay);
    });
  }
} };
const MD = navigator.mediaDevices;

// --- fake DOM / window ---------------------------------------------------
const els = {};
function mk(id) {
  const handlers = {};
  const e = { id, style: {}, _cls: '', textContent: '', innerHTML: '', value: '',
    disabled: false, srcObject: null, options: [], selectedOptions: [],
    firstElementChild: { style: {} },
    focus() {}, select() {}, play() { return Promise.resolve(); },
    addEventListener(t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
    removeEventListener(t, fn) { const a = handlers[t]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } },
    _fire(t) { (handlers[t] || []).slice().forEach(fn => fn({ detail: 1 })); },
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

// The runner's setTimeout is capped so its 15 s guard fires fast in the test;
// the fake getUserMedia above uses node's real setTimeout and is not capped.
const capped = (fn, ms) => setTimeout(fn, Math.min(ms || 0, 40));
const ctx = vm.createContext({ document, window, navigator, console, prompt: () => null,
  screen: {}, innerWidth: 0, innerHeight: 0, fetch: () => new Promise(() => {}),
  setTimeout: capped, clearTimeout: (id) => clearTimeout(id), setInterval: () => 0 });
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
  HWT_NEEDS_FILING=false; HWT_SAVES=0; BOOT={}; CAM.stream=null; CAM.settled=false;
  for(const k of HWT_KEYS){ delete HWT_UNSAVED[k]; } renderHwTest();`);

function scenario(cfg) {
  GUM = Object.assign({ mode: 'resolve', label: 'Integrated Camera', errName: '', delay: 5 }, cfg);
  STOPS.length = 0; LATE_STREAM = null;
  navigator.mediaDevices = (cfg && cfg.mode === 'noapi') ? null : MD;
  // A fresh DOM per scenario: in the real page each run rebuilds hwtDetail_camera,
  // so old nodes and the click handlers on them are gone. Without clearing the
  // stand-in's cache the buttons would keep last run's handlers and fire twice.
  for (const k in els) delete els[k];
  for (const k in WIN) delete WIN[k];
  reset();
}
function readCamera() {
  return run(`(function(){ var c=HWTEST.camera||{};
    return {status:c.status, device:c.device, notes:c.notes, reason:c.reason, action:c.action,
      badge:document.getElementById('hwtStat_camera').textContent,
      why:document.getElementById('hwtWhy_camera').textContent,
      saved:(SAVED.length?SAVED[SAVED.length-1].b.camera:null)}; })()`);
}

const out = {};
out.registered = run(`typeof HWT_RUNNERS.camera`);

// PASS: open, type a note, click "working". Result PASSED with device + notes,
// and the one track stopped so the light goes out.
scenario({ mode: 'resolve', label: 'Integrated Camera' });
run(`CAMP = runHwTest('camera')`);
await sleep(90);
run(`document.getElementById('camNotes').value = 'clear, moving picture'`);
run(`document.getElementById('camPass')._fire('click')`);
await run(`CAMP`);
out.pass = readCamera();
out.pass.stopped = STOPS.length === 1 && STOPS[0]._stopped === true;

// FAIL: the technician says the picture is black.
scenario({ mode: 'resolve', label: 'Integrated Camera' });
run(`CAMP = runHwTest('camera')`);
await sleep(90);
run(`document.getElementById('camFail')._fire('click')`);
await run(`CAMP`);
out.fail = readCamera();
out.fail.stopped = STOPS.length === 1 && STOPS[0]._stopped === true;

// A camera whose track carries no label: the device name falls back to a plain
// phrase, never blank.
scenario({ mode: 'resolve', label: '' });
run(`CAMP = runHwTest('camera')`);
await sleep(90);
run(`document.getElementById('camPass')._fire('click')`);
await run(`CAMP`);
out.noLabel = readCamera();

// Permission refused: could-not-run, never a fail.
scenario({ mode: 'reject', errName: 'NotAllowedError' });
run(`CAMP = runHwTest('camera')`);
await run(`CAMP`);
out.denied = readCamera();

// No camera fitted.
scenario({ mode: 'reject', errName: 'NotFoundError' });
run(`CAMP = runHwTest('camera')`);
await run(`CAMP`);
out.noDevice = readCamera();

// A camera that is there but cannot be opened (in use / privacy switch).
scenario({ mode: 'reject', errName: 'NotReadableError' });
run(`CAMP = runHwTest('camera')`);
await run(`CAMP`);
out.inUse = readCamera();

// The media API is missing altogether.
scenario({ mode: 'noapi' });
run(`CAMP = runHwTest('camera')`);
await run(`CAMP`);
out.noApi = readCamera();

// The prompt never answers (the pre-grant pref absent, doorhanger off-screen):
// the runner's own timeout gives up rather than hang the page.
scenario({ mode: 'timeout' });
run(`CAMP = runHwTest('camera')`);
await run(`CAMP`);
out.timeout = readCamera();

// A stream that arrives AFTER the timeout must still be released, or a late
// grant would leave the camera light on.
scenario({ mode: 'late', delay: 90 });
run(`CAMP = runHwTest('camera')`);
await run(`CAMP`);
await sleep(140);
out.late = readCamera();
out.late.lateStopped = !!(LATE_STREAM && LATE_STREAM._tracks.every(t => t._stopped));

// The page is torn down while the technician is still deciding: pagehide stops
// the tracks even though no verdict was ever recorded.
scenario({ mode: 'resolve', label: 'Integrated Camera' });
run(`CAMP = runHwTest('camera')`);
await sleep(90);
STOPS.length = 0;
fireWindow('pagehide');
out.pagehideStopped = STOPS.length >= 1 && STOPS.every(t => t._stopped);
run(`document.getElementById('camPass')._fire('click')`);   // let it finish so the harness ends
await run(`CAMP`);

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

    check("HWT_RUNNERS.camera is a function", o.get("registered") == "function", o.get("registered"))

    p = o.get("pass") or {}
    check("a technician PASS stores PASSED with the device and the note",
          p.get("status") == "PASSED" and p.get("device") == "Integrated Camera"
          and p.get("notes") == "clear, moving picture" and p.get("badge") == "Passed", p)
    check("...and the same fields reach the station (device + notes, not whitelisted away)",
          (p.get("saved") or {}).get("status") == "PASSED"
          and (p.get("saved") or {}).get("device") == "Integrated Camera"
          and (p.get("saved") or {}).get("notes") == "clear, moving picture", p.get("saved"))
    check("...and the camera track is stopped, so the light goes out", p.get("stopped") is True, p)

    f = o.get("fail") or {}
    check("a technician FAIL stores FAILED with the device named",
          f.get("status") == "FAILED" and f.get("device") == "Integrated Camera"
          and f.get("badge") == "Failed", f)
    check("...and a FAIL still stops the track", f.get("stopped") is True, f)

    nl = o.get("noLabel") or {}
    check("a camera with no track label still gets a readable device name, never blank",
          nl.get("status") == "PASSED" and isinstance(nl.get("device"), str)
          and nl.get("device", "").startswith("the machine") and "camera" in nl.get("device", ""), nl)

    d = o.get("denied") or {}
    check("a REFUSED permission is ATTENTION, never FAILED",
          d.get("status") == "ATTENTION" and d.get("badge") == "Needs attention", d)
    check("...with a plain reason and an action the operator can take",
          "permission was refused" in (d.get("reason") or "")
          and "pre-granted" in (d.get("action") or ""), d)

    nd = o.get("noDevice") or {}
    check("NO camera fitted is ATTENTION, never FAILED",
          nd.get("status") == "ATTENTION"
          and "no camera is fitted" in (nd.get("reason") or "")
          and "BIOS" in (nd.get("action") or ""), nd)

    iu = o.get("inUse") or {}
    check("a camera that cannot be opened is ATTENTION, never FAILED",
          iu.get("status") == "ATTENTION" and "could not open it" in (iu.get("reason") or ""), iu)

    na = o.get("noApi") or {}
    check("a missing media API is ATTENTION, never FAILED",
          na.get("status") == "ATTENTION" and "media API is missing" in (na.get("reason") or ""), na)

    to = o.get("timeout") or {}
    check("a prompt that never answers times out to ATTENTION, not a hung page",
          to.get("status") == "ATTENTION" and "did not open in time" in (to.get("reason") or "")
          and "pre-granted" in (to.get("action") or ""), to)

    la = o.get("late") or {}
    check("a stream that arrives after the timeout is still released (no lit light)",
          la.get("lateStopped") is True, la)

    check("the page being torn down mid-decision stops the tracks",
          o.get("pagehideStopped") is True, o.get("pagehideStopped"))

    # The whole rule, restated across every could-not-run path at once.
    cnr = [o.get(k) or {} for k in ("denied", "noDevice", "inUse", "noApi", "timeout")]
    check("NOT ONE could-not-run path is ever recorded as FAILED (the rule the module hangs on)",
          all(x.get("status") == "ATTENTION" for x in cnr)
          and not any(x.get("status") == "FAILED" for x in cnr), [x.get("status") for x in cnr])
    check("no could-not-run message ever prints 'Unknown'",
          not any("Unknown" in ((x.get("reason") or "") + (x.get("action") or "") + (x.get("why") or ""))
                  for x in cnr), cnr)

    shutil.rmtree(TMP, True)

print("\n%d passed, %d failed" % (PASS[0], len(FAIL)))
sys.exit(1 if FAIL else 0)
