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

echo
printf '%d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
