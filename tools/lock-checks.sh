#!/usr/bin/env bash
#
# ALS Inventory — Device Locks & Management Status
# ------------------------------------------------
# Sourced by hardware-audit.sh. Answers ONE question for a buyer standing in
# front of a used machine: is there anything on it that would stop us
# refurbishing, reselling or redeploying it?
#
# DETECTION ONLY. Nothing in here bypasses, clears, disables or defeats a lock,
# and nothing may be added that does. A lock that is found is reported and left
# exactly as it is — removal is the legitimate owner's job, through the vendor's
# own process (Microsoft documents Autopilot deregistration for devices that
# permanently leave an organisation).
#
# THE RULE THAT MATTERS MOST
#   A check that could not run reports UNKNOWN. Never PASS.
# Telling a buyer a locked machine is clear is the single most expensive thing
# this tool could do — they buy a pallet of devices that cannot be resold. So
# "we looked and found nothing" and "we could not look" are different answers
# and are never collapsed into one.
#
# Adding a detector: write a function that calls lock_add once, then list it in
# LOCK_DETECTORS. Nothing else needs to change.

# Root prefix for every system path this file reads. Empty in production, so
# paths resolve to the real /sys and the real disk. A test harness sets it to a
# fixture tree, which is the only way to exercise the DETECTED and LOCKED
# branches on a machine that is not itself locked — and those are precisely the
# branches whose failure would be expensive.
LOCK_SYSROOT="${LOCK_SYSROOT:-}"

# --- result accumulator ------------------------------------------------------
# Kept as a newline-delimited record set rather than an associative array so the
# ordering is stable and the whole thing survives being sourced by a plain sh.
LOCK_ROWS=""

# Strip the two characters that would corrupt a record. Several fields carry
# values read from firmware or the Windows registry — a BIOS attribute string, a
# tenant name, a REG_MULTI_SZ value — and none of that is under our control.
#
# Both failures were reproduced, not theorised. A pipe shifts every later field,
# so the report prints the wrong method and confidence. A NEWLINE is worse: it
# injects a whole extra ROW, and a fabricated "LOCKED" line appeared in the
# report from a single lock_add call. Sanitise once, here, where rows are made.
_lock_clean() { printf '%s' "$1" | tr '|\r\n' '   ' | sed 's/   */ /g; s/ *$//'; }

# lock_add <key> <label> <status> <detail> <method> <confidence>
#   status: PASS | DETECTED | LOCKED | WARNING | UNKNOWN
#   method: how the answer was obtained — shown to the operator so a surprising
#           result can be traced back to the thing that produced it
lock_add() {
  LOCK_ROWS="$LOCK_ROWS$(_lock_clean "$1")|$(_lock_clean "$2")|$(_lock_clean "$3")|$(_lock_clean "$4")|$(_lock_clean "$5")|$(_lock_clean "$6")
"
}

lock_field() { printf '%s' "$1" | cut -d'|' -f"$2"; }

# --- privilege ---------------------------------------------------------------
#
# Almost everything below reads something only root can read: the ACPI tables
# are mode 0400, efivars is root-only, mounting the Windows partition needs
# root, and so does blkid on a raw device.
#
# This mattered less on SystemRescue, which boots you in as root. It matters a
# great deal on the Ubuntu stick, where the live user is NOT root and an
# operator who forgets sudo would otherwise get a page of confident PASSes from
# checks that never ran. Six such false passes were reproduced before this gate
# existed. Refusing to guess is the whole point of this file.
LOCK_IS_ROOT=0
[ "$(id -u 2>/dev/null)" = "0" ] && LOCK_IS_ROOT=1

# Usage:  lock_need_root key "Label" && return
# Returns 0 (and files an UNKNOWN row) when we are NOT root, so the caller stops.
lock_need_root() {
  [ "$LOCK_IS_ROOT" = "1" ] && return 1
  lock_add "$1" "$2" UNKNOWN \
    "Not running as root, so this check could not read what it needs. Re-run with sudo." \
    "requires root" low
  return 0
}

# --- helpers -----------------------------------------------------------------
lock_has() { command -v "$1" >/dev/null 2>&1; }

# The Windows partition, mounted read-only, or empty if we could not get one.
# Set by lock_mount_windows; every Windows-side detector depends on it and
# reports UNKNOWN when it is empty.
WIN_MNT=""
WIN_MOUNTED_BY_US=""
# Set when a Windows volume was found but is encrypted — the difference between
# "no Windows here" and "Windows here that we cannot read".
WIN_ENCRYPTED=""

# Is this block device BitLocker-encrypted? Checked BEFORE any mount attempt:
# an encrypted volume cannot have its registry read at all, so the Microsoft
# checks must report UNKNOWN rather than "nothing found". blkid knows the type
# on newer util-linux; the FVE signature in the first sector is the fallback.
lock_is_bitlocker() {
  case "$(blkid -o value -s TYPE "$1" 2>/dev/null)" in
    *BitLocker*|*bitlocker*) return 0 ;;
  esac
  dd if="$1" bs=512 count=1 2>/dev/null | grep -aq -- '-FVE-FS-'
}

lock_mount_windows() {
  [ -n "$WIN_MNT" ] && return 0
  lock_has lsblk || return 1

  # Already mounted somewhere? Use that rather than mounting twice.
  local existing
  existing=$(lsblk -no MOUNTPOINT,FSTYPE 2>/dev/null | awk '$2=="ntfs"||$2=="ntfs3"{print $1; exit}')
  if [ -n "$existing" ] && [ -d "$existing/Windows/System32/config" ]; then
    WIN_MNT="$existing"
    return 0
  fi

  # BitLocker volumes belong in this list as much as NTFS ones do. libblkid on
  # a modern util-linux — which this stick ships — types an encrypted volume as
  # "BitLocker", NOT as "ntfs", so an ntfs-only filter walked straight past the
  # one disk we most need to notice: lock_is_bitlocker below was never called on
  # it, WIN_ENCRYPTED stayed empty, and every caller then reported "no Windows
  # here" about a machine whose Windows is sitting there intact and merely
  # unreadable. Nothing is mounted for such a device — the loop records it and
  # moves on — so widening the filter only ever ADDS the encrypted answer.
  local dev
  for dev in $(lsblk -pnro NAME,FSTYPE 2>/dev/null | awk '$2=="ntfs"||$2=="ntfs3"||$2~/[Bb]it[Ll]ocker/{print $1}'); do
    # Encrypted: skip it and remember why, so the caller can say so instead of
    # reporting a clean registry it never actually read.
    if lock_is_bitlocker "$dev"; then WIN_ENCRYPTED=1; continue; fi
    mkdir -p /mnt/als-win 2>/dev/null || return 1
    # READ-ONLY, always. This tool never writes to the machine's own disk.
    if mount -o ro,noexec,nodev "$dev" /mnt/als-win 2>/dev/null ||
       mount -t ntfs-3g -o ro,noexec,nodev "$dev" /mnt/als-win 2>/dev/null; then
      if [ -d /mnt/als-win/Windows/System32/config ]; then
        WIN_MNT="/mnt/als-win"
        WIN_MOUNTED_BY_US=1
        return 0
      fi
      umount /mnt/als-win 2>/dev/null
    fi
  done
  return 1
}

lock_unmount_windows() {
  [ -n "$WIN_MOUNTED_BY_US" ] && umount /mnt/als-win 2>/dev/null
  WIN_MOUNTED_BY_US=""
}

# Read one value out of an offline registry hive. Prints nothing and returns
# non-zero when the tooling is absent, which callers must treat as UNKNOWN
# rather than as "not present".
lock_hive_get() {
  local hive="$1" key="$2" value="$3"
  [ -r "$hive" ] || return 1
  if lock_has hivexget; then
    hivexget "$hive" "$key" "$value" 2>/dev/null
    return $?
  fi
  return 1
}

# Does a key exist in a hive at all? Used where the mere presence of a key is
# the signal, independent of any value inside it.
lock_hive_haskey() {
  local hive="$1" key="$2"
  [ -r "$hive" ] || return 1
  lock_has hivexsh || return 1
  printf 'cd %s\nls\n' "$key" | hivexsh "$hive" >/dev/null 2>&1
}

# Read a key's DEFAULT (unnamed) value.
#
# lock_hive_get above runs `hivexget hive key value` and there is no spelling of
# `value` that means "the unnamed one", so the LSA policy values — which are all
# stored in the default value of their key — are out of its reach. hivexsh can
# do it: its `lsval` command with NO argument prints the current node's default
# value.
#
# NOT VERIFIED AGAINST HIVEX. There is no hivex on the machine this was written
# on, so the `lsval` behaviour here is taken from its documentation and has
# never been run against a real SECURITY hive. That is deliberately not
# load-bearing: NOTHING in check_domain decides a verdict from this reader. It
# supplies the domain's NAME and nothing else, and the evidence that decides the
# verdict comes from lock_hive_haskey (cd + ls), which this file already depends
# on elsewhere and which is known to work. If lsval turns out to behave
# differently, a domain-joined machine is still reported as domain joined — it
# is reported without the domain's name, which is a worse report, not a wrong
# one.
#
# NUL BYTES. These values are binary: a small header followed by the name in
# UTF-16LE, so every other byte is 00. Bash command substitution DROPS NUL bytes
# silently, which mangles anything read through `$( )` without warning, so the
# NULs are stripped INSIDE the pipeline, before the substitution can eat them.
lock_hive_get_default() {
  local hive="$1" key="$2" out
  [ -r "$hive" ] || return 1
  lock_has hivexsh || return 1
  # The key goes in as an ARGUMENT, never inside the format string — printf
  # reads \E, \b, \n, \t and friends as escapes and would silently corrupt a
  # path like Policy\Secrets. See the note in check_mdm.
  out=$(printf 'cd %s\nlsval\n' "$key" | hivexsh "$hive" 2>/dev/null | LC_ALL=C tr -d '\000\r')
  [ -n "$out" ] || return 1
  printf '%s' "$out"
}

# =============================================================================
# FIRMWARE DETECTORS — readable from the live USB, whatever OS is installed
# =============================================================================

EFI_GUID="8be4df61-93ca-11d2-aa0d-00e098032b8c"

# The efivars file is 4 bytes of attributes followed by the value, so the byte
# we want is the 5th. Read it directly rather than depending on mokutil, which
# is not installed on every live image.
lock_efivar_byte() {
  local f="$LOCK_SYSROOT/sys/firmware/efi/efivars/$1-$EFI_GUID"
  [ -r "$f" ] || return 1
  od -An -tu1 -j4 -N1 "$f" 2>/dev/null | tr -d ' \n'
}

check_secure_boot() {
  lock_need_root secureBoot "Secure Boot" && return
  if [ ! -d "$LOCK_SYSROOT/sys/firmware/efi" ]; then
    # We booted legacy/CSM, so the UEFI variables are not exposed to us at all.
    # That says nothing about the MACHINE's Secure Boot setting — the firmware
    # may well have it on. Reporting "off" here would be reading our own boot
    # mode and calling it the device's configuration. Boot the USB in UEFI mode
    # to get a real answer.
    lock_add secureBoot "Secure Boot" UNKNOWN       "Booted in Legacy/CSM mode, so the firmware's Secure Boot setting cannot be read. Re-run from a UEFI boot to determine it."       "/sys/firmware/efi absent — UEFI variables unavailable" low
    return
  fi
  local b
  b=$(lock_efivar_byte SecureBoot)
  if [ -z "$b" ] && lock_has mokutil; then
    case "$(mokutil --sb-state 2>/dev/null | tr '[:upper:]' '[:lower:]')" in
      *enabled*)  b=1 ;;
      *disabled*) b=0 ;;
    esac
    [ -n "$b" ] && { lock_add secureBoot "Secure Boot" PASS \
      "$([ "$b" = 1 ] && echo 'ON - the normal setting; not an ownership lock' || echo 'OFF')" "mokutil --sb-state" high; return; }
  fi
  # Secure Boot is REPORTED, never scored against the device.
  #
  # It used to score ON as WARNING, and lock_status promotes any WARNING to the
  # whole-device verdict. Since the documented procedure is to boot this stick
  # with Secure Boot left ON - which is the entire reason it was rebuilt on
  # Ubuntu - every machine came back WARNING and CLEAR was unreachable. The
  # incentive was backwards too: ON scored WARNING and OFF scored PASS, so the
  # way to a clean report was to switch off the security of a machine we are
  # supposed to assess without modifying.
  #
  # It is also not what this tool is for. Secure Boot is a firmware preference
  # the next owner can change; whether they CAN change it is the BIOS password
  # check, which is separate and does score. So: state it, do not judge it.
  case "$b" in
    1) lock_add secureBoot "Secure Boot" PASS "ON - the normal setting on business machines. Not an ownership lock: it only means unsigned boot media is refused." "UEFI variable SecureBoot" high ;;
    0) lock_add secureBoot "Secure Boot" PASS "OFF" "UEFI variable SecureBoot" high ;;
    *) lock_add secureBoot "Secure Boot" UNKNOWN "Could not read the SecureBoot UEFI variable" "UEFI variable SecureBoot" low ;;
  esac
}

check_setup_mode() {
  # A check that files NO ROW is worse than one that reports UNKNOWN: it does
  # not appear in the report, the JSON or the roll-up, so the UNKNOWN that
  # would have forced UNVERIFIED never exists and a legacy/CSM boot could read
  # CLEAR. (run_lock_checks only manufactures a fallback row when a detector
  # returns non-zero, and this returned 0.) check_secure_boot files an explicit
  # UNKNOWN in exactly this condition; match it.
  if [ ! -d "$LOCK_SYSROOT/sys/firmware/efi" ]; then
    lock_add setupMode "UEFI Setup Mode" UNKNOWN \
      "Booted in Legacy/CSM mode, so the firmware's Setup Mode cannot be read. Re-run from a UEFI boot to determine it." \
      "/sys/firmware/efi absent — UEFI variables unavailable" low
    return
  fi
  local b
  b=$(lock_efivar_byte SetupMode)
  case "$b" in
    1) lock_add setupMode "UEFI Setup Mode" WARNING "Firmware is in Setup Mode — Secure Boot keys are not enrolled" "UEFI variable SetupMode" high ;;
    0) lock_add setupMode "UEFI Setup Mode" PASS "Normal (User Mode) — platform keys enrolled" "UEFI variable SetupMode" high ;;
    *) lock_add setupMode "UEFI Setup Mode" UNKNOWN "Could not read the SetupMode UEFI variable" "UEFI variable SetupMode" low ;;
  esac
}

check_tpm() {
  if [ ! -d "$LOCK_SYSROOT/sys/class/tpm" ]; then
    lock_add tpm "TPM" UNKNOWN "No TPM subsystem exposed by this kernel, so presence could not be determined" "/sys/class/tpm absent" low
    return
  fi
  if [ ! -e "$LOCK_SYSROOT/sys/class/tpm/tpm0" ]; then
    # Subsystem present, no device: genuinely no TPM exposed. Not a lock — it is
    # reported because it governs Windows 11 eligibility, and it may mean the
    # TPM is switched off in firmware rather than physically absent.
    lock_add tpm "TPM" PASS "No TPM exposed (absent, or disabled in firmware setup)" "/sys/class/tpm" medium
    return
  fi

  local ver detail
  ver=$(cat "$LOCK_SYSROOT/sys/class/tpm/tpm0/tpm_version_major" 2>/dev/null)
  detail="Present${ver:+ — TPM ${ver}.0}"

  # Ownership is a bonus, not the point: a TPM can be cleared from firmware by
  # whoever holds the machine, so a previous owner's TPM is not a resale
  # blocker. Presence is what matters, and presence is world-readable.
  #
  # But the query needs root and a free device, and it FAILS more often than it
  # errors. Reporting "no owner authorisation set" because a failed command
  # printed nothing is a claim we did not earn — reproduced, and fixed by
  # checking the command actually succeeded before reading anything into it.
  if [ "$LOCK_IS_ROOT" = "1" ] && lock_has tpm2_getcap; then
    local caps
    if caps=$(tpm2_getcap properties-variable 2>/dev/null) && [ -n "$caps" ]; then
      if printf '%s' "$caps" | grep -qi 'ownerAuthSet.*1'; then
        lock_add tpm "TPM" DETECTED "$detail, owner authorisation SET (provisioned by a previous owner; clearable from firmware)" "/sys/class/tpm + tpm2_getcap" medium
        return
      fi
      # The command succeeding is not the field being there. A different
      # tpm2-tools layout, a TPM 1.2, or the wrong property group all print
      # output with no ownerAuthSet line at all - and the grep above fails
      # identically for "the field says 0" and "the field is absent". Saying
      # "no owner authorisation set" at HIGH confidence on the second is how a
      # provisioned TPM - the one outcome here that scores - turned clean.
      if ! printf '%s' "$caps" | grep -qi 'ownerAuthSet'; then
        lock_add tpm "TPM" UNKNOWN \
          "$detail, but tpm2_getcap did not report ownerAuthSet, so whether a previous owner provisioned it is not known" \
          "/sys/class/tpm + tpm2_getcap (no ownerAuthSet property)" low
        return
      fi
      lock_add tpm "TPM" PASS "$detail, no owner authorisation set" "/sys/class/tpm + tpm2_getcap" high
      return
    fi
    lock_add tpm "TPM" PASS "$detail (ownership state not determined — tpm2_getcap did not return)" "/sys/class/tpm" medium
    return
  fi
  lock_add tpm "TPM" PASS "$detail (ownership state not checked)" "/sys/class/tpm" medium
}

# BIOS/UEFI administrator or system password.
#
# The modern, vendor-neutral way to see this from Linux is the kernel's
# firmware-attributes class, exposed by dell-wmi-sysman (Dell), think-lmi
# (Lenovo) and hp-bioscfg (HP). is_enabled reports whether a password is SET.
# It never reveals or changes the password.
check_bios_password() {
  lock_need_root biosPassword "BIOS/UEFI password" && return

  local base found=0 unreadable=0 readany=0 detail="" v
  for base in "$LOCK_SYSROOT"/sys/class/firmware-attributes/*/authentication; do
    [ -d "$base" ] || continue
    found=1
    # Admin/Setup and System/Power-on are reported separately: they are
    # different passwords with different consequences for a refurbisher.
    for which in Admin System; do
      [ -e "$base/$which/is_enabled" ] || continue
      # A file that EXISTS but cannot be read is not a "no". Treating the empty
      # result as 0 is how this check used to claim a password-locked machine
      # was clear — reproduced, and the reason for the unreadable flag.
      if v=$(cat "$base/$which/is_enabled" 2>/dev/null) && [ -n "$v" ]; then
        # Only 0 and 1 are answers. Anything else - "Not Supported", a value
        # with a trailing CR, a 2 from a firmware that counts differently - was
        # read as "not 1" and therefore as no password, at high confidence.
        # An unrecognised value is an unread one: check_absolute's `*)` arm
        # already treats this class of input that way.
        case "$(printf '%s' "$v" | tr -d '\r[:space:]')" in
          1) readany=1; detail="${detail}${which} password is SET. " ;;
          0) readany=1 ;;
          *) unreadable=1 ;;
        esac
      else
        unreadable=1
      fi
    done
  done

  if [ "$found" = "0" ]; then
    lock_add biosPassword "BIOS/UEFI password" UNKNOWN \
      "No firmware-attributes interface on this machine, so a BIOS password cannot be confirmed either way" \
      "/sys/class/firmware-attributes (dell-wmi-sysman / think-lmi / hp-bioscfg)" low
    return
  fi
  if [ -n "$detail" ]; then
    lock_add biosPassword "BIOS/UEFI password" WARNING "$detail" \
      "/sys/class/firmware-attributes authentication/*/is_enabled" high
    return
  fi
  if [ "$unreadable" = "1" ] || [ "$readany" = "0" ]; then
    lock_add biosPassword "BIOS/UEFI password" UNKNOWN \
      "The firmware-attributes interface is present but its password state could not be read" \
      "/sys/class/firmware-attributes (read failed)" low
    return
  fi
  lock_add biosPassword "BIOS/UEFI password" PASS \
    "No BIOS admin or system password set" \
    "/sys/class/firmware-attributes authentication/*/is_enabled" high
}

# Absolute (formerly Computrace) Persistence.
#
# The distinction the buyer cares about is "the BIOS merely offers Absolute" vs
# "Persistence is actually ACTIVE". WPBT is what separates them: it is the ACPI
# table through which firmware injects an agent into Windows at every boot, so
# an Absolute payload sitting in WPBT means the firmware is actively planting
# it — not that the option exists in a menu.
# --- WPBT parsing ------------------------------------------------------------
#
# The Windows Platform Binary Table is how firmware injects an executable into
# Windows at every boot. It is the mechanism behind Absolute Persistence, and
# the thing that separates "the BIOS offers Absolute" from "Absolute is running".
#
# THE TABLE DOES NOT CONTAIN THE BINARY. Per Microsoft's spec it is a 52-byte
# structure holding a 64-bit PHYSICAL ADDRESS pointing at a PE image elsewhere
# in memory:
#
#   0   ACPI header (36 bytes) - OEM ID @10, OEM Table ID @16, Creator ID @28
#   36  Handoff Memory Size        u32
#   40  Handoff Memory Location    u64   <- physical address of the payload
#   48  Content Layout             u8
#   49  Content Type               u8
#   50  Command-line Args Length   u16
#   52  Command-line Args          UTF-16LE, optional
#
# An earlier version of this file grepped the raw table for the ASCII string
# "rpcnetp". There is nothing in the table for that to match - not in ASCII, and
# not in UTF-16 either, because the payload name is not stored here at all. It
# could never have fired on real hardware, and the fixture that "proved" it
# worked was a 36-byte blob Windows itself would reject on the length check.
# Parse the fields; do not sift the bytes.

_wpbt_u16() { od -An -tu2 -j"$2" -N2 -v "$1" 2>/dev/null | tr -d ' \n'; }
_wpbt_u32() { od -An -tu4 -j"$2" -N4 -v "$1" 2>/dev/null | tr -d ' \n'; }
_wpbt_str() { dd if="$1" bs=1 skip="$2" count="$3" 2>/dev/null | tr -cd '[:print:]'; }

# The command-line arguments field, decoded from UTF-16LE. Absent on most
# machines - ArgumentsLength=0 is normal and explicitly legal - so an empty
# result here is not evidence either way.
_wpbt_args() {
  local f="$1" al
  al=$(_wpbt_u16 "$f" 50)
  case "$al" in ''|0|*[!0-9]*) return 1 ;; esac
  dd if="$f" bs=1 skip=52 count="$al" 2>/dev/null |
    { iconv -f UTF-16LE -t UTF-8 2>/dev/null || LC_ALL=C tr -d '\000'; }
}

# The injected payload itself, read from physical memory. The spec requires the
# buffer to be EfiACPIReclaimMemory, which is not System RAM, so a kernel with
# CONFIG_STRICT_DEVMEM will usually still allow the read. When it refuses we say
# so rather than concluding anything.
_wpbt_payload() {
  local f="$1" addr sz
  [ -r /dev/mem ] || return 1
  addr=$(od -An -tx8 -j40 -N8 -v "$f" 2>/dev/null | tr -d ' \n')
  sz=$(_wpbt_u32 "$f" 36)
  case "$addr" in ''|*[!0-9a-fA-F]*) return 1 ;; esac
  case "$sz" in ''|0|*[!0-9]*) return 1 ;; esac
  [ "$sz" -gt 8388608 ] && return 1
  dd if=/dev/mem bs=1 skip=$((16#$addr)) count="$sz" 2>/dev/null
}

_ABS_PAT='rpcnetp|rpcnet|absolute|computrace|namequery'

check_absolute() {
  lock_need_root absolute "Absolute / Computrace" && return

  # Split deliberately: in this shell a `local a=X b="$a/Y"` does NOT see the
  # a it just assigned, so wpbt silently became "/WPBT" and every machine
  # reported "no WPBT injection table". Verified: local a=X b=$a/Y -> b=/Y.
  local tables="$LOCK_SYSROOT/sys/firmware/acpi/tables"
  local wpbt="$tables/WPBT"

  if [ ! -d "$tables" ]; then
    lock_add absolute "Absolute / Computrace" UNKNOWN \
      "ACPI tables are not readable from this boot, so firmware-injected agents could not be checked" \
      "/sys/firmware/acpi/tables absent" low
    return
  fi
  # Mode 0400: present but unreadable is a different answer from absent.
  if [ -e "$wpbt" ] && [ ! -r "$wpbt" ]; then
    lock_add absolute "Absolute / Computrace" UNKNOWN \
      "A WPBT table exists but could not be read, so the injected agent could not be identified" \
      "ACPI WPBT (unreadable)" low
    return
  fi

  if [ -r "$wpbt" ]; then
    local len oem args hits payload
    len=$(_wpbt_u32 "$wpbt" 4)
    case "$len" in ''|*[!0-9]*) len=0 ;; esac
    if [ "$len" -lt 52 ]; then
      lock_add absolute "Absolute / Computrace" UNKNOWN \
        "The WPBT table is malformed (length $len, minimum 52), so its payload could not be identified" \
        "ACPI WPBT (bad length)" low
      return
    fi

    oem=$(_wpbt_str "$wpbt" 10 6)
    args=$(_wpbt_args "$wpbt")
    hits=$(printf '%s' "$args" | grep -aoiE "$_ABS_PAT" | tr '[:upper:]' '[:lower:]' | sort -u | paste -sd', ' -)
    if [ -n "$hits" ]; then
      lock_add absolute "Absolute / Computrace" LOCKED \
        "Persistence ACTIVE - firmware injects an agent at boot (WPBT arguments name: $hits)" \
        "ACPI WPBT command-line arguments" high
      return
    fi

    # Nothing in the arguments: follow the pointer to the payload itself.
    if payload=$(_wpbt_payload "$wpbt") && [ -n "$payload" ]; then
      hits=$(printf '%s' "$payload" | LC_ALL=C tr -d '\000' | grep -aoiE "$_ABS_PAT" | tr '[:upper:]' '[:lower:]' | sort -u | paste -sd', ' -)
      if [ -n "$hits" ]; then
        lock_add absolute "Absolute / Computrace" LOCKED \
          "Persistence ACTIVE - the binary this firmware injects identifies as: $hits" \
          "ACPI WPBT payload read from physical memory" high
        return
      fi
      lock_add absolute "Absolute / Computrace" DETECTED \
        "Firmware injects a binary at every boot${oem:+ (published by $oem)}, but it does not identify as Absolute" \
        "ACPI WPBT payload read from physical memory" medium
      return
    fi

    # The payload could not be read, but the arguments DID decode to something.
    # That is identification: firmware is injecting a named binary and the name
    # is not Absolute. Reporting UNKNOWN here would throw away a real answer.
    if [ -n "$args" ]; then
      lock_add absolute "Absolute / Computrace" DETECTED \
        "Firmware injects a binary at every boot${oem:+ (published by $oem)}, named: $args. It does not identify as Absolute." \
        "ACPI WPBT command-line arguments" medium
      return
    fi
    # A WPBT exists and we could not see what it injects. Emphatically NOT a
    # clean bill: this is the exact shape of an active Absolute install.
    lock_add absolute "Absolute / Computrace" UNKNOWN \
      "Firmware injects a binary at boot${oem:+ (published by $oem)} but it could not be read, so it may or may not be Absolute. Boot with iomem=relaxed to identify it." \
      "ACPI WPBT present, payload unreadable" low
    return
  fi

  # No WPBT. Fall back to the vendor's own setting — but read it correctly.
  #
  # THIS IS THE DISTINCTION THE WHOLE CHECK EXISTS FOR, and it was backwards.
  # Dell's documentation is explicit about the Absolute Persistence states:
  #
  #   Disable              the module interface is disabled
  #   Enable               "The Absolute Persistence Module Interface is
  #                         Enabled. (This allows the Absolute OS Activation
  #                         Agent to Provision the platform and 'Activate' the
  #                         platform.)"   <- READY to be activated, NOT active
  #   Permanently Disable  cannot be changed again
  #
  # and states plainly that "Enabled does not mean that the feature is active":
  # it only makes the interface ready for activation by Absolute's server, which
  # additionally requires the agent to be installed and to authenticate. Once
  # that has genuinely happened the BIOS option is greyed out.
  #
  # ENABLE IS ALSO THE FACTORY DEFAULT on modern Dell business machines (it
  # changed from Computrace's "Deactivate"). Reporting LOCKED on it therefore
  # flagged essentially every Dell that has ever come through the door — the
  # exact false positive that makes a report worth ignoring.
  #
  # The legacy Computrace vocabulary is different and DOES have a real
  # activation state: Deactivate (changeable), Activate (permanent, genuinely
  # on), Disable (permanently off). Only Computrace's "Activate" is a lock.
  local f state attr lower
  for f in "$LOCK_SYSROOT"/sys/class/firmware-attributes/*/attributes/*bsolute*/current_value \
           "$LOCK_SYSROOT"/sys/class/firmware-attributes/*/attributes/*omputrace*/current_value; do
    [ -r "$f" ] || continue
    state=$(cat "$f" 2>/dev/null)
    attr=$(basename "$(dirname "$f")")
    lower=$(printf '%s' "$state" | tr '[:upper:]' '[:lower:]')
    # ORDER MATTERS TWICE OVER: "Permanently Disable" contains "disable", and
    # "Deactivate" contains "activate". Most specific and most negative first.
    case "$lower" in
      *permanent*disab*)
        lock_add absolute "Absolute / Computrace" PASS \
          "$attr is permanently disabled in BIOS ($state) — it can never be activated" \
          "firmware-attributes + no WPBT" high; return ;;
      *deactivat*)
        lock_add absolute "Absolute / Computrace" PASS \
          "$attr is deactivated in BIOS ($state)" \
          "firmware-attributes + no WPBT" high; return ;;
      *disab*)
        lock_add absolute "Absolute / Computrace" PASS \
          "$attr is disabled in BIOS ($state)" \
          "firmware-attributes + no WPBT" high; return ;;
      *activat*)
        # Legacy Computrace's "Activate" is a genuine activation and permanent -
        # it cannot be set back. But this arm is only reached when there is NO
        # WPBT table, so whatever the BIOS was told to do, firmware is not
        # planting an agent at boot right now. That is worth flagging loudly
        # and is not the same as a running lock, so DETECTED rather than LOCKED.
        lock_add absolute "Absolute / Computrace" DETECTED \
          "$attr reports ACTIVATED in BIOS ($state). On legacy Computrace that is permanent and cannot be reversed. No WPBT injection table is present, so no agent is being planted at boot - but the interface is armed and an agent installed in Windows could reach the Absolute service." \
          "firmware-attributes (activated) + no WPBT" high; return ;;
      *enabl*)
        # The factory default. Per Dell, this means the interface is READY for
        # activation, not that anything is running — and with no WPBT there is
        # no agent being injected at boot either.
        lock_add absolute "Absolute / Computrace" PASS \
          "$attr interface is enabled in BIOS ($state), which is the factory default and means it is READY to be activated, not active. No WPBT injection table is present, so nothing is being planted at boot." \
          "firmware-attributes + no WPBT" medium; return ;;
      *)
        lock_add absolute "Absolute / Computrace" UNKNOWN \
          "$attr has an unrecognised value ($state), so its activation state could not be determined" \
          "firmware-attributes" low; return ;;
    esac
  done

  # No WPBT and no vendor setting to read. Absence of the injection table is
  # real evidence - that is how Persistence works - but it is not proof on its
  # own, so this is deliberately not a confident PASS.
  lock_add absolute "Absolute / Computrace" PASS \
    "No WPBT injection table published by firmware, so nothing is being planted at boot. No vendor Absolute setting was readable to confirm it independently." \
    "ACPI WPBT absent (no vendor setting to corroborate)" medium
}

# =============================================================================
# WINDOWS-SIDE DETECTORS — the installed OS's registry, read offline
#
# Autopilot, Intune and Entra state all live in the Windows registry, so a Linux
# live USB has to mount the machine's own partition READ-ONLY and parse the
# hives. That is why hivex matters: without it these checks cannot run at all
# and must say so.
# =============================================================================

WIN_SOFTWARE=""
WIN_SYSTEM=""
# The SECURITY hive. It sits in the same directory as the other two and is where
# the LSA keeps the machine's domain membership — the one place that holds PROOF
# of an Active Directory join rather than a side effect of one.
#
# It is worth being clear about why this is readable at all, because on a live
# Windows it is not: `reg query HKLM\SECURITY` is Access Denied to everything
# short of SYSTEM. That denial is a Windows ACL, enforced by the Windows kernel
# on a running machine. There is no running machine here. The disk is powered
# off and mounted read-only, hivex parses the hive FILE as a data structure, and
# a file's Windows ACL means nothing to a Linux process reading its bytes as
# root. So the check that cannot be done live is exactly the one that can be
# done offline.
WIN_SECURITY=""

lock_locate_hives() {
  [ -n "$WIN_SOFTWARE" ] && return 0
  lock_mount_windows || return 1
  local cfg="$WIN_MNT/Windows/System32/config"
  [ -r "$cfg/SOFTWARE" ] && WIN_SOFTWARE="$cfg/SOFTWARE"
  [ -r "$cfg/SYSTEM" ]   && WIN_SYSTEM="$cfg/SYSTEM"
  [ -r "$cfg/SECURITY" ] && WIN_SECURITY="$cfg/SECURITY"
  # SOFTWARE remains the gate, deliberately. SECURITY is missing on a damaged or
  # part-copied install, and making it a precondition here would turn every
  # Windows check — Autopilot, MDM, Entra — UNKNOWN over a hive only one of them
  # needs. Each check reports what its own inputs allow.
  [ -n "$WIN_SOFTWARE" ]
}

# Which control set the registry reads should address.
#
# ControlSet001 is hard-coded throughout this file and is right on nearly every
# machine, but not on all of them: SYSTEM\Select\Current is a DWORD naming the
# set Windows last booted, and it reads 2 after a Last Known Good boot. Pointing
# every lookup at a set that is stale — or at one that is not in the hive at all
# — would return nothing from every read, and "nothing found" is how this file
# would then have said PASS about a managed machine. Cheap to get right, so get
# it right.
#
# Conservative by construction: the resolved name is adopted ONLY when the key
# is actually there. Anything unexpected leaves ControlSet001 in place, which is
# where this file has always looked.
WIN_CTRLSET='ControlSet001'
lock_resolve_controlset() {
  WIN_CTRLSET='ControlSet001'
  [ -n "$WIN_SYSTEM" ] && [ -r "$WIN_SYSTEM" ] || return 1
  local n
  n=$(lock_hive_get "$WIN_SYSTEM" 'Select' 'Current' 2>/dev/null | tr -cd '0-9')
  case "$n" in ''|*[!0-9]*) return 1 ;; esac
  [ "$n" -ge 1 ] && [ "$n" -le 999 ] || return 1
  local cs
  cs=$(printf 'ControlSet%03d' "$n")
  lock_hive_haskey "$WIN_SYSTEM" "$cs" || return 1
  WIN_CTRLSET="$cs"
}

# Why every Windows detector starts the same way: distinguish "no Windows on
# this disk", "Windows present but we lack the tools to read it" and "we read it
# and found nothing". Only the third can ever be PASS.
lock_win_blocked() {
  local key="$1" label="$2" need="${3:-hivexget}"
  lock_need_root "$key" "$label" && return 0
  # Guard on the tool this particular check actually USES. The old guard passed
  # whenever EITHER hivex tool was present, so a box with hivexget but no
  # hivexsh sailed through and then reported "not enrolled" — because the
  # hivexsh call that reads enrolments had silently produced nothing.
  if ! lock_has "$need"; then
    lock_add "$key" "$label" UNKNOWN "$need is not installed on this live image, so the Windows registry could not be read" "offline registry ($need missing)" low
    return 0
  fi
  if ! lock_locate_hives; then
    if [ -n "$WIN_ENCRYPTED" ]; then
      lock_add "$key" "$label" UNKNOWN "A BitLocker-encrypted Windows volume is present but cannot be read without the recovery key" "offline registry (volume encrypted)" low
    else
      lock_add "$key" "$label" UNKNOWN "No readable Windows installation found on the internal disks" "offline registry (no Windows partition)" low
    fi
    return 0
  fi
  return 1
}

# --- Autopilot ---------------------------------------------------------------
#
# THE MOST IMPORTANT CHECK IN THIS FILE, AND THE ONE MOST EASILY GOT WRONG.
#
# Autopilot registration does NOT live on the device. It lives in Microsoft's
# cloud, keyed to the hardware identity (the device's hardware hash). A machine
# that has been wiped carries NO local trace and will still, at the next
# network-connected OOBE, be claimed by the organisation that registered it.
#
# So a clean registry here proves nothing whatsoever, and this check must never
# return PASS on that basis. Absence of local traces is UNKNOWN — the only way
# to be sure is an OOBE test with a network connection, or the tenant owner
# checking their own Autopilot device list.
# Pull a value out of the cached Autopilot policy JSON. The blob is JSON that
# has been embedded inside another JSON string, so the quotes arrive escaped:
#   "CloudAssignedTenantDomain\":\"contoso.onmicrosoft.com\"
# The pattern deliberately requires a real character immediately after the
# punctuation. An empty domain reads as ...Domain\":\"\",\"CloudAssignedTenantUpn...
# and a looser match would happily skip the comma and return the NEXT key's
# name as the tenant.
_ap_field() {
  printf '%s' "$2" \
    | grep -o "$1[\\\":]*[A-Za-z0-9][A-Za-z0-9._:@-]*" \
    | head -1 \
    | sed "s/^$1[\\\":]*//"
}

# hivexget renders a DWORD as a decimal, but be liberal about what we accept.
_ap_true() {
  case "$(printf '%s' "$1" | tr -d ' \t\r\n' | sed 's/^dword://; s/^0[xX]//')" in
    '' | 0 | 00 | 000 | 0000) return 1 ;;
    *) return 0 ;;
  esac
}

# The verdict, split out from the registry reads so it can be tested against
# real-world values without a Windows hive to hand.
_autopilot_verdict() {
  local dom="$1" tid="$2" json="$3" avail="$4" jdom when

  jdom=$(_ap_field CloudAssignedTenantDomain "$json")
  [ -z "$dom" ] && dom="$jdom"
  when=$(_ap_field AutopilotCreationDate "$json")

  # A named tenant is the unambiguous case: this device belongs to somebody.
  if [ -n "$dom" ] || [ -n "$tid" ]; then
    lock_add autopilot "Windows Autopilot" LOCKED \
      "Registered to an organisation${dom:+ - tenant $dom}${tid:+ (id $tid)}. Removal requires the owning organisation to deregister the device." \
      'offline registry SOFTWARE\Microsoft\Provisioning' high
    return
  fi

  # A profile was assigned even though the tenant was not named locally.
  if _ap_true "$avail"; then
    lock_add autopilot "Windows Autopilot" LOCKED \
      "An Autopilot deployment profile is assigned to this device${when:+, as of $when}, so it is registered to an organisation even though the tenant is not named locally. Removal requires that organisation to deregister it." \
      'offline registry SOFTWARE\Microsoft\Provisioning\AutopilotPolicyCache ProfileAvailable' high
    return
  fi

  # ProfileAvailable present and zero. This is the one genuinely positive
  # answer available offline: Windows asked Microsoft's Autopilot service about
  # this hardware hash and was told there is no profile for it. It is evidence,
  # not proof - hence medium confidence and an explicit statement of what it
  # does not cover.
  if [ -n "$avail" ]; then
    lock_add autopilot "Windows Autopilot" UNKNOWN \
      "The Autopilot service was contacted${when:+ on $when} and returned no profile, and no tenant is assigned locally - which is what an unregistered device looks like. It is not proof: a blank profile is also cached when the organisation has not assigned one yet, and registration lives in Microsoft's cloud against the hardware hash and survives a wipe. Confirm with a network-connected OOBE, or ask the seller for proof of deregistration." \
      'offline registry AutopilotPolicyCache ProfileAvailable=0 (no tenant)' high
    return
  fi

  # Traces but no verdict. Note what these are NOT: every Windows install
  # carries Provisioning\AutopilotSettings (service URLs and timeouts shipped
  # in the image) and any machine that reached OOBE with a network carries
  # correlation ids from asking the service. Treating either as a positive
  # flagged clean consumer hardware as enrolled.
  if [ -n "$json" ]; then
    lock_add autopilot "Windows Autopilot" UNKNOWN \
      "Autopilot policy cache present but it records no tenant and no profile result, so enrolment could not be decided either way." \
      'offline registry AutopilotPolicyCache (no usable result)' medium
    return
  fi

  lock_add autopilot "Windows Autopilot" UNKNOWN \
    "No local Autopilot traces. This does NOT mean the device is unregistered: registration is held in Microsoft's cloud against the hardware hash and survives a wipe. Confirm with a network-connected OOBE, or ask the seller for proof of deregistration." \
    'offline registry (no traces) - cloud state not checkable from here' high
}

check_autopilot() {
  lock_win_blocked autopilot "Windows Autopilot" && return

  # Prove the hive can be READ before reporting what is not in it.
  #
  # The four reads below come back empty in two completely different cases: the
  # value is genuinely absent, or hivexget could not open the hive at all. They
  # were indistinguishable, so a hive that would not open produced four empty
  # strings and _autopilot_verdict's last branch announced "No local Autopilot
  # traces" - a claim to have looked. Found on a real machine whose SOFTWARE
  # hive could not be walked (the MDM row on the same audit said so) and which
  # the owner knew was Autopilot-registered: the row said the device carried no
  # local traces when nothing had been read.
  #
  # ProductName has been in that key since NT, so failing to read IT means the
  # hive is the problem, not the key. check_mdm proves the same thing with a
  # hivexsh `cd`; this is the hivexget equivalent, because that is the tool
  # these four reads actually use.
  if ! lock_hive_get "$WIN_SOFTWARE" 'Microsoft\Windows NT\CurrentVersion' ProductName >/dev/null 2>&1; then
    lock_add autopilot "Windows Autopilot" UNKNOWN \
      "The SOFTWARE hive could not be read, so nothing can be concluded about Autopilot from this machine - not even that it carries no local traces. Registration lives in Microsoft's cloud against the hardware hash and survives a wipe, so confirm with a network-connected OOBE or ask the seller for proof of deregistration." \
      'offline registry (hivexget could not read the hive)' low
    return
  fi

  local ap='Microsoft\Provisioning\Diagnostics\AutoPilot'
  local pc='Microsoft\Provisioning\AutopilotPolicyCache'
  local dom tid json avail
  dom=$(lock_hive_get "$WIN_SOFTWARE" "$ap" CloudAssignedTenantDomain 2>/dev/null)
  tid=$(lock_hive_get "$WIN_SOFTWARE" "$ap" CloudAssignedTenantId 2>/dev/null)
  json=$(lock_hive_get "$WIN_SOFTWARE" "$pc" PolicyJsonCache 2>/dev/null)
  avail=$(lock_hive_get "$WIN_SOFTWARE" "$pc" ProfileAvailable 2>/dev/null)

  _autopilot_verdict "$dom" "$tid" "$json" "$avail"
}

# --- Intune / MDM enrolment --------------------------------------------------
#
# PRIVACY: these keys also hold the previous user's UPN and email. This audit
# ends up in an inventory database that gets exported and emailed, so only the
# ORGANISATION is recorded — the provider and the tenant domain. That is all
# that is needed to prove the lock and to chase deregistration, and a former
# employee's address is nobody's business here. Do not add UPN capture.
# An enrolment subkey counts only if it names a management SERVER. Windows
# ships around thirty GUID subkeys under Enrollments on a stock install, and
# three of them carry a ProviderID - "Local Authority", "Cloud Authority" and
# "Deploy Authority" - which are built-in CSP authorities, not enrolments.
# Treating any ProviderID as an enrolment reports LOCKED on every Windows
# machine ever made. A real MDM has a DiscoveryServiceFullURL pointing at the
# server that manages the device; Intune's is manage.microsoft.com.
_mdm_provider() {
  local id="$1" url="$2"
  [ -n "$url" ] || return 0
  case "$url" in
    *manage.microsoft.com*) printf 'Microsoft Intune' ;;
    *) printf '%s' "${id:-unidentified MDM}" ;;
  esac
}

_mdm_verdict() {
  local provider="$1" org="$2"
  if [ -n "$provider" ]; then
    lock_add mdm "Intune / MDM enrolment" LOCKED \
      "Enrolled in mobile device management (provider: $provider${org:+, organisation $org}). The device is under an organisation's control, and only that organisation can release it." \
      'offline registry SOFTWARE\Microsoft\Enrollments (enrolment with a management server URL)' high
    return
  fi
  lock_add mdm "Intune / MDM enrolment" PASS \
    "No enrolment names a management server. The built-in Local/Cloud/Deploy Authority entries that every Windows install carries are present but are not enrolments." \
    'offline registry SOFTWARE\Microsoft\Enrollments (no DiscoveryServiceFullURL)' high
}

check_mdm() {
  # Needs hivexsh: enrolments are GUID SUBKEYS, which only hivexsh can list.
  lock_win_blocked mdm "Intune / MDM enrolment" hivexsh && return

  # The key name goes in as an ARGUMENT, never inside the format string.
  # 'cd Microsoft\Enrollments\n' looks harmless and is not: printf reads \E as
  # ESC, so the command became "cd Microsoft<0x1b>nrollments", the cd failed
  # silently, and the check then reported "no MDM enrolment" on every machine
  # it was ever run against.
  local hivesh_ls='cd %s\nls\n'
  if ! printf "$hivesh_ls" 'Microsoft' | hivexsh "$WIN_SOFTWARE" >/dev/null 2>&1; then
    lock_add mdm "Intune / MDM enrolment" UNKNOWN \
      "The SOFTWARE hive could not be walked, so enrolment state is unknown" \
      'offline registry (hivexsh could not read the hive)' low
    return
  fi

  # The SAME two mistakes 45526b2 took out of check_entra's JoinInfo listing,
  # which lived here untouched because that fix went looking at one function
  # instead of one construct:
  #
  #   - subkeys were kept only if they matched ^[0-9a-f]{8}- . A listing line
  #     that does not (a leading space, a name that is not GUID-shaped) was
  #     dropped, and an ENROLLED machine then reported PASS.
  #   - hivexsh's exit status was discarded, so a subtree that would not walk
  #     was indistinguishable from one holding no enrolments. The `cd Microsoft`
  #     probe above proves the HIVE opens; it says nothing about Enrollments.
  #
  # The shape was never the evidence. Take every listed subkey and let the
  # per-enrolment reads below decide, and treat a failed listing as unknown.
  local enrolments ls_rc
  enrolments=$(printf "$hivesh_ls" 'Microsoft\Enrollments' 2>/dev/null \
    | hivexsh "$WIN_SOFTWARE" 2>/dev/null)
  ls_rc=$?
  if [ "$ls_rc" -ne 0 ]; then
    lock_add mdm "Intune / MDM enrolment" UNKNOWN \
      "The Enrollments key could not be listed, so enrolment state is unknown. A hive left dirty by fast start-up or hibernation reads this way." \
      'offline registry (Enrollments listing failed)' low
    return
  fi

  local g p url upn org="" provider="" name
  for g in $enrolments; do
    # Single-quote the literal half and double-quote the variable: inside one
    # pair of double quotes "...\$g" is an escaped dollar, which substitutes
    # nothing and swallows the separator.
    local key='Microsoft\Enrollments\'"$g"
    p=$(lock_hive_get "$WIN_SOFTWARE" "$key" ProviderID 2>/dev/null)
    url=$(lock_hive_get "$WIN_SOFTWARE" "$key" DiscoveryServiceFullURL 2>/dev/null)
    # A READ that failed is not an enrolment that lacks a management server.
    # lock_hive_get returns non-zero when the value is absent (fine - that is
    # what a built-in Local/Cloud/Deploy Authority entry looks like) and ALSO
    # when hivexget could not read the hive at all. Only the second is a
    # problem, and the two were the same empty string: every enrolment then
    # fell to `continue` and the machine reported PASS with a detail asserting
    # the built-in entries "are present" - a positive claim about a listing we
    # may never have obtained. hivexget is only guarded for its presence, not
    # its success, so this is reachable whenever the SOFTWARE hive opens for
    # hivexsh but not for hivexget.
    if [ -z "$url" ] && ! lock_hive_get "$WIN_SOFTWARE" "$key" ProviderID >/dev/null 2>&1 \
       && ! lock_hive_haskey "$WIN_SOFTWARE" "$key"; then
      lock_add mdm "Intune / MDM enrolment" UNKNOWN \
        "An enrolment key was listed but could not be read, so enrolment state is unknown." \
        'offline registry (enrolment values unreadable)' low
      return
    fi
    name=$(_mdm_provider "$p" "$url")
    [ -n "$name" ] || continue
    provider="$provider
$name"
    # The organisation is worth recording; the individual who used to own the
    # account is not. Keep the domain, drop the local part.
    upn=$(lock_hive_get "$WIN_SOFTWARE" "$key" UPN 2>/dev/null)
    case "$upn" in *@*) org="${upn##*@}" ;; esac
  done

  provider=$(printf '%s' "$provider" | grep -v '^$' | sort -u | paste -sd', ' -)
  _mdm_verdict "$provider" "$org"
}

# --- shared helpers for the two directory checks ------------------------------

# Trim a registry string: drop NULs and CRs, then leading and trailing space.
_lock_sz() {
  printf '%s' "$1" | LC_ALL=C tr -d '\000\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

# Join accumulated evidence lines into one readable sentence fragment.
_lock_join() {
  printf '%s\n' "$1" | grep -v '^[[:space:]]*$' |
    awk 'NR>1{printf "; "} {printf "%s", $0} END{ if (NR) printf "\n" }'
}

# Pull a host or domain name out of an LSA policy blob.
#
# These values are not tidy REG_SZ strings: they are a short binary header
# followed by the name in UTF-16LE. The NULs are already gone by the time this
# sees the data (lock_hive_get_default strips them inside the pipeline), but the
# header bytes are not, so print the longest thing that actually LOOKS like a
# name rather than printing the blob. A blob that yields nothing means "could
# not name it" — it never means "not joined", and no verdict turns on it.
_lock_lsa_name() {
  printf '%s' "$1" | LC_ALL=C tr -c 'A-Za-z0-9.-' '\n' |
    LC_ALL=C grep -E '^[A-Za-z0-9][A-Za-z0-9.-]{0,62}[A-Za-z0-9]$' |
    awk '{ if (length($0) > length(b)) b=$0 } END { if (b != "") print b }'
}

# cn=...,DC=contoso,DC=com  ->  contoso.com
_lock_dn_domain() {
  printf '%s' "$1" | tr 'A-Z' 'a-z' | tr ',' '\n' | sed -n 's/^[[:space:]]*dc=//p' |
    awk 'NR>1{printf "."} {printf "%s", $0} END{ if (NR) printf "\n" }'
}

# Bytes of real content in one cached-logon slot.
#
# Split out as its own function for two reasons. The NUL stripping has to happen
# INSIDE the pipeline — bash throws NUL bytes out of a command substitution
# without saying a word, so counting after the fact gives a number that happens
# to be right for the wrong reason. And it gives the fixtures one thing to stub.
#
# PRESENCE AND SIZE ONLY. The blob is encrypted credential material for somebody
# who used to work somewhere. Nothing here decrypts it, nothing here wants to,
# and nothing that does may be added.
_lock_nl_bytes() {
  hivexget "$WIN_SECURITY" 'Cache' "$1" 2>/dev/null |
    LC_ALL=C tr -d '\000' | wc -c | tr -d ' \n'
}

# How many of the ten cached-logon slots hold something that is not padding.
# An unused slot is zero-filled, so the NUL strip above empties it; a real
# cached credential is a couple of hundred bytes of ciphertext. The 16-byte
# floor is a margin against a slot header being mistaken for a credential.
_lock_cached_logons() {
  local i n=0 bytes
  lock_has hivexget || { printf '0'; return 1; }
  for i in 1 2 3 4 5 6 7 8 9 10; do
    bytes=$(_lock_nl_bytes 'NL$'"$i")
    case "$bytes" in ''|*[!0-9]*) continue ;; esac
    [ "$bytes" -gt 16 ] && n=$((n+1))
  done
  printf '%s' "$n"
}

# --- Microsoft Entra ID (Azure AD) join ---------------------------------------
#
# PRIVACY. The same rule as check_mdm above, restated here because this is the
# key where breaking it is most tempting: JoinInfo holds the previous user's
# UserEmail, sitting right next to the tenant fields. IT IS NEVER READ. This
# audit ends up in an inventory database that gets exported and emailed, and a
# former employee's address is nobody's business here. What proves the lock, and
# what an administrator actually needs in order to deregister the device, is the
# ORGANISATION and the DEVICE: TenantId, TenantDisplayName, IdpDomain, DeviceId.
# That is the whole list. Do not add UserEmail capture.
#
# JoinType is deliberately not read either. It is a DWORD with no published
# mapping anyone can point at, the numbers reported in the wild disagree, and a
# verdict resting on a guessed enum is a verdict that will be wrong on some
# build of Windows nobody tested. Presence of a join is established from the key
# itself; the type of join changes nothing about who has to release it.
check_entra() {
  # Needs hivexsh for the JoinInfo subkey listing, not just hivexget.
  lock_win_blocked entra "Microsoft Entra ID join" hivexsh && return

  # The answer lives in the SYSTEM hive. Without it we have read nothing, and
  # the old code fell straight through to PASS — claiming a joined machine was
  # clear on the strength of lookups that never ran.
  if [ -z "$WIN_SYSTEM" ] || [ ! -r "$WIN_SYSTEM" ]; then
    lock_add entra "Microsoft Entra ID join" UNKNOWN \
      "The Windows SYSTEM hive could not be read, so an Entra ID join can neither be confirmed nor ruled out" \
      "offline registry (SYSTEM hive unreadable)" low
    return
  fi

  lock_resolve_controlset
  local cdj="$WIN_CTRLSET"'\Control\CloudDomainJoin'
  local ji="$cdj"'\JoinInfo'

  # CloudDomainJoin\JoinInfo holds one subkey per Entra-joined identity, and is
  # absent entirely on a device that was never joined.
  if ! lock_hive_haskey "$WIN_SYSTEM" "$ji"; then
    # NOTE THE WORDING, AND NOTE HOW IT DIFFERS FROM check_domain's.
    # Domain membership is genuinely recorded on the machine, so finding none is
    # close to a real negative. An Entra join is not like that in one direction:
    # the tenant's own record of this device is in Microsoft's cloud, so while
    # an absent JoinInfo does say the device is not joined right now, it can
    # never say the organisation has let go of it. That is the tenant's
    # statement to make, not ours.
    lock_add entra "Microsoft Entra ID join" PASS \
      "No CloudDomainJoin\\JoinInfo key. Windows writes that key when a device is joined to a tenant, so this device is not currently joined to one. That is not the same as released: only the owning tenant can confirm it has given the device up, and this says nothing about an Autopilot registration, which is held in the cloud against the hardware hash. The registry transaction logs are not replayed offline either, so a join made just before a fast-start-up or hibernation shutdown may not have reached the hive we are reading." \
      "offline registry SYSTEM\\$WIN_CTRLSET\\Control\\CloudDomainJoin (absent)" medium
    return
  fi

  local sub rc
  # Key name as an argument, never inside the format string - see check_mdm.
  sub=$(printf 'cd %s\nls\n' "$ji" | hivexsh "$WIN_SYSTEM" 2>/dev/null)
  rc=$?
  # Two ways this used to report an Entra-joined machine as CLEAR, which is the
  # worst answer this file can give:
  #
  # 1. It kept only subkeys matching ^[0-9a-f]{8}- . The subkey under JoinInfo
  #    is reported in the wild as a GUID and as a 40-character certificate
  #    thumbprint; a thumbprint matched nothing, so the run fell through to
  #    PASS. The shape was never the evidence - lock_hive_haskey above has
  #    ALREADY proved the key exists. Any listing at all is the signal,
  #    whatever the subkey happens to be called.
  #
  # 2. hivexsh's failures were indistinguishable from an empty listing: a dirty
  #    or truncated hive exits non-zero with nothing on stdout, and that also
  #    read as "no subkeys" and PASSed. Per this file's governing rule a read
  #    that did not happen is UNKNOWN, never PASS.
  if [ "$rc" -ne 0 ]; then
    lock_add entra "Microsoft Entra ID join" UNKNOWN \
      "The CloudDomainJoin key is present but could not be listed, so an Entra ID join can neither be confirmed nor ruled out. A hive left dirty by fast start-up or hibernation reads this way." \
      'offline registry SYSTEM\...\CloudDomainJoin (listing failed)' low
    return
  fi
  if ! printf '%s' "$sub" | grep -q '[^[:space:]]'; then
    # The key only exists on a device that was joined, so an empty listing is
    # odd rather than reassuring. Say so instead of calling the device clear.
    lock_add entra "Microsoft Entra ID join" UNKNOWN \
      "The CloudDomainJoin key exists but names no joined identity. That key is not present on a device that was never joined, so this cannot be read as clear." \
      'offline registry SYSTEM\...\CloudDomainJoin (key present, no entries)' low
    return
  fi

  # WHICH ORGANISATION. A join proved but not named leaves the operator with
  # nothing to act on: deregistration has to be chased with the tenant, and you
  # cannot chase a tenant you cannot name. So read INSIDE JoinInfo.
  local id
  id=$(printf '%s\n' "$sub" | grep '[^[:space:]]' | head -1 | tr -d ' \t\r')
  local tid="" tname="" idp="" devid="" mdmurl="" org=""
  if [ -n "$id" ]; then
    local jk="$ji"'\'"$id"
    tid=$(_lock_sz "$(lock_hive_get "$WIN_SYSTEM" "$jk" TenantId 2>/dev/null)")
    tname=$(_lock_sz "$(lock_hive_get "$WIN_SYSTEM" "$jk" TenantDisplayName 2>/dev/null)")
    idp=$(_lock_sz "$(lock_hive_get "$WIN_SYSTEM" "$jk" IdpDomain 2>/dev/null)")
    devid=$(_lock_sz "$(lock_hive_get "$WIN_SYSTEM" "$jk" DeviceId 2>/dev/null)")
    # UserEmail is in this same key and is NOT read. See the privacy note above.
  fi

  # Corroboration only, and secondary. TenantInfo\<TenantId> carries the
  # tenant's MDM enrolment endpoints, which is a second, independent place the
  # same tenant is written down. It is MEDIUM confidence and unverified against
  # real hardware, so it strengthens a verdict that is already made — it never
  # makes one, and its absence means nothing.
  if [ -n "$tid" ]; then
    mdmurl=$(_lock_sz "$(lock_hive_get "$WIN_SYSTEM" "$cdj"'\TenantInfo\'"$tid" MdmEnrollmentUrl 2>/dev/null)")
  fi

  org="$tname"
  [ -z "$org" ] && org="$idp"

  local detail="Joined to Microsoft Entra ID (Azure AD)"
  if [ -n "$org" ] || [ -n "$tid" ]; then
    detail="$detail${org:+ - organisation $org}${tid:+ (tenant id $tid)}"
  else
    detail="$detail, but JoinInfo named no tenant that could be read, so the owning organisation is not identified here"
  fi
  detail="$detail${devid:+. Device id $devid, which is what an administrator needs in order to deregister it}"
  # NO APOSTROPHES INSIDE ${var:+...}. Bash parses a single quote inside a
  # parameter expansion as opening a quoted section even when the whole
  # expansion is already inside double quotes, and "the tenant's MDM endpoint"
  # here swallowed the rest of the function: bash -n reported the syntax error
  # ninety lines further down, in a string that was perfectly well formed.
  detail="$detail${mdmurl:+. An MDM enrolment endpoint for that tenant is recorded alongside it ($mdmurl), which corroborates the join}"
  detail="$detail. Only that tenant can release the device, and nothing readable offline can ever show that it has: an Entra join found here can be confirmed but never downgraded. Registry transaction logs are not replayed offline, so a join or unjoin made just before a fast-start-up or hibernation shutdown may not be visible in this hive."

  lock_add entra "Microsoft Entra ID join" LOCKED "$detail" \
    "offline registry SYSTEM\\$WIN_CTRLSET\\Control\\CloudDomainJoin\\JoinInfo${mdmurl:+ + TenantInfo}" high
}

# --- Active Directory domain join ---------------------------------------------
#
# WHERE THE PROOF IS. Domain membership, unlike an Entra join, is written down
# on the machine by the LSA — in the SECURITY hive, which is why this file now
# opens it. Everything else below is a consequence of having been joined
# (policy, site, DNS suffix) and survives an unjoin, so it can show that a
# machine HAS been in a domain without showing that it still is.
#
# EVERY NEGATIVE HERE IS A TRAP, and each one was checked on a clean Windows 11
# that has never seen a domain controller. Testing for the presence of a key
# instead of the content of a value gives a false positive on every machine
# ever made:
#
#   Group Policy\History        EXISTS, with DSPath = LocalGPO. The
#                               discriminator is a DSPath beginning LDAP://,
#                               never "History has a subkey".
#   State\Machine\
#     Distinguished-Name        EXISTS as an EMPTY REG_SZ. Must be non-empty.
#   Netlogon\Parameters         EXISTS (DisablePasswordChange and friends). Key
#                               presence proves nothing; DynamicSiteName is the
#                               value that is absent until a DC is reached.
#   Tcpip\Parameters\Domain     EXISTS as an empty REG_SZ, so an empty read is
#                               not a detection.
#   Winlogon\CachedLogonsCount  is REG_SZ "10" on EVERY Windows. No evidential
#                               value whatsoever — deliberately not used.
#   SAM                         is NOT evidence: a domain-joined machine's SAM
#                               is structurally identical to a workgroup one.
#   ActiveComputerName          is a VOLATILE key. It is not in the hive file at
#                               all and cannot be read offline; ComputerName is
#                               the one that persists.
check_domain() {
  # Needs hivexsh: the SECURITY evidence is key PRESENCE, which only hivexsh can
  # establish, and hivexget cannot reach a default (unnamed) value either.
  lock_win_blocked domainJoin "Active Directory domain join" hivexsh && return

  lock_resolve_controlset

  local proof="" strong="" weak="" unread="" name="" dn="" corroborated=0

  # hivexget reads every VALUE below. Without it the value-based evidence simply
  # does not happen, and a check that did not happen is not a check that came
  # back negative.
  lock_has hivexget || unread="$unread
registry values (hivexget is not installed)"

  # ---- SECURITY: the primary domain record --------------------------------
  # Probe a key that exists on every Windows BEFORE reading anything else. Once
  # `Policy` is known to be walkable, a later "key not found" means the key
  # really is absent instead of meaning the hive could not be opened — which is
  # the difference between "not in a domain" and "we did not look", and this
  # file never collapses those two into one answer.
  local sid_key=0 sid_val=""
  if [ -n "$WIN_SECURITY" ] && lock_hive_haskey "$WIN_SECURITY" 'Policy'; then
    # PolPrDmS is the primary domain SID. A workgroup machine has no primary
    # domain, so this is the best offline discriminator there is.
    if lock_hive_haskey "$WIN_SECURITY" 'Policy\PolPrDmS'; then
      sid_key=1
      sid_val=$(lock_hive_get_default "$WIN_SECURITY" 'Policy\PolPrDmS')
      proof="a primary domain SID is recorded (SECURITY Policy\\PolPrDmS)"
    fi

    # PolPrDmN and PolDnDDN NAME the domain. They are read for the name and for
    # nothing else, and on purpose: the NetBIOS-name key is reported as existing
    # on standalone machines holding an empty value, and this file has been
    # bitten before by treating "the key is there" as "the thing is true". The
    # SID above decides; these two only say what to call it.
    local v
    v=$(lock_hive_get_default "$WIN_SECURITY" 'Policy\PolPrDmN') && name=$(_lock_lsa_name "$v")
    v=$(lock_hive_get_default "$WIN_SECURITY" 'Policy\PolDnDDN') && {
      v=$(_lock_lsa_name "$v"); [ -n "$v" ] && name="$v"
    }

    # Policy\Secrets\$MACHINE.ACC is the computer account's secret. Its
    # existence proves a computer account was established in a domain.
    #
    # UNCERTAIN, AND WORDED AS SUCH: it has not been established whether Windows
    # removes this secret when a machine is unjoined. Until that is known it is
    # evidence of HAVING BEEN joined, not of being joined now, so it corroborates
    # and never concludes. CurrVal beneath it is encrypted credential material
    # and is not read, decrypted or touched.
    if lock_hive_haskey "$WIN_SECURITY" 'Policy\Secrets\$MACHINE.ACC'; then
      strong="$strong
a computer-account secret exists (SECURITY Policy\\Secrets\\\$MACHINE.ACC), so this machine held a computer account in a domain"
    fi

    # Cached domain logons. Presence and size only — see _lock_nl_bytes.
    local nl
    nl=$(_lock_cached_logons)
    case "$nl" in
      ''|0|*[!0-9]*) : ;;
      *) strong="$strong
$nl cached domain logon slot(s) hold credential material (SECURITY Cache\\NL\$1..NL\$10), so domain accounts have signed in here" ;;
    esac
  else
    # THE EXPENSIVE DIRECTION. Without SECURITY the primary domain record was
    # never read, so a quiet SOFTWARE and SYSTEM cannot add up to "not joined".
    unread="$unread
the SECURITY hive, which is where the primary domain record lives"
  fi

  # ---- SOFTWARE: Group Policy ---------------------------------------------
  if [ -n "$WIN_SOFTWARE" ] && [ -r "$WIN_SOFTWARE" ]; then
    local gp='Microsoft\Windows\CurrentVersion\Group Policy'
    local guids g dsp
    guids=$(printf 'cd %s\nls\n' "$gp"'\History' | hivexsh "$WIN_SOFTWARE" 2>/dev/null |
            grep '[^[:space:]]' | head -40)
    for g in $guids; do
      dsp=$(_lock_sz "$(lock_hive_get "$WIN_SOFTWARE" "$gp"'\History\'"$g"'\0' DSPath 2>/dev/null)")
      # LocalGPO here is the standalone machine's own policy and means nothing.
      case "$dsp" in
        LDAP://*|ldap://*)
          strong="$strong
a domain group policy was applied from $dsp (SOFTWARE Group Policy History DSPath)"
          [ -n "$dn" ] || dn="${dsp#[Ll][Dd][Aa][Pp]://}"
          break ;;
      esac
    done

    local dnv
    dnv=$(_lock_sz "$(lock_hive_get "$WIN_SOFTWARE" "$gp"'\State\Machine' Distinguished-Name 2>/dev/null)")
    if [ -n "$dnv" ]; then
      strong="$strong
the machine has a directory distinguished name, $dnv (SOFTWARE Group Policy State\\Machine)"
      [ -n "$dn" ] || dn="$dnv"
    fi
  else
    unread="$unread
the SOFTWARE hive"
  fi

  # ---- SYSTEM: Netlogon and TCP/IP ----------------------------------------
  if [ -n "$WIN_SYSTEM" ] && [ -r "$WIN_SYSTEM" ]; then
    local site
    site=$(_lock_sz "$(lock_hive_get "$WIN_SYSTEM" "$WIN_CTRLSET"'\Services\Netlogon\Parameters' DynamicSiteName 2>/dev/null)")
    [ -n "$site" ] && strong="$strong
the machine has been told its Active Directory site, $site (SYSTEM Netlogon DynamicSiteName), which is only written after reaching a domain controller"

    # Tcpip\Parameters\Domain is the DNS domain SUFFIX, which a machine can
    # carry from DHCP without ever having been domain-JOINED. Reported as an
    # indicator, never on its own as a lock — and it exists as an empty REG_SZ
    # on clean machines, so only a non-empty read means anything.
    local tdom ndom
    tdom=$(_lock_sz "$(lock_hive_get "$WIN_SYSTEM" "$WIN_CTRLSET"'\Services\Tcpip\Parameters' Domain 2>/dev/null)")
    ndom=$(_lock_sz "$(lock_hive_get "$WIN_SYSTEM" "$WIN_CTRLSET"'\Services\Tcpip\Parameters' 'NV Domain' 2>/dev/null)")
    [ -z "$tdom" ] && tdom="$ndom"
    if [ -n "$tdom" ]; then
      weak="carries the DNS domain suffix $tdom (SYSTEM Tcpip\\Parameters)"
      [ -n "$name" ] || name="$tdom"
    fi
  else
    unread="$unread
the SYSTEM hive"
  fi

  [ -n "$name" ] || name=$(_lock_dn_domain "$dn")
  local named=""
  [ -n "$name" ] && named=" - domain $name"

  local strongtxt; strongtxt=$(_lock_join "$strong")
  local unreadtxt; unreadtxt=$(_lock_join "$unread")
  [ -n "$strongtxt" ] && corroborated=1

  # The one sentence that has to be on every answer this check gives: hivex does
  # not replay SYSTEM.LOG1/LOG2, so a hive left dirty by fast start-up or
  # hibernation can be missing its last transactions.
  local caveat="Registry transaction logs are not replayed offline, so a join or unjoin made just before a fast-start-up or hibernation shutdown may not be visible in these hives."

  # ---- verdict -------------------------------------------------------------
  # A live primary-domain record WITH something to corroborate it. This is a
  # machine that is in a domain now.
  if [ "$sid_key" = "1" ] && [ "$corroborated" = "1" ]; then
    lock_add domainJoin "Active Directory domain join" LOCKED \
      "Joined to an Active Directory domain$named. Evidence: $proof; $strongtxt. The domain's administrators control the computer account; rejoining or reusing the machine elsewhere means removing it from that directory. $caveat" \
      "offline registry SECURITY Policy + SOFTWARE/SYSTEM corroboration" high
    return
  fi

  # The SID record alone. Reported, but not as a lock: it has not been possible
  # to establish here whether that key is genuinely absent on every workgroup
  # machine, and one unverified key presence is not enough to call a device
  # unsellable on its own.
  if [ "$sid_key" = "1" ]; then
    lock_add domainJoin "Active Directory domain join" DETECTED \
      "A primary domain record is present$named ($proof${sid_val:+, value readable}), but nothing else on this machine corroborates a current domain join - no domain group policy, no directory name, no site and no cached domain logons. Treat as a machine that has been in a domain. $caveat" \
      "offline registry SECURITY Policy\\PolPrDmS (uncorroborated)" medium
    return
  fi

  # No live record, but the machine plainly carries the marks of having been in
  # a domain. Those marks survive an unjoin, so this is history, not membership.
  if [ "$corroborated" = "1" ]; then
    local why="absent, which is what an unjoined machine looks like."
    [ -n "$unreadtxt" ] && why="not readable ($unreadtxt), so current membership could not be established either way."
    lock_add domainJoin "Active Directory domain join" DETECTED \
      "This machine has been joined to an Active Directory domain$named: $strongtxt. The LSA primary domain record that would show a CURRENT join was $why $caveat" \
      "offline registry SOFTWARE/SYSTEM domain traces" medium
    return
  fi

  # Only the DNS suffix. An indicator, not proof, and never a lock on its own.
  if [ -n "$weak" ]; then
    lock_add domainJoin "Active Directory domain join" DETECTED \
      "No domain membership record was found, but the machine $weak. A DNS suffix can be handed out by DHCP to a machine that was never joined, so this is an indicator of past domain membership, not proof of a join. $caveat" \
      "offline registry SYSTEM\\$WIN_CTRLSET\\Services\\Tcpip\\Parameters" low
    return
  fi

  # Something we needed was unreadable and we found nothing. That is not a
  # negative result, it is an absent one.
  if [ -n "$unreadtxt" ]; then
    lock_add domainJoin "Active Directory domain join" UNKNOWN \
      "Domain membership could not be established: $unreadtxt could not be read. No domain traces were found in what could be read, but the record that would settle it was not among it, so this must not be read as clear. $caveat" \
      "offline registry (required hives unreadable)" low
    return
  fi

  # Everything was read and nothing was found.
  #
  # NOTE THE WORDING, AND NOTE HOW IT DIFFERS FROM check_entra's. This is the
  # strongest negative this file is able to produce, because domain state really
  # is written on the machine: the LSA primary domain record, the computer
  # account secret, the applied policy, the site and the cached logons are all
  # local, and all of them are quiet. It still is not proof, and the reason is
  # the transaction logs rather than anything in the cloud.
  lock_add domainJoin "Active Directory domain join" PASS \
    "No Active Directory domain membership found. The LSA primary domain record is absent, no computer-account secret exists, no domain group policy has been applied, no directory distinguished name is set, no site has been assigned and no domain logons are cached. Domain membership is recorded on the machine itself, so finding none of it is close to a real negative - unlike an Entra or Autopilot answer, which lives in the cloud. $caveat" \
    "offline registry SECURITY Policy + SOFTWARE Group Policy + SYSTEM Netlogon" medium
}

# --- BitLocker ---------------------------------------------------------------
# Not an ownership lock, but a practical resale blocker: an encrypted volume
# without its recovery key is unreadable, and the data on it cannot be verified
# as wiped without destroying the volume.
check_bitlocker() {
  lock_need_root bitlocker "BitLocker" && return
  if ! lock_has blkid; then
    lock_add bitlocker "BitLocker" UNKNOWN "blkid unavailable, so volume encryption could not be checked" "block device scan" low
    return
  fi
  # blkid exits 2 when it finds nothing, so a bare exit status cannot separate
  # "no encrypted volumes" from "could not look". Require actual output before
  # concluding anything: with no output at all we do not know, and saying PASS
  # there was a reproduced false negative.
  local out
  out=$(blkid 2>/dev/null)
  if [ -z "$out" ]; then
    lock_add bitlocker "BitLocker" UNKNOWN "blkid returned nothing, so volume encryption could not be determined" "block device scan (no output)" low
    return
  fi
  # Count the TYPE field, not the line. `grep -ci BitLocker` counted any line
  # containing the word, so a USB stick labelled "BitLocker Recovery Keys" on a
  # vfat volume raised a WARNING about an encrypted disk that does not exist -
  # the whole-record grep this file's own roll-up forbids at the status field.
  local enc
  enc=$(printf '%s' "$out" | grep -c 'TYPE="[Bb]it[Ll]ocker')
  if [ "${enc:-0}" -gt 0 ]; then
    lock_add bitlocker "BitLocker" WARNING "$enc encrypted volume(s) found — the recovery key is needed to read or verify them" "blkid volume signatures" high
    return
  fi

  # Two ways this used to report a machine with an encrypted disk as having
  # none, both reproduced:
  #
  #   1. blkid enumerated only PART of the machine. On a live-USB boot blkid
  #      always prints the stick, so the empty-output guard above never fires;
  #      an internal disk hidden behind a RAID/Intel RST controller, unbound or
  #      failing, simply is not in the list, and its absence read as "no
  #      BitLocker anywhere".
  #   2. An older libblkid types a BitLocker volume as plain ntfs. This file
  #      already knows blkid's TYPE is unreliable - lock_is_bitlocker exists
  #      for exactly that and falls back to the -FVE-FS- signature.
  #
  # WIN_ENCRYPTED is set by the Windows mount attempt, which runs before this
  # detector and uses that signature. Honouring it also stops the report
  # contradicting itself: the Microsoft rows said "a BitLocker volume is
  # present and cannot be read" while this row said there were none.
  if [ -n "${WIN_ENCRYPTED:-}" ]; then
    lock_add bitlocker "BitLocker" WARNING \
      "An encrypted volume was found by signature while looking for Windows, though blkid did not type it as BitLocker. The recovery key is needed to read or verify it." \
      "volume signature (-FVE-FS-)" high
    return
  fi
  lock_add bitlocker "BitLocker" PASS \
    "No BitLocker-encrypted volumes found among the volumes blkid could see" \
    "blkid volume signatures" medium
}

# =============================================================================
# RUNNER, ROLLUP AND OUTPUT
# =============================================================================

# Add a detector here and it appears in the report, the JSON and the rollup.
LOCK_DETECTORS="
check_autopilot
check_mdm
check_entra
check_domain
check_bios_password
check_secure_boot
check_setup_mode
check_tpm
check_absolute
check_bitlocker
"

run_lock_checks() {
  LOCK_ROWS=""
  local d
  for d in $LOCK_DETECTORS; do
    # A detector that crashes must not take the audit down with it, and must
    # not silently vanish either — it becomes an UNKNOWN row.
    if ! "$d" 2>/dev/null; then
      case "$LOCK_ROWS" in
        *"${d#check_}"*) : ;;
        *) lock_add "${d#check_}" "${d#check_}" UNKNOWN "Detector failed to run" "$d" low ;;
      esac
    fi
  done
  lock_unmount_windows
}

# DEVICE STATUS: the single word a buyer acts on.
#
# Precedence is deliberate. UNVERIFIED outranks CLEAR, so a device is only ever
# called CLEAR when every check actually ran and every one came back negative.
# Anything we could not look at leaves the whole verdict UNVERIFIED.
lock_status() {
  # Parse the STATUS FIELD, never the raw row text. Grepping the whole record
  # for "|LOCKED|" meant a PASS row whose detail merely mentioned those letters
  # flipped the entire device verdict — reproduced with a BIOS value of
  # "Deactivate|LOCKED|yes". Field 3 is the status and nothing else is.
  local sts
  sts=$(printf '%s' "$LOCK_ROWS" | cut -d'|' -f3)
  printf '%s\n' "$sts" | grep -qx 'LOCKED'            && { echo LOCKED; return; }
  printf '%s\n' "$sts" | grep -qxE 'DETECTED|WARNING' && { echo WARNING; return; }
  printf '%s\n' "$sts" | grep -qx 'UNKNOWN'           && { echo UNVERIFIED; return; }
  echo CLEAR
}

lock_status_blurb() {
  case "$1" in
    LOCKED)     echo "an ownership or management lock was found — this machine cannot be freely resold" ;;
    WARNING)    echo "restrictions found that may affect refurbishment" ;;
    UNVERIFIED) echo "some checks could not be completed — treat as unproven, not as clear" ;;
    CLEAR)      echo "every check ran and found no locks" ;;
  esac
}

print_lock_report() {
  local status row key label st detail method conf
  status=$(lock_status)

  echo
  echo "================ Device Locks & Management Status ================"
  printf "  DEVICE STATUS: %s — %s\n" "$status" "$(lock_status_blurb "$status")"
  echo

  printf '%s' "$LOCK_ROWS" | while IFS='|' read -r key label st detail method conf; do
    [ -n "$key" ] || continue
    # Status word first and always spelled out: never colour alone, and never a
    # bare tick that a tired operator reads as "fine".
    printf "  %-10s %-26s %s\n" "$st" "$label" "$detail"
    printf "  %-10s %-26s   via %s (confidence: %s)\n" "" "" "$method" "$conf"
  done

  echo
  if [ "$status" = "UNVERIFIED" ] || [ "$status" = "LOCKED" ]; then
    echo "  Note: locks are REPORTED here, never removed. Clearing an Autopilot or"
    echo "  MDM registration is the registering organisation's job through"
    echo "  Microsoft's own deregistration process."
  fi
  echo "================================================================="
}

# JSON for upload. Uses the same o_* helpers as the rest of the audit so the
# escaping rules stay in one place.
lock_json() {
  local out="" row key label st detail method conf first=1
  out="{\"status\":\"$(lock_status)\",\"checks\":["
  while IFS='|' read -r key label st detail method conf; do
    [ -n "$key" ] || continue
    [ "$first" = 1 ] || out="$out,"
    first=0
    out="$out{\"key\":\"$(esc "$key")\",\"label\":\"$(esc "$label")\",\"status\":\"$(esc "$st")\",\"detail\":\"$(esc "$detail")\",\"method\":\"$(esc "$method")\",\"confidence\":\"$(esc "$conf")\"}"
  done <<EOF
$(printf '%s' "$LOCK_ROWS")
EOF
  printf '%s]}' "$out"
}

# The single boolean the API has always taken. Kept in step with the detailed
# report rather than computed separately: true only when something is actually
# LOCKED, so it never contradicts the section above it.
lock_bios_locked() {
  printf '%s' "$LOCK_ROWS" | grep -q '|LOCKED|' && echo true || echo false
}
