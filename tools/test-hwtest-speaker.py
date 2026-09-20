#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""The speaker hardware test (contract C6), the runner filled into index.html
plus its one station duty - the /api/hwtest/audio-prep endpoint in server.py.

The shell (91228c1, 466b4a1) owns the state machine, the save and the summary;
this file exercises ONLY the speaker runner in its region, and checks that the
station duty it depends on is in place. What it proves is the contract for this
one component:

  - the runner registers itself (HWT_RUNNERS.speaker is a function);
  - the station unmutes FIRST (a POST to /api/hwtest/audio-prep), then a tone is
    played per side and the technician judges left and right separately;
  - both sides Working stores PASSED with the contract's fields - left, right,
    mixer, sink, notes - and they reach the station un-whitelisted;
  - a side marked "Not working" stores FAILED (the technician's call, the only
    way to a fault);
  - a side marked "Quiet or distorted" stores ATTENTION with a reason and an
    action;
  - the two things that are NOT dead speakers - the station could not unmute,
    and the call never reached the service - are recorded as ATTENTION
    (could-not-run) with a plain reason and an action, and NEVER as FAILED. Nor
    is a missing Web Audio API: it is could-not-run too;
  - Save is held off until both sides have been judged;
  - the tone is never left droning: the oscillator is stopped and the
    AudioContext closed on the recorded result and when the page is torn down
    mid-decision;
  - the region never prints the word this module is forbidden to print;
  - the station duty is added to server.py AND preview-server.py, is python3
    stdlib and time-limited, and is guarded by the same Host/Origin check every
    other route has (it lives inside do_POST, after request_problem()).

The runner uses fetch (via the page's jpost), the Web Audio API and DOM
elements, so those are stood in for under node the way tools/test-hwtest.py and
tools/test-hwtest-camera.py stand in for the DOM. Without node the browser-driven
section SKIPs and passes, unless ALS_REQUIRE_NODE=1 (set in CI).

    python3 tools/test-hwtest-speaker.py
"""
import ast
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PAGE = os.path.join(HERE, "gui", "index.html")
SERVER = os.path.join(HERE, "gui", "server.py")
PREVIEW = os.path.join(HERE, "gui", "preview-server.py")

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
    """The text between a pair of speaker markers, so a claim about 'the speaker
    region' is checked against that region alone and not the whole page."""
    start = {"CSS": "/* HWTEST:SPEAKER:CSS:START */", "JS": "/* HWTEST:SPEAKER:JS:START */",
             "markup": "<!-- HWTEST:SPEAKER:START -->"}[kind]
    end = {"CSS": "/* HWTEST:SPEAKER:CSS:END */", "JS": "/* HWTEST:SPEAKER:JS:END */",
           "markup": "<!-- HWTEST:SPEAKER:END -->"}[kind]
    i, j = HTML.find(start), HTML.find(end)
    return HTML[i:j] if 0 <= i < j else ""


# ------------------------------------------------------ 1. the region itself --
print("1. the speaker region is present, closed once, and self-contained")
for kind in ("CSS", "JS", "markup"):
    start = {"CSS": "/* HWTEST:SPEAKER:CSS:START */", "JS": "/* HWTEST:SPEAKER:JS:START */",
             "markup": "<!-- HWTEST:SPEAKER:START -->"}[kind]
    end = {"CSS": "/* HWTEST:SPEAKER:CSS:END */", "JS": "/* HWTEST:SPEAKER:JS:END */",
           "markup": "<!-- HWTEST:SPEAKER:END -->"}[kind]
    check("the speaker %s region exists exactly once and closes" % kind,
          HTML.count(start) == 1 and HTML.count(end) == 1 and 0 <= HTML.find(start) < HTML.find(end),
          (HTML.count(start), HTML.count(end)))

JS = region("JS")
check("the runner is registered on HWT_RUNNERS.speaker", "HWT_RUNNERS.speaker" in JS)
check("it unmutes through the station endpoint before the tone",
      "/api/hwtest/audio-prep" in JS and "jpost(" in JS)
check("it plays a per-channel tone with Web Audio (a StereoPanner or a merger)",
      "AudioContext" in JS and ("createStereoPanner" in JS or "createChannelMerger" in JS)
      and "createOscillator" in JS)
check("it records through the shell's helpers, not by hand",
      "hwPass('speaker'" in JS and "hwFail('speaker'" in JS
      and "hwAttention('speaker'" in JS and "hwCannotRun('speaker'" in JS)
check("the whole flow sits in a finally so the tone is always stopped",
      "finally{" in JS or "finally {" in JS)
check("the region binds no global key handler (the shell's rule)",
      "addEventListener('keydown'" not in JS and 'addEventListener("keydown"' not in JS)
check("the speaker region never prints 'Unknown'",
      "Unknown" not in JS and "Unknown" not in region("CSS") and "Unknown" not in region("markup"),
      "Unknown appears in a speaker region")

# ----------------------------------------- 2. the station duty (server.py) ----
print("2. the station duty: /api/hwtest/audio-prep, stdlib, time-limited, guarded")
with open(SERVER, encoding="utf-8") as fh:
    SRV = fh.read()
# ast.parse, reported plainly so a syntax slip is obvious.
try:
    ast.parse(SRV)
    check("server.py is valid Python (ast.parse)", True)
except SyntaxError as exc:
    check("server.py is valid Python (ast.parse)", False, str(exc))
check("server.py answers POST /api/hwtest/audio-prep", '"/api/hwtest/audio-prep"' in SRV)
check("server.py has an audio_prep() that unmutes with wpctl or amixer",
      "def audio_prep(" in SRV and "wpctl" in SRV and "amixer" in SRV)
check("the mixer commands are time-limited so the endpoint cannot hang the page",
      "AUDIO_PREP_TIMEOUT" in SRV and "timeout=" in SRV and "subprocess.run" in SRV)
check("it is stdlib only (no third-party HTTP client dragged in for it)",
      "import requests" not in SRV and "import httpx" not in SRV)
# The guard: the route lives inside do_POST, which runs request_problem() (the
# same Host/Origin check every route has) before it reaches any handler.
dopost = SRV.find("def do_POST")
guard = SRV.find("request_problem(self.headers", dopost)
route = SRV.find('"/api/hwtest/audio-prep"', dopost)
check("the new route is behind the same Host/Origin guard (request_problem in do_POST, before it)",
      0 <= dopost < guard < route, (dopost, guard, route))

# --------------------------------------- 3. the preview stub (clickable) ------
print("3. the preview server has a matching audio-prep stub")
with open(PREVIEW, encoding="utf-8") as fh:
    PRE = fh.read()
try:
    ast.parse(PRE)
    check("preview-server.py is valid Python (ast.parse)", True)
except SyntaxError as exc:
    check("preview-server.py is valid Python (ast.parse)", False, str(exc))
check("preview-server.py answers /api/hwtest/audio-prep with a plausible mixer/sink",
      "/api/hwtest/audio-prep" in PRE and '"mixer"' in PRE and '"sink"' in PRE)
# Scoped to the audio-prep code each file adds - the rest of preview-server.py
# legitimately quotes the word while documenting the drive-health rule that
# forbids it, so a whole-file check would be a false positive.
_srv_i = SRV.find("# ----------------------------------------------- speaker test: unmute ----")
_srv_j = SRV.find("# --------------------------------------------------------------- capture ----", _srv_i)
_pre_i = PRE.find('if u.path == "/api/hwtest/audio-prep":')
_pre_j = PRE.find('return self._send(200, {"ok": True, "message"', _pre_i)
check("neither server's audio-prep code prints 'Unknown'",
      0 <= _srv_i < _srv_j and "Unknown" not in SRV[_srv_i:_srv_j]
      and 0 <= _pre_i < _pre_j and "Unknown" not in PRE[_pre_i:_pre_j],
      (_srv_i, _srv_j, _pre_i, _pre_j))

# --------------------------------------------------- 4. the runner, in a page --
print("4. the runner, driven under node with an audio + station stand-in")
node = shutil.which("node")
if not node:
    if os.environ.get("ALS_REQUIRE_NODE") == "1":
        check("node is installed (ALS_REQUIRE_NODE=1)", False)
    else:
        print("  SKIP running the speaker runner under node (node not installed)")
else:
    TMP = tempfile.mkdtemp(prefix="als-hwt-spk-")
    blocks = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", HTML, re.S | re.I)
    js = os.path.join(TMP, "page.js")
    with open(js, "w", encoding="utf-8") as fh:
        fh.write("\n;\n".join(blocks))
    harness = os.path.join(TMP, "h.js")
    # The stand-in provides just enough of a browser to run the speaker runner:
    # a DOM whose elements remember their click handlers (so a Play or a verdict
    # button can be "clicked"), a window that remembers pagehide handlers and
    # carries a fake AudioContext (recording every oscillator stop and context
    # close, which is how "the tone never drones on" is proved), and a jpost we
    # drive per scenario - answering /api/hwtest/audio-prep with the scenario's
    # prep result (ok, or a could-not-unmute, or a throw), and /api/hwtest with
    # a station stand-in that hands the whole object back so the recorded result
    # reaches SAVED.
    body = r"""
const vm = require('vm'), fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- fake Web Audio ------------------------------------------------------
const AC_STOPS = [], AC_CLOSED = [];
function FakeAudioContext() {
  this.state = 'running'; this.destination = {};
  const self = this;
  this.createOscillator = () => ({ frequency: { value: 0 }, type: '',
    connect() {}, disconnect() {}, start() { self._started = true; },
    stop() { AC_STOPS.push(1); } });
  this.createGain = () => ({ gain: { value: 0 }, connect() {} });
  this.createStereoPanner = () => ({ pan: { value: 0 }, connect() {} });
  this.createChannelMerger = () => ({ connect() {} });
  this.resume = function () { this.state = 'running'; };
  this.close = function () { AC_CLOSED.push(1); };
}

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
  addEventListener(t, fn) { (WIN[t] = WIN[t] || []).push(fn); },
  removeEventListener(t, fn) { const a = WIN[t]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } },
  URL: { createObjectURL() { return 'blob:fake'; } } };
function fireWindow(t) { (WIN[t] || []).slice().forEach(fn => { try { fn(); } catch (e) {} }); }

// The runner's setTimeout (the 1.2 s tone burst) is capped so it fires fast in
// the test; nothing here depends on its real duration.
const capped = (fn, ms) => setTimeout(fn, Math.min(ms || 0, 20));
const ctx = vm.createContext({ document, window, navigator: {}, console, prompt: () => null,
  screen: {}, innerWidth: 0, innerHeight: 0, fetch: () => new Promise(() => {}),
  setTimeout: capped, clearTimeout: (id) => clearTimeout(id), setInterval: () => 0 });
vm.runInContext(src, ctx, { filename: 'index.html<script>' });
const run = (c) => vm.runInContext(c, ctx);
const el = (id) => document.getElementById(id);

// jpost stand-in: /api/hwtest/audio-prep answers with the scenario's PREP (or
// throws when PREP.__throw, to model the call never reaching the service);
// /api/hwtest merges the saved component and hands the object back, so a
// recorded result reaches SAVED with its own fields intact.
run(`SAVED=[]; HELD={}; PREP={ok:true,mixer:'unmuted Master and Speaker, set to 80%',sink:'Built-in Audio Analogue Stereo'};
  jpost=async(u,b)=>{
    if(u==='/api/hwtest/audio-prep'){ if(PREP && PREP.__throw){ throw new Error('no service'); }
      return {ok:true,status:200,data:PREP}; }
    SAVED.push({u:u,b:JSON.parse(JSON.stringify(b))});
    HELD=Object.assign({technician:'Tester',testedAt:'2026-09-20T12:00:00Z',clockWasNetwork:true},HELD,b);
    return {ok:true,status:200,data:{hardwareTest:JSON.parse(JSON.stringify(HELD)),
      hwtestMachine:'HOST1',hwtestNeedsFiling:false}}; };`);
const reset = () => run(`HWTEST={}; HELD={}; SAVED=[]; HWT_RUNNING=false; HWT_MACHINE=''; HWT_NOTE='';
  HWT_NEEDS_FILING=false; HWT_SAVES=0; BOOT={}; SPK.reset();
  for(const k of HWT_KEYS){ delete HWT_UNSAVED[k]; } renderHwTest();`);

function scenario(cfg) {
  cfg = cfg || {};
  AC_STOPS.length = 0; AC_CLOSED.length = 0;
  // A fresh DOM per scenario: in the real page each run rebuilds
  // hwtDetail_speaker, so old nodes and their handlers are gone.
  for (const k in els) delete els[k];
  for (const k in WIN) delete WIN[k];
  // Web Audio present unless the scenario removes it.
  if (cfg.api === false) { delete window.AudioContext; delete window.webkitAudioContext; }
  else { window.AudioContext = FakeAudioContext; }
  reset();
  run(`PREP=${JSON.stringify(cfg.prep || {ok:true,mixer:'unmuted Master and Speaker, set to 80%',sink:'Built-in Audio Analogue Stereo'})};`);
}
function readSpeaker() {
  return run(`(function(){ var s=HWTEST.speaker||{};
    return {status:s.status, left:s.left, right:s.right, mixer:s.mixer, sink:s.sink, notes:s.notes,
      reason:s.reason, action:s.action,
      badge:document.getElementById('hwtStat_speaker').textContent,
      why:document.getElementById('hwtWhy_speaker').textContent,
      saved:(SAVED.length?SAVED[SAVED.length-1].b.speaker:null)}; })()`);
}

const out = {};
out.registered = run(`typeof HWT_RUNNERS.speaker`);

// PASS: unmute ok, play both sides, mark both Working, Save. Result PASSED with
// left/right/mixer/sink/notes, the tone stopped and the context closed.
scenario({});
run(`SP = runHwTest('speaker')`);
await sleep(60);
out.builtPanel = run(`!!document.getElementById('spkSave')`);
run(`document.getElementById('spkNotes').value = 'both clear'`);
run(`document.getElementById('spkPlayLeft')._fire('click')`);
run(`document.getElementById('spkPlayRight')._fire('click')`);
run(`document.getElementById('spkLeftPass')._fire('click')`);
out.saveDisabledAfterOne = run(`document.getElementById('spkSave').disabled`);
run(`document.getElementById('spkRightPass')._fire('click')`);
out.saveEnabledAfterBoth = run(`document.getElementById('spkSave').disabled`) === false;
run(`document.getElementById('spkSave')._fire('click')`);
await run(`SP`);
out.pass = readSpeaker();
out.pass.toneStopped = AC_STOPS.length >= 1;
out.pass.ctxClosed = AC_CLOSED.length >= 1;

// FAIL: the technician marks the left speaker Not working.
scenario({});
run(`SP = runHwTest('speaker')`);
await sleep(60);
run(`document.getElementById('spkLeftFail')._fire('click')`);
run(`document.getElementById('spkRightPass')._fire('click')`);
run(`document.getElementById('spkSave')._fire('click')`);
await run(`SP`);
out.fail = readSpeaker();

// ATTENTION (technician): right speaker quiet or distorted, left working.
scenario({});
run(`SP = runHwTest('speaker')`);
await sleep(60);
run(`document.getElementById('spkLeftPass')._fire('click')`);
run(`document.getElementById('spkRightAttn')._fire('click')`);
run(`document.getElementById('spkSave')._fire('click')`);
await run(`SP`);
out.attn = readSpeaker();

// COULD-NOT-RUN: the station reports it could not unmute. ATTENTION, never a
// fail, and the reason/action come from the endpoint; mixer/sink still stored.
scenario({ prep: { ok: false,
  reason: 'the station could not unmute this machine - it has no working audio output',
  action: 'Check the machine has a built-in speaker, unmute it by hand, then test again.',
  mixer: 'tried Master', sink: '' } });
run(`SP = runHwTest('speaker')`);
await run(`SP`);
out.cannotUnmute = readSpeaker();

// COULD-NOT-RUN: the call never reached the service (jpost throws).
scenario({ prep: { __throw: true } });
run(`SP = runHwTest('speaker')`);
await run(`SP`);
out.noService = readSpeaker();

// COULD-NOT-RUN: no Web Audio API to emit a tone.
scenario({ api: false });
run(`SP = runHwTest('speaker')`);
await run(`SP`);
out.noAudio = readSpeaker();

// The page is torn down while the technician is still deciding: pagehide stops
// the tone and closes the context even though no verdict was recorded.
scenario({});
run(`SP = runHwTest('speaker')`);
await sleep(60);
run(`document.getElementById('spkPlayLeft')._fire('click')`);
AC_STOPS.length = 0; AC_CLOSED.length = 0;
fireWindow('pagehide');
out.pagehideStopped = AC_STOPS.length >= 1 || AC_CLOSED.length >= 1;
run(`document.getElementById('spkLeftPass')._fire('click')`);   // finish so the harness ends
run(`document.getElementById('spkRightPass')._fire('click')`);
run(`document.getElementById('spkSave')._fire('click')`);
await run(`SP`);

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

    check("HWT_RUNNERS.speaker is a function", o.get("registered") == "function", o.get("registered"))
    check("the panel builds after the station unmutes", o.get("builtPanel") is True, o.get("builtPanel"))

    p = o.get("pass") or {}
    check("both sides Working stores PASSED with left/right/mixer/sink/notes",
          p.get("status") == "PASSED" and p.get("left") == "PASSED" and p.get("right") == "PASSED"
          and "80%" in (p.get("mixer") or "") and "Stereo" in (p.get("sink") or "")
          and p.get("notes") == "both clear" and p.get("badge") == "Passed", p)
    check("...and those fields reach the station (not whitelisted away)",
          (p.get("saved") or {}).get("status") == "PASSED"
          and (p.get("saved") or {}).get("left") == "PASSED"
          and (p.get("saved") or {}).get("right") == "PASSED"
          and (p.get("saved") or {}).get("sink"), p.get("saved"))
    check("Save is held off until BOTH sides are judged",
          o.get("saveDisabledAfterOne") is True and o.get("saveEnabledAfterBoth") is True,
          (o.get("saveDisabledAfterOne"), o.get("saveEnabledAfterBoth")))
    check("the tone is stopped and the AudioContext closed on the recorded result",
          p.get("toneStopped") is True and p.get("ctxClosed") is True, p)

    f = o.get("fail") or {}
    check("a side marked 'Not working' stores FAILED",
          f.get("status") == "FAILED" and f.get("left") == "FAILED"
          and "does not work" in (f.get("reason") or "") and f.get("badge") == "Failed", f)

    a = o.get("attn") or {}
    check("a side marked 'Quiet or distorted' stores ATTENTION with a reason and an action",
          a.get("status") == "ATTENTION" and a.get("right") == "ATTENTION"
          and "quiet or distorted" in (a.get("reason") or "")
          and bool(a.get("action")) and a.get("badge") == "Needs attention", a)

    cu = o.get("cannotUnmute") or {}
    check("the station being unable to unmute is ATTENTION, never FAILED",
          cu.get("status") == "ATTENTION"
          and "could not unmute" in (cu.get("reason") or "")
          and bool(cu.get("action")), cu)
    check("...and it still records where it got to (mixer kept)",
          "tried Master" in (cu.get("mixer") or ""), cu)

    ns = o.get("noService") or {}
    check("the unmute call never reaching the service is ATTENTION, never FAILED",
          ns.get("status") == "ATTENTION" and "unmute" in (ns.get("reason") or ""), ns)

    na = o.get("noAudio") or {}
    check("a missing Web Audio API is ATTENTION, never FAILED",
          na.get("status") == "ATTENTION" and "Web Audio API is missing" in (na.get("reason") or ""), na)

    check("the page torn down mid-decision stops the tone / closes the context",
          o.get("pagehideStopped") is True, o.get("pagehideStopped"))

    # The whole rule, restated across every could-not-run path at once.
    cnr = [o.get(k) or {} for k in ("cannotUnmute", "noService", "noAudio")]
    check("NOT ONE could-not-run path is ever recorded as FAILED (the rule the module hangs on)",
          all(x.get("status") == "ATTENTION" for x in cnr)
          and not any(x.get("status") == "FAILED" for x in cnr), [x.get("status") for x in cnr])
    check("no could-not-run message ever prints 'Unknown'",
          not any("Unknown" in ((x.get("reason") or "") + (x.get("action") or "") + (x.get("why") or ""))
                  for x in cnr), cnr)

    shutil.rmtree(TMP, True)

print("\n%d passed, %d failed" % (PASS[0], len(FAIL)))
sys.exit(1 if FAIL else 0)
