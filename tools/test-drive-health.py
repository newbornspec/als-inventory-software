#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Drive health as a percentage (contract C5), end to end on the station side.

The owner asked for every HDD/SSD's health as a PERCENTAGE with a status
(Good 90-100, Caution 50-89, Bad 0-49), computed from the drive's own data by
a documented formula, and for the screen NEVER to say "Unknown": when a number
cannot be measured it says why and what to do.

1. THE FORMULA. The engine's python helper (als_health_py in
   hardware-audit.sh - extracted and run exactly as the engine runs it) is fed
   smartctl 7.4 `-j -x` JSON shaped like smartmontools' own output, and
   `mmc extcsd read` text shaped like mmc-utils' own output, for: healthy /
   worn / critical-warning NVMe, SATA SSDs with Device Statistics and each of
   the 231/233/177/202/169 life attributes (and a vendor that reuses an id),
   a clean HDD, an HDD with reallocated + pending + uncorrectable sectors,
   SMART FAILED, an attribute failing now / in the past, a failed self-test, a
   hot drive, SMART switched off, SMART unsupported, a RAID logical volume, a
   timed-out read, a drive that could not be opened, and eMMC life estimates
   including PRE_EOL 0x02 / 0x03. Percent, status, basis and reasons are
   asserted exactly; every measured result's status must be the band of its
   percent, and no result may contain "unknown".
2. HIDDEN DRIVES. The same helper's sysfs scan finds an Intel RST controller
   that remaps NVMe drives, and a RAID-class controller with no disk under it,
   and leaves a RAID-class controller that does have a disk alone.
3. THE KIOSK (tools/gui/server.py). The hardware panel gets a Drive health
   line per drive from the captured profile, in the contract's wording; the
   wipe panel's drives carry the SAME profile health, matched by serial (and by
   kernel name for a drive with no serial), and no smartctl is ever run by the
   kiosk; before a capture it says "Not scanned yet - press Rescan".
4. THE PAGE (tools/gui/index.html). No "Unknown", "SMART not available" or
   "no SMART" anywhere in it; under node, the panel row and the wipe banner
   show what the server supplied (skipped without node unless
   ALS_REQUIRE_NODE=1).

    python3 tools/test-drive-health.py
"""
import copy
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.join(HERE, "hardware-audit.sh")
PAGE = os.path.join(HERE, "gui", "index.html")

PASS, FAIL = [0], []


def check(name, cond, detail=""):
    if cond:
        PASS[0] += 1
        print("  ok   %s" % name)
    else:
        FAIL.append(name)
        print("  FAIL %s   %s" % (name, detail))


def helper_source():
    """als_health_py's python, exactly as the engine prints it."""
    with open(ENGINE, encoding="utf-8") as fh:
        text = fh.read()
    m = re.search(r"^als_health_py\(\) \{\n  cat <<'PYEOF'\n(.*?)\nPYEOF\n\}", text, re.S | re.M)
    return m.group(1) if m else None


SRC = helper_source()
check("the engine carries the health helper (als_health_py)", bool(SRC))
if not SRC:
    sys.exit(1)
TMP = tempfile.mkdtemp(prefix="als-dh-")
HELPER = os.path.join(TMP, "health.py")
with open(HELPER, "w", encoding="utf-8", newline="\n") as fh:
    fh.write(SRC)


def run_helper(args, stdin="", cwd=None):
    r = subprocess.run([sys.executable, HELPER] + [str(a) for a in args],
                       input=stdin.encode("utf-8"), capture_output=True, cwd=cwd)
    return r.stdout.decode("utf-8"), r.returncode, r.stderr.decode("utf-8", "replace")


def parse(out):
    res = {"flat": {}, "raw": out}
    for line in out.splitlines():
        if line.startswith("H "):
            res["health"] = json.loads(line[2:])
        elif line.startswith("L "):
            res["line"] = line[2:]
        elif line.startswith(("S ", "N ")):
            _, k, v = line.split(" ", 2)
            res["flat"][k] = int(v) if line[0] == "N" else v
    return res


def smart(doc, rc=0, kind="ata-ssd", tried=0):
    raw = doc if isinstance(doc, str) else json.dumps(doc)
    out, code, err = run_helper(["smart", rc, kind, tried], raw)
    if code != 0:
        print(err)
    return parse(out)


def emmc(text, rc=0):
    out, code, err = run_helper(["emmc", rc], text)
    if code != 0:
        print(err)
    return parse(out)


# ---------------------------------------------------------------- fixtures --
# Shaped like smartctl 7.4 r5530 `-j -x` output (json_format_version 1.0).
def base(protocol, dtype, name):
    return {"json_format_version": [1, 0],
            "smartctl": {"version": [7, 4], "svn_revision": "5530",
                         "platform_info": "x86_64-linux-6.8.0", "build_info": "(local build)",
                         "argv": ["smartctl", "-j", "-x", name], "exit_status": 0},
            "local_time": {"time_t": 1790000000, "asctime": "Sat Sep 19 10:00:00 2026 UTC"},
            "device": {"name": name, "info_name": name, "type": dtype, "protocol": protocol}}


def nvme(used=3, spare=100, thr=10, media=0, cw=0, temp=36, passed=None, limit=None,
         selftest=None):
    d = base("NVMe", "nvme", "/dev/nvme0n1")
    d.update({"model_name": "SAMSUNG MZVLB512HBJQ-000L7", "serial_number": "S4ENNX0N123456",
              "firmware_version": "5M2QEXF7", "nvme_pci_vendor": {"id": 5197, "subsystem_id": 5197},
              "nvme_total_capacity": 512110190592, "nvme_number_of_namespaces": 1,
              "smart_support": {"available": True, "enabled": True},
              "smart_status": {"passed": (cw == 0) if passed is None else passed,
                               "nvme": {"value": cw}},
              "nvme_smart_health_information_log": {
                  "critical_warning": cw, "temperature": temp, "available_spare": spare,
                  "available_spare_threshold": thr, "percentage_used": used,
                  "data_units_read": 9123456, "data_units_written": 8123456,
                  "host_reads": 123456789, "host_writes": 98765432,
                  "controller_busy_time": 900, "power_cycles": 1432, "power_on_hours": 5678,
                  "unsafe_shutdowns": 91, "media_errors": media, "num_err_log_entries": 12,
                  "warning_temp_time": 0, "critical_comp_time": 0,
                  "temperature_sensors": [temp, temp + 5]},
              "temperature": {"current": temp}, "power_cycle_count": 1432,
              "power_on_time": {"hours": 5678}})
    if limit is not None:
        d["temperature"]["op_limit_max"] = limit
    if selftest is not None:
        d["nvme_self_test_log"] = {
            "current_self_test_operation": {"value": 0, "string": "No self-test in progress"},
            "table": [{"self_test_code": {"value": 2, "string": "Extended"},
                       "self_test_result": {"value": selftest,
                                            "string": {0: "Completed without error",
                                                       7: "Completed: failed segments"}.get(selftest, "x")},
                       "power_on_hours": 5600}]}
    return d


def attr(i, name, value=100, worst=100, thresh=0, raw=0, raw_string=None, when_failed="",
         prefailure=False):
    return {"id": i, "name": name, "value": value, "worst": worst, "thresh": thresh,
            "when_failed": when_failed,
            "flags": {"value": 51 if prefailure else 50, "string": "PO--CK " if prefailure else "-O--CK ",
                      "prefailure": prefailure, "updated_online": True, "performance": False,
                      "error_rate": False, "event_count": True, "auto_keep": True},
            "raw": {"value": raw, "string": raw_string if raw_string is not None else str(raw)}}


def ata(rotation, attrs, passed=True, temp=34, devstat_used=None, selftests=None,
        support=None, hours=16083):
    d = base("ATA", "sat", "/dev/sda")
    d.update({"model_family": "Western Digital Blue Mobile" if rotation else "Samsung based SSDs",
              "model_name": "WDC WD5000LPCX-24VHAT0" if rotation else "Samsung SSD 860 EVO 500GB",
              "serial_number": "WD-WXA1A1234567", "firmware_version": "01.01A01",
              "user_capacity": {"blocks": 976773168, "bytes": 500107862016},
              "logical_block_size": 512, "physical_block_size": 4096,
              "rotation_rate": rotation, "form_factor": {"ata_value": 3, "name": "2.5 inches"},
              "ata_version": {"string": "ACS-3 T13/2161-D revision 5", "major_value": 2032,
                              "minor_value": 109},
              "sata_version": {"string": "SATA 3.1", "value": 127},
              "smart_support": support or {"available": True, "enabled": True},
              "smart_status": {"passed": passed},
              "ata_smart_attributes": {"revision": 16, "table": attrs},
              "power_on_time": {"hours": hours}, "power_cycle_count": 2100,
              "temperature": {"current": temp}})
    if devstat_used is not None:
        d["ata_device_statistics"] = {"pages": [
            {"number": 1, "name": "General Statistics", "revision": 1, "table": [
                {"offset": 8, "name": "Lifetime Power-On Resets", "size": 4, "value": 2100,
                 "flags": {"value": 192, "string": "V---C- ", "valid": True, "normalized": False,
                           "supports_dsn": False, "monitored_condition_met": False}}]},
            {"number": 7, "name": "Solid State Device Statistics", "revision": 1, "table": [
                {"offset": 8, "name": "Percentage Used Endurance Indicator", "size": 1,
                 "value": devstat_used,
                 "flags": {"value": 192, "string": "V---C- ", "valid": True, "normalized": True,
                           "supports_dsn": False, "monitored_condition_met": False}}]}]}
    if selftests is not None:
        d["ata_smart_self_test_log"] = {"standard": {"revision": 1, "table": selftests,
                                                     "count": len(selftests)}}
    return d


def st(string, passed, value, kind="Short offline", hours=16000):
    s = {"value": value, "string": string}
    if passed is not None:
        s["passed"] = passed
    return {"type": {"value": 1, "string": kind}, "status": s, "lifetime_hours": hours}


def hdd_attrs(realloc=0, pending=0, offunc=0, repunc=None, crc=0, spin=0, when5=""):
    a = [attr(1, "Raw_Read_Error_Rate", 200, 200, 51, 0, prefailure=True),
         attr(3, "Spin_Up_Time", 175, 173, 21, 2233, prefailure=True),
         attr(5, "Reallocated_Sector_Ct", 200 if not when5 else 1, 200, 140, realloc,
              when_failed=when5, prefailure=True),
         attr(9, "Power_On_Hours", 78, 78, 0, 16083, raw_string="16083h+45m+12.345s"),
         attr(10, "Spin_Retry_Count", 100, 100, 0, spin),
         attr(12, "Power_Cycle_Count", 98, 98, 0, 2100),
         attr(194, "Temperature_Celsius", 113, 97, 0, 34, raw_string="34 (Min/Max 18/55)"),
         attr(197, "Current_Pending_Sector", 200, 200, 0, pending),
         attr(198, "Offline_Uncorrectable", 200, 200, 0, offunc),
         attr(199, "UDMA_CRC_Error_Count", 200, 200, 0, crc)]
    if repunc is not None:
        a.append(attr(187, "Reported_Uncorrect", 100, 100, 0, repunc))
    return a


def ssd_attrs(extra):
    return [attr(5, "Reallocated_Sector_Ct", 100, 100, 10, 0, prefailure=True),
            attr(9, "Power_On_Hours", 95, 95, 0, 21234),
            attr(12, "Power_Cycle_Count", 99, 99, 0, 1812),
            attr(190, "Airflow_Temperature_Cel", 66, 51, 0, 34)] + extra


HDD_CLEAN = "no reallocated, pending or uncorrectable sectors"
HOT = u"running hot: %d °C (the drive's limit is %d °C)"


def expect(name, res, percent, status, basis, reasons):
    h = res.get("health") or {}
    ok = (h.get("measured") is True and h.get("percent") == percent and h.get("status") == status
          and h.get("basis") == basis and h.get("reasons") == reasons)
    check(name + ": %s%% %s" % (percent, status), ok,
          json.dumps({k: h.get(k) for k in ("percent", "status", "basis", "reasons")}))
    return h


def expect_nm(name, res, reason, action, source):
    h = res.get("health") or {}
    ok = (h.get("measured") is False and h.get("reason") == reason and h.get("action") == action
          and h.get("source") == source and "percent" not in h and "status" not in h)
    check(name + ": not measurable - " + reason, ok, json.dumps(h))
    return h


RESULTS = []


def keep(res):
    RESULTS.append(res)
    return res


# --------------------------------------------------------------- 1. formula --
print("1. the formula, on smartctl 7.4 JSON")

h = expect("healthy NVMe", keep(smart(nvme(), kind="nvme")), 97, "good",
           "life remaining 97% reported by the drive", [])
check("healthy NVMe: the contract's fields", h.get("source") == "nvme" and h.get("smartPassed") is True
      and h.get("temperatureC") == 36 and h.get("powerOnHours") == 5678 and h.get("powerCycles") == 1432
      and h.get("lifeUsedPct") == 3 and h.get("availableSparePct") == 100 and h.get("mediaErrors") == 0
      and h.get("criticalWarning") == 0 and h.get("reallocatedSectors") is None
      and h.get("selfTest") == "none" and h.get("tool") == "smartctl 7.4", json.dumps(h))

# The investigation's worn sample: 85% used, spare 15 against a threshold of
# 10, 74 degrees, no temperature limit reported (so the SSD's 70 applies).
worn = nvme(used=85, spare=15, thr=10, temp=74)
res = keep(smart(worn, kind="nvme"))
expect("worn NVMe (85% used, spare 15/10)", res, 15, "bad",
       "life remaining 15% reported by the drive",
       [HOT % (74, 70), "spare blocks at 15% (the drive's own threshold is 10%)"])
check("worn NVMe: the old flat fields from the same read",
      res["flat"] == {"smartStatus": "PASSED", "healthPct": 15, "powerOnHours": 5678,
                      "powerCycles": 1432, "ssdLifeUsedPct": 85, "temperatureC": 74}, res["flat"])
check("worn NVMe: the summary line", res.get("line") == "15% Bad (life remaining 15% reported by the drive)",
      res.get("line"))

expect("NVMe critical warning (spare + reliability, 2 media errors)",
       keep(smart(nvme(used=10, spare=5, thr=10, media=2, cw=0x05), kind="nvme")), 5, "bad",
       "life remaining 5% reported by the drive",
       ["2 media errors", "NVMe critical warning: available spare below threshold, reliability degraded",
        "spare blocks at 5% (the drive's own threshold is 10%)"])
expect("NVMe temperature warning, healthy flash", keep(smart(nvme(used=2, cw=0x02, temp=85, limit=80),
                                                             kind="nvme")), 25, "bad",
       "life remaining 98% reported by the drive; reduced by NVMe critical warning: temperature "
       "out of range, " + HOT % (85, 80),
       ["NVMe critical warning: temperature out of range", HOT % (85, 80)])
expect("NVMe media errors only", keep(smart(nvme(used=1, media=3), kind="nvme")), 70, "caution",
       "life remaining 99% reported by the drive; reduced by 3 media errors", ["3 media errors"])
expect("NVMe failed self-test", keep(smart(nvme(used=4, selftest=7), kind="nvme")), 25, "bad",
       "life remaining 96% reported by the drive; reduced by the last self-test failed (Extended, at 5600 h)",
       ["the last self-test failed (Extended, at 5600 h)"])
h = RESULTS[-1]["health"]
check("NVMe failed self-test: selfTest is failed", h.get("selfTest") == "failed", h.get("selfTest"))
check("NVMe passed self-test: selfTest is passed",
      smart(nvme(selftest=0), kind="nvme")["health"].get("selfTest") == "passed")
expect("NVMe SMART FAILED with no critical warning",
       keep(smart(nvme(used=1, passed=False), kind="nvme")), 20, "bad",
       "life remaining 99% reported by the drive; reduced by the drive's own SMART self-check FAILED",
       ["the drive's own SMART self-check FAILED"])

# SATA SSDs: Device Statistics first, then the life attributes by id AND name.
res = keep(smart(ata(0, ssd_attrs([attr(177, "Wear_Leveling_Count", 50, 50, 0, 900)]), devstat_used=7)))
expect("SATA SSD, Device Statistics endurance (wins over 177)", res, 93, "good",
       "life remaining 93% reported by the drive", [])
check("SATA SSD devstat: lifeUsedPct 7, ssdLifeUsedPct 7, source ata-ssd",
      res["health"].get("lifeUsedPct") == 7 and res["flat"].get("ssdLifeUsedPct") == 7
      and res["health"].get("source") == "ata-ssd", res["health"])
for i, nm, v, pct, status in [(231, "SSD_Life_Left", 88, 88, "caution"),
                              (233, "Media_Wearout_Indicator", 100, 100, "good"),
                              (177, "Wear_Leveling_Count", 95, 95, "good"),
                              (202, "Percent_Lifetime_Remain", 92, 92, "good"),
                              (169, "Remaining_Lifetime_Perc", 97, 97, "good")]:
    # A raw value that would read as "worn out" if the raw column were used.
    expect("SATA SSD attribute %d %s" % (i, nm),
           keep(smart(ata(0, ssd_attrs([attr(i, nm, v, v, 0, 4000)])))), pct, status,
           "life remaining %d%% reported by the drive" % pct, [])
# (ssd_attrs carries attribute 5 but no 197/198, so the basis names the one
# counter the drive actually reported - not the full all-clear sentence.)
expect("SATA SSD, id reused for another counter (233 NAND_Writes_GiB)",
       keep(smart(ata(0, ssd_attrs([attr(233, "NAND_Writes_GiB", 100, 100, 0, 51234)])))), 100, "good",
       "no wear figure reported by the drive; no reallocated sectors; SMART passed", [])
expect("SATA SSD with 3 reallocated sectors",
       keep(smart(ata(0, [attr(5, "Reallocated_Sector_Ct", 99, 99, 10, 3),
                          attr(177, "Wear_Leveling_Count", 97, 97, 0, 30)]))), 94, "good",
       "life remaining 97% reported by the drive; reduced by 3 reallocated sectors",
       ["3 reallocated sectors"])

res = keep(smart(ata(5400, hdd_attrs()), kind="ata-hdd"))
expect("SATA HDD, clean", res, 100, "good", HDD_CLEAN + "; SMART passed", [])
check("SATA HDD: hours from the JSON (the '16083h+45m+12.345s' raw is 16083, not 345)",
      res["health"].get("powerOnHours") == 16083 and res["flat"].get("powerOnHours") == 16083,
      res["flat"])
check("SATA HDD: ATA counts 0, NVMe fields null, no life figure",
      res["health"].get("reallocatedSectors") == 0 and res["health"].get("pendingSectors") == 0
      and res["health"].get("uncorrectableSectors") == 0 and res["health"].get("mediaErrors") is None
      and res["health"].get("lifeUsedPct") is None and "ssdLifeUsedPct" not in res["flat"]
      and res["health"].get("source") == "ata-hdd", res["health"])

expect("HDD with reallocated + pending + uncorrectable (and CRC errors, not counted)",
       keep(smart(ata(5400, hdd_attrs(realloc=10, pending=2, offunc=1, repunc=2, crc=5)), kind="ata-hdd")),
       30, "bad", "10 reallocated sectors, 2 pending sectors, 3 uncorrectable sectors; SMART passed",
       ["10 reallocated sectors", "2 pending sectors", "3 uncorrectable sectors",
        u"5 cable/connection (CRC) errors — a cable or connector fault, not counted against the drive"])
expect("HDD deductions are capped (500 reallocated -> -40 only)",
       keep(smart(ata(7200, hdd_attrs(realloc=500)), kind="ata-hdd")), 60, "caution",
       "500 reallocated sectors; SMART passed", ["500 reallocated sectors"])
expect("the investigation's HDD sample (3 reallocated, 2 offline uncorrectable)",
       keep(smart(ata(7200, hdd_attrs(realloc=3, offunc=2)), kind="ata-hdd")), 74, "caution",
       "3 reallocated sectors, 2 uncorrectable sectors; SMART passed",
       ["3 reallocated sectors", "2 uncorrectable sectors"])
expect("HDD spin retries", keep(smart(ata(7200, hdd_attrs(spin=4)), kind="ata-hdd")), 90, "good",
       "spin retries recorded (4); SMART passed", ["spin retries recorded (4)"])
res = keep(smart(ata(7200, hdd_attrs(), passed=False), kind="ata-hdd"))
expect("SMART FAILED", res, 20, "bad",
       HDD_CLEAN + "; the drive's own SMART self-check FAILED", ["the drive's own SMART self-check FAILED"])
check("SMART FAILED: smartStatus FAILED on the old flat field", res["flat"].get("smartStatus") == "FAILED")
expect("attribute failing now", keep(smart(ata(7200, hdd_attrs(realloc=3000, when5="now")), kind="ata-hdd")),
       20, "bad", "3000 reallocated sectors; Reallocated_Sector_Ct is below the drive's failure "
       "threshold now; SMART passed",
       ["3000 reallocated sectors", "Reallocated_Sector_Ct is below the drive's failure threshold now"])
past = hdd_attrs()
past[1] = attr(3, "Spin_Up_Time", 20, 20, 21, 9000, when_failed="past", prefailure=True)
expect("attribute failed in the past", keep(smart(ata(7200, past), kind="ata-hdd")), 49, "bad",
       HDD_CLEAN + "; Spin_Up_Time fell below the drive's failure threshold in the past; SMART passed",
       ["Spin_Up_Time fell below the drive's failure threshold in the past"])
# The failure flags are the drive's own alarms - but three attributes must not
# raise one. 199 is a CABLE fault (the contract says so, and the helper already
# says so in the same breath), and 190/194 are TEMPERATURE counters whose
# "In_the_past" flag is set for good by one warm afternoon. Before this, a
# spotless drive that once ran warm was graded 49% Bad.
past_temp = [attr(5, "Reallocated_Sector_Ct", 100, 100, 36, 0, prefailure=True),
             attr(190, "Airflow_Temperature_Cel", 62, 45, 45, 38, when_failed="past"),
             attr(197, "Current_Pending_Sector", 100, 100, 0, 0),
             attr(198, "Offline_Uncorrectable", 100, 100, 0, 0)]
expect("a warm afternoon recorded in 190 Airflow_Temperature_Cel is not damage",
       keep(smart(ata(7200, past_temp, temp=38), kind="ata-hdd")), 100, "good",
       HDD_CLEAN + "; SMART passed",
       ["Airflow_Temperature_Cel went over the drive's temperature threshold in the past — "
        "a temperature, not damage to the drive"])
expect("a flagged 199 UDMA_CRC_Error_Count is a cable fault, not a failing drive",
       keep(smart(ata(0, [attr(5, "Reallocated_Sector_Ct", 100, 100, 10, 0, prefailure=True),
                          attr(177, "Wear_Leveling_Count", 97, 97, 0, 60),
                          attr(199, "UDMA_CRC_Error_Count", 99, 99, 0, 7, when_failed="now")]))),
       97, "good", "life remaining 97% reported by the drive",
       [u"7 cable/connection (CRC) errors — a cable or connector fault, not counted against the drive"])
now_temp = [attr(5, "Reallocated_Sector_Ct", 100, 100, 36, 0, prefailure=True),
            attr(194, "Temperature_Celsius", 40, 40, 45, 45, when_failed="now"),
            attr(197, "Current_Pending_Sector", 100, 100, 0, 0),
            attr(198, "Offline_Uncorrectable", 100, 100, 0, 0)]
expect("a temperature attribute failing NOW is treated as heat (cap 89), not as damage",
       keep(smart(ata(7200, now_temp, temp=45), kind="ata-hdd")), 89, "caution",
       HDD_CLEAN + "; Temperature_Celsius is over the drive's own temperature threshold now; "
       "SMART passed",
       ["Temperature_Celsius is over the drive's own temperature threshold now"])
expect("a drive that is hot now is not charged for heat twice",
       keep(smart(ata(7200, now_temp, temp=58), kind="ata-hdd")), 89, "caution",
       HDD_CLEAN + "; " + HOT % (58, 55) + "; SMART passed", [HOT % (58, 55)])

res = keep(smart(ata(0, ssd_attrs([attr(177, "Wear_Leveling_Count", 96, 96, 0, 40)]), selftests=[
    st("Completed: read failure", False, 121, "Extended offline", 5000),
    st("Completed without error", True, 0, "Short offline", 4000)])))
expect("failed self-test", res, 25, "bad",
       "life remaining 96% reported by the drive; reduced by the last self-test failed (Extended offline, at 5000 h)",
       ["the last self-test failed (Extended offline, at 5000 h)"])
res = smart(ata(0, ssd_attrs([attr(177, "Wear_Leveling_Count", 96, 96, 0, 40)]), selftests=[
    st("Aborted by host", None, 25), st("Completed without error", True, 0)]))
check("an aborted self-test is skipped: the last real one passed",
      res["health"].get("selfTest") == "passed" and res["health"].get("percent") == 96, res["health"])
expect("hot HDD (58 C, limit 55)", keep(smart(ata(7200, hdd_attrs(), temp=58), kind="ata-hdd")), 89,
       "caution", HDD_CLEAN + "; " + HOT % (58, 55) + "; SMART passed", [HOT % (58, 55)])
expect("SSD at 60 C is not hot (limit 70)",
       keep(smart(ata(0, ssd_attrs([attr(177, "Wear_Leveling_Count", 99, 99, 0, 3)]), temp=60))), 99, "good",
       "life remaining 99% reported by the drive", [])


# A SAS/SCSI disk (server pull-outs reach this station: the engine already
# handles MegaRAID/PERC) has NO ata_smart_attributes table at all. Its tallies
# live in its own logs: the grown defect list (blocks retired since the
# factory - the SCSI name for reallocated sectors) and the error counter log's
# uncorrected read/write/verify errors. Reading neither, the first version of
# this helper graded such a drive 100% Good and printed the all-clear sentence
# "no reallocated, pending or uncorrectable sectors" - a claim about counters
# it had never read.
def sas(defects=0, unc=0, rotation=10000, passed=True, logs=True, temp=34):
    d = base("SCSI", "scsi", "/dev/sdb")
    d.update({"scsi_vendor": "HGST", "scsi_product": "HUC101830CSS200",
              "scsi_model_name": "HGST HUC101830CSS200", "scsi_revision": "A3B0",
              "scsi_version": "SPC-4", "user_capacity": {"blocks": 585937500, "bytes": 300000000000},
              "rotation_rate": rotation, "form_factor": {"scsi_value": 3, "name": "2.5 inches"},
              "smart_support": {"available": True, "enabled": True},
              "smart_status": {"passed": passed},
              "temperature": {"current": temp, "drive_trip": 65},
              "power_on_time": {"hours": 48213}})
    if logs:
        d["scsi_grown_defect_list"] = defects
        d["scsi_error_counter_log"] = {
            "read": {"errors_corrected_by_eccfast": 0, "errors_corrected_by_eccdelayed": 121,
                     "errors_corrected_by_rereads_rewrites": 3, "total_errors_corrected": 124,
                     "correction_algorithm_invocations": 3, "gigabytes_processed": "12000.000",
                     "total_uncorrected_errors": unc},
            "write": {"errors_corrected_by_eccfast": 0, "errors_corrected_by_eccdelayed": 0,
                      "errors_corrected_by_rereads_rewrites": 0, "total_errors_corrected": 0,
                      "correction_algorithm_invocations": 0, "gigabytes_processed": "8000.000",
                      "total_uncorrected_errors": 0},
            "verify": {"errors_corrected_by_eccfast": 0, "errors_corrected_by_eccdelayed": 0,
                       "errors_corrected_by_rereads_rewrites": 0, "total_errors_corrected": 0,
                       "correction_algorithm_invocations": 0, "gigabytes_processed": "100.000",
                       "total_uncorrected_errors": 0}}
    return d


res = keep(smart(sas(defects=1204, unc=13), kind="ata-hdd"))
expect("SAS disk: 1204 grown defects and 13 uncorrected errors", res, 10, "bad",
       "1204 grown defects (reallocated sectors), 13 uncorrected read/write errors; SMART passed",
       ["1204 grown defects (reallocated sectors)", "13 uncorrected read/write errors"])
check("SAS disk: the counts are the drive's own, in the contract's fields",
      res["health"].get("reallocatedSectors") == 1204
      and res["health"].get("uncorrectableSectors") == 13
      and res["health"].get("pendingSectors") is None
      and res["flat"].get("reallocatedSectors") == 1204
      and res["health"].get("powerOnHours") == 48213, res["health"])
expect("SAS disk: clean", keep(smart(sas(), kind="ata-hdd")), 100, "good",
       "no grown defects or uncorrected errors; SMART passed", [])
expect("SAS disk: one grown defect reads as one", keep(smart(sas(defects=1), kind="ata-hdd")), 98,
       "good", "1 grown defect (reallocated sector); SMART passed",
       ["1 grown defect (reallocated sector)"])
expect_nm("SAS disk that reports neither log (nothing to compute a percentage from)",
          keep(smart(sas(logs=False), kind="ata-hdd")), "the drive does not report health data",
          u"none on this machine — test it on another machine or replace", "ata-hdd")

# The same rule for ATA: a table that does not carry 5/197/198 is not an
# all-clear. Either the drive reports SOME counter (then the basis names only
# what was read) or there is nothing to compute a percentage from at all.
expect_nm("ATA drive whose table has no error counter and no wear figure",
          keep(smart(ata(7200, [attr(9, "Power_On_Hours", 80, 80, 0, 20000)]), kind="ata-hdd")),
          "the drive does not report health data",
          u"none on this machine — test it on another machine or replace", "ata-hdd")
expect("ATA drive that reports only the reallocated count",
       keep(smart(ata(7200, [attr(5, "Reallocated_Sector_Ct", 200, 200, 140, 0),
                             attr(9, "Power_On_Hours", 80, 80, 0, 20000)]), kind="ata-hdd")),
       100, "good", "no reallocated sectors; SMART passed", [])
res = keep(smart(ata(7200, [attr(5, "Reallocated_Sector_Ct", 200, 200, 140, 0),
                            attr(197, "Current_Pending_Sector", 200, 200, 0, 0)]), kind="ata-hdd"))
check("a counter the drive never reported stays null, and the basis does not claim it",
      res["health"].get("uncorrectableSectors") is None
      and res["health"]["basis"] == "no reallocated or pending sectors; SMART passed", res["health"])
# A drive whose only answer is the overall verdict: its FAILED verdict is real
# data (cap 20), a PASSED verdict on its own is not a percentage.
expect("a drive whose only answer is a FAILED verdict",
       keep(smart(ata(7200, [attr(9, "Power_On_Hours", 80, 80, 0, 900)], passed=False), kind="ata-hdd")),
       20, "bad", "the drive's own SMART self-check FAILED",
       ["the drive's own SMART self-check FAILED"])

# Not measurable: reason + action, never a number, never "unknown".
off = ata(7200, [], support={"available": True, "enabled": False})
del off["smart_status"]
del off["ata_smart_attributes"]
out, _, _ = run_helper(["smart", 0, "ata-hdd", 0], json.dumps(off))
check("SMART switched off: first read asks the engine to switch it on", out.strip() == "ENABLE", out)
expect_nm("SMART still off after `smartctl -s on`", keep(smart(off, kind="ata-hdd", tried=1)),
          "SMART is switched off and would not turn on", "enable SMART in the BIOS, then press Rescan",
          "ata-hdd")
unsup = base("ATA", "sat", "/dev/sda")
unsup["smart_support"] = {"available": False}
expect_nm("SMART unsupported", keep(smart(unsup, kind="ata-ssd")), "the drive does not report health data",
          u"none on this machine — test it on another machine or replace", "ata-ssd")
raid = base("SCSI", "scsi", "/dev/sda")
raid["smartctl"]["exit_status"] = 2
raid["smartctl"]["messages"] = [{"string": "Smartctl open device: /dev/sda failed: DELL or MegaRaid "
                                            "controller, please try adding '-d megaraid,N'",
                                  "severity": "error"}]
expect_nm("RAID logical volume (MegaRAID)", keep(smart(raid, rc=2, kind="ata-hdd")),
          "behind a RAID/Intel RST controller", "set the storage mode to AHCI in the BIOS, then press Rescan",
          "ata-hdd")
perc = base("SCSI", "scsi", "/dev/sdb")
perc.update({"scsi_vendor": "DELL", "scsi_product": "PERC H730P Mini", "scsi_model_name": "DELL PERC H730P Mini",
             "smart_support": {"available": False}})
expect_nm("RAID logical volume (PERC by product name)", keep(smart(perc, kind="ata-hdd")),
          "behind a RAID/Intel RST controller", "set the storage mode to AHCI in the BIOS, then press Rescan",
          "ata-hdd")
expect_nm("timed out (timeout exit 124)", keep(smart("", rc=124, kind="nvme")),
          "the drive did not answer the health request in 30 s",
          "press Rescan; if it repeats, the drive may be failing", "nvme")
gone = base("NVMe", "nvme", "/dev/nvme0n1")
gone["smartctl"]["exit_status"] = 2
gone["smartctl"]["messages"] = [{"string": "Smartctl open device: /dev/nvme0n1 failed: No such device",
                                  "severity": "error"}]
expect_nm("device could not be opened", keep(smart(gone, rc=2, kind="nvme")),
          "the drive could not be opened for a health read",
          "press Rescan; if it repeats, reseat the drive or test it on another machine", "nvme")
# Captured from the real smartctl 7.4 r5530 (ubuntu:24.04) run on a path that
# is not a drive: exit_status 1, "Unable to detect device type".
real_nodev = {"json_format_version": [1, 0],
              "smartctl": {"version": [7, 4], "pre_release": False, "svn_revision": "5530",
                           "platform_info": "x86_64-linux-6.18.33.2-microsoft-standard-WSL2",
                           "build_info": "(local build)",
                           "argv": ["smartctl", "-j", "-x", "/dev/nonexistent-als-test"],
                           "messages": [{"string": "/dev/nonexistent-als-test: Unable to detect device type",
                                         "severity": "error"}],
                           "exit_status": 1},
              "local_time": {"time_t": 1789855876, "asctime": "Sat Sep 19 22:51:16 2026 UTC"}}
expect_nm("real smartctl 7.4 'Unable to detect device type' (exit 1)", keep(smart(real_nodev, rc=1, kind="nvme")),
          "the drive could not be opened for a health read",
          "press Rescan; if it repeats, reseat the drive or test it on another machine", "nvme")
expect_nm("smartctl printed nothing", keep(smart("", rc=1, kind="ata-ssd")),
          "the drive gave no readable health answer",
          "press Rescan; if it repeats, the drive may be failing", "ata-ssd")
expect_nm("smartctl missing", keep(smart("", rc=127, kind="ata-ssd")),
          "this build cannot read drive health (smartctl is missing)", "update the stick", "ata-ssd")
res = keep(smart(raid, rc=2, kind="ata-hdd"))
check("not measurable: summary line gives reason and action",
      res.get("line") == u"Not measurable — behind a RAID/Intel RST controller — set the "
                         u"storage mode to AHCI in the BIOS, then press Rescan", res.get("line"))
check("not measurable: no old flat fields invented", res["flat"] == {}, res["flat"])


# eMMC, `mmc extcsd read` (mmc-utils) text.
def extcsd(a, b, eol):
    return ("=============================================\n"
            "  Extended CSD rev 1.8 (MMC 5.1)\n"
            "=============================================\n\n"
            "Card Supported Command sets [S_CMD_SET: 0x01]\n"
            "eMMC Life Time Estimation A [EXT_CSD_DEVICE_LIFE_TIME_EST_TYP_A]: 0x%02x\n"
            "eMMC Life Time Estimation B [EXT_CSD_DEVICE_LIFE_TIME_EST_TYP_B]: 0x%02x\n"
            "eMMC Pre EOL information [EXT_CSD_PRE_EOL_INFO]: 0x%02x\n"
            "Secure Removal Type [SECURE_REMOVAL_TYPE]: 0x3b\n" % (a, b, eol))


res = keep(emmc(extcsd(0x01, 0x01, 0x01)))
expect("eMMC 0-10% used", res, 90, "good", "life remaining 90% reported by the drive", [])
check("eMMC: source emmc, tool mmc-utils, smartPassed null, lifeUsedPct 10",
      res["health"].get("source") == "emmc" and res["health"].get("tool") == "mmc-utils"
      and res["health"].get("smartPassed") is None and res["health"].get("lifeUsedPct") == 10
      and res["health"].get("selfTest") == "none", res["health"])
expect("eMMC type B worse than A", keep(emmc(extcsd(0x01, 0x03, 0x01))), 70, "caution",
       "life remaining 70% reported by the drive", [])
expect("eMMC PRE_EOL 0x02 (warning) caps at 89", keep(emmc(extcsd(0x01, 0x01, 0x02))), 89, "caution",
       "life remaining 90% reported by the drive; reduced by the drive reports its reserve blocks are "
       "running low (pre-EOL warning)",
       ["the drive reports its reserve blocks are running low (pre-EOL warning)"])
expect("eMMC PRE_EOL 0x03 (urgent) caps at 25", keep(emmc(extcsd(0x02, 0x02, 0x03))), 25, "bad",
       "life remaining 80% reported by the drive; reduced by the drive reports its reserve blocks are "
       "nearly used up (pre-EOL urgent)",
       ["the drive reports its reserve blocks are nearly used up (pre-EOL urgent)"])
expect("eMMC over its rated life (0x0B)", keep(emmc(extcsd(0x0B, 0x0A, 0x01))), 0, "bad",
       "life remaining 0% reported by the drive", [])
expect_nm("eMMC that defines no estimate (0x00)", keep(emmc(extcsd(0, 0, 0))),
          "the drive does not report health data",
          u"none on this machine — test it on another machine or replace", "emmc")
expect_nm("eMMC, mmc-utils not on the stick", keep(emmc("", rc=127)), "this build cannot read eMMC health",
          "update the stick", "emmc")
expect_nm("eMMC read timed out", keep(emmc("", rc=124)), "the drive did not answer the health request in 30 s",
          "press Rescan; if it repeats, the drive may be failing", "emmc")

bad_band = [r["health"] for r in RESULTS if r.get("health", {}).get("measured") is True
            and r["health"]["status"] != ("good" if r["health"]["percent"] >= 90 else
                                          "caution" if r["health"]["percent"] >= 50 else "bad")]
check("every measured status is the band of its percent (%d results)" % len(RESULTS), not bad_band, bad_band)
check("no result anywhere says 'unknown'",
      not [r for r in RESULTS if "unknown" in r["raw"].lower()], "")
check("every measured result names the formula's basis",
      all(r["health"].get("basis") for r in RESULTS if r.get("health", {}).get("measured")))

# ------------------------------------------------------------ 2. hidden -----
print("2. drives hidden by the storage controller")


def A(name):
    """Windows cannot hold ':' in a folder name; sysfs names are the kernel's,
    and the scan never parses them, so any stand-in works there."""
    return name.replace(":", "-") if os.name == "nt" else name


def pci(root, addr, cls, remap=None, disks=()):
    p = os.path.join(root, "sys", "bus", "pci", "devices", A(addr))
    os.makedirs(p, exist_ok=True)
    with open(os.path.join(p, "class"), "w") as fh:
        fh.write(cls + "\n")
    if remap is not None:
        with open(os.path.join(p, "remapped_nvme"), "w") as fh:
            fh.write("%d\n" % remap)
    for d in disks:
        os.makedirs(os.path.join(p, *A(d).split("/")), exist_ok=True)


root = os.path.join(TMP, "sys1")
pci(root, "0000:00:17.0", "0x010400", remap=1)                       # RST "RAID On", NVMe remapped
pci(root, "0000:00:0e.0", "0x010400")                                # VMD / RAID, nothing under it
pci(root, "0000:02:00.0", "0x010400", disks=["host0/target0:2:0/0:2:0:0/block/sda"])  # RAID with a volume
pci(root, "0000:00:1f.2", "0x010601", disks=["ata1/host1/target1:0:0/1:0:0:0/block/sdb"])  # AHCI
pci(root, "0000:03:00.0", "0x010802", disks=["nvme/nvme0/nvme0n1"])  # plain NVMe
out, code, err = run_helper(["hidden", root])
try:
    hid = json.loads(out)
except ValueError:
    hid = None
check("hidden scan runs", code == 0 and isinstance(hid, list), out + err)
hid = hid or []
by = {x["controller"]: x for x in hid}
check("RST remapped NVMe found, with its count and source nvme",
      by.get(A("0000:00:17.0"), {}).get("count") == 1
      and by.get(A("0000:00:17.0"), {}).get("health") == {
          "measured": False, "reason": "behind a RAID/Intel RST controller",
          "action": "set the storage mode to AHCI in the BIOS, then press Rescan", "source": "nvme"}, hid)
check("RAID-class controller with no disk under it is reported",
      A("0000:00:0e.0") in by and by[A("0000:00:0e.0")]["health"]["measured"] is False, hid)
check("a RAID controller that shows its volume, AHCI and NVMe are not reported",
      set(by) == {A("0000:00:17.0"), A("0000:00:0e.0")}, sorted(by))
# Nothing is under that controller, so nothing can be counted: the scan may
# not invent a number. Only remapped_nvme gives a count the kernel vouches for.
check("a RAID-class controller with no disk under it does not invent a drive count",
      "count" not in by.get(A("0000:00:0e.0"), {"count": 1}), by.get(A("0000:00:0e.0")))
out, _, _ = run_helper(["hidden", os.path.join(TMP, "no-such-root")])
check("no sysfs: an empty list, not an error", out.strip() == "[]", out)
# ALS_SYS_ROOT is a test-only variable: on the station the engine passes an
# EMPTY root, which must mean the real /sys. It used to mean "./sys", relative
# to whatever directory the kiosk happened to start the engine in, so on a
# real Intel RST machine the scan found nothing at all.
decoy = os.path.join(TMP, "decoy")
pci(decoy, "0000:DE:CO.Y", "0x010400")
out, code, err = run_helper(["hidden", ""], cwd=decoy)
check("an empty root means the real /sys, not a ./sys under the current directory",
      code == 0 and A("0000:DE:CO.Y") not in out, out + err)

# ------------------------------------------------------------- 3. kiosk -----
print("3. the kiosk shows the captured health")
spec = importlib.util.spec_from_file_location("als_server_dh", os.path.join(HERE, "gui", "server.py"))
srv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(srv)
srv.SYS_ROOT = os.path.join(TMP, "no-sys")

H_NVME = smart(nvme(), kind="nvme")["health"]
H_HDD = smart(ata(7200, hdd_attrs(realloc=3, offunc=2)), kind="ata-hdd")["health"]
H_RAID = smart(raid, rc=2, kind="ata-hdd")["health"]
PROFILE = {"identification": {"manufacturer": "Dell", "model": "Latitude 7490", "serialNumber": "HOST1"},
           "storage": [
               {"model": "SAMSUNG MZVLB512", "capacity": "512GB", "type": "NVMe", "interface": "NVMe",
                "serialNumber": "S4ENNX0N123456", "device": "nvme0n1", "health": H_NVME},
               # The profile holds the RAW lsblk value; the kiosk decodes both sides.
               {"model": "WDC WD5000", "capacity": "500GB", "type": "HDD", "interface": "SATA",
                "serialNumber": r"WD\x24X1", "device": "sda", "health": H_HDD},
               {"model": "PERC", "capacity": "1000GB", "type": "HDD", "interface": "sas",
                "serialNumber": "", "device": "sdb", "health": H_RAID},
               # An older engine: no health object at all.
               {"model": "Old SSD", "capacity": "256GB", "type": "SSD", "interface": "SATA",
                "serialNumber": "OLD1", "device": "sdc", "smartStatus": "PASSED"}],
           "hiddenStorage": [{"controller": "0000:00:17.0", "count": 1, "health": {
               "measured": False, "reason": "behind a RAID/Intel RST controller",
               "action": "set the storage mode to AHCI in the BIOS, then press Rescan", "source": "nvme"}},
               # No count: a RAID-mode controller with nothing visible under it.
               {"controller": "0000:00:0e.0", "health": {
                   "measured": False, "reason": "behind a RAID/Intel RST controller",
                   "action": "set the storage mode to AHCI in the BIOS, then press Rescan"}}]}

v = srv.health_view(H_NVME)
check("health_view measured: '97% · Good', ok, basis + key numbers",
      v == {"cls": "ok", "title": u"97% · Good",
            "detail": u"life remaining 97% reported by the drive · 36 °C · 5,678 h · life used 3%"}, v)
v = srv.health_view(H_HDD)
check("health_view caution: warn colour, '74% · Caution'",
      v["cls"] == "warn" and v["title"] == u"74% · Caution"
      and v["detail"].startswith("3 reallocated sectors, 2 uncorrectable sectors; SMART passed"), v)
check("health_view bad: bad colour", srv.health_view(dict(H_NVME, percent=45, status="bad"))["cls"] == "bad")
v = srv.health_view(H_RAID)
check("health_view not measurable: 'Not measurable — <reason>' + the action",
      v == {"cls": "na", "title": u"Not measurable — behind a RAID/Intel RST controller",
            "detail": "set the storage mode to AHCI in the BIOS, then press Rescan"}, v)
check("health_view no health: 'Not scanned yet — press Rescan'",
      srv.health_view(None) == {"cls": "na", "title": u"Not scanned yet — press Rescan", "detail": ""})
check("a status that disagrees with its percent is not shown as measured",
      srv.health_view(dict(H_NVME, percent=40))["title"] == u"Not scanned yet — press Rescan")

srv.STATE["profile"] = copy.deepcopy(PROFILE)
dev = srv.ident()
lines = dev.get("driveHealth") or []
check("ident: one Drive health line per drive plus the two controllers", len(lines) == 6, lines)
if len(lines) == 6:
    check("ident line 1: NVMe 97% Good", lines[0]["drive"] == "512GB NVMe" and lines[0]["cls"] == "ok"
          and lines[0]["title"] == u"97% · Good", lines[0])
    check("ident line 2: HDD 74% Caution", lines[1]["title"] == u"74% · Caution"
          and lines[1]["cls"] == "warn", lines[1])
    check("ident line 3: RAID volume says why and what to do",
          lines[2]["title"] == u"Not measurable — behind a RAID/Intel RST controller"
          and lines[2]["detail"].startswith("set the storage mode to AHCI"), lines[2])
    check("ident line 4: an older engine's drive says rescan",
          lines[3]["title"] == u"Not scanned yet — press Rescan", lines[3])
    check("ident line 5: the hidden drive", lines[4]["drive"] == "1 drive hidden by the storage controller"
          and lines[4]["title"].startswith(u"Not measurable — behind a RAID"), lines[4])
    # Nothing is known to be behind it, so the row says what IS known - the
    # controller's mode - instead of claiming a drive that may not exist.
    check("ident line 6: a controller with no count does not claim a drive",
          lines[5]["drive"] == "Storage controller in RAID mode"
          and lines[5]["title"].startswith(u"Not measurable — behind a RAID"), lines[5])
check("ident: the Storage line no longer carries a second, probed health note",
      "Health" not in dev["hw"]["storage"], dev["hw"]["storage"])

LSBLK = ('NAME="nvme0n1" SIZE="512110190592" MODEL="SAMSUNG MZVLB512" TRAN="nvme" RM="0" ROTA="0" '
         'TYPE="disk" SERIAL="S4ENNX0N123456"\n'
         'NAME="sda" SIZE="500107862016" MODEL="WDC WD5000" TRAN="sata" RM="0" ROTA="1" TYPE="disk" '
         'SERIAL="WD\\x24X1"\n'
         'NAME="sdb" SIZE="1000204886016" MODEL="PERC" TRAN="sas" RM="0" ROTA="1" TYPE="disk" SERIAL=""\n'
         'NAME="sdd" SIZE="256060514304" MODEL="Late SSD" TRAN="sata" RM="0" ROTA="0" TYPE="disk" '
         'SERIAL="LATE1"\n')
CALLS = []


class _R:
    stdout = LSBLK
    returncode = 0


def fake_run(cmd, *a, **k):
    CALLS.append(list(cmd))
    return _R()


real_run = srv.subprocess.run
srv.subprocess.run = fake_run
try:
    got = {d["device"]: d for d in srv.list_drives(force=True)}
    cached = {d["device"]: d for d in srv.list_drives()}
    srv.STATE["profile"] = None
    before = {d["device"]: d for d in srv.list_drives()}
    srv.STATE["profile"] = copy.deepcopy(PROFILE)
finally:
    srv.subprocess.run = real_run
check("wipe panel: the NVMe carries the profile's health (matched by serial)",
      got.get("/dev/nvme0n1", {}).get("health") == H_NVME
      and got["/dev/nvme0n1"]["healthView"]["title"] == u"97% · Good", got.get("/dev/nvme0n1"))
check("wipe panel: an escaped lsblk serial still matches (both sides decoded)",
      got.get("/dev/sda", {}).get("health") == H_HDD, got.get("/dev/sda"))
check("wipe panel: a drive with no serial matches by kernel name",
      got.get("/dev/sdb", {}).get("health") == H_RAID, got.get("/dev/sdb"))
check("wipe panel: a drive plugged in after the capture says 'Not scanned yet — press Rescan'",
      got.get("/dev/sdd", {}).get("health") is None
      and got["/dev/sdd"]["healthView"]["title"] == u"Not scanned yet — press Rescan", got.get("/dev/sdd"))
check("wipe panel: the cached list carries health too", cached.get("/dev/sda", {}).get("health") == H_HDD)
check("wipe panel before any capture: every drive says 'Not scanned yet — press Rescan'",
      before and all(d["health"] is None and d["healthView"]["title"] == u"Not scanned yet — press Rescan"
                     for d in before.values()), before)
check("the kiosk never runs smartctl (no unprivileged probe left)",
      CALLS and not [c for c in CALLS if any("smartctl" in str(x) for x in c)], CALLS)
check("the kiosk has no smart_health probe any more", not hasattr(srv, "smart_health"))
dup = copy.deepcopy(PROFILE)
dup["storage"].append(dict(dup["storage"][0], device="nvme1n1", health=H_HDD))
srv.STATE["profile"] = dup
check("two drives reporting one serial: told apart by kernel name, never guessed",
      srv.profile_health("nvme0n1", "S4ENNX0N123456") == H_NVME
      and srv.profile_health("nvme9n1", "S4ENNX0N123456") is None)
srv.STATE["profile"] = copy.deepcopy(PROFILE)
srv.STATE["capturing"] = False
payload = json.dumps(srv.ident(), ensure_ascii=False)
check("the kiosk's hardware answer never says 'Unknown' or 'SMART not available'",
      "Unknown" not in payload and "SMART not available" not in payload and "no SMART" not in payload, payload)
views = json.dumps([d["healthView"] for d in got.values()], ensure_ascii=False)
check("the wipe panel's health words never say 'Unknown'", "nknown" not in views, views)

# -------------------------------------------------------------- 4. page -----
print("4. the kiosk page")
with open(PAGE, encoding="utf-8") as fh:
    html = fh.read()
# The one allowed occurrence: a comparison against lsblk's own placeholder
# model name (never shown - it is what is filtered OUT of the label).
scrubbed = html.replace("d.model!=='Unknown model'", "")
check("index.html: no 'Unknown' anywhere (apart from the model placeholder it filters out)",
      "Unknown" not in scrubbed, [m.start() for m in re.finditer("Unknown", scrubbed)])
check("index.html: no 'SMART not available' / 'no SMART'",
      "SMART not available" not in html and "no SMART" not in html)
check("index.html: a Drive health row next to Battery in the hardware panel",
      re.search(r"\['batteryLine','Battery'.*\n\s*\['driveHealth','Drive health'", html) is not None)
with open(os.path.join(HERE, "gui", "preview-server.py"), encoding="utf-8") as fh:
    prev = fh.read()
check("preview-server: drives carry contract health objects and the panel rows",
      '"measured": True' in prev and '"driveHealth"' in prev and '"healthView"' in prev)

node = shutil.which("node")
if not node:
    if os.environ.get("ALS_REQUIRE_NODE") == "1":
        check("node is installed (ALS_REQUIRE_NODE=1)", False)
    else:
        print("  SKIP page rendering under node (node not installed)")
else:
    blocks = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", html, re.S | re.I)
    js = os.path.join(TMP, "page.js")
    with open(js, "w", encoding="utf-8") as fh:
        fh.write("\n;\n".join(blocks))
    harness = os.path.join(TMP, "h.js")
    with open(harness, "w", encoding="utf-8") as fh:
        fh.write(r"""
const vm = require('vm'), fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const els = {};
function mk(id) {
  const e = { id, style: {}, _cls: '', textContent: '', innerHTML: '', value: '',
    options: [], selectedOptions: [], firstElementChild: { style: {} }, focus() {}, select() {},
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
const ctx = vm.createContext({ document, console, prompt: () => null, screen: {}, innerWidth: 0,
  innerHeight: 0, fetch: () => new Promise(() => {}), setTimeout: () => 0, clearTimeout() {},
  setInterval() {} });
vm.runInContext(src, ctx, { filename: 'index.html<script>' });
const run = (c) => vm.runInContext(c, ctx);
const out = {};
const IN = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
ctx.IN = IN;
run(`BOOT={capturing:false}; fillHardware();`);
out.before = document.getElementById('hwGrid').innerHTML;
run(`BOOT={capturing:true}; fillHardware();`);
out.capturing = document.getElementById('hwGrid').innerHTML;
run(`BOOT={device:IN.device}; fillHardware();`);
out.after = document.getElementById('hwGrid').innerHTML;
run(`DRIVES=IN.drives; selectedWipeDrives=()=>[IN.drives[0].device]; renderHealth();`);
out.banner = document.getElementById('wHealth').innerHTML;
out.bannerCls = document.getElementById('wHealth').className;
run(`DRIVES=[IN.drives[0]]; document.getElementById('wHealth').__k=null; selectedWipeDrives=()=>[IN.drives[0].device]; renderHealth();`);
out.single = document.getElementById('wHealth').innerHTML;
out.singleCls = document.getElementById('wHealth').className;
process.stdout.write(JSON.stringify(out));
""")
    srv.STATE["profile"] = copy.deepcopy(PROFILE)
    srv.subprocess.run = fake_run
    try:
        drives = srv.list_drives(force=True)
    finally:
        srv.subprocess.run = real_run
    # Several drives: the banner names the one in trouble (the HDD) first.
    order = [d for d in drives if d["device"] == "/dev/sda"] + [d for d in drives if d["device"] != "/dev/sda"]
    inp = os.path.join(TMP, "in.json")
    with open(inp, "w", encoding="utf-8") as fh:
        json.dump({"device": srv.ident(), "drives": order}, fh)
    r = subprocess.run([node, harness, js, inp], capture_output=True)
    try:
        o = json.loads(r.stdout.decode("utf-8"))
    except ValueError:
        o = {}
        print(r.stderr.decode("utf-8", "replace")[-2000:])
    check("page: before a capture the Drive health row says 'Not scanned yet — press Rescan'",
          u"Drive health" in o.get("before", "") and u"Not scanned yet — press Rescan" in o.get("before", ""),
          o.get("before", "")[-400:])
    check("page: while capturing it says it is reading", u"Reading drive health" in o.get("capturing", ""))
    after = o.get("after", "")
    check("page: the panel shows each drive's percent and status in colour",
          u'<span class="dhp ok">97% · Good</span>' in after
          and u'<span class="dhp warn">74% · Caution</span>' in after, after[-1500:])
    check("page: the panel shows the basis under it",
          '<span class="dhb">life remaining 97% reported by the drive' in after)
    check("page: the panel shows not-measurable reason and action",
          u"Not measurable — behind a RAID/Intel RST controller" in after
          and "set the storage mode to AHCI in the BIOS, then press Rescan" in after)
    check("page: the panel never says Unknown", "Unknown" not in after and "nknown" not in o.get("before", ""))
    check("page: wipe banner (two drives) shows the drive in trouble from the profile health",
          u"Drive health: 74% · Caution" in o.get("banner", "") and "warn" in o.get("bannerCls", ""),
          o.get("banner"))
    check("page: wipe banner (one drive) shows its profile health",
          u"Drive health: 74% · Caution" in o.get("single", "") and "warn" in o.get("singleCls", ""),
          o.get("single"))

shutil.rmtree(TMP, True)
print("\n%d passed, %d failed" % (PASS[0], len(FAIL)))
sys.exit(1 if FAIL else 0)
