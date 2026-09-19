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
3. The header connection chip follows /api/net as it changes (Connected ->
   Not connected -> Server unreachable), says "Not connected" when /api/net
   itself fails, and is not painted over by a later bootstrap.

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
  addEventListener(t, f) { (LISTEN[t] = LISTEN[t] || []).push(f); },
  querySelectorAll: () => [], activeElement: null, hidden: false };
const LISTEN = {};
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
  run(`REAL_POLL=pollJob; REAL_FETCH=fetch; REAL_BOOT=bootstrap; REAL_JGET=jget;`);
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
  out.oHeld = run(`wipeOutcome({status:'wiped',method:'Zero pass',queued:true,recorded:false,
    recordError:'the wipe record is saved on this machine; it was made by Ann Operator; it is sent only under their own sign-in'})`);
  out.oUnrec = run(`wipeOutcome({status:'wiped',method:'Zero pass',recordError:'HTTP 500'})`);
  out.cMixed = run(`certSummary([${W('x')},{status:'failed',reason:'r'}])`);
  out.cUnrecorded = run(`certSummary([${W('x')},{status:'wiped',method:'y',queued:true}])`);
  out.cPending = run(`certSummary([${W('x')},${W('y')}])`);
  out.cServerYes = run(`certSummary([${W('x')},${W('y')}],[{known:true,available:true,verdict:'wiped'}])`);
  out.cServerNo = run(`certSummary([${W('x')}],[{known:true,available:false,verdict:'incomplete',
    reason:'another drive of this machine has no wipe on record',
    drives:[{key:'W2',serialNumber:'W2',model:'WD Blue',status:'missing'}]}])`);
  out.cUnknown = run(`certSummary([${W('x')}],[{known:false}])`);

  // D36: namespaces of one NVMe drive. Only one ticked: the other is named
  // as NOT ticked (not wiped by format/overwrite, not recorded). Both ticked:
  // they run in turn. A sanitize takes them all either way.
  run(`closeOv(); RUN=null; DRIVES=[
    {device:'/dev/nvme0n1',size:'512 GB',model:'Samsung',serial:'S1',controller:'nvme0',
     namespaces:['/dev/nvme0n1','/dev/nvme0n2']},
    {device:'/dev/nvme0n2',size:'1 GB',model:'Samsung',serial:'S1',controller:'nvme0',
     namespaces:['/dev/nvme0n1','/dev/nvme0n2']},
    {device:'/dev/nvme1n1',size:'256 GB',model:'WD',serial:'W9',controller:'nvme1',
     namespaces:['/dev/nvme1n1']}];
    selectedWipeDrives=()=>['/dev/nvme0n1'];`);
  run(`confirmWipe()`);
  out.confirmMultiNs = document.getElementById('ovMsg').textContent;
  run(`closeOv(); selectedWipeDrives=()=>['/dev/nvme0n1','/dev/nvme0n2','/dev/nvme1n1'];`);
  run(`confirmWipe()`);
  out.confirmBothNs = document.getElementById('ovMsg').textContent;

  // The server refuses to start: the reason stays on screen (a dialog the
  // operator dismisses), not a toast that vanishes after 4.2 s.
  run(`OKPOST=jpost; jpost=async()=>({ok:false,status:400,data:{message:'/dev/nvme9n1 is not an internal disk this station can wipe'}});
       document.getElementById('wRun').className='hidden';`);
  await run(`ovGo()`);
  out.refusedTitle = document.getElementById('ovTitle').textContent;
  out.refusedMsg = document.getElementById('ovMsg').textContent;
  out.refusedOpen = document.getElementById('ov').style.display;
  out.refusedRunHidden = hidden('wRun');
  run(`closeOv(); jpost=OKPOST;`);

  // A namespace waiting its turn says what it waits for, not a running clock.
  run(`fetch=async()=>({ok:true,json:async()=>({running:true,log:[],seq:0,logFrom:0,elapsed:40,idle:0,
         waiting:'Waiting for /dev/nvme0n1 to finish - it is on the same NVMe drive (nvme0)'})});`);
  run(`REAL_POLL('wipe:/dev/nvme0n2',{statId:'stWait',label:'Wiping',onDone(){}})`);
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  out.waitStat = document.getElementById('stWait').textContent;
  run(`fetch=REAL_FETCH`); timers.length = 0;
  run(`closeOv(); selectedWipeDrives=()=>['/dev/nvme1n1'];`);
  run(`confirmWipe()`);
  out.confirmSingleNs = document.getElementById('ovMsg').textContent;
  out.labelMultiNs = run(`driveLabel(DRIVES[0])`);
  out.labelSingleNs = run(`driveLabel(DRIVES[2])`);
  run(`closeOv(); DRIVES=[
    {device:'/dev/nvme0n1',size:'512 GB',model:'Samsung SSD 980',serial:'S5H2NS0N123',bytes:512e9},
    {device:'/dev/sda',size:'500 GB',model:'WD Blue',serial:'',bytes:500e9}];
    selectedWipeDrives=()=>['/dev/nvme0n1','/dev/sda'];`);

  // End to end with a server "yes": the run's summary is updated to available.
  run(`RUN=null; ELIG=[]; ELIGANS={known:true,available:true,verdict:'wiped',reason:null,drives:[]}`);
  run(`confirmWipe()`);
  await run(`ovGo()`);
  run(`POLLS[POLLS.length-2].o.onDone(${W('A')}); POLLS[POLLS.length-1].o.onDone(${W('B')});`);
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  out.e2eElig = run(`ELIG`);
  out.e2eSummary = document.getElementById('wSummary').innerHTML;

  // Step 38: requested X, achieved Y (reason), and limitations in words.
  const FB = `({status:'wiped',method:'Overwrite + verify',recorded:true,recordTag:'ALS-9',
    methodRequested:'secure',methodAttempted:'ata-secure-erase,overwrite',fallbackReason:'frozen',
    limitations:['12 reallocated sectors were not overwritten','Hidden areas could not be checked']})`;
  out.oFallback = run(`wipeOutcome(${FB})`);
  out.oSame = run(`wipeOutcome({status:'wiped',method:'NVMe crypto erase',recorded:true,
    methodRequested:'auto',methodAttempted:'nvme-sanitize-crypto',fallbackReason:''})`);
  out.oTwoTried = run(`wipeOutcome({status:'wiped',method:'NVMe format',recorded:true,
    methodRequested:'crypto',methodAttempted:'nvme-sanitize-crypto,nvme-format'})`);
  out.oUnknownWhy = run(`wipeOutcome({status:'wiped',method:'Zero pass',recorded:true,
    methodRequested:'overwrite',fallbackReason:'weird_new_code'})`);
  out.oFailedLim = run(`wipeOutcome({status:'failed',method:'none',reason:'read-back found data',
    limitations:['Could not read the SMART counts']})`);
  out.tOne = run(`wipeToast([${FB}])`);
  out.tMany = run(`wipeToast([${FB},${W('NVMe crypto erase')}])`);
  out.tPlain = run(`wipeToast([${W('NVMe crypto erase')}])`);
  // The run's own toast, end to end.
  run(`RUN=null; TOASTS=[]; const _t=toast; toast=(m,g)=>TOASTS.push(m); selectedWipeDrives=()=>['/dev/sda'];
       jpost=async()=>({ok:true,status:200,data:{started:['/dev/sda'],busy:[]}});`);
  run(`confirmWipe()`);
  await run(`ovGo()`);
  run(`POLLS[POLLS.length-1].o.onDone(${FB})`);
  out.runToast = run(`TOASTS.slice(-1)[0]`);
  out.runBlock = document.getElementById('wres__dev_sda').innerHTML;

  // Operator sign-in (plan step 27). Flag off: the typed-name control stays,
  // the sign-in button is hidden. Flag on, nobody signed in: Sign in, and
  // the panel opens by itself - once. Signed in: Sign out.
  const vis = (id) => !hidden(id);
  document.getElementById('hSign').className = 'linklike hidden';
  run(`renderSignin({required:false})`);
  out.siOff = { op: vis('hOperator'), sign: vis('hSign') };
  run(`renderSignin({required:true,signedIn:false,message:'Your sign-in has expired - sign in again.'})`);
  out.siOn = { op: vis('hOperator'), sign: vis('hSign'), label: document.getElementById('hSign').textContent,
    panel: document.getElementById('ovSign').style.display, msg: document.getElementById('signMsg').textContent };
  run(`closeSign(); renderSignin({required:true,signedIn:false})`);
  out.siNoNag = document.getElementById('ovSign').style.display;
  run(`renderSignin({required:true,signedIn:true,name:'Ann Operator'})`);
  out.siIn = { label: document.getElementById('hSign').textContent,
    title: document.getElementById('hSign').title };
  // The password field is emptied before the request goes out.
  run(`SIGNPOSTS=[]; jpost=async(u,b)=>{SIGNPOSTS.push({u,b,field:document.getElementById('signPass').value});
         return {ok:true,status:200,data:{name:'Ann Operator'}};}; bootstrap=()=>{};`);
  document.getElementById('signEmail').value = 'ann@example.test';
  document.getElementById('signPass').value = 'pw-123456789';
  await run(`doSignIn()`);
  out.siPost = run(`SIGNPOSTS`);
  out.siFieldAfter = document.getElementById('signPass').value;
  // Audit button: disabled while sign-in is required and nobody is signed in.
  run(`BOOT={device:{name:'x'},workflow:'amazon',signin:{required:true,signedIn:false}}; auditGate()`);
  out.auditOffWhenSignedOut = document.getElementById('aStart').disabled;
  run(`BOOT={device:{name:'x'},workflow:'amazon',signin:{required:true,signedIn:true}}; auditGate()`);
  out.auditOnWhenSignedIn = document.getElementById('aStart').disabled;
  run(`BOOT={device:{name:'x'},workflow:'amazon'}; auditGate()`);
  out.auditFlagOff = document.getElementById('aStart').disabled;

  // "Already audited" banner: the machine's roll-up verdict (contract C4),
  // or - from an older API - the newest record, labelled as a record.
  out.pwRollup = run(`priorWipeBits({wipeVerdict:'failed',lastWipeStatus:'failed'})`);
  out.pwIncomplete = run(`priorWipeBits({wipeVerdict:'incomplete'})`);
  out.pwLegacy = run(`priorWipeBits({lastWipeStatus:'wiped',wipeSource:'last-record'})`);
  out.pwNothing = run(`priorWipeBits({})`);
  run(`BOOT={workflow:'goods_in',device:{name:'x'}};
       jget=async()=>({found:true,tag:'ALS-9',auditCount:2,lastAuditAt:'2026-09-19T10:01:30Z',
         lastWipeStatus:'failed',wipeVerdict:'failed',wipeSource:'rollup'});`);
  await run(`checkPrior()`);
  out.priorHtml = document.getElementById('aPrior').innerHTML;

  // The Rescan button re-runs the capture (POST /api/rescan) and re-polls.
  run(`RSC=[]; jpost=async(u,b)=>{RSC.push(u);return {ok:true,status:200,data:{started:true}};};
       BOOTS=0; bootstrap=()=>{BOOTS++;};`);
  timers.length = 0;
  await run(`rescan()`);
  flush();
  out.rescanPosts = run(`RSC`);
  out.rescanBoots = run(`BOOTS`);

  // Wipe gate: a dual-permission account that has not chosen a workflow gets
  // no Wipe button, with the reason beside it, and confirmWipe sends nothing.
  run(`closeOv(); selectedWipeDrives=()=>['/dev/sda']; WG=[];
       jpost=async(u,b)=>{WG.push(u);return {ok:true,status:200,data:{started:['/dev/sda']}};};
       BOOT={device:{name:'x'},workflows:['amazon','goods_in'],workflow:''}; applyWipeGate();`);
  out.wgNoWf = { disabled: document.getElementById('wStart').disabled,
    msg: document.getElementById('wGateMsg').textContent, shown: !hidden('wGateMsg') };
  run(`confirmWipe()`);
  out.wgConfirmTitle = document.getElementById('ovTitle').textContent;
  out.wgConfirmMsg = document.getElementById('ovMsg').textContent;
  await run(`ovGo()`);
  out.wgPosts = run(`WG`);
  run(`closeOv(); BOOT.workflow='amazon'; applyWipeGate();`);
  out.wgAmazon = { disabled: document.getElementById('wStart').disabled, shown: !hidden('wGateMsg') };
  document.getElementById('batchSel').value = '';
  run(`BOOT.workflow='goods_in'; applyWipeGate();`);
  out.wgNoBatch = { disabled: document.getElementById('wStart').disabled,
    msg: document.getElementById('wGateMsg').textContent };
  document.getElementById('batchSel').value = 'lot-1';
  run(`applyWipeGate();`);
  out.wgBatch = document.getElementById('wStart').disabled;
  run(`BOOT={device:{name:'x'},workflows:[],workflow:''}; applyWipeGate();`);
  out.wgNoPerm = document.getElementById('wGateMsg').textContent;

  // Queued records the server refused: a banner with the reason, not only
  // "1 waiting to upload".
  document.getElementById('rejBanner').className = 'alert hidden';
  run(`renderQueue({waiting:1,waitingHeld:0,waitingRejected:1,waitingRejectedWipes:1,queueDurable:true,
       rejected:[{code:400,count:1,wipes:1,reason:'No audit lot selected'}]})`);
  out.rqShown = !hidden('rejBanner');
  out.rqTitle = document.getElementById('rejTitle').textContent;
  out.rqMsg = document.getElementById('rejMsg').textContent;
  out.rqChip = document.getElementById('hQueueN').textContent;
  run(`renderQueue({waiting:1,waitingHeld:0,waitingRejected:0,queueDurable:true,rejected:[]})`);
  out.rqNetOnly = !hidden('rejBanner');

  // The live connection chip, driven by /api/net (pollNet), not only by the
  // bootstrap at page load.
  const chip = () => ({ text: document.getElementById('hConn').textContent,
    dot: document.getElementById('hDot').className,
    title: document.getElementById('hConnWrap').title,
    color: document.getElementById('hConn').style.color });
  run(`NETASK=[]; NETANS=null; jget=async(u)=>{ NETASK.push(u);
         if(NETANS instanceof Error) throw NETANS; return NETANS; };`);
  const poll = async (ans) => { run(`NETANS=${ans}`); await run(`pollNet()`); return chip(); };
  out.netC = await poll(`{state:'connected',via:'wifi',ssid:'ALS Warehouse',checkedAt:1,since:1}`);
  out.netN = await poll(`{state:'no-network',via:null,ssid:null,checkedAt:2,since:2}`);
  out.netU = await poll(`{state:'server-unreachable',via:'wifi',ssid:'ALS Warehouse',checkedAt:3,since:3}`);
  out.netE = await poll(`{state:'connected',via:'ethernet',ssid:null,checkedAt:4,since:4}`);
  out.netDown = await poll(`new Error('station service down')`);
  out.netJunk = await poll(`{state:'weird'}`);
  out.netAsked = run(`NETASK`);
  // connClick: Settings whenever the chip is not "Connected".
  run(`OPENED=0; openSettings=()=>{OPENED++;}; BOOT={};`);
  await poll(`{state:'server-unreachable',via:'wifi'}`); run(`connClick()`);
  await poll(`{state:'no-network'}`); run(`connClick()`);
  await poll(`{state:'connected',via:'wifi'}`); run(`connClick()`);
  out.netOpened = run(`OPENED`);
  // A later bootstrap (Rescan, capturing re-poll) does not paint its old
  // verdict over the live one.
  run(`jget=async()=>({error:'old failure',server:'',lots:[],drives:[]});`);
  try { await run(`REAL_BOOT()`); } catch (e) {}
  out.netAfterBoot = chip();
  // Page visible again: asks at once.
  run(`NETASK=[]; jget=async(u)=>{NETASK.push(u); return {state:'no-network'};};`);
  for (const f of (LISTEN.visibilitychange || [])) f();
  await new Promise(r => setImmediate(r));
  out.netOnVisible = { asked: run(`NETASK`), chip: chip() };
  run(`jget=REAL_JGET`);

  process.stdout.write(JSON.stringify(out));
})().catch((e) => { process.stdout.write(JSON.stringify({ error: String(e && e.stack || e) })); });
"""


def main():
    with open(PAGE, encoding="utf-8") as fh:
        html = fh.read()
    js = inline_script(html)
    check("index.html has an inline script", len(js) > 1000, len(js))

    # The station's refusals tell the operator to "press Rescan" (no profile
    # captured; a drive that was not in the capture). The page had no control
    # of that name - only "Retry connection" inside the offline banner and a
    # Save in the PIN-locked Settings - so the instruction led nowhere.
    with open(os.path.join(HERE, "gui", "server.py"), encoding="utf-8") as fh:
        server = fh.read()
    told = re.findall(r"[Pp]ress Rescan|then Rescan", server)
    btn = re.search(r'<button[^>]*onclick="rescan\(\)"[^>]*>\s*Rescan\s*</button>', html)
    check("the station's messages name Rescan (the thing this checks exists)", len(told) >= 2, told)
    check("the main screen has a button labelled exactly 'Rescan'", bool(btn), "")
    check("...outside the offline banner and the Settings panel",
          bool(btn) and html.rfind('id="errBanner"', 0, btn.start()) == -1
          and html.rfind('id="ovSet"', 0, btn.start()) == -1, "")
    check("chip before any answer: 'Checking…' with a grey dot, never a green one",
          '<span class="dot wait" id="hDot"' in html
          and '<span id="hConn" aria-live="polite">Checking…</span>' in html, "")
    check("the chip's words are announced (aria-live polite on #hConn)",
          re.search(r'<span id="hConn" aria-live="polite">', html) is not None, "")
    check("the chip is polled every ~10 s and once at load",
          "setInterval(pollNet,10000)" in js and re.search(r"^pollNet\(\);", js, re.M) is not None, "")
    check("...and it posts /api/rescan", re.search(
        r"async function rescan\(\)\{[^}]*jpost\('/api/rescan'", js, re.S) is not None, "")

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
    check("outcome held for another operator: says whose, not 'no connection'",
          "Ann Operator" in o["oHeld"]["text"] and "no connection" not in o["oHeld"]["text"]
          and "NOT recorded yet" in o["oHeld"]["text"], o["oHeld"])
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
    cm, cs = o["confirmMultiNs"], o["confirmSingleNs"]
    cb = o["confirmBothNs"]
    check("D36: confirm says a sanitize erases ALL namespaces, ticked or not",
          "ALL of its namespaces" in cm and "ticked or not" in cm, cm)
    check("D36: one namespace ticked - names the unticked one as NOT wiped/recorded",
          "/dev/nvme0n2 is NOT ticked" in cm and "not recorded" in cm and "untouched" in cm, cm)
    check("D36: never claims erasing one namespace erases the others",
          "ALL of them" not in cm and "covers" not in cm, cm)
    check("D36: both ticked - they are wiped one after the other",
          "one after the other" in cb and "NOT ticked" not in cb, cb)
    check("D36: the warning appears once per drive, not once per namespace",
          cb.count("parts (namespaces)") == 1, cb)
    check("start refused: the reason stays on screen in a dialog",
          o["refusedOpen"] == "flex" and "did not start" in o["refusedTitle"]
          and "not an internal disk" in o["refusedMsg"], (o["refusedTitle"], o["refusedMsg"]))
    check("start refused: no run panel for a wipe that did not start", o["refusedRunHidden"])
    check("a namespace waiting its turn says so on its status line",
          "Waiting for /dev/nvme0n1" in o["waitStat"], o["waitStat"])
    check("D36: no namespace warning for a single-namespace drive",
          "namespace" not in cs.lower(), cs)
    check("D36: the drive list names the sibling namespace",
          "same NVMe drive as /dev/nvme0n2" in o["labelMultiNs"], o["labelMultiNs"])
    check("D36: a single-namespace drive's label has no such note",
          "same NVMe drive" not in o["labelSingleNs"], o["labelSingleNs"])
    check("end to end: the server is asked about the asset the run was filed under",
          o["e2eElig"] == ["/api/wipe/eligibility?assetId=a-1"], o["e2eElig"])
    check("end to end: server yes -> 'certificate available'",
          "certificate available" in o["e2eSummary"], o["e2eSummary"])

    t = o["oFallback"]["text"]
    check("fallback: 'requested X, achieved Y (reason)' in plain words",
          "requested the drive's own secure erase, achieved Overwrite + verify "
          "(the drive's security is frozen by the BIOS)" in t, t)
    check("fallback: still says recorded", "recorded as ALS-9" in t, t)
    check("fallback: limitations listed in words, each one",
          "Limitations: 12 reallocated sectors were not overwritten; Hidden areas could not be "
          "checked." in t, t)
    check("fallback: shown amber, not green", o["oFallback"]["cls"] == "warn", o["oFallback"])
    check("achieved = requested: no 'requested' clause, green",
          "requested" not in o["oSame"]["text"] and o["oSame"]["cls"] == "ok", o["oSame"])
    check("two methods tried, no reason given: still says what was asked for",
          "requested a cryptographic erase, achieved NVMe format" in o["oTwoTried"]["text"],
          o["oTwoTried"])
    check("an unknown reason code is shown readably, not dropped",
          "(weird new code)" in o["oUnknownWhy"]["text"], o["oUnknownWhy"])
    check("failed: limitations listed too",
          "Could not read the SMART counts" in o["oFailedLim"]["text"], o["oFailedLim"])
    check("toast, one drive: the method note in full",
          "requested the drive's own secure erase, achieved Overwrite + verify" in o["tOne"]
          and "Limitations noted" in o["tOne"], o["tOne"])
    check("toast, several drives: counts the ones that fell back",
          "1 of 2 drives did not get the method asked for" in o["tMany"], o["tMany"])
    check("toast, nothing to flag: as before",
          o["tPlain"] == "Wipe finished — the result for each drive is on screen.", o["tPlain"])
    check("a real run: the toast says requested/achieved",
          "achieved Overwrite + verify" in (o["runToast"] or ""), o["runToast"])
    check("a real run: the drive's block says requested/achieved and the limitations",
          "requested the drive&#39;s own secure erase" in o["runBlock"] and
          "Limitations:" in o["runBlock"], o["runBlock"])

    si = o["siOff"]
    check("sign-in off: the typed operator control stays, no sign-in button",
          si["op"] and not si["sign"], si)
    si = o["siOn"]
    check("sign-in on: the typed operator control is hidden, Sign in shown",
          not si["op"] and si["sign"] and si["label"] == "Sign in", si)
    check("sign-in on, nobody signed in: the panel opens by itself", si["panel"] == "flex", si)
    check("sign-in on: the panel says why the session ended", "expired" in si["msg"], si)
    check("sign-in on: closing the panel is not undone by the next poll", o["siNoNag"] == "none",
          o["siNoNag"])
    check("signed in: the button offers Sign out and names the person",
          o["siIn"]["label"] == "Sign out" and "Ann Operator" in o["siIn"]["title"], o["siIn"])
    sp = o["siPost"]
    check("sign-in posts email and password to the station service only",
          len(sp) == 1 and sp[0]["u"] == "/api/operator/signin" and
          sp[0]["b"] == {"email": "ann@example.test", "password": "pw-123456789"}, sp)
    check("the password field is emptied before the request goes out",
          sp and sp[0]["field"] == "" and o["siFieldAfter"] == "", (sp, o["siFieldAfter"]))
    check("audit disabled while sign-in is required and nobody is signed in",
          o["auditOffWhenSignedOut"] is True and o["auditOnWhenSignedIn"] is False
          and o["auditFlagOff"] is False,
          (o["auditOffWhenSignedOut"], o["auditOnWhenSignedIn"], o["auditFlagOff"]))

    check("Rescan: re-runs the capture on the station (POST /api/rescan)",
          o["rescanPosts"] == ["/api/rescan"], o["rescanPosts"])
    check("Rescan: the screen re-reads the state afterwards", o["rescanBoots"] >= 1, o["rescanBoots"])
    g = o["wgNoWf"]
    check("wipe gate: no workflow chosen - Wipe disabled, reason shown",
          g["disabled"] is True and g["shown"] and "Choose Amazon" in g["msg"], g)
    check("wipe gate: confirmWipe says the wipe did not start, and why",
          "did not start" in o["wgConfirmTitle"] and "Choose Amazon" in o["wgConfirmMsg"]
          and "Nothing was erased" in o["wgConfirmMsg"], (o["wgConfirmTitle"], o["wgConfirmMsg"]))
    check("wipe gate: nothing was posted to /api/wipe/start", o["wgPosts"] == [], o["wgPosts"])
    check("wipe gate: workflow chosen - Wipe enabled, no reason",
          o["wgAmazon"]["disabled"] is False and not o["wgAmazon"]["shown"], o["wgAmazon"])
    check("wipe gate: Goods In with no batch - disabled, asks for a batch",
          o["wgNoBatch"]["disabled"] is True and "batch" in o["wgNoBatch"]["msg"], o["wgNoBatch"])
    check("wipe gate: Goods In with a batch - enabled", o["wgBatch"] is False, o["wgBatch"])
    check("wipe gate: no audit permission - says so", "no audit permission" in o["wgNoPerm"],
          o["wgNoPerm"])
    check("refused record: banner shown, '1 wipe record was not accepted by the server'",
          o["rqShown"] and "1 wipe record was not accepted by the server" in o["rqTitle"],
          (o["rqShown"], o["rqTitle"]))
    check("refused record: the server's reason and status are on screen",
          "No audit lot selected" in o["rqMsg"] and "HTTP 400" in o["rqMsg"], o["rqMsg"])
    check("refused record: the header chip counts it as refused",
          "1 waiting to upload (1 refused)" == o["rqChip"], o["rqChip"])
    check("only waiting for the network: no refusal banner", o["rqNetOnly"] is False)
    check("prior banner: the roll-up verdict names the machine's state",
          o["pwRollup"] == ["wipe: a drive FAILED its wipe"], o["pwRollup"])
    check("prior banner: incomplete is said in words",
          o["pwIncomplete"] == ["wipe: not every drive wiped yet"], o["pwIncomplete"])
    check("prior banner: without C4 the newest row is labelled as a record, not the machine",
          o["pwLegacy"] == ["last wipe record: wiped"], o["pwLegacy"])
    check("prior banner: nothing known, nothing said", o["pwNothing"] == [], o["pwNothing"])
    check("chip: 'Connected' + green dot, via Wi-Fi and the SSID in the tooltip",
          o["netC"]["text"] == "Connected" and o["netC"]["dot"] == "dot"
          and "Wi-Fi (ALS Warehouse)" in o["netC"]["title"], o["netC"])
    check("chip: Connected -> 'Not connected' (red) when /api/net says no-network",
          o["netN"]["text"] == "Not connected" and "bad" in o["netN"]["dot"]
          and "red" in o["netN"]["color"], o["netN"])
    check("chip: 'Server unreachable' (amber, different words) with a network but no server",
          o["netU"]["text"] == "Server unreachable" and "warn" in o["netU"]["dot"]
          and "not answering" in o["netU"]["title"], o["netU"])
    check("chip: back to Connected, via Ethernet in the tooltip",
          o["netE"]["text"] == "Connected" and "Ethernet" in o["netE"]["title"], o["netE"])
    check("chip: /api/net itself failing -> 'Not connected'",
          o["netDown"]["text"] == "Not connected" and "bad" in o["netDown"]["dot"], o["netDown"])
    check("chip: an unknown state is not shown as connected",
          o["netJunk"]["text"] == "Not connected", o["netJunk"])
    check("chip: asks /api/net", set(o["netAsked"]) == {"/api/net"}, o["netAsked"])
    check("chip: tapping it opens Settings whenever it is not connected (2 of 3 taps)",
          o["netOpened"] == 2, o["netOpened"])
    check("chip: a later bootstrap does not paint over the live state",
          o["netAfterBoot"]["text"] == "Connected", o["netAfterBoot"])
    check("chip: the page becoming visible asks at once",
          o["netOnVisible"]["asked"] == ["/api/net"]
          and o["netOnVisible"]["chip"]["text"] == "Not connected", o["netOnVisible"])
    check("prior banner end to end: shows the failed roll-up, never 'wipe: wiped'",
          "a drive FAILED its wipe" in o["priorHtml"] and "wipe: wiped" not in o["priorHtml"]
          and "ALS-9" in o["priorHtml"], o["priorHtml"])


main()
print("")
print("%d passed, %d failed" % (PASS[0], len(FAIL)))
sys.exit(1 if FAIL else 0)
