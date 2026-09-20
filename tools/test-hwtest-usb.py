#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""The USB ports hardware test (contract C6): the station endpoint + the runner.

A browser cannot see USB ports at all - WebUSB only ever shows a device the user
explicitly permitted, and nothing about sockets - so this test has two halves,
and both are checked here:

  THE STATION (server.py). A GET /api/hwtest/usb that parses
  /sys/bus/usb/devices with nothing but the standard library: no lsusb, no new
  package, so the whole thing still ships by syncing the stick. It is behind the
  SAME Host/Origin guard every other route has, works to a time budget so it can
  never hang the page, only READS, and LEAVES OUT the port the station booted
  from - the stick it is running from is always present and was never plugged in
  as part of the test.

  THE PAGE (index.html). The runner polls that endpoint while the test is open
  and counts each NEW port path that responds. What it must never do is the
  point: never claim WHICH physical socket answered (Linux reports bus paths,
  not labels), never count what was already plugged in, and never auto-fail when
  nothing is plugged in - the technician may simply not have got there yet. A
  station that cannot read USB at all is ATTENTION with a reason and an action,
  never FAILED.

The page section needs node. Without it that section SKIPs and passes, unless
ALS_REQUIRE_NODE=1 (set in CI).

    python3 tools/test-hwtest-usb.py
"""
import http.client
import importlib.util
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


with open(PAGE, encoding="utf-8") as fh:
    HTML = fh.read()
with open(SERVER, encoding="utf-8") as fh:
    SRV = fh.read()

MARKS = {"CSS": ("/* HWTEST:USB:CSS:START */", "/* HWTEST:USB:CSS:END */"),
         "JS": ("/* HWTEST:USB:JS:START */", "/* HWTEST:USB:JS:END */"),
         "markup": ("<!-- HWTEST:USB:START -->", "<!-- HWTEST:USB:END -->")}


def region(kind):
    """The text between a pair of USB markers, so a claim about 'the USB region'
    is checked against that region alone and not the whole page."""
    start, end = MARKS[kind]
    i, j = HTML.find(start), HTML.find(end)
    return HTML[i:j] if 0 <= i < j else ""


# ------------------------------------------------------ 1. the region itself --
print("1. the USB region is present, closed once, and self-contained")
for kind in ("CSS", "JS", "markup"):
    start, end = MARKS[kind]
    check("the USB %s region exists exactly once and closes" % kind,
          HTML.count(start) == 1 and HTML.count(end) == 1 and 0 <= HTML.find(start) < HTML.find(end),
          (HTML.count(start), HTML.count(end)))

JS = region("JS")
check("the runner is registered on HWT_RUNNERS.usb", "HWT_RUNNERS.usb" in JS)
check("it asks the station, because a browser cannot see USB ports",
      "/api/hwtest/usb" in JS and "jget(" in JS)
check("it polls while the test is open, and clears that timer again",
      "setInterval" in JS and "clearInterval" in JS)
check("it records through the shell's helpers, not by hand",
      "hwPass('usb'" in JS and "hwFail('usb'" in JS and "hwCannotRun('usb'" in JS)
check("it is wired to the shell's ids: hwtDetail_usb is where it builds", "hwtDetail_usb" in JS)
check("the USB rows and shell know the test: HWT_KEYS, HWT_NAMES, HWT_ABOUT",
      "'usb'" in HTML and "usb:'USBports'" in HTML.replace(" ", "")
      and 'id="hwtStat_usb"' in HTML and 'id="hwtWhy_usb"' in HTML
      and 'id="hwtRun_usb"' in HTML)
# The honesty the owner asked for, in the words the technician actually reads.
check("the page SAYS it cannot tell which physical socket is which",
      "cannot tell which physical socket is which" in JS, "the wording is missing")
check("...and tells the technician to keep track of any that do nothing",
      "keep track of any that do nothing" in JS)
check("it says the boot stick's own port is not counted",
      "booted from" in JS and "left out of the count" in JS)
check("nothing plugged in is explicitly NOT a fault", "not a fault on its own" in JS)
check("the USB region never prints 'Unknown'",
      "Unknown" not in JS and "Unknown" not in region("CSS") and "Unknown" not in region("markup"),
      "Unknown appears in a USB region")

# ------------------------------------------------- 2. the station's endpoint --
print("2. the station reads sysfs itself: stdlib, time-limited, origin-guarded")
spec = importlib.util.spec_from_file_location("als_server_usb", SERVER)
srv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(srv)

check("server.py answers GET /api/hwtest/usb", '"/api/hwtest/usb"' in SRV)
check("both sides name the test, or a save would be silently ignored",
      "microphone" in str(srv.HWTEST_TESTS) and "usb" in srv.HWTEST_TESTS
      and list(srv.HWTEST_TESTS) == ["speaker", "keyboard", "camera", "screen", "trackpad",
                                     "microphone", "usb"], srv.HWTEST_TESTS)
check("it reads the kernel's own list, not a tool that may not be installed",
      "/sys/bus/usb/devices" in SRV
      and '"lsusb"' not in SRV and "'lsusb'" not in SRV,
      "lsusb is used as a command, so the station would need usbutils installed")
# The guard: the route lives inside do_GET, which runs request_problem() (the
# same Host/Origin check every route has) before it reaches any handler.
doget = SRV.find("def do_GET")
guard = SRV.find("request_problem(self.headers", doget)
route = SRV.find('"/api/hwtest/usb"', doget)
check("the new route is behind the same Host/Origin guard (request_problem in do_GET, before it)",
      doget > 0 and 0 < guard < route, (doget, guard, route))

# The function itself, against a sysfs tree we build - so the parsing is proved
# without needing a Linux machine with USB devices on it.
TMP = tempfile.mkdtemp(prefix="als-hwt-usb-")
SYS = os.path.join(TMP, "usb-devices")


def make_device(name, attrs):
    d = os.path.join(SYS, name)
    os.makedirs(d, exist_ok=True)
    for k, v in attrs.items():
        with open(os.path.join(d, k), "w", encoding="utf-8") as fh:
            fh.write(v + "\n")


os.makedirs(SYS, exist_ok=True)
# What a real /sys/bus/usb/devices holds: a root hub (usb1), an INTERFACE
# (1-3:1.0), a real stick (1-3), a wireless receiver behind an internal hub
# (1-4.2), that internal hub (1-4) and the port the station booted from (1-2).
# Only the DEVICE directories may ever be reported. The interface is checked
# against the pattern rather than created, because a colon is not a legal
# filename on the Windows machine this suite also runs on.
check("an interface directory is never mistaken for a port",
      srv.USB_PORT_RE.match("1-3:1.0") is None and srv.USB_PORT_RE.match("usb1") is None
      and srv.USB_PORT_RE.match("1-3") and srv.USB_PORT_RE.match("1-4.2"),
      "the port-path pattern does not match what the kernel really writes")
make_device("usb1", {"product": "xHCI Host Controller", "speed": "480", "bDeviceClass": "09"})
make_device("1-3", {"manufacturer": "SanDisk", "product": "Ultra", "speed": "5000",
                    "bDeviceClass": "00"})
make_device("1-4", {"manufacturer": "Generic", "product": "USB2.0 Hub", "speed": "480",
                    "bDeviceClass": "09"})
make_device("1-4.2", {"manufacturer": "Logitech", "product": "USB Receiver", "speed": "12",
                      "bDeviceClass": "00"})
make_device("1-2", {"manufacturer": "ALS", "product": "Audit Station stick", "speed": "5000",
                    "bDeviceClass": "00"})

real_boot_port = srv.usb_boot_port
try:
    srv.usb_boot_port = lambda *a, **k: "1-2"
    ans = srv.usb_ports(root=SYS)
    ports = [d["port"] for d in ans.get("devices", [])]
    check("a readable bus answers ok, with one entry per DEVICE", ans.get("ok") is True, ans)
    check("the boot medium's own port is LEFT OUT - the station is running from it",
          "1-2" not in ports and ans.get("bootPortExcluded") is True, ans)
    check("a root hub is not a port a technician can plug into, so it is not listed",
          "usb1" not in ports, ports)
    check("every other device IS listed, including one behind an internal hub",
          sorted(ports) == ["1-3", "1-4", "1-4.2"], ports)
    stick = [d for d in ans["devices"] if d["port"] == "1-3"][0]
    check("a device is named from what it calls itself, and its speed is put in words",
          stick["name"] == "SanDisk Ultra" and "USB 3.0" in stick["speed"], stick)
    hub = [d for d in ans["devices"] if d["port"] == "1-4"][0]
    check("a hub is flagged as one - it fills a socket without being a thing under test",
          hub["hub"] is True and stick["hub"] is False, (hub, stick))
    slow = [d for d in ans["devices"] if d["port"] == "1-4.2"][0]
    check("a slow device's speed is still said in words, never a bare number",
          "USB 1.x" in slow["speed"], slow)

    # A device whose strings the kernel does not publish: "" everywhere, and
    # never the word this module is forbidden to print.
    make_device("1-5", {})
    ans = srv.usb_ports(root=SYS)
    bare = [d for d in ans["devices"] if d["port"] == "1-5"][0]
    check("a device that publishes no name or speed reports empty strings, never 'Unknown'",
          bare["name"] == "" and bare["speed"] == ""
          and "nknown" not in json.dumps(ans), bare)

    # The station booted from something that is not USB (an internal disk, or a
    # checkout on a desk): nothing is excluded, and the answer SAYS so rather
    # than quietly dropping a port.
    srv.usb_boot_port = lambda *a, **k: ""
    ans = srv.usb_ports(root=SYS)
    ports = [d["port"] for d in ans["devices"]]
    check("with no boot port to exclude, nothing is dropped and the answer admits it",
          ans.get("ok") is True and "1-2" in ports
          and ans.get("bootPortKnown") is False and ans.get("bootPortExcluded") is False, ans)

    # No bus to read at all: a could-not-run with a reason AND an action, which
    # is what the runner turns into ATTENTION.
    gone = srv.usb_ports(root=os.path.join(TMP, "no-such-bus"))
    check("a machine whose USB the station cannot read is could-not-run, with what to do",
          gone.get("ok") is False and "cannot read" in (gone.get("reason") or "")
          and (gone.get("action") or "").strip(), gone)
    check("...and it says it in plain English, never 'Unknown'",
          "nknown" not in json.dumps(gone), gone)

    # A bus that will not answer in time: the endpoint gives up rather than
    # holding the page's poll open.
    slow_ans = srv.usb_ports(root=SYS, budget=-1)
    check("a bus that does not answer in time gives up, and says why",
          slow_ans.get("ok") is False and "ran out of time" in (slow_ans.get("reason") or "")
          and (slow_ans.get("action") or "").strip(), slow_ans)
finally:
    srv.usb_boot_port = real_boot_port

# Only reads. The whole point of the endpoint is that it touches nothing: a
# write into sysfs, or a shell-out, would make an inspection tool an actor.
body = SRV[SRV.find("def usb_ports("):]
body = body[:body.find("\n# ------")]
check("usb_ports only READS - no write, no subprocess, no device touched",
      '"w"' not in body and "'w'" not in body and "subprocess" not in body
      and "os.remove" not in body, body[:200])
check("...and needs no package that is not already on the image",
      "import " not in body, body[:200])

# The real Handler on a real port: the guard, and a well-formed answer.
srv.CONF_PATH = None
srv.STATE["conf"] = {"AUDIT_URL": "https://als-inventory-software-production.up.railway.app"}
srv.report_now = lambda *a, **k: None
httpd = ThreadingHTTPServer(("127.0.0.1", 0), srv.Handler)
PORT = httpd.server_address[1]
srv.PORT = PORT
threading.Thread(target=httpd.serve_forever, daemon=True).start()


def call(path, headers=None):
    c = http.client.HTTPConnection("127.0.0.1", PORT, timeout=10)
    c.request("GET", path, None, headers or {})
    r = c.getresponse()
    data = r.read()
    c.close()
    try:
        return r.status, json.loads(data or b"{}")
    except ValueError:
        return r.status, data


try:
    code, ans = call("/api/hwtest/usb")
    check("the station's own screen gets an answer, always shaped the same way",
          code == 200 and isinstance(ans, dict) and "ok" in ans, (code, ans))
    check("...and it is never the word this module is forbidden to print",
          "nknown" not in json.dumps(ans), ans)
    code, ans = call("/api/hwtest/usb", {"Host": "attacker.example"})
    check("another page cannot ask this machine what is plugged into it (Host refused)",
          code == 403 and "own screen" in (ans.get("message") or ""), (code, ans))
    code, ans = call("/api/hwtest/usb", {"Origin": "http://attacker.example"})
    check("...nor from another origin (Origin refused)",
          code == 403 and "own screen" in (ans.get("message") or ""), (code, ans))
finally:
    httpd.shutdown()

# ---------------------------------------------------- 3. the runner, in a page --
print("3. the runner, driven under node with a station stand-in")
node = shutil.which("node")
if not node:
    if os.environ.get("ALS_REQUIRE_NODE") == "1":
        check("node is installed (ALS_REQUIRE_NODE=1)", False)
    else:
        print("  SKIP running the USB runner under node (node not installed)")
else:
    blocks = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", HTML, re.S | re.I)
    js = os.path.join(TMP, "page.js")
    with open(js, "w", encoding="utf-8") as fh:
        fh.write("\n;\n".join(blocks))
    harness = os.path.join(TMP, "h.js")
    # The stand-in provides a DOM whose elements remember their click handlers,
    # a window that remembers pagehide handlers, a jget that answers with
    # whatever the scenario has set, and setInterval as a registry - so the poll
    # can be driven a step at a time AND a timer left behind is visible.
    harness_body = r"""
const vm = require('vm'), fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

// setInterval as a registry: nothing polls on its own, so each read of the bus
// is deliberate and a timer left behind is visible rather than silent.
const LIVE = {};
let SEQ = 0;
const fakeSetInterval = (fn) => { const id = ++SEQ; LIVE[id] = fn; return id; };
const fakeClearInterval = (id) => { delete LIVE[id]; };
const liveTimers = () => Object.keys(LIVE).length;
async function poll(n) {
  for (let i = 0; i < (n || 1); i++) {
    Object.keys(LIVE).forEach(k => { try { LIVE[k](); } catch (e) {} });
    await sleep(5);                       // let the async read settle
  }
}

const ctx = vm.createContext({ document, window, console, prompt: () => null, screen: {},
  innerWidth: 0, innerHeight: 0, fetch: () => new Promise(() => {}),
  setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 40)), clearTimeout: (id) => clearTimeout(id),
  setInterval: fakeSetInterval, clearInterval: fakeClearInterval });
vm.runInContext(src, ctx, { filename: 'index.html<script>' });
const run = (c) => vm.runInContext(c, ctx);
const el = (id) => document.getElementById(id);

// The station stand-in: jget answers with whatever NEXT holds, jpost merges and
// hands the whole object back so a recorded result reaches SAVED.
run(`ASKED=[]; NEXT={ok:true,devices:[],bootPortKnown:true,bootPortExcluded:true};
  jget=async(u)=>{ ASKED.push(u); return JSON.parse(JSON.stringify(NEXT)); };
  SAVED=[]; HELD={};
  jpost=async(u,b)=>{ SAVED.push({u:u,b:JSON.parse(JSON.stringify(b))});
    HELD=Object.assign({technician:'Tester',testedAt:'2026-09-20T12:00:00Z',clockWasNetwork:true},HELD,b);
    return {ok:true,status:200,data:{hardwareTest:JSON.parse(JSON.stringify(HELD)),
      hwtestMachine:'HOST1',hwtestNeedsFiling:false}}; };`);
const answer = (o) => run('NEXT = ' + JSON.stringify(o));
const reset = () => run(`HWTEST={}; HELD={}; SAVED=[]; ASKED=[]; HWT_RUNNING=false; HWT_MACHINE='';
  HWT_NOTE=''; HWT_NEEDS_FILING=false; HWT_SAVES=0; BOOT={};
  for(const k of HWT_KEYS){ delete HWT_UNSAVED[k]; } renderHwTest();`);
function scenario(first) {
  for (const k in els) delete els[k];
  for (const k in WIN) delete WIN[k];
  for (const k in LIVE) delete LIVE[k];
  reset();
  answer(first);
}
function readUsb() {
  return run(`(function(){ var u=HWTEST.usb||{};
    return {status:u.status, portsSeen:u.portsSeen, devices:u.devices, notes:u.notes,
      confirmedBy:u.confirmedBy, reason:u.reason, action:u.action,
      badge:document.getElementById('hwtStat_usb').textContent,
      why:document.getElementById('hwtWhy_usb').textContent,
      saved:(SAVED.length?SAVED[SAVED.length-1].b.usb:null)}; })()`);
}
// The stand-in DOM does not parse innerHTML into nodes, so the instruction is
// read from the markup the runner actually wrote into the row.
const panel = () => ({ count: el('usbCount').textContent, list: el('usbList').innerHTML,
  none: el('usbNone').textContent, known: el('usbKnown').textContent,
  instr: el('hwtDetail_usb').innerHTML });

const D = (port, name, speed, hub) => ({ port, name, speed, hub: !!hub });
const out = {};
out.registered = run(`typeof HWT_RUNNERS.usb`);

// The ordinary run: an internal camera is already on the bus, then the
// technician moves a stick through three sockets.
scenario({ ok: true, bootPortKnown: true, bootPortExcluded: true,
  devices: [D('1-1', 'Integrated Camera', 'USB 2.0 (480 Mbps)')] });
run(`USBP = runHwTest('usb')`);
await sleep(30);
out.start = panel();
answer({ ok: true, bootPortKnown: true, bootPortExcluded: true,
  devices: [D('1-1', 'Integrated Camera', 'USB 2.0 (480 Mbps)'),
            D('1-3', 'SanDisk Ultra', 'USB 3.0 (5000 Mbps)')] });
await poll(1);
out.one = panel();
// The same device seen again on the next poll must not be counted twice.
await poll(2);
out.stillOne = panel().count;
answer({ ok: true, bootPortKnown: true, bootPortExcluded: true,
  devices: [D('1-1', 'Integrated Camera', 'USB 2.0 (480 Mbps)'),
            D('1-4', 'SanDisk Ultra', 'USB 2.0 (480 Mbps)')] });
await poll(1);
answer({ ok: true, bootPortKnown: true, bootPortExcluded: true,
  devices: [D('1-1', 'Integrated Camera', 'USB 2.0 (480 Mbps)'),
            D('2-1', '', '')] });
await poll(1);
out.three = panel();
out.pollsWhileOpen = liveTimers();
out.askedPath = run(`ASKED[0]`);
run(`document.getElementById('usbNote').value = 'all four sockets answered'`);
run(`document.getElementById('usbPass')._fire('click')`);
await run(`USBP`);
out.pass = readUsb();
out.pass.timersLeft = liveTimers();

// Nothing plugged in at all: a count of nought is NOT a failure, and the
// technician's answer is still what decides.
scenario({ ok: true, bootPortKnown: true, bootPortExcluded: true, devices: [] });
run(`USBP = runHwTest('usb')`);
await sleep(30);
await poll(2);
out.emptyPanel = panel();
out.emptyStatus = run(`HWTEST.usb ? HWTEST.usb.status : 'none'`);
run(`document.getElementById('usbPass')._fire('click')`);
await run(`USBP`);
out.nonePlugged = readUsb();

// A port that did nothing: the technician says so, in their own words.
scenario({ ok: true, bootPortKnown: true, bootPortExcluded: true, devices: [] });
run(`USBP = runHwTest('usb')`);
await sleep(30);
answer({ ok: true, bootPortKnown: true, bootPortExcluded: true,
  devices: [D('1-3', 'SanDisk Ultra', 'USB 3.0 (5000 Mbps)')] });
await poll(1);
run(`document.getElementById('usbNote').value = 'the front-left socket did nothing'`);
run(`document.getElementById('usbFail')._fire('click')`);
await run(`USBP`);
out.fail = readUsb();
out.fail.timersLeft = liveTimers();

// The station cannot read USB at all.
scenario({ ok: false, reason: "this station cannot read the machine's USB ports (the kernel's list of USB devices is not there)",
  action: 'Check the ports by hand and tell a supervisor.' });
run(`USBP = runHwTest('usb')`);
await run(`USBP`);
out.cannotRead = readUsb();
out.cannotRead.timersLeft = liveTimers();

// A refusal that carries only a message (the Host/Origin guard's shape).
scenario({ message: "This station's service answers only its own screen." });
run(`USBP = runHwTest('usb')`);
await run(`USBP`);
out.refused = readUsb();

// A poll that fails half way through: it is said out loud and the test carries
// on - a station hiccup is not a verdict on the machine's sockets.
scenario({ ok: true, bootPortKnown: true, bootPortExcluded: true, devices: [] });
run(`USBP = runHwTest('usb')`);
await sleep(30);
answer({ ok: true, bootPortKnown: true, bootPortExcluded: true,
  devices: [D('1-3', 'SanDisk Ultra', 'USB 3.0 (5000 Mbps)')] });
await poll(1);
answer({ ok: false, reason: 'the station service did not answer' });
await poll(1);
out.hiccup = { panel: panel(), status: run(`HWTEST.usb ? HWTEST.usb.status : 'none'`) };
answer({ ok: true, bootPortKnown: true, bootPortExcluded: true,
  devices: [D('1-3', 'SanDisk Ultra', 'USB 3.0 (5000 Mbps)'), D('1-4', 'SanDisk Ultra', 'USB 2.0 (480 Mbps)')] });
await poll(1);
out.recovered = panel();
run(`document.getElementById('usbPass')._fire('click')`);
await run(`USBP`);

// The station could not tell which port it booted from: it says so instead of
// pretending the boot stick was left out.
scenario({ ok: true, bootPortKnown: false, bootPortExcluded: false, devices: [] });
run(`USBP = runHwTest('usb')`);
await sleep(30);
out.bootUnknownNote = el('usbKnown').textContent;
run(`document.getElementById('usbPass')._fire('click')`);
await run(`USBP`);

// The page torn down mid-decision: the poll stops rather than hammering a
// station whose panel has gone.
scenario({ ok: true, bootPortKnown: true, bootPortExcluded: true, devices: [] });
run(`USBP = runHwTest('usb')`);
await sleep(30);
out.beforeHide = liveTimers();
fireWindow('pagehide');
out.afterHide = liveTimers();
run(`document.getElementById('usbPass')._fire('click')`);   // let it finish so the harness ends
await run(`USBP`);

out.panelText = run(`HWT_KEYS.map(k=>document.getElementById('hwtStat_'+k).textContent+' '+
  document.getElementById('hwtWhy_'+k).textContent).join(' ')`);

process.stdout.write(JSON.stringify(out));
"""
    with open(harness, "w", encoding="utf-8") as fh:
        fh.write("(async () => {\n" + harness_body +
                 "\n})().catch(e => { console.error(e); process.exit(3); });\n")
    r = subprocess.run([node, harness, js], capture_output=True)
    try:
        o = json.loads(r.stdout.decode("utf-8"))
    except ValueError:
        o = {}
        print(r.stderr.decode("utf-8", "replace")[-3000:])
    check("the page's script runs and the runner drives", bool(o),
          r.stderr.decode("utf-8", "replace")[-800:])

    check("HWT_RUNNERS.usb is a function", o.get("registered") == "function", o.get("registered"))
    check("it asks the station's own endpoint", o.get("askedPath") == "/api/hwtest/usb",
          o.get("askedPath"))

    st = o.get("start") or {}
    check("the test opens at nought, and says nothing has responded YET",
          "Ports that responded: 0" in st.get("count", "")
          and "not a fault on its own" in st.get("none", ""), st)
    check("what was already plugged in is listed and NOT counted",
          "Already connected when the test started" in st.get("known", "")
          and "1-1" in st.get("known", "")
          and "Ports that responded: 0" in st.get("count", ""), st)
    check("...and the boot stick's own port is said to be left out",
          "booted from" in st.get("known", "") and "left out of the count" in st.get("known", ""), st)
    check("the instruction never claims which socket answered",
          "cannot tell which physical socket is which" in st.get("instr", "")
          and "keep track of any that do nothing" in st.get("instr", ""), st.get("instr"))

    one = o.get("one") or {}
    check("a stick appearing at a new port counts ONE, and the port is listed",
          "Ports that responded: 1" in one.get("count", "")
          and "1-3" in one.get("list", "") and "SanDisk Ultra" in one.get("list", ""), one)
    check("...and the 'nothing yet' line goes away once something has responded",
          one.get("none", "") == "", one)
    check("the same port seen again is not counted twice",
          "Ports that responded: 1" in (o.get("stillOne") or ""), o.get("stillOne"))

    three = o.get("three") or {}
    check("three ports in turn read 'Ports that responded: 3'",
          "Ports that responded: 3" in three.get("count", ""), three)
    check("...each one listed by the path the kernel gave, with what appeared there",
          all(p in three.get("list", "") for p in ("1-3", "1-4", "2-1")), three)
    check("a device that published no name still reports its speed in words",
          "speed not reported" in three.get("list", ""), three)
    check("the poll really is running while the panel is open",
          o.get("pollsWhileOpen") == 1, o.get("pollsWhileOpen"))

    p = o.get("pass") or {}
    check("a technician PASS stores PASSED with the count, the devices and who confirmed it",
          p.get("status") == "PASSED" and p.get("portsSeen") == 3
          and isinstance(p.get("devices"), list) and len(p["devices"]) == 3
          and p.get("confirmedBy") == "technician"
          and p.get("notes") == "all four sockets answered" and p.get("badge") == "Passed", p)
    check("...and the same fields reach the station (not whitelisted away)",
          (p.get("saved") or {}).get("portsSeen") == 3
          and (p.get("saved") or {}).get("devices", [{}])[0].get("port") == "1-3", p.get("saved"))
    check("...and the poll is stopped once the answer is in",
          p.get("timersLeft") == 0, p)

    ep = o.get("emptyPanel") or {}
    check("polling with nothing plugged in NEVER records a verdict of its own",
          o.get("emptyStatus") == "IN_PROGRESS"
          and "Ports that responded: 0" in ep.get("count", ""), (o.get("emptyStatus"), ep))
    check("...and it says a count of nought is not a fault",
          "not a fault on its own" in ep.get("none", ""), ep)
    npg = o.get("nonePlugged") or {}
    check("the technician's 'all ports work' with nothing seen is a PASS, not a failure",
          npg.get("status") == "PASSED" and npg.get("portsSeen") == 0
          and npg.get("devices") == [], npg)

    f = o.get("fail") or {}
    check("a technician FAIL stores FAILED, in the technician's own words",
          f.get("status") == "FAILED" and f.get("badge") == "Failed"
          and "front-left socket" in (f.get("reason") or "")
          and f.get("portsSeen") == 1, f)
    check("...and it stops the poll as well", f.get("timersLeft") == 0, f)

    cr = o.get("cannotRead") or {}
    check("a station that cannot read USB at all is ATTENTION, never FAILED",
          cr.get("status") == "ATTENTION" and cr.get("badge") == "Needs attention"
          and "cannot read" in (cr.get("reason") or "")
          and (cr.get("action") or "").strip(), cr)
    check("...and it leaves no poll running behind it", cr.get("timersLeft") == 0, cr)
    rf = o.get("refused") or {}
    check("a refusal that carries only a message still reads as could-not-run with an action",
          rf.get("status") == "ATTENTION" and "own screen" in (rf.get("reason") or "")
          and (rf.get("action") or "").strip(), rf)

    hic = o.get("hiccup") or {}
    check("a poll that fails half way through does NOT end the test or record a verdict",
          hic.get("status") == "IN_PROGRESS", hic)
    check("...it says so out loud and keeps what was already counted",
          "could not read the ports just now" in (hic.get("panel") or {}).get("known", "")
          and "Ports that responded: 1" in (hic.get("panel") or {}).get("count", ""), hic)
    rec = o.get("recovered") or {}
    check("...and when it answers again the count carries on",
          "Ports that responded: 2" in rec.get("count", "")
          and "could not read the ports just now" not in rec.get("known", ""), rec)

    check("a station that cannot tell which port it booted from says so, rather than "
          "pretending the boot stick was left out",
          "could not work out which port it booted from" in (o.get("bootUnknownNote") or ""),
          o.get("bootUnknownNote"))

    check("the page being torn down mid-decision stops the poll",
          o.get("beforeHide") == 1 and o.get("afterHide") == 0,
          (o.get("beforeHide"), o.get("afterHide")))

    check("nothing the USB test ever put on the card says 'Unknown'",
          "nknown" not in (o.get("panelText") or "x"), o.get("panelText"))

shutil.rmtree(TMP, True)
print("\n%d passed, %d failed" % (PASS[0], len(FAIL)))
sys.exit(1 if FAIL else 0)
