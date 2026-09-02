# Device Locks & Management Status

Answers one question before you buy a machine: **is there anything on it that
would stop us refurbishing, reselling or redeploying it?**

Runs as part of `hardware-audit.sh`. Prints at the bench and is stored with the
audit, inside the hardware profile under `locks`.

---

## The rule that governs everything here

> **A check that could not run reports UNKNOWN. Never PASS.**

Telling a buyer that a locked machine is clear is the most expensive mistake
this tool could make — you take a pallet of devices you cannot sell. So
"we looked and found nothing" and "we could not look" are different answers and
are never merged.

That is why the verdict is `UNVERIFIED` rather than `CLEAR` whenever anything
was unreadable, and why `CLEAR` requires **every** check to have actually run.

## Detection only

Nothing here bypasses, clears, disables or defeats a lock, and nothing that does
may be added. A lock that is found is reported and left exactly as it is.
Removal is the legitimate owner's job through the vendor's own process —
Microsoft documents Autopilot deregistration for devices that permanently leave
an organisation. **Detection and authorised removal are different things**, and
this tool only does the first.

---

## Verdicts

| Device status | Meaning |
|---|---|
| `CLEAR` | Every check ran and found nothing |
| `WARNING` | Restrictions found that may affect refurbishment |
| `LOCKED` | An ownership or management lock is present |
| `UNVERIFIED` | Something could not be checked — unproven, **not** clear |

Per check: `PASS`, `DETECTED`, `LOCKED`, `WARNING`, `UNKNOWN` — each with the
method that produced it and a confidence level, so a surprising result can be
traced back to the thing that produced it.

## What is checked

| Check | How | Confidence |
|---|---|---|
| Windows Autopilot | Offline registry: `SOFTWARE\Microsoft\Provisioning\Diagnostics\AutoPilot` | High when found — see caveat |
| Intune / MDM | Offline registry: `SOFTWARE\Microsoft\Enrollments\{GUID}` | High |
| Entra ID / domain join | Offline registry: `SYSTEM\...\CloudDomainJoin`, `Tcpip\Parameters` | High |
| BIOS/UEFI password | `/sys/class/firmware-attributes/*/authentication/*/is_enabled` | High where the interface exists |
| Secure Boot | UEFI variable `SecureBoot` | High from a UEFI boot |
| UEFI Setup Mode | UEFI variable `SetupMode` | High |
| TPM | `/sys/class/tpm`, `tpm2_getcap` | High |
| Absolute / Computrace | ACPI **WPBT** table, then firmware-attributes | High |
| BitLocker | Volume signatures | High |

### Absolute: available vs actually active

The distinction that matters commercially. **WPBT** is the ACPI table through
which firmware injects an agent into Windows at every boot. An Absolute payload
sitting in WPBT means the firmware is *actively planting it* — that is
`LOCKED`. A BIOS that merely exposes an Absolute setting which is switched off
is not.

---

## Limits you must know

**Autopilot is the big one.** Registration does not live on the device. It lives
in Microsoft's cloud, keyed to the hardware hash. **A wiped machine carries no
local trace and will still be claimed by its organisation at the next
network-connected OOBE.** So a clean registry proves nothing, and this check
reports `UNKNOWN` rather than `PASS` in that case. To be certain, either run a
network-connected OOBE and see whether an organisation's branding appears, or
get proof of deregistration from the seller.

**Needs `hivex`** for the three Microsoft checks — without it they report
`UNKNOWN`, because the Windows registry cannot be read at all.
Install with `apt install libhivex-bin` / `pacman -S hivex`.

**Needs a UEFI boot.** Booted legacy/CSM, the UEFI variables are not exposed and
Secure Boot reports `UNKNOWN` — reporting "off" there would be reading our own
boot mode and calling it the machine's configuration.

**Needs the vendor driver** for BIOS password detection: `dell-wmi-sysman`,
`think-lmi` or `hp-bioscfg`. No interface means `UNKNOWN` — a BIOS password
cannot be ruled out.

---

## Secure Boot is ON and the USB will not boot

Do **not** just switch Secure Boot off — that changes the machine you are
assessing, and may not be possible if the BIOS is password-protected.

1. **Boot a Secure Boot signed live image.** Ubuntu/Debian/Fedora ship a shim
   signed by the Microsoft UEFI CA and boot unmodified with Secure Boot on.
2. **If USB boot is blocked in firmware**, the machine's boot menu may still
   offer PXE (the Dell menu shows Onboard NIC IPV4/IPV6).
3. **If the BIOS is password-locked**, that is itself the finding — record it
   and treat the device accordingly. Do not attempt to clear it.

## Adding a detector

Write a function that calls `lock_add` once, then add its name to
`LOCK_DETECTORS`. Nothing else changes.

```
lock_add <key> <label> <status> <detail> <method> <confidence>
```

Add a fixture case to `test-lock-checks.sh` in the same commit. The `LOCKED`
branches cannot be exercised on an unlocked bench machine, so a detector without
a fixture is a detector nobody has ever seen fire — and the fixtures have
already caught two real bugs, including one that reported a machine with
Absolute switched **off** as locked.

```sh
bash tools/test-lock-checks.sh
```
