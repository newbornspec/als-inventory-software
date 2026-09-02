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

# lock_add <key> <label> <status> <detail> <method> <confidence>
#   status: PASS | DETECTED | LOCKED | WARNING | UNKNOWN
#   method: how the answer was obtained — shown to the operator so a surprising
#           result can be traced back to the thing that produced it
lock_add() {
  LOCK_ROWS="$LOCK_ROWS$1|$2|$3|$4|$5|$6
"
}

lock_field() { printf '%s' "$1" | cut -d'|' -f"$2"; }

# --- helpers -----------------------------------------------------------------
lock_has() { command -v "$1" >/dev/null 2>&1; }

# The Windows partition, mounted read-only, or empty if we could not get one.
# Set by lock_mount_windows; every Windows-side detector depends on it and
# reports UNKNOWN when it is empty.
WIN_MNT=""
WIN_MOUNTED_BY_US=""

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
    [ -n "$b" ] && { lock_add secureBoot "Secure Boot" "$([ "$b" = 1 ] && echo WARNING || echo PASS)" \
      "$([ "$b" = 1 ] && echo 'ON' || echo 'OFF')" "mokutil --sb-state" high; return; }
  fi
  case "$b" in
    1) lock_add secureBoot "Secure Boot" WARNING "ON — unsigned boot media will be refused" "UEFI variable SecureBoot" high ;;
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
    # The kernel has no TPM subsystem exposed here, which is not the same as
    # the machine having no TPM.
    lock_add tpm "TPM" UNKNOWN "No TPM subsystem exposed by this kernel — presence could not be determined" "/sys/class/tpm absent" low
    return
  fi
  if [ ! -e "$LOCK_SYSROOT/sys/class/tpm/tpm0" ]; then
    # Subsystem present, no device: genuinely no TPM exposed. Not a lock — it
    # is reported because it governs Windows 11 eligibility, and it may mean
    # the TPM is switched off in firmware rather than missing.
    lock_add tpm "TPM" PASS "No TPM exposed (absent, or disabled in firmware setup)" "/sys/class/tpm" medium
    return
  fi
  local ver detail
  ver=$(cat "$LOCK_SYSROOT/sys/class/tpm/tpm0/tpm_version_major" 2>/dev/null)
  detail="Present${ver:+ — TPM ${ver}.0}"
  # Owned/provisioned state is reported when tpm2-tools can read it. We only
  # ever READ capabilities; clearing a TPM is destructive and is never done.
  if lock_has tpm2_getcap; then
    if tpm2_getcap properties-variable 2>/dev/null | grep -qi 'ownerAuthSet.*1\|TPMA_PERMANENT.*ownerAuthSet'; then
      detail="$detail, owner authorisation SET (provisioned by a previous owner)"
      lock_add tpm "TPM" DETECTED "$detail" "/sys/class/tpm + tpm2_getcap" medium
      return
    fi
    detail="$detail, no owner authorisation set"
    lock_add tpm "TPM" PASS "$detail" "/sys/class/tpm + tpm2_getcap" high
    return
  fi
  lock_add tpm "TPM" PASS "$detail (ownership state not checked — tpm2-tools absent)" "/sys/class/tpm" medium
}

# BIOS/UEFI administrator or system password.
#
# The modern, vendor-neutral way to see this from Linux is the kernel's
# firmware-attributes class, exposed by dell-wmi-sysman (Dell), think-lmi
# (Lenovo) and hp-bioscfg (HP). is_enabled reports whether a password is SET.
# It never reveals or changes the password.
check_bios_password() {
  local base found=0 admin sysp detail=""
  for base in "$LOCK_SYSROOT"/sys/class/firmware-attributes/*/authentication; do
    [ -d "$base" ] || continue
    found=1
    admin=$(cat "$base/Admin/is_enabled" 2>/dev/null)
    sysp=$(cat "$base/System/is_enabled" 2>/dev/null)
    [ "$admin" = "1" ] && detail="${detail}Admin/Setup password is SET. "
    [ "$sysp" = "1" ]  && detail="${detail}System/Power-on password is SET. "
  done

  if [ "$found" = "0" ]; then
    lock_add biosPassword "BIOS/UEFI password" UNKNOWN \
      "No firmware-attributes interface on this machine — a BIOS password cannot be confirmed either way" \
      "/sys/class/firmware-attributes (dell-wmi-sysman / think-lmi / hp-bioscfg)" low
    return
  fi
  if [ -n "$detail" ]; then
    lock_add biosPassword "BIOS/UEFI password" WARNING "$detail" "/sys/class/firmware-attributes authentication/*/is_enabled" high
  else
    lock_add biosPassword "BIOS/UEFI password" PASS "No BIOS admin or system password set" "/sys/class/firmware-attributes authentication/*/is_enabled" high
  fi
}

# Absolute (formerly Computrace) Persistence.
#
# The distinction the buyer cares about is "the BIOS merely offers Absolute" vs
# "Persistence is actually ACTIVE". WPBT is what separates them: it is the ACPI
# table through which firmware injects an agent into Windows at every boot, so
# an Absolute payload sitting in WPBT means the firmware is actively planting
# it — not that the option exists in a menu.
check_absolute() {
  local wpbt="$LOCK_SYSROOT/sys/firmware/acpi/tables/WPBT" hits=""

  # No ACPI table directory at all: we cannot see whether firmware publishes a
  # WPBT, so we cannot conclude anything about Persistence.
  if [ ! -d "$LOCK_SYSROOT/sys/firmware/acpi/tables" ]; then
    lock_add absolute "Absolute / Computrace" UNKNOWN       "ACPI tables are not readable from this boot, so firmware-injected agents could not be checked"       "/sys/firmware/acpi/tables absent" low
    return
  fi
  if [ -r "$wpbt" ]; then
    # grep -a rather than `strings`: strings lives in binutils and is missing
    # from minimal live images, and its absence silently emptied this match —
    # turning an ACTIVE Absolute agent into a mere "table present" note.
    hits=$(grep -aoiE 'rpcnetp|rpcnet|absolute|computrace' "$wpbt" 2>/dev/null | tr '[:upper:]' '[:lower:]' | sort -u | paste -sd', ' -)
    if [ -n "$hits" ]; then
      lock_add absolute "Absolute / Computrace" LOCKED \
        "Persistence ACTIVE — firmware injects an agent at boot (WPBT payload: $hits)" \
        "ACPI WPBT table" high
      return
    fi
    lock_add absolute "Absolute / Computrace" DETECTED \
      "Firmware publishes a WPBT injection table, but no Absolute agent identified in it" \
      "ACPI WPBT table" medium
    return
  fi

  # No WPBT. Check whether the firmware still exposes the Absolute switch, which
  # is a weaker signal — available but not activated.
  local f state
  for f in "$LOCK_SYSROOT"/sys/class/firmware-attributes/*/attributes/*bsolute*/current_value \
           "$LOCK_SYSROOT"/sys/class/firmware-attributes/*/attributes/*omputrace*/current_value; do
    [ -r "$f" ] || continue
    state=$(cat "$f" 2>/dev/null)
    # ORDER MATTERS. "Deactivate" contains the substring "activate", so the
    # negative states must be matched FIRST — otherwise a machine with Absolute
    # explicitly switched off is reported as locked.
    case "$(printf '%s' "$state" | tr '[:upper:]' '[:lower:]')" in
      *deactivate*|*disable*|*off*)
        lock_add absolute "Absolute / Computrace" PASS "BIOS reports Absolute not activated ($state)" "firmware-attributes" high; return ;;
      *activate*|*enable*|*on*)
        lock_add absolute "Absolute / Computrace" LOCKED "BIOS reports Absolute ACTIVATED ($state)" "firmware-attributes" high; return ;;
      *)
        lock_add absolute "Absolute / Computrace" UNKNOWN "BIOS exposes an Absolute setting with an unrecognised value ($state)" "firmware-attributes" low; return ;;
    esac
  done

  lock_add absolute "Absolute / Computrace" PASS \
    "No WPBT injection table and no Absolute agent planted by firmware" \
    "ACPI tables (WPBT absent)" medium
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
  local key="$1" label="$2"
  if ! lock_has hivexget && ! lock_has hivexsh; then
    lock_add "$key" "$label" UNKNOWN "hivex tools not installed on this live image — the Windows registry could not be read" "offline registry (hivex missing)" low
    return 0
  fi
  if ! lock_locate_hives; then
    lock_add "$key" "$label" UNKNOWN "No readable Windows installation found on the internal disks" "offline registry (no Windows partition)" low
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
check_autopilot() {
  lock_win_blocked autopilot "Windows Autopilot" && return

  local tenant domain csid cached=""
  tenant=$(lock_hive_get "$WIN_SOFTWARE" 'Microsoft\Provisioning\Diagnostics\AutoPilot' CloudAssignedTenantId 2>/dev/null)
  domain=$(lock_hive_get "$WIN_SOFTWARE" 'Microsoft\Provisioning\Diagnostics\AutoPilot' CloudAssignedTenantDomain 2>/dev/null)
  csid=$(lock_hive_get "$WIN_SOFTWARE" 'Microsoft\Provisioning\Diagnostics\AutoPilot' AutopilotServiceCorrelationId 2>/dev/null)
  lock_hive_haskey "$WIN_SOFTWARE" 'Microsoft\Provisioning\AutopilotPolicyCache' && cached=1

  if [ -n "$domain" ] || [ -n "$tenant" ]; then
    lock_add autopilot "Windows Autopilot" LOCKED \
      "Registered to an organisation${domain:+ — tenant $domain}${tenant:+ (id $tenant)}. Removal requires the owning organisation to deregister the device." \
      'offline registry SOFTWARE\Microsoft\Provisioning\Diagnostics\AutoPilot' high
    return
  fi
  if [ -n "$csid" ] || [ -n "$cached" ]; then
    lock_add autopilot "Windows Autopilot" DETECTED \
      "Autopilot provisioning traces present without a tenant name — the device has been through Autopilot at some point" \
      'offline registry SOFTWARE\Microsoft\Provisioning' medium
    return
  fi

  # Read the hives fine, found nothing — and that still is not a clean bill of
  # health, for the reason set out above.
  lock_add autopilot "Windows Autopilot" UNKNOWN \
    "No local Autopilot traces. This does NOT mean the device is unregistered: registration is held in Microsoft's cloud against the hardware hash and survives a wipe. Confirm with a network-connected OOBE, or ask the seller for proof of deregistration." \
    'offline registry (no traces) — cloud state not checkable from here' high
}

# --- Intune / MDM enrolment --------------------------------------------------
check_mdm() {
  lock_win_blocked mdm "Intune / MDM enrolment" && return

  local enrolments provider=""
  # Each enrolment is a GUID-named subkey; the provider tells us whose MDM it is.
  enrolments=$(printf 'cd Microsoft\Enrollments\nls\n' | hivexsh "$WIN_SOFTWARE" 2>/dev/null | grep -Ei '^[0-9a-f]{8}-' | head -20)

  local g p url
  for g in $enrolments; do
    p=$(lock_hive_get "$WIN_SOFTWARE" "Microsoft\Enrollments\$g" ProviderID 2>/dev/null)
    url=$(lock_hive_get "$WIN_SOFTWARE" "Microsoft\Enrollments\$g" DiscoveryServiceFullURL 2>/dev/null)
    [ -n "$p" ] && provider="$provider $p"
    case "$url" in *manage.microsoft.com*) provider="$provider Intune" ;; esac
  done

  provider=$(printf '%s' "$provider" | tr ' ' '\n' | grep -v '^$' | sort -u | paste -sd', ' -)
  if [ -n "$provider" ]; then
    lock_add mdm "Intune / MDM enrolment" LOCKED \
      "Enrolled in mobile device management (provider: $provider). The device is under an organisation's control." \
      'offline registry SOFTWARE\Microsoft\Enrollments' high
    return
  fi
  lock_add mdm "Intune / MDM enrolment" PASS "No MDM enrolment found in the installed Windows" 'offline registry SOFTWARE\Microsoft\Enrollments' medium
}

# --- Entra ID / Azure AD join and domain join --------------------------------
check_entra() {
  lock_win_blocked entra "Entra ID / domain join" && return

  local joined=""
  # CloudDomainJoin\JoinInfo holds one subkey per Entra-joined identity.
  if lock_hive_haskey "$WIN_SYSTEM" 'ControlSet001\Control\CloudDomainJoin\JoinInfo'; then
    local sub
    sub=$(printf 'cd ControlSet001\Control\CloudDomainJoin\JoinInfo\nls\n' | hivexsh "$WIN_SYSTEM" 2>/dev/null | grep -Ei '^[0-9a-f]{8}-' | head -1)
    [ -n "$sub" ] && joined="Entra ID (Azure AD) joined"
  fi

  local dom
  dom=$(lock_hive_get "$WIN_SYSTEM" 'ControlSet001\Services\Tcpip\Parameters' Domain 2>/dev/null)
  [ -n "$dom" ] && joined="${joined:+$joined; }Active Directory domain: $dom"

  if [ -n "$joined" ]; then
    lock_add entra "Entra ID / domain join" LOCKED \
      "$joined — the device is bound to an organisation's directory" \
      'offline registry SYSTEM\...\CloudDomainJoin, Tcpip\Parameters' high
    return
  fi
  lock_add entra "Entra ID / domain join" PASS "No Entra ID join or AD domain membership found" 'offline registry SYSTEM hive' medium
}

# --- BitLocker ---------------------------------------------------------------
# Not an ownership lock, but a practical resale blocker: an encrypted volume
# without its recovery key is unreadable, and the data on it cannot be verified
# as wiped without destroying the volume.
check_bitlocker() {
  lock_has lsblk || { lock_add bitlocker "BitLocker" UNKNOWN "lsblk unavailable" "block device scan" low; return; }
  local enc
  enc=$(blkid 2>/dev/null | grep -ci 'BitLocker')
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
  local rows="$LOCK_ROWS"
  printf '%s' "$rows" | grep -q '|LOCKED|'  && { echo LOCKED; return; }
  printf '%s' "$rows" | grep -qE '\|(DETECTED|WARNING)\|' && { echo WARNING; return; }
  printf '%s' "$rows" | grep -q '|UNKNOWN|' && { echo UNVERIFIED; return; }
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
