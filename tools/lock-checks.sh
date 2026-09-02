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

  local dev
  for dev in $(lsblk -pnro NAME,FSTYPE 2>/dev/null | awk '$2=="ntfs"||$2=="ntfs3"{print $1}'); do
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
  [ -d "$LOCK_SYSROOT/sys/firmware/efi" ] || return 0
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
        readany=1
        [ "$v" = "1" ] && detail="${detail}${which} password is SET. "
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

lock_locate_hives() {
  [ -n "$WIN_SOFTWARE" ] && return 0
  lock_mount_windows || return 1
  local cfg="$WIN_MNT/Windows/System32/config"
  [ -r "$cfg/SOFTWARE" ] && WIN_SOFTWARE="$cfg/SOFTWARE"
  [ -r "$cfg/SYSTEM" ]   && WIN_SYSTEM="$cfg/SYSTEM"
  [ -n "$WIN_SOFTWARE" ]
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

  local enrolments
  enrolments=$(printf "$hivesh_ls" 'Microsoft\Enrollments' 2>/dev/null \
    | hivexsh "$WIN_SOFTWARE" 2>/dev/null \
    | grep -Ei '^[0-9a-f]{8}-' | head -40)

  local g p url upn org="" provider="" name
  for g in $enrolments; do
    # Single-quote the literal half and double-quote the variable: inside one
    # pair of double quotes "...\$g" is an escaped dollar, which substitutes
    # nothing and swallows the separator.
    local key='Microsoft\Enrollments\'"$g"
    p=$(lock_hive_get "$WIN_SOFTWARE" "$key" ProviderID 2>/dev/null)
    url=$(lock_hive_get "$WIN_SOFTWARE" "$key" DiscoveryServiceFullURL 2>/dev/null)
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

# --- Entra ID / Azure AD join and domain join --------------------------------
check_entra() {
  # Needs hivexsh for the JoinInfo subkey listing, not just hivexget.
  lock_win_blocked entra "Entra ID / domain join" hivexsh && return

  # Both answers live in the SYSTEM hive. Without it we have read nothing, and
  # the old code fell straight through to PASS — claiming a domain-joined
  # machine was clear on the strength of two lookups that never ran.
  if [ -z "$WIN_SYSTEM" ] || [ ! -r "$WIN_SYSTEM" ]; then
    lock_add entra "Entra ID / domain join" UNKNOWN \
      "The Windows SYSTEM hive could not be read, so directory membership is unknown" \
      "offline registry (SYSTEM hive unreadable)" low
    return
  fi

  local joined=""
  # CloudDomainJoin\JoinInfo holds one subkey per Entra-joined identity.
  if lock_hive_haskey "$WIN_SYSTEM" 'ControlSet001\Control\CloudDomainJoin\JoinInfo'; then
    local sub
    # Key name as an argument, never inside the format string - see check_mdm.
    # This particular path survives, but only by luck: \C and \J are not printf
    # escapes. A segment starting with a b e f n r t v u x or a digit would be
    # mangled the same way \Enrollments was, and \c would truncate the command.
    sub=$(printf 'cd %s\nls\n' 'ControlSet001\Control\CloudDomainJoin\JoinInfo' | hivexsh "$WIN_SYSTEM" 2>/dev/null | grep -Ei '^[0-9a-f]{8}-' | head -1)
    [ -n "$sub" ] && joined="Entra ID (Azure AD) joined"
  fi

  # NOTE: Tcpip\Parameters\Domain is the DNS domain suffix, which a machine can
  # carry without being domain-JOINED. It is reported as an indicator, not as
  # proof, and never on its own as a lock.
  local dom
  dom=$(lock_hive_get "$WIN_SYSTEM" 'ControlSet001\Services\Tcpip\Parameters' Domain 2>/dev/null)

  if [ -n "$joined" ]; then
    lock_add entra "Entra ID / domain join" LOCKED \
      "$joined${dom:+; DNS domain $dom} — the device is bound to an organisation's directory" \
      'offline registry SYSTEM\...\CloudDomainJoin' high
    return
  fi
  if [ -n "$dom" ]; then
    lock_add entra "Entra ID / domain join" DETECTED \
      "Carries the DNS domain suffix $dom. That is an indicator of past domain membership, not proof of a current join." \
      'offline registry SYSTEM\...\Tcpip\Parameters' low
    return
  fi
  lock_add entra "Entra ID / domain join" PASS "No Entra ID join or AD domain membership found" 'offline registry SYSTEM hive' medium
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
  local enc
  enc=$(printf '%s' "$out" | grep -ci 'BitLocker')
  if [ "${enc:-0}" -gt 0 ]; then
    lock_add bitlocker "BitLocker" WARNING "$enc encrypted volume(s) found — the recovery key is needed to read or verify them" "blkid volume signatures" high
    return
  fi
  lock_add bitlocker "BitLocker" PASS "No BitLocker-encrypted volumes found" "blkid volume signatures" medium
}

# =============================================================================
# RUNNER, ROLLUP AND OUTPUT
# =============================================================================

# Add a detector here and it appears in the report, the JSON and the rollup.
LOCK_DETECTORS="
check_autopilot
check_mdm
check_entra
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
