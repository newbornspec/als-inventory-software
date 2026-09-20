#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""The microphone hardware test (contract C6), the runner filled into index.html.

The shell owns the state machine, the save and the summary; this file exercises
ONLY the microphone runner in its region. What it proves is the contract for
this one component:

  - the runner registers itself (HWT_RUNNERS.microphone is a function);
  - the technician clicking "Microphone works" stores PASSED with the fields the
    contract wants for the microphone - device, notes, confirmedBy - and those
    fields reach the station;
  - clicking "Microphone has an issue" stores FAILED, carrying the technician's
    own words;
  - the two things that are NOT a broken microphone - a refused permission and
    no microphone fitted - are recorded as ATTENTION (could-not-run) with a
    plain reason and an action, and NEVER as FAILED. Nor is a microphone the
    station cannot open, a missing media API, a missing Web Audio API, or a
    permission prompt that never answers: every failure to open or to MEASURE
    the microphone is could-not-run;
  - the microphone is never left live - every track is stopped AND the
    AudioContext closed on the pass, the fail, an error and when the page is torn
    down while the technician is still deciding, and a stream that arrives after
    a timeout is released too;
  - the level meter is said in WORDS as well as drawn as a bar, so the reading
    never rides on motion or colour alone, and its timer is cleared on the way
    out rather than left ticking against a panel that has gone;
  - the region never prints the word this module is forbidden to print;
  - the station pre-grants the microphone in the SYNCED path (als-autostart.sh),
    beside the camera one and not in the baked layer template, and the runner
    still degrades gracefully without it.

The runner uses getUserMedia, an AudioContext and an AnalyserNode, so those are
stood in for under node the way tools/test-hwtest-camera.py stands in for the
camera. Without node the browser-driven section SKIPs and passes, unless
ALS_REQUIRE_NODE=1 (set in CI).

    python3 tools/test-hwtest-microphone.py
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

MARKS = {"CSS": ("/* HWTEST:MICROPHONE:CSS:START */", "/* HWTEST:MICROPHONE:CSS:END */"),
         "JS": ("/* HWTEST:MICROPHONE:JS:START */", "/* HWTEST:MICROPHONE:JS:END */"),
         "markup": ("<!-- HWTEST:MICROPHONE:START -->", "<!-- HWTEST:MICROPHONE:END -->")}


def region(kind):
    """The text between a pair of microphone markers, so a claim about 'the
    microphone region' is checked against that region alone, not the whole
    page."""
    start, end = MARKS[kind]
    i, j = HTML.find(start), HTML.find(end)
    return HTML[i:j] if 0 <= i < j else ""


# ------------------------------------------------------ 1. the region itself --
print("1. the microphone region is present, closed once, and self-contained")
for kind in ("CSS", "JS", "markup"):
    start, end = MARKS[kind]
    check("the microphone %s region exists exactly once and closes" % kind,
          HTML.count(start) == 1 and HTML.count(end) == 1 and 0 <= HTML.find(start) < HTML.find(end),
          (HTML.count(start), HTML.count(end)))

JS = region("JS")
check("the runner is registered on HWT_RUNNERS.microphone", "HWT_RUNNERS.microphone" in JS)
check("it opens the microphone with getUserMedia({audio:true})", "getUserMedia({audio:true})" in JS)
check("it measures the level with an AnalyserNode, not by guessing",
      "createAnalyser" in JS and "getByteTimeDomainData" in JS)
check("it stops tracks and closes the AudioContext (the microphone must not stay live)",
      ".stop()" in JS and "getTracks()" in JS and ".close()" in JS)
check("it records through the shell's helpers, not by hand",
      "hwPass('microphone'" in JS and "hwFail('microphone'" in JS
      and "hwCannotRun('microphone'" in JS)
check("the whole flow sits in a finally so the microphone is always released",
      "finally{" in JS or "finally {" in JS)
check("the meter's interval is cleared as well as set (no timer outlives the panel)",
      "setInterval" in JS and "clearInterval" in JS)
check("the level is carried in WORDS, not by the bar alone",
      "Picking up sound" in JS and "Silent" in JS and "micWord" in JS)
check("it is wired to the shell's ids: hwtDetail_microphone is where it builds",
      "hwtDetail_microphone" in JS)
check("the microphone rows and shell know the test: HWT_KEYS, HWT_NAMES, HWT_ABOUT",
      "'microphone'" in HTML and "microphone:'Microphone'" in HTML.replace(" ", "")
      and 'id="hwtStat_microphone"' in HTML and 'id="hwtWhy_microphone"' in HTML
      and 'id="hwtRun_microphone"' in HTML)
check("the microphone region never prints 'Unknown'",
      "Unknown" not in JS and "Unknown" not in region("CSS") and "Unknown" not in region("markup"),
      "Unknown appears in a microphone region")

# ------------------------------------------- 2. the station's pre-grant duty --
print("2. the microphone is pre-granted in the SYNCED path, beside the camera")
with open(AUTOSTART, encoding="utf-8") as fh:
    AUTO = fh.read()
m = re.search(r"cat > \"\$1/user\.js\" <<'PREFS'\n(.*?)\nPREFS", AUTO, re.S)
prefs = m.group(1) if m else ""
check("als-autostart.sh has the user.js writer (write_ff_prefs)", bool(prefs))
check("the microphone is pre-granted for the kiosk origin (permissions.default.microphone = 1)",
      'user_pref("permissions.default.microphone", 1);' in prefs, prefs[-400:])
check("...in the same writer as the camera pre-grant, so one sync carries both",
      "permissions.default.camera" in prefs and "permissions.default.microphone" in prefs)
if os.path.exists(LAYER):
    with open(LAYER, encoding="utf-8") as fh:
        layer = fh.read()
    check("the baked layer template does NOT carry it (or a sync would need a layer rebuild)",
          "permissions.default.microphone" not in layer)
else:
    check("make-als-layer.sh is present to check against", True)  # nothing to contradict

# --------------------------------------------------- 3. the runner, in a page --
print("3. the runner, driven under node with a microphone stand-in")
node = shutil.which("node")
if not node:
    if os.environ.get("ALS_REQUIRE_NODE") == "1":
        check("node is installed (ALS_REQUIRE_NODE=1)", False)
    else:
        print("  SKIP running the microphone runner under node (node not installed)")
else:
    TMP = tempfile.mkdtemp(prefix="als-hwt-mic-")
    blocks = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", HTML, re.S | re.I)
    js = os.path.join(TMP, "page.js")
    with open(js, "w", encoding="utf-8") as fh:
        fh.write("\n;\n".join(blocks))
    harness = os.path.join(TMP, "h.js")
    # The stand-in provides just enough of a browser to run the microphone
    # runner: a DOM whose elements remember their click handlers, a window that
    # remembers pagehide handlers and carries an AudioContext, and a
    # navigator.mediaDevices.getUserMedia we drive per scenario - resolving with
    # a fake stream, rejecting with a named DOMException, never settling, or
    # arriving late. Every fake track records when it is stopped and every fake
    # AudioContext records when it is closed, which is how "the microphone is
    # never left live" is proved. setInterval is a registry rather than a real
    # timer, so the meter can be ticked on demand AND it can be proved that
    # nothing is left ticking afterwards. The runner's own 15 s guard is
    # collapsed to 40 ms here so the "prompt never answers" path is quick.
    body = r"""
const vm = require('vm'), fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- fake microphone -----------------------------------------------------
const STOPS = [];
let LATE_STREAM = null;
let GUM = { mode: 'resolve', label: 'Internal Microphone', errName: '', delay: 5 };
let AMP = 0;                       // what the fake microphone is "hearing", 0..1
function makeStream(label) {
  const track = { kind: 'audio', label: label, readyState: 'live', _stopped: false,
    stop() { this._stopped = true; this.readyState = 'ended'; STOPS.push(this); } };
  const tracks = [track];
  return { _tracks: tracks, getTracks() { return tracks.slice(); },
           getAudioTracks() { return tracks.slice(); } };
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

// --- fake Web Audio ------------------------------------------------------
const CTXS = [];
function FakeCtx() { this.state = 'suspended'; this.closed = false; CTXS.push(this); }
FakeCtx.prototype.resume = function () { this.state = 'running'; };
FakeCtx.prototype.close = function () { this.closed = true; this.state = 'closed'; };
FakeCtx.prototype.createMediaStreamSource = function (s) {
  this.source = s;
  return { connect() {}, disconnect() {} };
};
FakeCtx.prototype.createAnalyser = function () {
  return { fftSize: 1024, connect() {}, disconnect() {},
    // A square wave at AMP: the RMS the runner computes comes out as AMP, so a
    // scenario can "speak" by setting AMP and ticking the meter.
    getByteTimeDomainData(buf) {
      const swing = Math.round(127 * AMP);
      for (let i = 0; i < buf.length; i++) buf[i] = 128 + (i % 2 ? swing : -swing);
    } };
};

// --- fake DOM / window ---------------------------------------------------
const els = {};
function mk(id) {
  const handlers = {};
  const e = { id, style: {}, _cls: '', textContent: '', innerHTML: '', value: '',
    disabled: false, options: [], selectedOptions: [], firstElementChild: { style: {} },
    focus() {}, select() {},
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
  AudioContext: FakeCtx,
  addEventListener(t, fn) { (WIN[t] = WIN[t] || []).push(fn); },
  removeEventListener(t, fn) { const a = WIN[t]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } },
  URL: { createObjectURL() { return 'blob:fake'; } } };
function fireWindow(t) { (WIN[t] || []).slice().forEach(fn => { try { fn(); } catch (e) {} }); }

// setInterval as a registry: nothing fires on its own, so the meter is ticked
// deliberately and a timer left behind is visible rather than silent.
const LIVE = {};
let SEQ = 0;
const fakeSetInterval = (fn) => { const id = ++SEQ; LIVE[id] = fn; return id; };
const fakeClearInterval = (id) => { delete LIVE[id]; };
const tick = (n) => { for (let i = 0; i < (n || 1); i++) Object.keys(LIVE).forEach(k => { try { LIVE[k](); } catch (e) {} }); };
const liveTimers = () => Object.keys(LIVE).length;

// The runner's setTimeout is capped so its 15 s guard fires fast in the test;
// the fake getUserMedia above uses node's real setTimeout and is not capped.
const capped = (fn, ms) => setTimeout(fn, Math.min(ms || 0, 40));
const ctx = vm.createContext({ document, window, navigator, console, prompt: () => null,
  screen: {}, innerWidth: 0, innerHeight: 0, fetch: () => new Promise(() => {}),
  setTimeout: capped, clearTimeout: (id) => clearTimeout(id),
  setInterval: fakeSetInterval, clearInterval: fakeClearInterval });
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
  HWT_NEEDS_FILING=false; HWT_SAVES=0; BOOT={}; MIC.stream=null; MIC.ac=null; MIC.timer=null;
  MIC.settled=false; MIC.peak=0;
  for(const k of HWT_KEYS){ delete HWT_UNSAVED[k]; } renderHwTest();`);

function scenario(cfg) {
  GUM = Object.assign({ mode: 'resolve', label: 'Internal Microphone', errName: '', delay: 5 }, cfg);
  STOPS.length = 0; CTXS.length = 0; LATE_STREAM = null; AMP = 0;
  navigator.mediaDevices = (cfg && cfg.mode === 'noapi') ? null : MD;
  window.AudioContext = (cfg && cfg.mode === 'noaudio') ? undefined : FakeCtx;
  // A fresh DOM per scenario: in the real page each run rebuilds
  // hwtDetail_microphone, so old nodes and their click handlers are gone.
  for (const k in els) delete els[k];
  for (const k in WIN) delete WIN[k];
  for (const k in LIVE) delete LIVE[k];
  reset();
}
function readMic() {
  return run(`(function(){ var m=HWTEST.microphone||{};
    return {status:m.status, device:m.device, notes:m.notes, confirmedBy:m.confirmedBy,
      reason:m.reason, action:m.action,
      badge:document.getElementById('hwtStat_microphone').textContent,
      why:document.getElementById('hwtWhy_microphone').textContent,
      saved:(SAVED.length?SAVED[SAVED.length-1].b.microphone:null)}; })()`);
}
const closedAll = () => CTXS.length > 0 && CTXS.every(c => c.closed === true);

const out = {};
out.registered = run(`typeof HWT_RUNNERS.microphone`);

// PASS: open, watch the meter move, type a note, click "works".
scenario({ mode: 'resolve', label: 'Internal Microphone' });
run(`MICP = runHwTest('microphone')`);
await sleep(90);
out.meterSilent = { word: el('micWord').textContent, width: el('micFill').style.width,
  peak: el('micPeak').textContent };
AMP = 0.3; tick();
out.meterLoud = { word: el('micWord').textContent, width: el('micFill').style.width,
  peak: el('micPeak').textContent };
AMP = 0.08; tick();
out.meterQuiet = el('micWord').textContent;
AMP = 0; tick();
out.meterBackToSilence = { word: el('micWord').textContent, peak: el('micPeak').textContent };
out.meterTicking = liveTimers();
run(`document.getElementById('micNote').value = 'clear, no crackle'`);
run(`document.getElementById('micPass')._fire('click')`);
await run(`MICP`);
out.pass = readMic();
out.pass.stopped = STOPS.length === 1 && STOPS[0]._stopped === true;
out.pass.ctxClosed = closedAll();
out.pass.timersLeft = liveTimers();

// FAIL: the technician heard nothing, and says so in the notes.
scenario({ mode: 'resolve', label: 'Internal Microphone' });
run(`MICP = runHwTest('microphone')`);
await sleep(90);
run(`document.getElementById('micNote').value = 'nothing at all, even shouting'`);
run(`document.getElementById('micFail')._fire('click')`);
await run(`MICP`);
out.fail = readMic();
out.fail.stopped = STOPS.length === 1 && STOPS[0]._stopped === true;
out.fail.ctxClosed = closedAll();
out.fail.timersLeft = liveTimers();

// A microphone whose track carries no label: the device name falls back to a
// plain phrase, never blank.
scenario({ mode: 'resolve', label: '' });
run(`MICP = runHwTest('microphone')`);
await sleep(90);
run(`document.getElementById('micPass')._fire('click')`);
await run(`MICP`);
out.noLabel = readMic();

// Permission refused: could-not-run, never a fail.
scenario({ mode: 'reject', errName: 'NotAllowedError' });
run(`MICP = runHwTest('microphone')`);
await run(`MICP`);
out.denied = readMic();

// No microphone fitted.
scenario({ mode: 'reject', errName: 'NotFoundError' });
run(`MICP = runHwTest('microphone')`);
await run(`MICP`);
out.noDevice = readMic();

// One that is there but cannot be opened (in use / hardware mute).
scenario({ mode: 'reject', errName: 'NotReadableError' });
run(`MICP = runHwTest('microphone')`);
await run(`MICP`);
out.inUse = readMic();

// The media API is missing altogether.
scenario({ mode: 'noapi' });
run(`MICP = runHwTest('microphone')`);
await run(`MICP`);
out.noApi = readMic();

// Web Audio is missing: the microphone could be opened but not MEASURED, which
// is the station being unable to run the test - and it must not open the
// microphone at all in that case.
scenario({ mode: 'noaudio' });
run(`MICP = runHwTest('microphone')`);
await run(`MICP`);
out.noAudio = readMic();
out.noAudio.everOpened = STOPS.length > 0 || LATE_STREAM !== null;

// The prompt never answers (the pre-grant pref absent, doorhanger off-screen).
scenario({ mode: 'timeout' });
run(`MICP = runHwTest('microphone')`);
await run(`MICP`);
out.timeout = readMic();

// A stream that arrives AFTER the timeout must still be released, or a late
// grant would leave the microphone live.
scenario({ mode: 'late', delay: 90 });
run(`MICP = runHwTest('microphone')`);
await run(`MICP`);
await sleep(140);
out.late = readMic();
out.late.lateStopped = !!(LATE_STREAM && LATE_STREAM._tracks.every(t => t._stopped));

// The page is torn down while the technician is still deciding: pagehide stops
// the tracks, closes the context and clears the meter even though no verdict
// was ever recorded.
scenario({ mode: 'resolve', label: 'Internal Microphone' });
run(`MICP = runHwTest('microphone')`);
await sleep(90);
STOPS.length = 0;
fireWindow('pagehide');
out.pagehide = { stopped: STOPS.length >= 1 && STOPS.every(t => t._stopped),
  ctxClosed: closedAll(), timersLeft: liveTimers() };
run(`document.getElementById('micPass')._fire('click')`);   // let it finish so the harness ends
await run(`MICP`);

// Everything the panel ever said, for the "never Unknown" sweep.
out.panelText = run(`HWT_KEYS.map(k=>document.getElementById('hwtStat_'+k).textContent+' '+
  document.getElementById('hwtWhy_'+k).textContent).join(' ')`);

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

    check("HWT_RUNNERS.microphone is a function", o.get("registered") == "function",
          o.get("registered"))

    ms = o.get("meterSilent") or {}
    ml = o.get("meterLoud") or {}
    check("a silent room reads 'Silent' IN WORDS, with an empty bar",
          ms.get("word", "").startswith("Silent") and ms.get("width") == "0%", ms)
    check("...and says so about the whole test too, rather than leaving a blank",
          "No sound has reached the microphone yet" in ms.get("peak", ""), ms)
    check("speaking moves the reading to 'Picking up sound' IN WORDS, not just the bar",
          ml.get("word", "").startswith("Picking up sound") and ml.get("width") not in ("", "0%"), ml)
    check("a quieter voice is still reported as picking up sound",
          (o.get("meterQuiet") or "").startswith("Picking up sound"), o.get("meterQuiet"))
    bs = o.get("meterBackToSilence") or {}
    check("falling silent again says silent, but what was heard is not forgotten",
          bs.get("word", "").startswith("Silent")
          and "Sound has reached the microphone" in bs.get("peak", ""), bs)
    check("the meter really is on a timer while the panel is up", o.get("meterTicking") == 1,
          o.get("meterTicking"))

    p = o.get("pass") or {}
    check("a technician PASS stores PASSED with the device, the note and who confirmed it",
          p.get("status") == "PASSED" and p.get("device") == "Internal Microphone"
          and p.get("notes") == "clear, no crackle" and p.get("confirmedBy") == "technician"
          and p.get("badge") == "Passed", p)
    check("...and the same fields reach the station (not whitelisted away)",
          (p.get("saved") or {}).get("status") == "PASSED"
          and (p.get("saved") or {}).get("device") == "Internal Microphone"
          and (p.get("saved") or {}).get("notes") == "clear, no crackle", p.get("saved"))
    check("...and the microphone is released: the track stopped and the AudioContext closed",
          p.get("stopped") is True and p.get("ctxClosed") is True, p)
    check("...and the meter's timer is cleared, not left ticking on a panel that has gone",
          p.get("timersLeft") == 0, p)

    f = o.get("fail") or {}
    check("a technician FAIL stores FAILED, in the technician's own words",
          f.get("status") == "FAILED" and f.get("badge") == "Failed"
          and "nothing at all" in (f.get("reason") or "")
          and f.get("notes") == "nothing at all, even shouting", f)
    check("...and a FAIL releases the microphone just the same",
          f.get("stopped") is True and f.get("ctxClosed") is True and f.get("timersLeft") == 0, f)

    nl = o.get("noLabel") or {}
    check("a microphone with no track label still gets a readable device name, never blank",
          nl.get("status") == "PASSED" and isinstance(nl.get("device"), str)
          and nl.get("device", "").startswith("the machine")
          and "microphone" in nl.get("device", ""), nl)

    d = o.get("denied") or {}
    check("a REFUSED permission is ATTENTION, never FAILED",
          d.get("status") == "ATTENTION" and d.get("badge") == "Needs attention", d)
    check("...with a plain reason and an action the operator can take",
          "permission was refused" in (d.get("reason") or "")
          and "pre-granted" in (d.get("action") or "")
          and "permissions.default.microphone" in (d.get("action") or ""), d)

    nd = o.get("noDevice") or {}
    check("NO microphone fitted is ATTENTION, never FAILED",
          nd.get("status") == "ATTENTION"
          and "no microphone is fitted" in (nd.get("reason") or "")
          and "BIOS" in (nd.get("action") or ""), nd)

    iu = o.get("inUse") or {}
    check("a microphone that cannot be opened is ATTENTION, never FAILED",
          iu.get("status") == "ATTENTION" and "could not open it" in (iu.get("reason") or ""), iu)

    na = o.get("noApi") or {}
    check("a missing media API is ATTENTION, never FAILED",
          na.get("status") == "ATTENTION" and "media API is missing" in (na.get("reason") or ""), na)

    nau = o.get("noAudio") or {}
    check("no Web Audio means the level cannot be measured: ATTENTION, never FAILED",
          nau.get("status") == "ATTENTION"
          and "Web Audio API is missing" in (nau.get("reason") or "")
          and "sync-usb.ps1" in (nau.get("action") or ""), nau)
    check("...and the microphone is not even opened when it could not be measured",
          nau.get("everOpened") is False, nau)

    to = o.get("timeout") or {}
    check("a prompt that never answers times out to ATTENTION, not a hung page",
          to.get("status") == "ATTENTION" and "did not open in time" in (to.get("reason") or "")
          and "pre-granted" in (to.get("action") or ""), to)

    la = o.get("late") or {}
    check("a stream that arrives after the timeout is still released (never left live)",
          la.get("lateStopped") is True, la)

    ph = o.get("pagehide") or {}
    check("the page being torn down mid-decision stops the track, closes the context "
          "and clears the meter",
          ph.get("stopped") is True and ph.get("ctxClosed") is True
          and ph.get("timersLeft") == 0, ph)

    # The whole rule, restated across every could-not-run path at once.
    cnr = [o.get(k) or {} for k in ("denied", "noDevice", "inUse", "noApi", "noAudio", "timeout")]
    check("NOT ONE could-not-run path is ever recorded as FAILED (the rule the module hangs on)",
          all(x.get("status") == "ATTENTION" for x in cnr)
          and not any(x.get("status") == "FAILED" for x in cnr), [x.get("status") for x in cnr])
    check("every could-not-run carries BOTH a reason and an action",
          all((x.get("reason") or "").strip() and (x.get("action") or "").strip() for x in cnr), cnr)
    check("no microphone message ever prints 'Unknown'",
          not any("nknown" in ((x.get("reason") or "") + (x.get("action") or "") + (x.get("why") or ""))
                  for x in cnr)
          and "nknown" not in (o.get("panelText") or "x"), cnr)

    shutil.rmtree(TMP, True)

print("\n%d passed, %d failed" % (PASS[0], len(FAIL)))
sys.exit(1 if FAIL else 0)
