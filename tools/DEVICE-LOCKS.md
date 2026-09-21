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
| Microsoft Entra ID join | Offline registry: `SYSTEM\...\CloudDomainJoin\JoinInfo` — and reads inside it to name the tenant | High when found |
| Active Directory domain join | Offline registry: `SECURITY\Policy\PolPrDmS`, corroborated by Group Policy, Netlogon and cached logons | High when corroborated |
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

Nor is a BIOS setting that is switched **on**. Dell's Absolute states are
Disable / Enable / Permanently Disable, and Dell says plainly that *"Enabled
does not mean that the feature is active"* — it only makes the interface ready
for activation by Absolute's server, which additionally needs the agent
installed in Windows and an authenticated activation packet. **Enable is the
factory default** on modern Dell business machines, so reading it as a lock
flags almost every Dell that comes through the door. Legacy Computrace is a
different vocabulary in which `Activate` *is* a genuine, permanent activation;
with no WPBT alongside it that is reported as `DETECTED`, not `LOCKED`, because
nothing is being planted at boot.

### MDM: an enrolment needs a server

A stock Windows 11 install carries roughly thirty GUID subkeys under
`SOFTWARE\Microsoft\Enrollments`, and three of them have a `ProviderID` —
`Local Authority`, `Cloud Authority` and `Deploy Authority`. These are built-in
CSP authorities, present on every machine, and they are **not** enrolments.
What makes an enrolment real is a `DiscoveryServiceFullURL`: the address of the
server that manages the device. Intune's contains `manage.microsoft.com`.
Where a UPN is present only its domain is recorded — the organisation is what
matters, and the previous user's identity is not ours to keep.

### Entra ID and Active Directory are two different findings

They used to be one row. That forced one verdict, one confidence level and one
sentence onto two things that behave nothing alike, and the row could not say
either of them properly.

**Entra ID** membership is read from `SYSTEM\...\CloudDomainJoin\JoinInfo`, and
the check now reads *inside* that key so the report can say **which tenant**:
the tenant id, the tenant's display name, the identity provider's domain, and
the device id an administrator needs in order to deregister the device. Proving
a lock without naming the owner leaves the operator nothing to act on.
`TenantInfo\{tenant id}` carries the same tenant's MDM enrolment endpoint and is
used as secondary corroboration only. `JoinType` is deliberately ignored: there
is no mapping for that DWORD anyone can point at.

**The previous user's `UserEmail` sits in the same key and is never read** —
same rule as MDM above, for the same reason.

**Active Directory** membership is read from the **SECURITY hive**, which is
where the LSA actually records it. A live Windows refuses to read
`HKLM\SECURITY` at all; offline that denial is meaningless, because it is a
Windows ACL and there is no Windows running — hivex parses the hive *file* and
a file's ACL means nothing to a Linux process reading its bytes as root. So the
check that cannot be done live is exactly the one that can be done offline.

| Evidence | Weight |
|---|---|
| `SECURITY\Policy\PolPrDmS` — the primary domain SID | Proof of a current join |
| `SECURITY\Policy\PolPrDmN` / `PolDnDDN` | Names the domain (never decides) |
| `SECURITY\Policy\Secrets\$MACHINE.ACC` | Proof of *having been* joined |
| `SECURITY\Cache\NL$1..NL$10` holding real content | Domain accounts have signed in |
| `SOFTWARE\...\Group Policy\History\{GUID}\0` `DSPath` beginning `LDAP://` | A domain GPO was applied |
| `SOFTWARE\...\Group Policy\State\Machine` `Distinguished-Name`, non-empty | The machine has a directory name |
| `SYSTEM\...\Netlogon\Parameters` `DynamicSiteName` | Only written after reaching a DC |
| `SYSTEM\...\Tcpip\Parameters` `Domain` | Weak — DHCP hands this out too |

`$MACHINE.ACC` and the cached logons are read for **presence and size only**.
Nothing decrypts them and nothing that does may be added.

#### The traps, all verified on a clean never-joined Windows 11

Testing whether a key *exists* instead of what a value *contains* reports a
domain join on every machine ever made:

* `Group Policy\History` **exists** on a standalone machine, with
  `DSPath = LocalGPO`. The discriminator is `LDAP://`, never "History has a
  subkey".
* `State\Machine\Distinguished-Name` **exists as an empty `REG_SZ`**.
* `Netlogon\Parameters` **exists** (`DisablePasswordChange` and friends);
  `DynamicSiteName` is the value that is absent.
* `Tcpip\Parameters\Domain` **exists as an empty `REG_SZ`**.
* `Winlogon\CachedLogonsCount` is `"10"` on **every** Windows — no evidential
  value at all, and deliberately unused.
* The **SAM hive is not evidence**: a domain-joined machine's SAM is
  structurally identical to a workgroup one.
* `ActiveComputerName` is **volatile** — not in the hive file, unreadable
  offline. `ComputerName` is the one that persists.

#### The two negatives do not mean the same thing

* **"No AD evidence"** is close to a real negative. Domain membership is written
  on the machine, and all of it is quiet.
* **"No Entra join"** says the device is not joined *right now*. It can never
  say the organisation has **released** it — only the tenant can say that, and
  an Autopilot registration lives in the cloud regardless.

Both carry one shared caveat: **hivex does not replay the registry transaction
logs** (`SYSTEM.LOG1`/`LOG2`). A machine shut down with fast start-up or
hibernation can hand over a hive whose last transactions were never flushed, so
a very recent join or unjoin may simply not be there.

#### Which control set

The registry reads resolve `SYSTEM\Select\Current` — usually `1`, but `2` after
a Last Known Good boot — and use that control set, falling back to
`ControlSet001` if the resolved one is not in the hive. Reading a stale set
returns nothing from every lookup, and "found nothing" is exactly how this tool
would otherwise have reported a managed machine as clear.

---

## Limits you must know

**Autopilot is the big one.** Registration does not live on the device. It lives
in Microsoft's cloud, keyed to the hardware hash. **A wiped machine carries no
local trace and will still be claimed by its organisation at the next
network-connected OOBE.** So a clean registry proves nothing, and this check
reports `UNKNOWN` rather than `PASS` in that case. To be certain, either run a
network-connected OOBE and see whether an organisation's branding appears, or
get proof of deregistration from the seller.

**Needs `hivex`** for the four Microsoft checks — without it they report
`UNKNOWN`, because the Windows registry cannot be read at all.
Install with `apt install libhivex-bin` / `pacman -S hivex`.
`hivexget` reads named values; `hivexsh` is needed as well, because subkey
listings and the LSA policy values — which live in a key's *default*, unnamed
value — are out of `hivexget`'s reach.

**Needs a UEFI boot.** Booted legacy/CSM, the UEFI variables are not exposed and
Secure Boot reports `UNKNOWN` — reporting "off" there would be reading our own
boot mode and calling it the machine's configuration.

**Needs the vendor driver** for BIOS password detection: `dell-wmi-sysman`,
`think-lmi` or `hp-bioscfg`. No interface means `UNKNOWN` — a BIOS password
cannot be ruled out.

---

## Secure Boot is ON and the USB will not boot

**CONFIRMED ON HARDWARE (Dell OptiPlex 5080, Secure Boot ON):**

```
Operating System Loader failed signature verification.
WARNING: The file may have been tampered with!
All bootable devices failed Secure Boot verification.
```

**The SystemRescue stick cannot boot with Secure Boot enabled.** It is an
archiso image whose only loader is `EFI/boot/bootx64.efi` — there is no
`shimx64.efi` on it, so nothing in the chain carries a Microsoft-trusted
signature. This is not a misconfiguration to fix on the stick: SystemRescue
does not support Secure Boot, its own forum tells users to disable it, and the
feature request for support is still open upstream.

Do **not** just switch Secure Boot off. It changes the machine you are
assessing, and it may not even be possible — a BIOS admin password is one of
the things this tool exists to detect, and it would block you.

The fixes, in order of preference:

1. **Use a Secure Boot signed live base.** Ubuntu ships `shimx64.efi` signed by
   the Microsoft UEFI CA and GRUB signed by Canonical, and boots unmodified with
   Secure Boot on. `hardware-audit.sh` already installs its dependencies through
   either `pacman` or `apt-get`, so the audit and lock checks port cleanly; the
   `gui/` kiosk is the part that is Arch-coupled (`install-cage.sh` requires
   pacman, and several paths assume `/run/archiso/bootmnt`).
2. **A Windows-side collector**, for machines that boot Windows. Autopilot,
   Intune and Entra state is native to Windows — `dsregcmd /status` and the live
   registry beat reading hives offline — and it sidesteps the boot problem
   entirely. It cannot audit a machine that will not boot, or wipe one.
3. **If USB boot is blocked in firmware**, the boot menu may still offer PXE
   (the Dell menu shows Onboard NIC IPV4/IPV6).
4. **If the BIOS is password-locked**, that is itself the finding — record it
   and price the device accordingly. Do not attempt to clear it.

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
