#!/usr/bin/env bash
#
# Fixture tests for lock-checks.sh.
#
# The cheap failure is calling a clean machine locked. The EXPENSIVE failure is
# calling a locked machine clear — a buyer takes a pallet of devices that cannot
# be resold. So these tests build fake /sys trees for machines that ARE locked
# and assert the detectors say so, because that branch cannot be exercised on
# the auditor's own hardware.

cd "$(dirname "$0")" || exit 1
# Use the audit script's own esc(), not a retyped copy.
eval "$(grep -n '^esc()' hardware-audit.sh | cut -d: -f1 | xargs -I{} sed -n '{}p' hardware-audit.sh)"

PASSED=0; FAILED=0
ok()   { PASSED=$((PASSED+1)); printf '  ok    %s\n' "$1"; }
bad()  { FAILED=$((FAILED+1)); printf '  FAIL  %s\n     expected: %s\n     actual:   %s\n' "$1" "$2" "$3"; }
check(){ [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }

row_status() { printf '%s' "$LOCK_ROWS" | grep "^$1|" | cut -d'|' -f3; }
row_detail() { printf '%s' "$LOCK_ROWS" | grep "^$1|" | cut -d'|' -f4; }

FIX=$(mktemp -d)
trap 'rm -rf "$FIX"' EXIT

# ---------------------------------------------------------------------------
echo "== a machine with NOTHING probeable: every answer must be UNKNOWN =="
export LOCK_SYSROOT="$FIX/empty"; mkdir -p "$LOCK_SYSROOT"
. ./lock-checks.sh
# The fixtures below ARE the "we can read this" case: they hand the detectors a
# fake /sys tree that exists and is readable. Simulate root so the privilege
# gate does not short-circuit the very logic under test. The gate itself is
# tested separately at the end, where it belongs.
LOCK_IS_ROOT=1
check_secure_boot; check_tpm; check_absolute; check_bios_password
check "secure boot unreadable -> UNKNOWN" UNKNOWN "$(row_status secureBoot)"
check "tpm unreadable -> UNKNOWN"         UNKNOWN "$(row_status tpm)"
check "absolute unreadable -> UNKNOWN"    UNKNOWN "$(row_status absolute)"
check "bios password -> UNKNOWN"          UNKNOWN "$(row_status biosPassword)"
check "no check may claim PASS"           0 "$(printf '%s' "$LOCK_ROWS" | grep -c '|PASS|')"

# ---------------------------------------------------------------------------
echo
echo "== a LOCKED machine: Absolute active, BIOS password set, Secure Boot on =="
LOCK_ROWS=""
export LOCK_SYSROOT="$FIX/locked"
GUID="8be4df61-93ca-11d2-aa0d-00e098032b8c"
mkdir -p "$LOCK_SYSROOT/sys/firmware/efi/efivars" \
         "$LOCK_SYSROOT/sys/firmware/acpi/tables" \
         "$LOCK_SYSROOT/sys/class/tpm/tpm0" \
         "$LOCK_SYSROOT/sys/class/firmware-attributes/dell-wmi-sysman/authentication/Admin" \
         "$LOCK_SYSROOT/sys/class/firmware-attributes/dell-wmi-sysman/authentication/System"
# efivars: 4 attribute bytes then the value. SecureBoot=1, SetupMode=0.
printf '\006\000\000\000\001' > "$LOCK_SYSROOT/sys/firmware/efi/efivars/SecureBoot-$GUID"
printf '\006\000\000\000\000' > "$LOCK_SYSROOT/sys/firmware/efi/efivars/SetupMode-$GUID"
# A WPBT carrying the Absolute agent — firmware actively injecting it.
printf 'WPBT\000\000rpcnetp.exe\000Absolute Software\000' > "$LOCK_SYSROOT/sys/firmware/acpi/tables/WPBT"
echo 1 > "$LOCK_SYSROOT/sys/class/firmware-attributes/dell-wmi-sysman/authentication/Admin/is_enabled"
echo 0 > "$LOCK_SYSROOT/sys/class/firmware-attributes/dell-wmi-sysman/authentication/System/is_enabled"
echo 2 > "$LOCK_SYSROOT/sys/class/tpm/tpm0/tpm_version_major"

check_secure_boot; check_setup_mode; check_bios_password; check_absolute; check_tpm
check "Secure Boot ON detected"            WARNING "$(row_status secureBoot)"
check "Setup Mode normal"                  PASS    "$(row_status setupMode)"
check "BIOS admin password found"          WARNING "$(row_status biosPassword)"
check "Absolute Persistence ACTIVE"        LOCKED  "$(row_status absolute)"
check "TPM present"                        PASS    "$(row_status tpm)"
case "$(row_detail absolute)" in *rpcnetp*) ok "Absolute names the WPBT payload";; *) bad "Absolute names the WPBT payload" "mentions rpcnetp" "$(row_detail absolute)";; esac
case "$(row_detail biosPassword)" in *Admin*) ok "BIOS detail names which password";; *) bad "BIOS detail names which password" "mentions Admin" "$(row_detail biosPassword)";; esac
check "overall verdict is LOCKED"          LOCKED  "$(lock_status)"
check "biosLocked flag set"                true    "$(lock_bios_locked)"

# ---------------------------------------------------------------------------
echo
echo "== Absolute merely AVAILABLE in BIOS is not the same as ACTIVE =="
LOCK_ROWS=""
export LOCK_SYSROOT="$FIX/avail"
mkdir -p "$LOCK_SYSROOT/sys/firmware/acpi/tables" \
         "$LOCK_SYSROOT/sys/class/firmware-attributes/dell-wmi-sysman/attributes/Absolute/"
echo "Deactivate" > "$LOCK_SYSROOT/sys/class/firmware-attributes/dell-wmi-sysman/attributes/Absolute/current_value"
check_absolute
check "BIOS switch off -> not LOCKED"      PASS "$(row_status absolute)"

# ---------------------------------------------------------------------------
echo
echo "== a clean UEFI machine still cannot be CLEAR while Windows is unreadable =="
LOCK_ROWS=""
export LOCK_SYSROOT="$FIX/clean"
mkdir -p "$LOCK_SYSROOT/sys/firmware/efi/efivars" "$LOCK_SYSROOT/sys/firmware/acpi/tables" "$LOCK_SYSROOT/sys/class/tpm"
printf '\006\000\000\000\000' > "$LOCK_SYSROOT/sys/firmware/efi/efivars/SecureBoot-$GUID"
check_secure_boot; check_tpm; check_absolute; check_autopilot
check "Secure Boot off"                    PASS       "$(row_status secureBoot)"
check "Autopilot unverifiable -> UNKNOWN"  UNKNOWN    "$(row_status autopilot)"
check "verdict is UNVERIFIED, not CLEAR"   UNVERIFIED "$(lock_status)"


# ---------------------------------------------------------------------------
# Hostile input. Detail and method fields carry values read from firmware and
# from the Windows registry, neither of which is under our control. All three
# cases below were REAL, reproduced defects before the sanitiser existed.
echo
echo "== a value containing pipes must not corrupt the record or the verdict =="
LOCK_ROWS=""
lock_add absolute "Absolute" PASS "BIOS value: Deactivate|LOCKED|yes" "firmware-attributes" high
check "row still parses: status is PASS"   PASS  "$(row_status absolute)"
check "a PASS row does not read as LOCKED" CLEAR "$(lock_status)"
check "method field is not shifted"        "firmware-attributes" "$(printf '%s' "$LOCK_ROWS" | cut -d'|' -f5)"

echo
echo "== a multi-line value (REG_MULTI_SZ) must not inject extra rows =="
LOCK_ROWS=""
lock_add autopilot "Autopilot" PASS "tenant: contoso
evil|Injected|LOCKED|bogus|x|high" "registry" high
check "one lock_add makes exactly one row" 1     "$(printf '%s' "$LOCK_ROWS" | grep -c '.')"
check "no fabricated LOCKED verdict"       CLEAR "$(lock_status)"

echo
echo "== WPBT: an Absolute agent must be found in UTF-16, not only ASCII =="
LOCK_ROWS=""
export LOCK_SYSROOT="$FIX/wpbt16"
mkdir -p "$LOCK_SYSROOT/sys/firmware/acpi/tables"
W="$LOCK_SYSROOT/sys/firmware/acpi/tables/WPBT"
printf 'WPBT4\000\000\000\001' > "$W"
printf 'r\000p\000c\000n\000e\000t\000p\000.\000e\000x\000e\000\000\000' >> "$W"
check_absolute
check "UTF-16 Absolute payload detected"   LOCKED "$(row_status absolute)"

echo
echo "== an unrelated WPBT payload must NOT be called Absolute =="
LOCK_ROWS=""
export LOCK_SYSROOT="$FIX/wpbt-other"
mkdir -p "$LOCK_SYSROOT/sys/firmware/acpi/tables"
W="$LOCK_SYSROOT/sys/firmware/acpi/tables/WPBT"
printf 'WPBT4\000\000\000\001' > "$W"
printf 'H\000P\000S\000u\000r\000e\000S\000t\000a\000r\000t\000\000\000' >> "$W"
check_absolute
check "non-Absolute WPBT is not LOCKED"    DETECTED "$(row_status absolute)"


# ---------------------------------------------------------------------------
# The shipped shell files must be plain text with UNIX line endings.
#
# This is not hypothetical hygiene. A patch to check_absolute wrote a literal
# NUL byte where the escape sequence \000 belonged, so the code ran
# `tr -d ''` — deleting nothing — and the UTF-16 detection silently did not
# work while every other test still passed. A stray CR would be worse: the
# sticks are written from Windows, and `\r` at the end of a line makes bash
# fail in ways that look like logic bugs.
echo
echo "== the shipped files must be clean text =="
for f in lock-checks.sh find-media.sh hardware-audit.sh; do
  nuls=$(LC_ALL=C tr -cd '\000' < "$f" | wc -c | tr -d ' ')
  check "$f has no NUL bytes"      0 "$nuls"
  crs=$(LC_ALL=C tr -cd '\r' < "$f" | wc -c | tr -d ' ')
  check "$f has no CR (CRLF)"      0 "$crs"
done


# ---------------------------------------------------------------------------
# DEGRADED CONDITIONS — the expensive failure.
#
# Every case below was a REPRODUCED false PASS: a probe that could not run was
# treated as a probe that came back negative, so the tool told a buyer a machine
# was clear when it had simply failed to look. That is the one outcome this
# whole file exists to prevent, and none of the earlier fixtures caught any of
# them, because fixtures only ever describe the happy path.
echo
echo "== not root: nothing may claim PASS =="
LOCK_ROWS=""
LOCK_IS_ROOT=0
export LOCK_SYSROOT="$FIX/locked"     # a fixture that WOULD read as locked
check_secure_boot; check_bios_password; check_absolute; check_bitlocker
check "no PASS while unprivileged"        0 "$(printf '%s' "$LOCK_ROWS" | cut -d'|' -f3 | grep -c '^PASS$')"
check "secure boot -> UNKNOWN"      UNKNOWN "$(row_status secureBoot)"
check "bios password -> UNKNOWN"    UNKNOWN "$(row_status biosPassword)"
check "absolute -> UNKNOWN"         UNKNOWN "$(row_status absolute)"
check "verdict is UNVERIFIED"    UNVERIFIED "$(lock_status)"
LOCK_IS_ROOT=1

echo
echo "== firmware-attributes present but unreadable: not a 'no password' =="
LOCK_ROWS=""
export LOCK_SYSROOT="$FIX/unreadable"
mkdir -p "$LOCK_SYSROOT/sys/class/firmware-attributes/dell-wmi-sysman/authentication/Admin/is_enabled"
check_bios_password
check "unreadable attribute -> UNKNOWN"  UNKNOWN "$(row_status biosPassword)"

echo
echo "== SOFTWARE hive readable but SYSTEM hive missing: not a 'no domain join' =="
LOCK_ROWS=""
_saved_locate=$(declare -f lock_locate_hives)
lock_locate_hives() { WIN_SOFTWARE="$FIX/sw"; WIN_SYSTEM=""; return 0; }
mkdir -p "$FIX"; echo x > "$FIX/sw"
_saved_has=$(declare -f lock_has)
lock_has() { return 0; }
check_entra
check "missing SYSTEM hive -> UNKNOWN"   UNKNOWN "$(row_status entra)"

echo
echo "== hivexget present but hivexsh missing: not a 'not enrolled' =="
LOCK_ROWS=""
lock_has() { case "$1" in hivexsh) return 1;; *) return 0;; esac; }
check_mdm
check "missing hivexsh -> UNKNOWN"       UNKNOWN "$(row_status mdm)"
eval "$_saved_has"; eval "$_saved_locate"

echo
echo "== blkid silent: not a 'no encrypted volumes' =="
LOCK_ROWS=""
blkid() { return 2; }
check_bitlocker
check "silent blkid -> UNKNOWN"          UNKNOWN "$(row_status bitlocker)"
unset -f blkid

echo
echo "== tpm2_getcap fails: must not claim 'no owner authorisation set' =="
LOCK_ROWS=""
export LOCK_SYSROOT="$FIX/tpmfail"
mkdir -p "$LOCK_SYSROOT/sys/class/tpm/tpm0"; echo 2 > "$LOCK_SYSROOT/sys/class/tpm/tpm0/tpm_version_major"
tpm2_getcap() { return 1; }
check_tpm
case "$(row_detail tpm)" in
  *"no owner authorisation set"*) bad "failed query must not assert ownership" "no such claim" "$(row_detail tpm)";;
  *) ok "failed query does not assert ownership";;
esac
unset -f tpm2_getcap

echo
printf '%d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
