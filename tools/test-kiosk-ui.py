#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""The kiosk page's own script: it must parse, and the wipe panel must keep
every drive's result on screen and only say "certificate available" when that
is true.

1. Extracts the inline <script> from tools/gui/index.html and runs
   `node --check` on it. The page is one file with no build step, so a syntax
   error would otherwise ship straight to the station and leave a dead screen.
2. Runs the script under node with a small stand-in for the DOM (no browser,
   no network: fetch never answers), then drives the wipe flow: the confirm
   dialog names model AND serial, names a batch only in the Goods In workflow;
   two drives finish (one failed, one wiped) and BOTH results are still written
   in their own blocks after every pending timer has fired; the run ends with a
   Done button, not by hiding itself; "certificate available" appears only when
   every drive wiped and was recorded, and a server "no" (contract C4) wins.

Needs node. Without it the test says SKIP and passes, unless
ALS_REQUIRE_NODE=1 (set it where node is expected, e.g. CI runners, which
ship node).

    python3 tools/test-kiosk-ui.py
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


def inline_script(html):
    """The page's inline script(s), joined. <script src=...> are not ours."""
    blocks = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", html, re.S | re.I)
    return "\n;\n".join(blocks)


# The stand-in DOM and the scenario. Kept deliberately small: elements are
# plain objects created on first getElementById, className and classList agree,
# and setTimeout only RECORDS callbacks so the test decides when "time passes".
HARNESS = r"""
const vm = require('vm'), fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const out = {};
const els = {};
function mk(id) {
  const e = { id, style: {}, _cls: '', textContent: '', innerHTML: '', value: '',
    options: [], selectedOptions: [], firstElementChild: { style: {} },
    scrollTop: 0, scrollHeight: 0, focus() {}, select() {},
    get className() { return this._cls; }, set className(v) { this._cls = String(v); } };
  const set = () => new Set(e._cls.split(' ').filter(Boolean));
  const put = (s) => { e._cls = Array.from(s).join(' '); };
  e.classList = {
    add(...c) { const s = set(); c.forEach(x => s.add(x)); put(s); },
    remove(...c) { const s = set(); c.forEach(x => s.delete(x)); put(s); },
    toggle(c, f) { const s = set(); const on = f === undefined ? !s.has(c) : !!f;
      if (on) s.add(c); else s.delete(c); put(s); return on; },
    contains(c) { return set().has(c); } };
  return e;
}
const document = {
  getElementById: (id) => els[id] || (els[id] = mk(id)),
  addEventListener() {}, querySelectorAll: () => [], activeElement: null };
const timers = [];
const ctx = vm.createContext({
  document, console, prompt: () => null, screen: {}, innerWidth: 0, innerHeight: 0,
  fetch: () => new Promise(() => {}),              // the network never answers
  setTimeout: (f) => { timers.push(f); return timers.length; },
  clearTimeout() {}, setInterval() {} });
vm.runInContext(src, ctx, { filename: 'index.html<script>' });
const run = (code) => vm.runInContext(code, ctx);
const flush = () => { while (timers.length) { try { timers.shift()(); } catch (e) {} } };
const hidden = (id) => document.getElementById(id).classList.contains('hidden');

(async () => {
  // Markup state the real page starts in.
  for (const id of ['wRun', 'wSummary', 'wDone']) document.getElementById(id).className = 'hidden';
  document.getElementById('wMethod').value = 'auto';
  const bs = document.getElementById('batchSel');
  bs.value = 'lot-1'; bs.selectedOptions = [{ textContent: 'B-0042' }];

  run(`DRIVES=[
    {device:'/dev/nvme0n1',size:'512 GB',model:'Samsung SSD 980',serial:'S5H2NS0N123',bytes:512e9},
    {device:'/dev/sda',size:'500 GB',model:'WD Blue',serial:'',bytes:500e9}];
    selectedWipeDrives=()=>['/dev/nvme0n1','/dev/sda'];`);
  out.labelSerial = run(`driveLabel(DRIVES[0])`);
  out.labelNoSerial = run(`driveLabel(DRIVES[1])`);
  out.optHtml = run(`driveOpts()`);

  // Confirm dialog, general (amazon) workflow: no batch named.
  run(`BOOT={workflow:'amazon'}`);
  run(`confirmWipe()`);
  out.confirmAmazon = document.getElementById('ovMsg').textContent;
  run(`closeOv()`);
  // Goods In: the batch is named.
  run(`BOOT={workflow:'goods_in'}`);
  run(`confirmWipe()`);
  out.confirmGoodsIn = document.getElementById('ovMsg').textContent;

  // Start the run: the server accepts both; capture each drive's poller.
  run(`POLLS=[]; pollJob=(kind,o)=>{POLLS.push({kind,o});};
       jpost=async()=>({ok:true,status:200,data:{started:['/dev/nvme0n1','/dev/sda'],busy:[]}});
       ELIG=[]; jget=async(u)=>{ELIG.push(u); return ELIGANS;}; ELIGANS={known:false};`);
  await run(`ovGo()`);
  out.polls = run(`POLLS.map(p=>p.kind)`);
  out.runsHtml = document.getElementById('wRuns').innerHTML;
  out.runShown = !hidden('wRun');
  out.actionsHiddenDuring = hidden('wActions');

  // One fails, then the other wipes a moment later.
  run(`POLLS[0].o.onDone({status:'failed',method:'none',reason:'sanitize aborted by the drive',recorded:true,recordAssetId:'a-1'})`);
  out.doneAfterOne = !hidden('wDone');
  run(`POLLS[1].o.onDone({status:'wiped',method:'Overwrite + verify',recorded:true,recordTag:'ALS-7',recordAssetId:'a-1'})`);
  flush();                                          // "10 seconds later"
  await new Promise(r => setImmediate(r));
  flush();
  const k0 = 'wres__dev_nvme0n1', k1 = 'wres__dev_sda';
  out.res0 = document.getElementById(k0).innerHTML; out.res0cls = document.getElementById(k0).className;
  out.res1 = document.getElementById(k1).innerHTML; out.res1cls = document.getElementById(k1).className;
  out.runStillShown = !hidden('wRun');
  out.doneShown = !hidden('wDone');
  out.actionsStillHidden = hidden('wActions');
  out.summary = document.getElementById('wSummary').innerHTML;
  out.eligAskedOnFailure = run(`ELIG.length`);

  // Done hands the controls back.
  run(`bootstrap=()=>{}`);
  run(`wipeDone()`);
  out.afterDoneRunHidden = hidden('wRun');
  out.afterDoneActions = !hidden('wActions');

  // Pure rules.
  const W = (m) => `({status:'wiped',method:'${m}',recorded:true,recordAssetId:'a-1'})`;
  out.oWiped = run(`wipeOutcome(${W('NVMe crypto erase')})`);
  out.oFailed = run(`wipeOutcome({status:'failed',method:'none',reason:'drive stopped responding'})`);
  out.oRefused = run(`wipeOutcome({status:'refused',reason:'serial mismatch'})`);
  out.oQueued = run(`wipeOutcome({status:'wiped',method:'Zero pass',queued:true,recorded:false})`);
  out.oUnrec = run(`wipeOutcome({status:'wiped',method:'Zero pass',recordError:'HTTP 500'})`);
  out.cMixed = run(`certSummary([${W('x')},{status:'failed',reason:'r'}])`);
  out.cUnrecorded = run(`certSummary([${W('x')},{status:'wiped',method:'y',queued:true}])`);
  out.cPending = run(`certSummary([${W('x')},${W('y')}])`);
  out.cServerYes = run(`certSummary([${W('x')},${W('y')}],[{known:true,available:true,verdict:'wiped'}])`);
  out.cServerNo = run(`certSummary([${W('x')}],[{known:true,available:false,verdict:'incomplete',
    reason:'another drive of this machine has no wipe on record',
    drives:[{key:'W2',serialNumber:'W2',model:'WD Blue',status:'missing'}]}])`);
  out.cUnknown = run(`certSummary([${W('x')}],[{known:false}])`);

  // End to end with a server "yes": the run's summary is updated to available.
  run(`RUN=null; ELIG=[]; ELIGANS={known:true,available:true,verdict:'wiped',reason:null,drives:[]}`);
  run(`confirmWipe()`);
  await run(`ovGo()`);
  run(`POLLS[POLLS.length-2].o.onDone(${W('A')}); POLLS[POLLS.length-1].o.onDone(${W('B')});`);
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  out.e2eElig = run(`ELIG`);
  out.e2eSummary = document.getElementById('wSummary').innerHTML;

  process.stdout.write(JSON.stringify(out));
})().catch((e) => { process.stdout.write(JSON.stringify({ error: String(e && e.stack || e) })); });
"""


def main():
    with open(PAGE, encoding="utf-8") as fh:
        html = fh.read()
    js = inline_script(html)
    check("index.html has an inline script", len(js) > 1000, len(js))

    node = shutil.which("node")
    if not node:
        if os.environ.get("ALS_REQUIRE_NODE") == "1":
            check("node is installed (ALS_REQUIRE_NODE=1)", False)
        else:
            print("  SKIP node not installed - the script was not syntax-checked or run")
        return

    tmp = tempfile.mkdtemp(prefix="als-kiosk-ui-")
    try:
        page_js = os.path.join(tmp, "page.js")
        harness = os.path.join(tmp, "harness.js")
        with open(page_js, "w", encoding="utf-8") as fh:
            fh.write(js)
        with open(harness, "w", encoding="utf-8") as fh:
            fh.write(HARNESS)

        print("syntax")
        chk = subprocess.run([node, "--check", page_js], capture_output=True, text=True)
        check("node --check: the page script parses", chk.returncode == 0, chk.stderr[-800:])
        if chk.returncode != 0:
            return

        print("wipe panel")
        res = subprocess.run([node, harness, page_js], capture_output=True, text=True,
                             encoding="utf-8", timeout=60)
        try:
            o = json.loads(res.stdout)
        except ValueError:
            check("harness ran", False, (res.stdout[-800:], res.stderr[-800:]))
            return
        check("harness ran", "error" not in o, o.get("error"))
        if "error" in o:
            return
    finally:
        shutil.rmtree(tmp, True)

    check("drive label names model and serial",
          "Samsung SSD 980" in o["labelSerial"] and "S/N S5H2NS0N123" in o["labelSerial"],
          o["labelSerial"])
    check("a drive with no serial says so", "serial not reported" in o["labelNoSerial"],
          o["labelNoSerial"])
    check("the drive list shows the serial", "S/N S5H2NS0N123" in o["optHtml"], o["optHtml"])
    ca, cg = o["confirmAmazon"], o["confirmGoodsIn"]
    check("confirm dialog names each drive's model and serial",
          "Samsung SSD 980" in ca and "S5H2NS0N123" in ca and "WD Blue" in ca, ca)
    check("confirm dialog: no batch named outside Goods In", "batch" not in ca.lower(), ca)
    check("confirm dialog: Goods In names the batch", "B-0042" in cg, cg)

    check("one poller per drive", o["polls"] == ["wipe:/dev/nvme0n1", "wipe:/dev/sda"], o["polls"])
    check("run panel names each drive with its serial",
          "S/N S5H2NS0N123" in o["runsHtml"] and "serial not reported" in o["runsHtml"],
          o["runsHtml"][:400])
    check("run panel shown, controls hidden while running",
          o["runShown"] and o["actionsHiddenDuring"])
    check("Done not offered while a drive is still running", not o["doneAfterOne"])
    check("failed drive's result is still on screen after the other finished",
          "FAILED" in o["res0"] and "sanitize aborted by the drive" in o["res0"]
          and "bad" in o["res0cls"] and "hidden" not in o["res0cls"], (o["res0"], o["res0cls"]))
    check("wiped drive's result is on screen: method and recorded",
          "Wiped" in o["res1"] and "Overwrite + verify" in o["res1"] and "recorded" in o["res1"]
          and "hidden" not in o["res1cls"], (o["res1"], o["res1cls"]))
    check("the panel does not hide itself when the run ends", o["runStillShown"])
    check("a Done button is offered once every drive has finished", o["doneShown"])
    check("the controls stay hidden until Done", o["actionsStillHidden"])
    check("mixed run: no 'certificate available'", "available" not in o["summary"], o["summary"])
    check("mixed run: says there is no certificate", "No erasure certificate" in o["summary"],
          o["summary"])
    check("mixed run: the server is not even asked", o["eligAskedOnFailure"] == 0)
    check("Done hides the panel and restores the controls",
          o["afterDoneRunHidden"] and o["afterDoneActions"])

    check("outcome wiped: 'Wiped - <method> - recorded'",
          o["oWiped"]["text"].startswith("Wiped — NVMe crypto erase — recorded"), o["oWiped"])
    check("outcome failed: 'FAILED - <reason>'",
          o["oFailed"]["text"].startswith("FAILED — drive stopped responding"), o["oFailed"])
    check("outcome refused: 'Refused - <reason>', nothing recorded",
          o["oRefused"]["text"].startswith("Refused — serial mismatch")
          and "nothing was recorded" in o["oRefused"]["text"], o["oRefused"])
    check("outcome wiped but offline: not called recorded",
          "NOT recorded yet" in o["oQueued"]["text"], o["oQueued"])
    check("outcome wiped but upload failed: NOT recorded, with why",
          "NOT recorded" in o["oUnrec"]["text"] and "HTTP 500" in o["oUnrec"]["text"], o["oUnrec"])
    check("cert: a failed drive in the run means no certificate",
          "available" not in o["cMixed"]["text"] and o["cMixed"]["cls"] == "bad", o["cMixed"])
    check("cert: an unrecorded drive means no certificate",
          "available" not in o["cUnrecorded"]["text"], o["cUnrecorded"])
    check("cert: all wiped, server not answered yet: not claimed",
          "available" not in o["cPending"]["text"], o["cPending"])
    check("cert: all wiped + server yes: available",
          "certificate available" in o["cServerYes"]["text"], o["cServerYes"])
    check("cert: server no wins, with its verdict and reason",
          o["cServerNo"]["cls"] == "bad" and "incomplete" in o["cServerNo"]["text"]
          and "no wipe on record" in o["cServerNo"]["text"]
          and "certificate available" not in o["cServerNo"]["text"], o["cServerNo"])
    check("cert: server no lists the drive holding it up",
          "W2" in o["cServerNo"]["text"] and "missing" in o["cServerNo"]["text"], o["cServerNo"])
    check("cert: server unknown (404) is labelled as unconfirmed",
          "could not confirm" in o["cUnknown"]["text"], o["cUnknown"])
    check("end to end: the server is asked about the asset the run was filed under",
          o["e2eElig"] == ["/api/wipe/eligibility?assetId=a-1"], o["e2eElig"])
    check("end to end: server yes -> 'certificate available'",
          "certificate available" in o["e2eSummary"], o["e2eSummary"])


main()
print("")
print("%d passed, %d failed" % (PASS[0], len(FAIL)))
sys.exit(1 if FAIL else 0)
