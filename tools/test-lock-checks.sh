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
# WPBT — built to the real spec, not to whatever the code happened to accept.
#
# The previous fixture was a 36-byte ASCII blob containing "rpcnetp.exe". No
# such table can exist: Microsoft's spec requires at least 52 bytes, and the
# payload name is not stored in the table at all — the table holds a POINTER to
# a PE image in memory. The old detector passed its test and could not have
# fired on a single real machine. These fixtures are laid out field by field so
# that never happens again.
#
#   0  signature "WPBT" | 4 length u32 | 8 rev | 9 cksum | 10 OEM ID (6)
#   16 OEM Table ID (8) | 24 OEM rev u32 | 28 Creator ID (4) | 32 Creator rev
#   36 HandoffSize u32  | 40 HandoffAddress u64 | 48 layout | 49 type
#   50 ArgsLength u16   | 52 Args (UTF-16LE)

# build_wpbt <file> <argslen> [utf16-args-printf-string]
build_wpbt() {
  local out="$1" al="$2" args="$3"
  # Separate statement: see the note in check_absolute — a sibling in the
  # same `local` is not visible, and this silently wrote a 52-byte length
  # into a 74-byte table.
  local total=$((52 + al))
  {
    printf 'WPBT'
    printf "$(printf '\\%03o\\%03o\\%03o\\%03o' $((total & 255)) $(((total >> 8) & 255)) 0 0)"
    printf '\001\000'                 # revision, checksum
    printf 'DELL  '                   # OEM ID (6)
    printf 'WPBT    '                 # OEM Table ID (8)
    printf '\001\000\000\000'         # OEM revision
    printf 'DELL'                     # Creator ID (4)
    printf '\001\000\000\000'         # Creator revision
    printf '\000\020\000\000'         # HandoffSize = 4096
    printf '\000\000\000\000\000\000\000\000'   # HandoffAddress = 0 (unreadable here)
    printf '\001\001'                 # layout, type
    printf "$(printf '\\%03o\\%03o' $((al & 255)) $(((al >> 8) & 255)))"
  } > "$out"
  [ -n "$args" ] && printf "$args" >> "$out"
  return 0
}

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
# A spec-shaped table whose UTF-16 arguments name the agent. What stood here was
# a 36-byte ASCII blob no firmware could emit, and it was the ONLY input on
# which the old detector's LOCKED branch could fire.
build_wpbt "$LOCK_SYSROOT/sys/firmware/acpi/tables/WPBT" 22 'r\000p\000c\000n\000e\000t\000p\000.\000e\000x\000e\000'
echo 1 > "$LOCK_SYSROOT/sys/class/firmware-attributes/dell-wmi-sysman/authentication/Admin/is_enabled"
echo 0 > "$LOCK_SYSROOT/sys/class/firmware-attributes/dell-wmi-sysman/authentication/System/is_enabled"
echo 2 > "$LOCK_SYSROOT/sys/class/tpm/tpm0/tpm_version_major"

check_secure_boot; check_setup_mode; check_bios_password; check_absolute; check_tpm
# Reported, never scored: see check_secure_boot. Scoring ON as WARNING put every
# machine audited by the documented procedure (Secure Boot left ON) into
# DEVICE STATUS: WARNING, and made switching Secure Boot OFF - the one thing the
# docs forbid - the only route to a clean report.
check "Secure Boot ON is reported, not scored" PASS "$(row_status secureBoot)"
case "$(row_detail secureBoot)" in
  *"Not an ownership lock"*) ok "says why Secure Boot is not a lock" ;;
  *) bad "says why Secure Boot is not a lock" "the explanation" "$(row_detail secureBoot)" ;;
esac
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
build_wpbt "$W" 22 'r\000p\000c\000n\000e\000t\000p\000.\000e\000x\000e\000'
check_absolute
check "UTF-16 Absolute payload detected"   LOCKED "$(row_status absolute)"

echo
echo "== an unrelated WPBT payload must NOT be called Absolute =="
LOCK_ROWS=""
export LOCK_SYSROOT="$FIX/wpbt-other"
mkdir -p "$LOCK_SYSROOT/sys/firmware/acpi/tables"
W="$LOCK_SYSROOT/sys/firmware/acpi/tables/WPBT"
build_wpbt "$W" 22 'H\000P\000S\000u\000r\000e\000S\000t\000a\000r\000t\000'
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
# test-lock-checks.sh checks ITSELF. It was left off this list, and a patch
# then wrote two literal NUL bytes into its own fixtures — so the fixtures
# silently stopped meaning what they said while the suite stayed green.
for f in lock-checks.sh find-media.sh hardware-audit.sh test-lock-checks.sh; do
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
echo "== SOFTWARE hive readable but SYSTEM/SECURITY hives missing: not a 'no join' =="
LOCK_ROWS=""
_saved_locate=$(declare -f lock_locate_hives)
lock_locate_hives() { WIN_SOFTWARE="$FIX/sw"; WIN_SYSTEM=""; WIN_SECURITY=""; return 0; }
mkdir -p "$FIX"; echo x > "$FIX/sw"
_saved_has=$(declare -f lock_has)
lock_has() { return 0; }
check_entra
check "missing SYSTEM hive -> entra UNKNOWN"   UNKNOWN "$(row_status entra)"
# The same run must not let the DOMAIN half of the old combined check quietly
# report a clean machine. The SECURITY hive holds the primary domain record, so
# without it there is no negative to report - only an absent answer.
LOCK_ROWS=""
check_domain
check "missing SECURITY hive -> domain UNKNOWN" UNKNOWN "$(row_status domainJoin)"

echo
echo "== an ENROLLED machine must never read as PASS =="
# The same two mistakes 45526b2 took out of check_entra lived on here, because
# that fix went looking at one function instead of one construct: enrolment
# subkeys were kept only if GUID-shaped, and hivexsh's exit status was thrown
# away. Either one made an Intune-enrolled machine report PASS.
_saved_locate4=$(declare -f lock_locate_hives)
_saved_has6=$(declare -f lock_has)
_saved_get4=$(declare -f lock_hive_get)
mkdir -p "$FIX"; echo x > "$FIX/sw3"
lock_locate_hives() { WIN_SOFTWARE="$FIX/sw3"; WIN_SYSTEM="$FIX/sw3"; return 0; }
lock_has() { return 0; }
LOCK_IS_ROOT=1

# A listing line that is not GUID-shaped, for a real enrolment with a
# management server URL.
hivexsh() { printf '  not-a-guid-shaped-name\n'; return 0; }
lock_hive_get() {
  case "$3" in
    DiscoveryServiceFullURL) printf 'https://enrollment.manage.microsoft.com/'; return 0 ;;
    *) return 1 ;;
  esac
}
LOCK_ROWS=""; check_mdm
check "non-GUID enrolment subkey -> not PASS" LOCKED "$(row_status mdm)"

# The Enrollments subtree will not walk. The `cd Microsoft` probe passes, so
# only the listing's own exit status can catch this.
# The key path arrives on STDIN (printf ... | hivexsh "$hive"), not in $@ —
# the hive path is the only argument. The `cd Microsoft` probe must still pass,
# so only the Enrollments listing fails.
hivexsh() { local _in; _in=$(cat); case "$_in" in *Enrollments*) return 2 ;; esac; return 0; }
LOCK_ROWS=""; check_mdm
check "Enrollments listing fails -> UNKNOWN"  UNKNOWN "$(row_status mdm)"

unset -f hivexsh
eval "$_saved_get4"; eval "$_saved_has6"; eval "$_saved_locate4"

echo
echo "== a legacy boot must leave a ROW, not vanish =="
# check_setup_mode used to `return 0` with no row on a non-UEFI boot. A missing
# row is worse than UNKNOWN: it is absent from the report, the JSON and the
# roll-up, so the UNKNOWN that forces UNVERIFIED never exists and the device
# read CLEAR.
LOCK_ROWS=""
export LOCK_SYSROOT="$FIX/legacy"; mkdir -p "$LOCK_SYSROOT"
LOCK_IS_ROOT=1
check_setup_mode
check "legacy boot files a row"            UNKNOWN "$(row_status setupMode)"
check "and the device is not CLEAR"        UNVERIFIED "$(lock_status)"

echo
echo "== an unrecognised is_enabled is not a 'no password' =="
LOCK_ROWS=""
export LOCK_SYSROOT="$FIX/biosodd"
mkdir -p "$LOCK_SYSROOT/sys/class/firmware-attributes/dell-wmi-sysman/authentication/Admin"
printf 'Not Supported\n' > "$LOCK_SYSROOT/sys/class/firmware-attributes/dell-wmi-sysman/authentication/Admin/is_enabled"
check_bios_password
check "unparseable value -> not PASS"      UNKNOWN "$(row_status biosPassword)"

echo
echo "== TPM: the command succeeding is not the field being there =="
LOCK_ROWS=""
export LOCK_SYSROOT="$FIX/tpmnofield"
mkdir -p "$LOCK_SYSROOT/sys/class/tpm/tpm0"
echo 2 > "$LOCK_SYSROOT/sys/class/tpm/tpm0/tpm_version_major"
_saved_has4=$(declare -f lock_has)
lock_has() { return 0; }
tpm2_getcap() { printf 'TPM2_PT_FIXED:\n  some.other.property: 0\n'; return 0; }
check_tpm
check "no ownerAuthSet property -> not PASS" UNKNOWN "$(row_status tpm)"
# The field present and 0 is a real answer and must still pass.
tpm2_getcap() { printf 'ownerAuthSet: 0\n'; return 0; }
LOCK_ROWS=""; check_tpm
check "ownerAuthSet: 0 -> PASS"            PASS "$(row_status tpm)"
unset -f tpm2_getcap; eval "$_saved_has4"

echo
echo "== BitLocker: a partial scan is not 'no encrypted volumes' =="
LOCK_ROWS=""
export LOCK_SYSROOT="$FIX/ble"
mkdir -p "$LOCK_SYSROOT"
LOCK_IS_ROOT=1
_saved_has5=$(declare -f lock_has)
lock_has() { return 0; }
# blkid sees only the boot stick; the internal disk is behind a RAID controller.
# The Windows mount already found an encrypted volume by signature.
blkid() { printf '/dev/sdb1: LABEL="ALSAUDIT" TYPE="vfat"\n'; return 0; }
WIN_ENCRYPTED=1
check_bitlocker
check "signature-found encryption -> WARNING" WARNING "$(row_status bitlocker)"
# And the inverse: a stick merely LABELLED BitLocker is not an encrypted volume.
WIN_ENCRYPTED=""
blkid() { printf '/dev/sdc1: LABEL="BitLocker Recovery Keys" TYPE="vfat"\n'; return 0; }
LOCK_ROWS=""; check_bitlocker
check "a label is not a volume type -> PASS" PASS "$(row_status bitlocker)"
unset -f blkid; eval "$_saved_has5"; WIN_ENCRYPTED=""

echo
echo "== an unreadable hive must not read as 'no Autopilot traces' =="
# A real machine, known to the owner to be Autopilot-registered, reported "No
# local Autopilot traces" while the MDM row on the SAME audit said the SOFTWARE
# hive could not be walked. The four hivexget reads return empty both when a
# value is absent and when the hive will not open, so "we looked and found
# nothing" was printed for a machine nothing had been read from.
_saved_locate3=$(declare -f lock_locate_hives)
_saved_has3=$(declare -f lock_has)
_saved_get3=$(declare -f lock_hive_get)
mkdir -p "$FIX"; echo x > "$FIX/sw2"
lock_locate_hives() { WIN_SOFTWARE="$FIX/sw2"; WIN_SYSTEM="$FIX/sw2"; return 0; }
lock_has() { return 0; }

# Every read fails, exactly as an unopenable hive behaves.
lock_hive_get() { return 1; }
LOCK_ROWS=""; check_autopilot
check "unreadable hive -> UNKNOWN"          UNKNOWN "$(row_status autopilot)"
case "$(row_detail autopilot)" in
  *"could not be read"*) ok "says the hive could not be read" ;;
  *) bad "says the hive could not be read" "an unreadable-hive reason" "$(row_detail autopilot)" ;;
esac
case "$(row_detail autopilot)" in
  *"No local Autopilot traces"*) bad "must not claim it looked" "no such claim" "$(row_detail autopilot)" ;;
  *) ok "does not claim it looked and found nothing" ;;
esac

# The hive opens (ProductName reads) but carries no Autopilot keys: the
# "no local traces" wording is correct here and must survive.
lock_hive_get() {
  case "$3" in ProductName) printf 'Windows 11 Pro'; return 0 ;; *) return 1 ;; esac
}
LOCK_ROWS=""; check_autopilot
check "readable hive, no traces -> UNKNOWN" UNKNOWN "$(row_status autopilot)"
case "$(row_detail autopilot)" in
  *"No local Autopilot traces"*) ok "a readable hive still says no local traces" ;;
  *) bad "a readable hive still says no local traces" "the no-traces wording" "$(row_detail autopilot)" ;;
esac

eval "$_saved_get3"; eval "$_saved_has3"; eval "$_saved_locate3"

echo
echo "== an Entra-joined machine must never read as CLEAR =="
# The three ways check_entra used to answer PASS on a device that is bound to
# somebody's tenant. Each is a "we did not establish this" dressed up as "we
# established there is nothing" - the worst direction this file can be wrong in.
_saved_locate2=$(declare -f lock_locate_hives)
_saved_has2=$(declare -f lock_has)
_saved_haskey=$(declare -f lock_hive_haskey)
_saved_get=$(declare -f lock_hive_get)
mkdir -p "$FIX"; echo x > "$FIX/sys"
lock_locate_hives() { WIN_SOFTWARE="$FIX/sw"; WIN_SYSTEM="$FIX/sys"; return 0; }
lock_has() { return 0; }
# JoinInfo is PRESENT in every case below - it does not exist at all on a
# machine that was never joined, so its presence is the whole point.
lock_hive_haskey() { return 0; }
lock_hive_get() { printf ''; }          # no DNS domain suffix, so nothing else can save it

# 1. The regression that started this: the subkey is a certificate thumbprint,
#    not a GUID. The old code kept only ^[0-9a-f]{8}- and so saw nothing.
hivexsh() { printf 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n'; return 0; }
LOCK_ROWS=""; check_entra
check "non-GUID JoinInfo subkey -> LOCKED"  LOCKED "$(row_status entra)"

# 2. hivexsh fails (dirty or truncated hive). stderr was dropped, so an error
#    was indistinguishable from "no subkeys" and read as clear.
hivexsh() { return 2; }
LOCK_ROWS=""; check_entra
check "JoinInfo listing fails -> UNKNOWN"   UNKNOWN "$(row_status entra)"

# 3. The key is there but lists nothing. Odd, not reassuring.
hivexsh() { printf '\n'; return 0; }
LOCK_ROWS=""; check_entra
check "JoinInfo present but empty -> UNKNOWN" UNKNOWN "$(row_status entra)"

unset -f hivexsh
eval "$_saved_haskey"; eval "$_saved_get"; eval "$_saved_has2"; eval "$_saved_locate2"

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
echo "== WPBT naming Absolute in its UTF-16 arguments -> LOCKED =="
LOCK_ROWS=""
export LOCK_SYSROOT="$FIX/wpbt-abs"
mkdir -p "$LOCK_SYSROOT/sys/firmware/acpi/tables"
# "rpcnetp.exe" UTF-16LE = 22 bytes
build_wpbt "$LOCK_SYSROOT/sys/firmware/acpi/tables/WPBT" 22 \
  'r\000p\000c\000n\000e\000t\000p\000.\000e\000x\000e\000'
check_absolute
check "Absolute named in WPBT args -> LOCKED" LOCKED "$(row_status absolute)"
check "table is a legal size" 1 "$([ "$(wc -c < "$LOCK_SYSROOT/sys/firmware/acpi/tables/WPBT")" -ge 52 ] && echo 1 || echo 0)"

echo
echo "== a valid WPBT with NO arguments and an unreadable payload -> UNKNOWN =="
echo "   (the shape of a real Absolute install; must never read as clear)"
LOCK_ROWS=""
export LOCK_SYSROOT="$FIX/wpbt-noargs"
mkdir -p "$LOCK_SYSROOT/sys/firmware/acpi/tables"
build_wpbt "$LOCK_SYSROOT/sys/firmware/acpi/tables/WPBT" 0 ''
check_absolute
check "argument-free WPBT -> UNKNOWN"   UNKNOWN "$(row_status absolute)"
case "$(row_detail absolute)" in
  *"could not be read"*|*"could not be identified"*) ok "says what it could not do" ;;
  *) bad "says what it could not do" "an explanation" "$(row_detail absolute)" ;;
esac

echo
echo "== a WPBT from another vendor must not be called Absolute =="
LOCK_ROWS=""
export LOCK_SYSROOT="$FIX/wpbt-hp"
mkdir -p "$LOCK_SYSROOT/sys/firmware/acpi/tables"
build_wpbt "$LOCK_SYSROOT/sys/firmware/acpi/tables/WPBT" 20 \
  'H\000P\000S\000u\000r\000e\000S\000t\000a\000rt\000'
check_absolute
case "$(row_status absolute)" in
  LOCKED) bad "other vendor is not Absolute" "not LOCKED" "LOCKED" ;;
  *) ok "other vendor is not Absolute" ;;
esac

echo
echo "== a malformed (too short) WPBT -> UNKNOWN, never a verdict =="
LOCK_ROWS=""
export LOCK_SYSROOT="$FIX/wpbt-short"
mkdir -p "$LOCK_SYSROOT/sys/firmware/acpi/tables"
printf 'WPBT\044\000\000\000rpcnetp.exe' > "$LOCK_SYSROOT/sys/firmware/acpi/tables/WPBT"
check_absolute
check "short table -> UNKNOWN"          UNKNOWN "$(row_status absolute)"

echo
echo "== WPBT present but unreadable (mode 0400, non-root) -> UNKNOWN =="
LOCK_ROWS=""
export LOCK_SYSROOT="$FIX/wpbt-unread"
mkdir -p "$LOCK_SYSROOT/sys/firmware/acpi/tables/WPBT"   # a dir: exists, cannot be read as a file
check_absolute
check "unreadable WPBT -> not PASS" 0 "$([ "$(row_status absolute)" = "PASS" ] && echo 1 || echo 0)"


# ---------------------------------------------------------------------------
# Dell's actual Absolute / Computrace BIOS vocabulary.
#
# The first real hardware run reported DEVICE STATUS: LOCKED on an OptiPlex 5080
# because its Absolute attribute read "Enabled" and the code matched *enable*.
# Dell's documentation says the opposite of what that assumed:
#
#   "The Absolute Persistence Module Interface is Enabled. (This allows the
#    Absolute OS Activation Agent to Provision the platform and 'Activate' the
#    platform.)"  ... "Enabled does not mean that the feature is active"
#
# and Enable is the FACTORY DEFAULT on modern Dell business machines. The check
# would therefore have called almost every Dell locked — the false positive that
# gets a report ignored. Legacy Computrace is a different vocabulary in which
# "Activate" IS a real, permanent activation.
#
# One case per documented state, so the mapping cannot drift back.

# abs_state <dirname> <value> -> runs check_absolute against that attribute
abs_state() {
  LOCK_ROWS=""
  export LOCK_SYSROOT="$FIX/absfw-$1"
  mkdir -p "$LOCK_SYSROOT/sys/firmware/acpi/tables"
  mkdir -p "$LOCK_SYSROOT/sys/class/firmware-attributes/dell-wmi-sysman/attributes/$1"
  printf '%s' "$2" > "$LOCK_SYSROOT/sys/class/firmware-attributes/dell-wmi-sysman/attributes/$1/current_value"
  check_absolute
}

echo
echo "== Dell Absolute states: only a real activation is a lock =="

abs_state Absolute "Enabled"
check "Absolute 'Enabled' (factory default) is NOT a lock" PASS "$(row_status absolute)"
case "$(row_detail absolute)" in
  *"READY to be activated"*) ok "explains that enabled != active" ;;
  *) bad "explains that enabled != active" "mentions READY to be activated" "$(row_detail absolute)" ;;
esac

abs_state Absolute "Disabled"
check "Absolute 'Disabled'"                    PASS "$(row_status absolute)"

abs_state Absolute "Permanently Disabled"
check "Absolute 'Permanently Disabled'"        PASS "$(row_status absolute)"
case "$(row_detail absolute)" in
  *"never be activated"*) ok "notes it can never be activated" ;;
  *) bad "notes it can never be activated" "mentions never be activated" "$(row_detail absolute)" ;;
esac

echo
echo "== legacy Computrace vocabulary: Activate IS a lock, Deactivate is not =="

abs_state Computrace "Activate"
check "Computrace 'Activate' -> DETECTED"      DETECTED "$(row_status absolute)"

abs_state Computrace "Deactivate"
check "Computrace 'Deactivate' -> not locked"  PASS "$(row_status absolute)"

abs_state Computrace "Disable"
check "Computrace 'Disable' -> not locked"     PASS "$(row_status absolute)"

abs_state Absolute "Wibble"
check "an unrecognised value -> UNKNOWN"       UNKNOWN "$(row_status absolute)"

echo
echo "== a real agent in WPBT still outranks any BIOS setting =="
LOCK_ROWS=""
export LOCK_SYSROOT="$FIX/absfw-both"
mkdir -p "$LOCK_SYSROOT/sys/firmware/acpi/tables"
mkdir -p "$LOCK_SYSROOT/sys/class/firmware-attributes/dell-wmi-sysman/attributes/Absolute"
printf 'Enabled' > "$LOCK_SYSROOT/sys/class/firmware-attributes/dell-wmi-sysman/attributes/Absolute/current_value"
build_wpbt "$LOCK_SYSROOT/sys/firmware/acpi/tables/WPBT" 22 'r\000p\000c\000n\000e\000t\000p\000.\000e\000x\000e\000'
check_absolute
check "WPBT agent beats a benign BIOS value"   LOCKED "$(row_status absolute)"


# ---------------------------------------------------------------------------
# Windows Autopilot.
#
# The first hardware run reported DETECTED on a machine with no tenant, because
# the code treated the mere existence of Provisioning\AutopilotPolicyCache as a
# trace of enrolment. It is not. The JSON below was read out of the live
# registry of a personal Windows 11 machine that has never been near Intune:
# every Windows install that reaches OOBE with a network gets one, along with
# correlation ids and the static Provisioning\AutopilotSettings key. Flagging
# those meant flagging clean consumer hardware.
#
# Read properly, the same key holds the one positive answer available offline:
# ProfileAvailable records what Microsoft's service said about this hardware.

CLEAN_JSON='{"AutopilotCreationDate":"2025-09-18T19:55:09Z","AutopilotUpdateTimeout":1800000,"AutopilotCorrelationVector":"V0JTVGdFa0aLYNJr.0","CloudAssignedAadServerData":"{\"ZeroTouchConfig\":{\"CloudAssignedTenantDomain\":\"\",\"CloudAssignedTenantUpn\":\"\",\"ForcedEnrollment\":0}}"}'
ORG_JSON='{"AutopilotCreationDate":"2026-02-11T08:14:00Z","CloudAssignedAadServerData":"{\"ZeroTouchConfig\":{\"CloudAssignedTenantDomain\":\"contoso.onmicrosoft.com\",\"ForcedEnrollment\":1}}"}'

verdict() { LOCK_ROWS=""; _autopilot_verdict "$1" "$2" "$3" "$4"; }

echo
echo "== Autopilot: an unenrolled machine's own policy cache is not evidence =="

verdict "" "" "$CLEAN_JSON" "0"
check "real clean-machine cache -> UNKNOWN"     UNKNOWN "$(row_status autopilot)"
case "$(row_detail autopilot)" in
  *Upn*) bad "empty domain not misread as the next key" "no CloudAssignedTenantUpn" "$(row_detail autopilot)" ;;
  *) ok "empty domain not misread as the next key" ;;
esac
case "$(row_detail autopilot)" in
  *2025-09-18T19:55:09Z*) ok "reports when the service answered" ;;
  *) bad "reports when the service answered" "the cache date" "$(row_detail autopilot)" ;;
esac

verdict "" "" "$CLEAN_JSON" "0x0"
check "hex zero reads as zero too"              UNKNOWN "$(row_status autopilot)"

echo
echo "== Autopilot: a real registration =="

verdict "" "" "$CLEAN_JSON" "1"
check "profile assigned -> LOCKED"              LOCKED "$(row_status autopilot)"

verdict "" "" "$ORG_JSON" "1"
check "tenant in the cached policy -> LOCKED"   LOCKED "$(row_status autopilot)"
case "$(row_detail autopilot)" in
  *contoso.onmicrosoft.com*) ok "names the owning tenant" ;;
  *) bad "names the owning tenant" "contoso.onmicrosoft.com" "$(row_detail autopilot)" ;;
esac

verdict "fabrikam.com" "" "" ""
check "tenant in the registry -> LOCKED"        LOCKED "$(row_status autopilot)"
verdict "" "6babcaad-1111-2222-3333-444455556666" "" ""
check "bare tenant id -> LOCKED"                LOCKED "$(row_status autopilot)"

echo
echo "== Autopilot: no answer is UNKNOWN, never DETECTED =="

verdict "" "" '{"AutopilotUpdateTimeout":1800000}' ""
check "cache with no result -> UNKNOWN"         UNKNOWN "$(row_status autopilot)"

verdict "" "" "" ""
check "nothing at all -> UNKNOWN"               UNKNOWN "$(row_status autopilot)"
case "$(row_detail autopilot)" in
  *"does NOT mean the device is unregistered"*) ok "says silence is not a clean bill of health" ;;
  *) bad "says silence is not a clean bill of health" "the cloud-state caveat" "$(row_detail autopilot)" ;;
esac


# ---------------------------------------------------------------------------
# Intune / MDM enrolment.
#
# This check was reporting "No MDM enrolment found" on every machine it had
# ever run against, and the cause was one character. The subkey listing was
# built as printf 'cd Microsoft\Enrollments\nls\n' - and printf reads \E as
# ESC, so hivexsh was asked to cd to "Microsoft<0x1b>nrollments", which fails
# silently. A second bug behind it: "Microsoft\Enrollments\$g" inside double
# quotes is an ESCAPED dollar, so the GUID never substituted either.
#
# Fixing that alone would have been worse than the bug. A stock Windows 11
# install carries around thirty GUID subkeys under Enrollments, and three of
# them have a ProviderID - the names below are read from a real personal
# machine that has never been managed. Counting any ProviderID as an enrolment
# would report LOCKED on every Windows device in existence. Only a
# DiscoveryServiceFullURL - an actual management server - makes it real.

echo
echo "== MDM: built-in authorities are not enrolments =="

for a in "Local Authority" "Cloud Authority" "Deploy Authority"; do
  got=$(_mdm_provider "$a" "")
  if [ -z "$got" ]; then ok "'$a' with no server URL is ignored"
  else bad "'$a' with no server URL is ignored" "" "$got"; fi
done

check "Intune is named from its URL" "Microsoft Intune" \
  "$(_mdm_provider 'MS DM Server' 'https://enrollment.manage.microsoft.com/enrollmentserver/discovery.svc')"
check "a third-party MDM keeps its provider id" "AirWatch" \
  "$(_mdm_provider 'AirWatch' 'https://ds1.awmdm.com/deviceservices/discovery.aws')"
check "an unnamed provider still counts" "unidentified MDM" \
  "$(_mdm_provider '' 'https://mdm.example.org/discovery.svc')"

echo
echo "== MDM verdicts =="

LOCK_ROWS=""; _mdm_verdict "" ""
check "no management server -> PASS"      PASS   "$(row_status mdm)"
case "$(row_detail mdm)" in
  *"not enrolments"*) ok "says why the built-in entries were ignored" ;;
  *) bad "says why the built-in entries were ignored" "an explanation" "$(row_detail mdm)" ;;
esac

LOCK_ROWS=""; _mdm_verdict "Microsoft Intune" "contoso.com"
check "a real enrolment -> LOCKED"        LOCKED "$(row_status mdm)"
case "$(row_detail mdm)" in
  *contoso.com*) ok "records the owning organisation" ;;
  *) bad "records the owning organisation" "contoso.com" "$(row_detail mdm)" ;;
esac

# The organisation is recorded, the individual is not.
LOCK_ROWS=""; upn='jane.doe@contoso.com'; _mdm_verdict "Microsoft Intune" "${upn##*@}"
case "$(row_detail mdm)" in
  *jane.doe*) bad "never records the previous user" "no local part" "$(row_detail mdm)" ;;
  *) ok "never records the previous user" ;;
esac


# ---------------------------------------------------------------------------
# ENTRA ID AND ACTIVE DIRECTORY, split into two checks.
#
# They used to be one row keyed "entra", which forced one verdict, one
# confidence and one sentence onto two findings that are not alike. An offline
# "Entra joined" can be confirmed but never withdrawn - only the tenant can say
# it has released the device. An offline "no AD evidence" is close to a real
# negative, because domain membership is written on the machine itself. One row
# could not say both things, so it said neither.
#
# A FAKE OFFLINE REGISTRY. The positive paths below cannot be exercised on the
# bench: nobody is going to domain-join a machine to test a test. So the hive
# readers are stubbed from a table, and each fixture reads like the machine it
# describes instead of like a pile of stubs. What this CANNOT prove is that the
# real hivex returns what the table says it does - see the note on
# lock_hive_get_default in lock-checks.sh.

_saved_locate3=$(declare -f lock_locate_hives)
_saved_has3=$(declare -f lock_has)
_saved_haskey3=$(declare -f lock_hive_haskey)
_saved_get3=$(declare -f lock_hive_get)
_saved_getdef3=$(declare -f lock_hive_get_default)
_saved_nl3=$(declare -f _lock_cached_logons)

mkdir -p "$FIX"; echo x > "$FIX/sw"; echo x > "$FIX/sys"; echo x > "$FIX/sec"

FAKE_KEYS=""; FAKE_VALS=""; FAKE_DEFS=""; FAKE_LS=""; FAKE_NL=0

# Which hive a path refers to, so fixtures can talk about SECURITY rather than
# about "$FIX/sec".
_hname() {
  case "$1" in
    */sec) printf SECURITY ;; */sw) printf SOFTWARE ;; */sys) printf SYSTEM ;;
    *) printf NONE ;;
  esac
}
fake_reset() { FAKE_KEYS=""; FAKE_VALS=""; FAKE_DEFS=""; FAKE_LS=""; FAKE_NL=0; LOCK_ROWS=""
                WIN_SOFTWARE="$FIX/sw"; WIN_SYSTEM="$FIX/sys"; WIN_SECURITY="$FIX/sec"; }
fake_key()  { FAKE_KEYS="$FAKE_KEYS
$1|$2"; }
fake_val()  { FAKE_VALS="$FAKE_VALS
$1|$2|$3|$4"; }
fake_def()  { FAKE_DEFS="$FAKE_DEFS
$1|$2|$3"; }
fake_ls()   { FAKE_LS="$1"; }

lock_locate_hives() { return 0; }
lock_has() { return 0; }
lock_hive_haskey() { printf '%s\n' "$FAKE_KEYS" | grep -Fxq "$(_hname "$1")|$2"; }
lock_hive_get() {
  local line
  line=$(printf '%s\n' "$FAKE_VALS" | grep -F "$(_hname "$1")|$2|$3|" | head -1)
  [ -n "$line" ] || return 1
  printf '%s' "${line#*|*|*|}"
}
lock_hive_get_default() {
  local line
  line=$(printf '%s\n' "$FAKE_DEFS" | grep -F "$(_hname "$1")|$2|" | head -1)
  [ -n "$line" ] || return 1
  printf '%s' "${line#*|*|}"
}
_lock_cached_logons() { printf '%s' "$FAKE_NL"; }
# Both checks list subkeys by piping a cd/ls script into hivexsh.
hivexsh() { cat >/dev/null; [ -n "$FAKE_LS" ] || return 0; printf '%s\n' "$FAKE_LS"; }

CDJ='ControlSet001\Control\CloudDomainJoin'
JI="$CDJ"'\JoinInfo'
GP='Microsoft\Windows\CurrentVersion\Group Policy'

echo
echo "== the combined check is now two rows, not one =="
case "$LOCK_DETECTORS" in
  *check_domain*) ok "check_domain is registered in LOCK_DETECTORS" ;;
  *) bad "check_domain is registered in LOCK_DETECTORS" "listed" "$LOCK_DETECTORS" ;;
esac
fake_reset; check_entra; check_domain
check "the Entra row keeps the key 'entra'" 1 "$(printf '%s' "$LOCK_ROWS" | grep -c '^entra|')"
check "the AD row has its own key 'domainJoin'" 1 "$(printf '%s' "$LOCK_ROWS" | grep -c '^domainJoin|')"
check "Entra row is labelled for Entra only" "Microsoft Entra ID join" \
  "$(printf '%s' "$LOCK_ROWS" | grep '^entra|' | cut -d'|' -f2)"
check "AD row is labelled for AD only" "Active Directory domain join" \
  "$(printf '%s' "$LOCK_ROWS" | grep '^domainJoin|' | cut -d'|' -f2)"

echo
echo "== Entra: the tenant is named, and the former employee never is =="
fake_reset
fake_key SYSTEM "$JI"
fake_ls 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
fake_val SYSTEM "$JI"'\a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' TenantId '6babcaad-1111-2222-3333-444455556666'
fake_val SYSTEM "$JI"'\a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' TenantDisplayName 'Contoso Ltd'
fake_val SYSTEM "$JI"'\a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' IdpDomain 'contoso.onmicrosoft.com'
fake_val SYSTEM "$JI"'\a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' DeviceId 'd7f4e2a0-9c31-4b55-8e0a-1122334455aa'
# Sitting right next to the fields above in the real key, and never read.
fake_val SYSTEM "$JI"'\a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' UserEmail 'jane.doe@contoso.com'
fake_val SYSTEM "$CDJ"'\TenantInfo\6babcaad-1111-2222-3333-444455556666' MdmEnrollmentUrl 'https://enrollment.manage.microsoft.com/enrollmentserver/discovery.svc'
check_entra
check "an Entra join -> LOCKED" LOCKED "$(row_status entra)"
case "$(row_detail entra)" in
  *"Contoso Ltd"*) ok "names WHICH organisation owns the device" ;;
  *) bad "names WHICH organisation owns the device" "Contoso Ltd" "$(row_detail entra)" ;;
esac
case "$(row_detail entra)" in
  *6babcaad-1111-2222-3333-444455556666*) ok "records the tenant id, which is the proof" ;;
  *) bad "records the tenant id, which is the proof" "the tenant id" "$(row_detail entra)" ;;
esac
case "$(row_detail entra)" in
  *d7f4e2a0-9c31-4b55-8e0a-1122334455aa*) ok "records the device id an admin needs to deregister" ;;
  *) bad "records the device id an admin needs to deregister" "the device id" "$(row_detail entra)" ;;
esac
case "$(row_detail entra)" in
  *enrollment.manage.microsoft.com*) ok "TenantInfo corroborates the join" ;;
  *) bad "TenantInfo corroborates the join" "the MDM enrolment url" "$(row_detail entra)" ;;
esac
# PRIVACY. This audit is exported and emailed; a former employee's address is
# nobody's business here. Assert against the WHOLE record set, not one field.
case "$LOCK_ROWS" in
  *jane.doe*|*UserEmail*) bad "UserEmail never reaches any row" "no trace of it" "$LOCK_ROWS" ;;
  *) ok "UserEmail never reaches any row" ;;
esac
case "$(row_detail entra)" in
  *"never be downgraded"*|*"never downgraded"*|*"can be confirmed but never downgraded"*)
    ok "says an offline Entra join can never be downgraded" ;;
  *) bad "says an offline Entra join can never be downgraded" "the tenant-only caveat" "$(row_detail entra)" ;;
esac

echo
echo "== Entra: a join proved but not named is still a lock =="
fake_reset
fake_key SYSTEM "$JI"
fake_ls '{d7f4e2a0-9c31-4b55-8e0a-1122334455aa}'
check_entra
check "JoinInfo with unreadable tenant -> still LOCKED" LOCKED "$(row_status entra)"

echo
echo "== Entra: no JoinInfo key is 'not joined', which is not 'released' =="
fake_reset
check_entra
check "no JoinInfo -> PASS" PASS "$(row_status entra)"
case "$(row_detail entra)" in
  *"not the same as released"*) ok "will not call an absent join a release" ;;
  *) bad "will not call an absent join a release" "the released caveat" "$(row_detail entra)" ;;
esac
case "$(row_detail entra)" in
  *"transaction logs"*) ok "warns that unflushed hives can hide a recent join" ;;
  *) bad "warns that unflushed hives can hide a recent join" "the transaction-log caveat" "$(row_detail entra)" ;;
esac


# ---------------------------------------------------------------------------
# ACTIVE DIRECTORY.
#
# Every negative below is a TRAP verified on a clean, never-joined Windows 11:
# the key is THERE on every machine, and only the CONTENT of a value tells the
# two apart. A check written against key presence reports a domain join on
# every device that has ever been switched on.

echo
echo "== AD: a domain-joined machine, proved from the SECURITY hive =="
fake_reset
fake_key SECURITY 'Policy'
fake_key SECURITY 'Policy\PolPrDmS'
fake_key SECURITY 'Policy\Secrets\$MACHINE.ACC'
fake_def SECURITY 'Policy\PolPrDmN' 'CONTOSO'
fake_def SECURITY 'Policy\PolDnDDN' 'contoso.local'
FAKE_NL=3
fake_val SYSTEM 'ControlSet001\Services\Netlogon\Parameters' DynamicSiteName 'Default-First-Site-Name'
check_domain
check "domain join proved from SECURITY -> LOCKED" LOCKED "$(row_status domainJoin)"
case "$(row_detail domainJoin)" in
  *contoso.local*) ok "names the domain" ;;
  *) bad "names the domain" "contoso.local" "$(row_detail domainJoin)" ;;
esac
case "$(row_detail domainJoin)" in
  *PolPrDmS*) ok "cites the primary domain SID as the proof" ;;
  *) bad "cites the primary domain SID as the proof" "PolPrDmS" "$(row_detail domainJoin)" ;;
esac
case "$(row_detail domainJoin)" in
  *"cached domain logon"*) ok "counts cached domain logons" ;;
  *) bad "counts cached domain logons" "the cached logons" "$(row_detail domainJoin)" ;;
esac
case "$(row_detail domainJoin)" in
  *"transaction logs"*) ok "AD row carries the unflushed-hive caveat too" ;;
  *) bad "AD row carries the unflushed-hive caveat too" "the caveat" "$(row_detail domainJoin)" ;;
esac
check "a domain join flips the device verdict" LOCKED "$(lock_status)"

echo
echo "== AD: a clean machine reads as a real negative, not as silence =="
fake_reset
fake_key SECURITY 'Policy'
# Every trap, all at once, exactly as a never-joined Windows 11 presents them.
fake_ls '{35378EAC-683F-11D2-A89A-00C04FBBCFA2}'
fake_val SOFTWARE "$GP"'\History\{35378EAC-683F-11D2-A89A-00C04FBBCFA2}\0' DSPath 'LocalGPO'
fake_val SOFTWARE "$GP"'\State\Machine' Distinguished-Name ''
fake_val SYSTEM 'ControlSet001\Services\Netlogon\Parameters' DisablePasswordChange '0'
fake_val SYSTEM 'ControlSet001\Services\Tcpip\Parameters' Domain ''
check_domain
check "a clean machine -> PASS" PASS "$(row_status domainJoin)"
case "$(row_detail domainJoin)" in
  *"close to a real negative"*) ok "words the AD negative as the stronger one" ;;
  *) bad "words the AD negative as the stronger one" "the local-state reasoning" "$(row_detail domainJoin)" ;;
esac

echo
echo "== AD traps: the key is there on EVERY machine; only the value decides =="

fake_reset; fake_key SECURITY 'Policy'
fake_ls '{35378EAC-683F-11D2-A89A-00C04FBBCFA2}'
fake_val SOFTWARE "$GP"'\History\{35378EAC-683F-11D2-A89A-00C04FBBCFA2}\0' DSPath 'LocalGPO'
check_domain
check "DSPath=LocalGPO is NOT a domain join" PASS "$(row_status domainJoin)"

fake_reset; fake_key SECURITY 'Policy'
fake_ls '{35378EAC-683F-11D2-A89A-00C04FBBCFA2}'
fake_val SOFTWARE "$GP"'\History\{35378EAC-683F-11D2-A89A-00C04FBBCFA2}\0' DSPath 'LDAP://cn={31B2F340-016D-11D2-945F-00C04FB984F9},cn=policies,cn=system,DC=contoso,DC=com'
check_domain
check "DSPath=LDAP:// IS evidence" DETECTED "$(row_status domainJoin)"
case "$(row_detail domainJoin)" in
  *contoso.com*) ok "reads the domain out of the LDAP distinguished name" ;;
  *) bad "reads the domain out of the LDAP distinguished name" "contoso.com" "$(row_detail domainJoin)" ;;
esac

fake_reset; fake_key SECURITY 'Policy'
fake_val SOFTWARE "$GP"'\State\Machine' Distinguished-Name '   '
check_domain
check "an empty Distinguished-Name is NOT a domain join" PASS "$(row_status domainJoin)"

fake_reset; fake_key SECURITY 'Policy'
fake_val SOFTWARE "$GP"'\State\Machine' Distinguished-Name 'CN=PC-01,OU=Workstations,DC=fabrikam,DC=com'
check_domain
check "a populated Distinguished-Name IS evidence" DETECTED "$(row_status domainJoin)"

fake_reset; fake_key SECURITY 'Policy'
# Netlogon\Parameters exists on every Windows. DynamicSiteName is the value that
# is absent until the machine has actually reached a domain controller.
fake_key SYSTEM 'ControlSet001\Services\Netlogon\Parameters'
fake_val SYSTEM 'ControlSet001\Services\Netlogon\Parameters' DisablePasswordChange '0'
check_domain
check "Netlogon\\Parameters without DynamicSiteName is NOT a join" PASS "$(row_status domainJoin)"

fake_reset; fake_key SECURITY 'Policy'
fake_val SYSTEM 'ControlSet001\Services\Netlogon\Parameters' DynamicSiteName 'London-Site'
check_domain
check "DynamicSiteName IS evidence" DETECTED "$(row_status domainJoin)"

fake_reset; fake_key SECURITY 'Policy'
fake_val SYSTEM 'ControlSet001\Services\Tcpip\Parameters' Domain 'corp.example.com'
check_domain
check "a DNS suffix alone is an indicator, not a join" DETECTED "$(row_status domainJoin)"
check "and it is low confidence" low "$(printf '%s' "$LOCK_ROWS" | grep '^domainJoin|' | cut -d'|' -f6)"
case "$(row_detail domainJoin)" in
  *"not proof"*) ok "says the DNS suffix is not proof" ;;
  *) bad "says the DNS suffix is not proof" "the indicator wording" "$(row_detail domainJoin)" ;;
esac

echo
echo "== AD: SECURITY unreadable must never become a clean bill of health =="
fake_reset
# The probe key cannot be walked, so nothing under Policy was ever read. The
# SOFTWARE and SYSTEM hives are quiet - and a quiet SOFTWARE is not an answer
# about a record that lives in SECURITY.
check_domain
check "unwalkable SECURITY -> UNKNOWN" UNKNOWN "$(row_status domainJoin)"
case "$(row_detail domainJoin)" in
  *"must not be read as clear"*) ok "says plainly that this is not a negative" ;;
  *) bad "says plainly that this is not a negative" "the not-clear wording" "$(row_detail domainJoin)" ;;
esac
check "and the device is UNVERIFIED, not CLEAR" UNVERIFIED "$(lock_status)"

fake_reset; WIN_SECURITY=""
fake_val SYSTEM 'ControlSet001\Services\Netlogon\Parameters' DynamicSiteName 'London-Site'
check_domain
check "no SECURITY hive but real traces -> DETECTED, not LOCKED" DETECTED "$(row_status domainJoin)"

echo
echo "== AD: one uncorroborated key presence is not enough to call a device locked =="
fake_reset
fake_key SECURITY 'Policy'
fake_key SECURITY 'Policy\PolPrDmS'
check_domain
check "PolPrDmS alone -> DETECTED, not LOCKED" DETECTED "$(row_status domainJoin)"

echo
echo "== AD: a computer account secret is proof of HAVING been joined =="
fake_reset
fake_key SECURITY 'Policy'
fake_key SECURITY 'Policy\Secrets\$MACHINE.ACC'
check_domain
check '$MACHINE.ACC alone -> DETECTED' DETECTED "$(row_status domainJoin)"
case "$(row_detail domainJoin)" in
  *"has been joined"*) ok "worded as having been joined, not as being joined" ;;
  *) bad "worded as having been joined, not as being joined" "past tense" "$(row_detail domainJoin)" ;;
esac


# ---------------------------------------------------------------------------
echo
echo "== the control set is resolved, not assumed =="
# SYSTEM\Select\Current names the live control set. It is 1 on nearly every
# machine and 2 after a Last Known Good boot, and reading a stale set returns
# nothing from every lookup - which is how "found nothing" would have become
# PASS on a managed machine.
fake_reset
fake_val SYSTEM 'Select' Current '2'
fake_key SYSTEM 'ControlSet002'
fake_key SECURITY 'Policy'
fake_val SYSTEM 'ControlSet002\Services\Netlogon\Parameters' DynamicSiteName 'Leeds-Site'
check_domain
check "Select\\Current=2 sends the reads to ControlSet002" DETECTED "$(row_status domainJoin)"
case "$(row_detail domainJoin)" in
  *Leeds-Site*) ok "read the value out of the live control set" ;;
  *) bad "read the value out of the live control set" "Leeds-Site" "$(row_detail domainJoin)" ;;
esac

fake_reset
# Select\Current names a set that is not in the hive. Fall back to the set this
# file has always used rather than sending every read into nothing.
fake_val SYSTEM 'Select' Current '7'
fake_key SECURITY 'Policy'
fake_val SYSTEM 'ControlSet001\Services\Netlogon\Parameters' DynamicSiteName 'Default-First-Site-Name'
check_domain
check "a control set that is not there falls back to 001" DETECTED "$(row_status domainJoin)"

eval "$_saved_nl3"; eval "$_saved_getdef3"; eval "$_saved_get3"
eval "$_saved_haskey3"; eval "$_saved_has3"; eval "$_saved_locate3"
unset -f hivexsh


# ---------------------------------------------------------------------------
echo
echo "== reading the LSA blobs: NUL bytes and header junk =="
# The primary-domain values are binary - a short header, then the name in
# UTF-16LE, so every other byte is 00. Bash command substitution throws NUL
# bytes away WITHOUT SAYING SO, so the strip has to happen inside the pipeline
# or the name comes back mangled and nobody finds out until a real machine.
WIN_SECURITY="$FIX/sec"
hivexsh() { cat >/dev/null; printf 'C\000O\000N\000T\000O\000S\000O\000'; }
got=$(lock_hive_get_default "$FIX/sec" 'Policy\PolPrDmN')
check "NULs are stripped inside the pipeline" "CONTOSO" "$got"
unset -f hivexsh

# The NULs are already gone by the time _lock_lsa_name sees the blob (the reader
# above strips them inside the pipeline), so this fixture is the header junk
# that survives that strip.
check "a name is pulled out of the header junk" "contoso.local" \
  "$(_lock_lsa_name "$(printf '\001\030\002contoso.local')")"
check "an unreadable blob names nothing rather than guessing" "" \
  "$(_lock_lsa_name "$(printf '\001\002\003')")"
# THE ONE THAT REACHED A CUSTOMER'S RECORD: hivex prints a REG_BINARY as
# "hex:04,00,63,00,..." and the extractor stripped everything that was not a
# letter, leaving the candidate "hex". A real machine's audit said, in as many
# words, "domain hex". Not a failed read reported as an absence - a value
# nobody decoded, reported as a fact about the customer's machine.
check "a REG_BINARY name is DECODED, not read as the word hex" "CONTOSO" \
  "$(_lock_lsa_name 'hex:04,00,00,00,43,00,4f,00,4e,00,54,00,4f,00,53,00,4f,00')"
check "a dotted name survives the UTF-16 decode" "corp.contoso.com" \
  "$(_lock_lsa_name 'hex:63,00,6f,00,72,00,70,00,2e,00,63,00,6f,00,6e,00,74,00,6f,00,73,00,6f,00,2e,00,63,00,6f,00,6d,00')"
check "a binary blob with no text in it names nothing" "" \
  "$(_lock_lsa_name 'hex:01,02,03,04')"
check "the word hex is never a domain name on its own" "" \
  "$(_lock_lsa_name 'hex:')"
check "a truncated byte is dropped, not turned into a character" "AB" \
  "$(_lock_lsa_name 'hex:41,00,42,00,4')"
check "plain ASCII in a hex blob still reads" "WORKGROUP" \
  "$(_lock_lsa_name 'hex:57,4f,52,4b,47,52,4f,55,50')"
check "DC= components become a domain name" "contoso.com" \
  "$(_lock_dn_domain 'cn={31B2F340-016D-11D2-945F-00C04FB984F9},cn=policies,cn=system,DC=contoso,DC=com')"

# A cached-logon slot is counted on the content it holds, never decrypted. An
# unused slot is zero-filled, so the NUL strip in _lock_nl_bytes empties it; a
# real cached credential is a couple of hundred bytes of ciphertext.
_saved_has4=$(declare -f lock_has)
lock_has() { return 0; }                # pretend hivexget is installed
_lock_nl_bytes() { case "$1" in 'NL$1'|'NL$2') printf '176' ;; *) printf '0' ;; esac; }
check "only slots holding real material are counted" 2 "$(_lock_cached_logons)"
_lock_nl_bytes() { printf '0'; }        # every slot is padding
check "empty slots are not counted"     0 "$(_lock_cached_logons)"
unset -f _lock_nl_bytes
eval "$_saved_has4"
# Without hivexget there is no count to make, and a count that did not happen
# must not read as "no cached logons" - it reports nothing and says so by
# failing, which leaves check_domain's other evidence to speak.
_lock_nl_bytes() { printf '176'; }
check "no hivexget -> the count does not happen" 1 \
  "$(_lock_cached_logons >/dev/null; echo $?)"
unset -f _lock_nl_bytes

echo
echo "== a Windows that would not open is not a disk with no Windows on it =="
# All three of these failures arrived as the same sentence: "No readable
# Windows installation found on the internal disks". The verdict was UNKNOWN in
# each case, so nothing was certified wrongly - but two of the three are facts
# about the STATION, and the operator was sent to look at a blank disk when the
# machine in front of them had an intact Windows on it that would not mount.
# The commonest by far is a Windows left hibernated or shut down with fast
# startup on: ntfs-3g refuses an unclean volume rather than risk the data.
_saved_mount=$(declare -f lock_mount_windows)
_saved_has5=$(declare -f lock_has)
_saved_root="${LOCK_IS_ROOT:-0}"
# Two gates stand in front of the branch under test - not root, and no hivexget
# - and each files a row of its own. Both are opened here so a pass cannot come
# from the wrong sentence.
LOCK_IS_ROOT=1
lock_has() { return 0; }
lock_mount_windows() { return 1; }

_win_why_case() {
  LOCK_ROWS=""; WIN_MNT=""; WIN_SOFTWARE=""; WIN_ENCRYPTED=""; WIN_MOUNT_WHY="$1"
  lock_win_blocked probe "Probe" >/dev/null
  printf '%s' "$LOCK_ROWS" | cut -d'|' -f4
}

# The harness itself, proved before it is trusted: with both gates open and no
# reason recorded, the row must be the "no Windows partition" one.
check "the mount-reason harness reaches the branch under test" 1 \
  "$(_win_why_case "" | grep -c 'No readable Windows installation found')"

D=$(_win_why_case "a Windows (NTFS) volume is present on /dev/sda2 but could not be opened — check that ntfs-3g is on the stick and that Windows was shut down rather than hibernated (fast startup), then re-run the audit")
check "a volume that would not mount is never 'no Windows found'" "" \
  "$(printf '%s' "$D" | grep -o 'No readable Windows installation found')"
check "it names the volume that was there" 1 \
  "$(printf '%s' "$D" | grep -c '/dev/sda2')"
check "it names hibernation, the usual cause" 1 \
  "$(printf '%s' "$D" | grep -c 'hibernated')"

D=$(_win_why_case "lsblk is not on this live image, so the machine's volumes could not even be listed")
check "a station that could not list the volumes says so, not 'no Windows'" "" \
  "$(printf '%s' "$D" | grep -o 'No readable Windows installation found')"
check "and it blames the live image, not the disk" 1 \
  "$(printf '%s' "$D" | grep -c 'live image')"

# The one case that IS a fact about the disk keeps its own words.
D=$(_win_why_case "")
check "a disk with genuinely no Windows still says so" 1 \
  "$(printf '%s' "$D" | grep -c 'No readable Windows installation found')"

# Encryption still outranks the rest: it is the most specific answer available.
LOCK_ROWS=""; WIN_MNT=""; WIN_SOFTWARE=""; WIN_ENCRYPTED=1
WIN_MOUNT_WHY="a Windows (NTFS) volume is present on /dev/sda2 but could not be opened"
lock_win_blocked probe "Probe" >/dev/null
check "a BitLocker volume is still reported as encrypted" 1 \
  "$(printf '%s' "$LOCK_ROWS" | cut -d'|' -f4 | grep -c 'BitLocker')"
eval "$_saved_mount"
eval "$_saved_has5"
LOCK_IS_ROOT="$_saved_root"
WIN_ENCRYPTED=""; WIN_MOUNT_WHY=""

echo
echo "== a record with nothing in it is not a machine that passed =="
# lock_status' own comment says CLEAR means every check ran and every one came
# back negative. It never checked that any had: with no rows at all, the three
# greps found nothing to object to and it fell through to CLEAR, which reaches
# the certificate as "No lock detected" - the most reassuring sentence on the
# document, produced by looking at nothing.
LOCK_ROWS=""
check "no rows at all is UNVERIFIED, never CLEAR" UNVERIFIED "$(lock_status)"
# And one row that passed is still a real answer.
lock_add tpm "TPM" PASS "No TPM exposed" "/sys/class/tpm" medium
check "a real PASS row is still CLEAR"             CLEAR      "$(lock_status)"

echo "== a detector that files no row is a check that did not happen =="
# Every detector either finds something or files a negative. One that returns
# success having filed nothing has answered no question at all, and the row it
# never wrote cannot be told apart from a clean result - so run_lock_checks
# files the UNKNOWN on its behalf. An early `return 0` down any branch of any
# detector is all this takes, which is why it is caught rather than trusted.
_saved_detectors="$LOCK_DETECTORS"
check_silent()  { return 0; }
check_speaks()  { lock_add speaks "Speaks" PASS "looked, found nothing" "test" high; return 0; }
LOCK_DETECTORS="check_speaks check_silent"
lock_unmount_windows() { :; }
run_lock_checks
check "the silent detector left an UNKNOWN row"   UNKNOWN "$(row_status silent)"
check "the one that spoke kept its own answer"    PASS    "$(row_status speaks)"
check "and the device is UNVERIFIED, not CLEAR"   UNVERIFIED "$(lock_status)"
check "the UNKNOWN says the check filed no result" 1 \
  "$(printf '%s' "$LOCK_ROWS" | grep -c 'filed no result')"

# A detector that FAILS and files nothing still gets exactly one row, not two.
check_broken() { return 3; }
LOCK_DETECTORS="check_broken"
run_lock_checks
check "a crashing detector still makes exactly one row" 1 \
  "$(printf '%s' "$LOCK_ROWS" | grep -c '.')"
check "and it is an UNKNOWN"                      UNKNOWN "$(row_status broken)"
LOCK_DETECTORS="$_saved_detectors"

echo
echo "== _ap_field must read JSON as it is actually written =="
# The separator class was quote/colon/backslash only, so it matched a compact
# blob and missed a pretty-printed one - which is how Microsoft writes these
# files. A registered machine whose profile had a space after the colon yielded
# no tenant, and the verdict reported it as unverifiable. This bit the REGISTRY
# path too (PolicyJsonCache), not just the files, so it is pinned on its own.
check "compact JSON"            "contoso.com" "$(_ap_field CloudAssignedTenantDomain '{"CloudAssignedTenantDomain":"contoso.com"}')"
check "a space after the colon" "contoso.com" "$(_ap_field CloudAssignedTenantDomain '{"CloudAssignedTenantDomain": "contoso.com"}')"
check "indented and wrapped"    "contoso.com" "$(_ap_field CloudAssignedTenantDomain '{
    "CloudAssignedTenantDomain":   "contoso.com",
    "Other": 1 }')"
check "a tab after the colon"   "contoso.com" "$(printf '%s' '{"CloudAssignedTenantDomain":	"contoso.com"}' | { read -r l; _ap_field CloudAssignedTenantDomain "$l"; })"
check "an empty value names nothing" "" "$(_ap_field CloudAssignedTenantDomain '{"CloudAssignedTenantDomain": ""}')"
check "a missing field names nothing" "" "$(_ap_field CloudAssignedTenantDomain '{"Something": "else"}')"

echo
echo "== the Autopilot profile FILES, on the volume already mounted =="
# The check read two registry keys on a volume it had already mounted, and
# ignored the profile Microsoft's own ZTD service had written to disk. A device
# registered by the "existing devices" route keeps its whole identity in
# Provisioning\Autopilot\AutopilotConfigurationFile.json and may have nothing
# in the registry at all - so a machine whose owning tenant was written on the
# disk in plain JSON was reported as unverifiable.
APROOT="$FIX/apfiles"
ap_reset() {
  rm -rf "$APROOT"; mkdir -p "$APROOT/Windows/ServiceState/wmansvc" \
    "$APROOT/Windows/Provisioning/Autopilot"
  WIN_MNT="$APROOT"
  AP_FILE_TENANT=""; AP_FILE_TID=""; AP_FILE_SRC=""; AP_FILE_UNREADABLE=""
}
# The shape a real downloaded profile has, trimmed to what matters here.
ap_profile() {   # ap_profile <path> <tenant> <tid>
  cat >"$1" <<APJSON
{ "CloudAssignedTenantDomain": "$2",
  "CloudAssignedTenantId": "$3",
  "CloudAssignedDeviceName": "LAPTOP-0001",
  "CloudAssignedAutopilotUpdateTimeout": 1800000,
  "ZtdCorrelationId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }
APJSON
}

ap_reset
ap_profile "$APROOT/Windows/ServiceState/wmansvc/AutopilotDDSZTDFile.json" "contoso.onmicrosoft.com" "11111111-2222-3333-4444-555555555555"
_ap_read_files
check "the downloaded ZTD profile names its tenant" "contoso.onmicrosoft.com" "$AP_FILE_TENANT"
check "...and its tenant id"      "11111111-2222-3333-4444-555555555555" "$AP_FILE_TID"
check "...and says which file said so" 1 "$(printf '%s' "$AP_FILE_SRC" | grep -c 'AutopilotDDSZTDFile')"
LOCK_ROWS=""; _autopilot_verdict "" "" "" ""
check "a profile on disk makes the device LOCKED" LOCKED "$(row_status autopilot)"
check "...and the row names the organisation" 1 \
  "$(printf '%s' "$LOCK_ROWS" | cut -d'|' -f4 | grep -c 'contoso.onmicrosoft.com')"
check "...and the device verdict follows" LOCKED "$(lock_status)"

# THE ROUTE THAT LEFT NOTHING IN THE REGISTRY: offline "existing devices".
ap_reset
ap_profile "$APROOT/Windows/Provisioning/Autopilot/AutopilotConfigurationFile.json" "fabrikam.com" "99999999-8888-7777-6666-555555555555"
_ap_read_files
check "an offline registration file names its tenant too" "fabrikam.com" "$AP_FILE_TENANT"
LOCK_ROWS=""; _autopilot_verdict "" "" "" ""
check "...and that is LOCKED, not unverifiable" LOCKED "$(row_status autopilot)"

# Case: Microsoft's own docs spell these directories both ways, and ntfs-3g
# shows names as they are stored.
ap_reset
mv "$APROOT/Windows/ServiceState" "$APROOT/Windows/servicestate"
mkdir -p "$APROOT/Windows/servicestate/Autopilot"
ap_profile "$APROOT/Windows/servicestate/Autopilot/profile.json" "northwind.local" ""
_ap_read_files
check "a lower-case ServiceState is still found" "northwind.local" "$AP_FILE_TENANT"

# A tenant id with no domain is still an owner.
ap_reset
printf '%s' '{"CloudAssignedTenantId":"12345678-90ab-cdef-1234-567890abcdef"}' \
  >"$APROOT/Windows/ServiceState/wmansvc/AutopilotDDSZTDFile.json"
_ap_read_files
LOCK_ROWS=""; _autopilot_verdict "" "" "" ""
check "a tenant id with no domain is still LOCKED" LOCKED "$(row_status autopilot)"

# A PREVIOUS USER'S IDENTITY IS NOT OURS TO RECORD. The profile can carry an
# assigned user; the organisation is the whole of what a resale audit needs.
ap_reset
cat >"$APROOT/Windows/ServiceState/wmansvc/AutopilotDDSZTDFile.json" <<'APUSER'
{ "CloudAssignedTenantDomain": "contoso.com",
  "CloudAssignedUser": "jane.doe@contoso.com",
  "CloudAssignedDeviceName": "JANES-LAPTOP" }
APUSER
_ap_read_files
LOCK_ROWS=""; _autopilot_verdict "" "" "" ""
check "the tenant is taken" "contoso.com" "$AP_FILE_TENANT"
check "a previous user's address never reaches the record" 0 \
  "$(printf '%s' "$LOCK_ROWS" | grep -c 'jane.doe')"
check "...nor their device name" 0 "$(printf '%s' "$LOCK_ROWS" | grep -c 'JANES-LAPTOP')"

# A filename from a CUSTOMER'S disk, with a space in it. Word-splitting on the
# find output turned one such path into two that did not exist, and the file
# was filed as "present but unreadable" - a fault invented out of a space.
ap_reset
ap_profile "$APROOT/Windows/ServiceState/wmansvc/Autopilot profile.json" "spaced.example" ""
_ap_read_files
check "a filename with a space is read, not called unreadable" "spaced.example" "$AP_FILE_TENANT"
check "...and nothing is reported as unreadable" "" "$AP_FILE_UNREADABLE"

# A json that is not Autopilot's is not read into the record as one.
ap_reset
printf '%s' '{"setting":"value","other":"thing"}' \
  >"$APROOT/Windows/ServiceState/wmansvc/unrelated.json"
_ap_read_files
check "an unrelated .json is not mistaken for a profile" "" "$AP_FILE_TENANT"

# A FILE THAT IS THERE AND WILL NOT OPEN is not an absence.
ap_reset
ap_profile "$APROOT/Windows/ServiceState/wmansvc/AutopilotDDSZTDFile.json" "contoso.com" ""
chmod 000 "$APROOT/Windows/ServiceState/wmansvc/AutopilotDDSZTDFile.json" 2>/dev/null
if [ -r "$APROOT/Windows/ServiceState/wmansvc/AutopilotDDSZTDFile.json" ]; then
  echo "  SKIP  unreadable-file case (running as root, or a filesystem with no modes)"
else
  _ap_read_files
  check "an unreadable profile is recorded as unreadable" 1 \
    "$(printf '%s' "$AP_FILE_UNREADABLE" | grep -c 'AutopilotDDSZTDFile')"
  LOCK_ROWS=""; _autopilot_verdict "" "" "" "0"
  check "...and is UNKNOWN, never the cached 'no profile' answer" UNKNOWN "$(row_status autopilot)"
  check "...and says the file could not be read" 1 \
    "$(printf '%s' "$LOCK_ROWS" | cut -d'|' -f4 | grep -c 'could not be read')"
fi
chmod 644 "$APROOT/Windows/ServiceState/wmansvc/AutopilotDDSZTDFile.json" 2>/dev/null

# No files at all: the registry answer stands, and the wording now covers both.
ap_reset
_ap_read_files
LOCK_ROWS=""; _autopilot_verdict "" "" "" ""
check "no files and no registry is still UNKNOWN" UNKNOWN "$(row_status autopilot)"
check "...and says the FILES were looked at too" 1 \
  "$(printf '%s' "$LOCK_ROWS" | cut -d'|' -f4 | grep -c 'profile files on disk')"
check "...and still refuses to call it unregistered" 1 \
  "$(printf '%s' "$LOCK_ROWS" | cut -d'|' -f4 | grep -c 'does NOT mean the device is unregistered')"

# The registry still wins when it has the answer: a file search must not be
# able to overwrite a tenant the hive already named.
ap_reset
ap_profile "$APROOT/Windows/ServiceState/wmansvc/AutopilotDDSZTDFile.json" "wrong.example" ""
_ap_read_files
LOCK_ROWS=""; _autopilot_verdict "registry.example" "" "" ""
check "a tenant named in the REGISTRY is the one reported" 1 \
  "$(printf '%s' "$LOCK_ROWS" | cut -d'|' -f4 | grep -c 'registry.example')"
check "...and the file's value does not appear" 0 \
  "$(printf '%s' "$LOCK_ROWS" | grep -c 'wrong.example')"

WIN_MNT=""; AP_FILE_TENANT=""; AP_FILE_TID=""; AP_FILE_SRC=""; AP_FILE_UNREADABLE=""

echo
echo "== the Autopilot EVENT LOG: every answer, not just the last one =="
# The registry keeps the last answer. The OOBE log keeps them all, which is the
# difference between "Microsoft said no once, in August" and "asked eleven
# times and was told 807 every time" - and it is the only artefact that catches
# a machine whose profile files were cleaned up but whose history was not.
_saved_has6=$(declare -f lock_has)
_saved_dump=$(declare -f als_evtx_dump)

evt_reset() {
  rm -rf "$APROOT"; mkdir -p "$APROOT/Windows/System32/winevt/Logs" \
    "$APROOT/Windows/ServiceState/wmansvc" "$APROOT/Windows/Provisioning/Autopilot"
  WIN_MNT="$APROOT"
  : >"$APROOT/Windows/System32/winevt/Logs/Microsoft-Windows-ModernDeployment-Diagnostics-Provider%4Autopilot.evtx"
  AP_FILE_TENANT=""; AP_FILE_TID=""; AP_FILE_SRC=""; AP_FILE_UNREADABLE=""
  lock_has() { case "$1" in evtxexport) return 0 ;; esac; return 0; }
}

# The log of a machine the service has never heard of.
evt_reset
als_evtx_dump() { printf '%s\n' \
  'Event: ZtdDeviceIsNotRegistered 807' \
  'Event: ZtdDeviceIsNotRegistered 807' \
  'Event: ZtdDeviceIsNotRegistered 807'; }
_ap_read_evt
check "every 'not registered' answer is counted" 3 "$AP_EVT_807"
check "and no tenant is invented from them" "" "$AP_EVT_TENANT"
LOCK_ROWS=""; _ap_read_files; _autopilot_verdict "" "" "" "0"
check "the cached 'no profile' answer is still UNKNOWN" UNKNOWN "$(row_status autopilot)"
check "...and now carries the history" 1 \
  "$(printf '%s' "$LOCK_ROWS" | cut -d'|' -f4 | grep -c 'same answer 3 time')"

# THE ONE THIS EXISTS FOR: the log names the tenant, the files do not.
evt_reset
als_evtx_dump() { printf '%s\n' 'Profile received: "CloudAssignedTenantDomain": "contoso.com"'; }
_ap_read_evt
check "a tenant named in the log is found" "contoso.com" "$AP_EVT_TENANT"
LOCK_ROWS=""; _ap_read_files; _autopilot_verdict "" "" "" "0"
check "...and the device is LOCKED on it" LOCKED "$(row_status autopilot)"
check "...and the row says the log said so" 1 \
  "$(printf '%s' "$LOCK_ROWS" | cut -d'|' -f5 | grep -c 'event log')"

# A hardware mismatch is an ENROLMENT, not a clean machine: the service knows
# the device and the hash has moved. Usually a mainboard swap.
evt_reset
als_evtx_dump() { printf '%s\n' 'Error: HardwareMismatchDetected 908'; }
_ap_read_evt
check "a hardware mismatch is counted" 1 "$AP_EVT_908"
LOCK_ROWS=""; _ap_read_files; _autopilot_verdict "" "" "" "0"
check "...and reads as LOCKED, not as a clean machine" LOCKED "$(row_status autopilot)"
check "...and explains the mainboard case" 1 \
  "$(printf '%s' "$LOCK_ROWS" | cut -d'|' -f4 | grep -c 'mainboard')"

# NO READER IS NOT NO REGISTRATION. A stick built before libevtx-utils was
# added has no evtxexport, and that must read as "could not look".
evt_reset
lock_has() { case "$1" in evtxexport) return 1 ;; esac; return 0; }
_ap_read_evt
check "no evtxexport: nothing is concluded from the log" "" "$AP_EVT_TENANT"
check "...and it says the BUILD cannot read them" 1 \
  "$(printf '%s' "$AP_EVT_WHY" | grep -c 'evtxexport is missing')"
check "...and no answer is counted" 0 "$AP_EVT_807"

# A log that is there and will not read is not an absence either.
evt_reset
als_evtx_dump() { return 1; }
_ap_read_evt
check "an unreadable log says so" 1 "$(printf '%s' "$AP_EVT_WHY" | grep -c 'could not be read')"
check "...and counts nothing" "00" "$AP_EVT_807$AP_EVT_908"

# No log at all - a wiped or freshly imaged machine. Not "no attempts".
evt_reset
rm -f "$APROOT/Windows/System32/winevt/Logs/"*.evtx
_ap_read_evt
check "no log present is reported as no log, not as a clean answer" 1 \
  "$(printf '%s' "$AP_EVT_WHY" | grep -c 'no Autopilot event log')"

# The files still win over the log when both name a tenant - the file is the
# profile itself, the log is a record of one.
evt_reset
ap_profile "$APROOT/Windows/ServiceState/wmansvc/AutopilotDDSZTDFile.json" "fromfile.example" ""
als_evtx_dump() { printf '%s\n' '"CloudAssignedTenantDomain": "fromlog.example"'; }
_ap_read_files; _ap_read_evt
LOCK_ROWS=""; _autopilot_verdict "" "" "" ""
check "the profile FILE is preferred over the log" 1 \
  "$(printf '%s' "$LOCK_ROWS" | grep -c 'fromfile.example')"
check "...and the log's value does not also appear" 0 \
  "$(printf '%s' "$LOCK_ROWS" | grep -c 'fromlog.example')"

eval "$_saved_has6"
eval "$_saved_dump" 2>/dev/null || unset -f als_evtx_dump
WIN_MNT=""; AP_EVT_TENANT=""; AP_EVT_807=0; AP_EVT_908=0; AP_EVT_WHY=""

echo
printf '%d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
