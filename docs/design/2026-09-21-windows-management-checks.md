# Windows management checks: Entra, domain, MDM and the licence

## Status

Shipped, 21 September 2026. `45526b2` · `a0a4c66` · `d066c3a` · `768e9c3` ·
`d958b21`

## The problem

The owner asked for proper Autopilot / Intune / Entra / domain / activation
checks, with "Run Check" buttons and `dsregcmd`.

## The constraint that governs everything

**The station boots Linux. The machine's Windows is never running.**

`lock-checks.sh` mounts the Windows volume **read-only** and parses its hives
with hivex. So `dsregcmd /status`, PowerShell, WMI and any live API are
**impossible** — only the registry those tools would have read. This is not a
limitation to engineer around; it is the shape of the problem.

## What is knowable, and how

**Entra ID (Azure AD) join** — `SYSTEM\<CtrlSet>\Control\CloudDomainJoin\JoinInfo\<sub>`,
carrying TenantId, TenantDisplayName, IdpDomain and DeviceId.

> **`UserEmail` is in that key and is never read.** It is a former employee's
> identity and has no place on a resale audit. `check_mdm` set that precedent
> by keeping only the UPN *domain*.

**Active Directory domain join** — the **SECURITY hive**, which the file had
never opened. `Policy\PolPrDmS` is the primary domain SID (a workgroup machine
has none); `PolPrDmN` and `PolDnDDN` name the domain;
`Policy\Secrets\$MACHINE.ACC` and the `Cache\NL$n` cached logons corroborate.

Readable offline as root because **hivex parses the hive file and ignores the
ACL** that blocks a live `reg query HKLM\SECURITY`.

Three mechanical traps, each of which cost a debugging session:

1. The values sit in the key's **default (unnamed)** value — `hivexget` cannot
   fetch it, it needs `hivexsh lsval`.
2. They are **binary UTF-16LE**, and bash drops NULs — pipe through
   `tr -d '\000'`.
3. `hivex` prints a REG_BINARY as `hex:04,00,...`, which the name extractor
   turned into the literal domain **"hex"** — fixed on 22 September in
   `c74df68`, after it appeared on a real audit.

**The licence** — ACPI MSDM/SLIC presence, and a configured KMS host. See
`2026-09-20-hardware-profile-and-os-capture.md`.

## What is impossible, and must never be promised

**"Windows is activated."** Evaluated at runtime from sealed machine-bound
stores; an expired KMS grant is indistinguishable on disk from a live one; a
digital-licence machine can have nothing on disk at all.

**Querying Autopilot registration.** It lives in the registering tenant's
Intune. No cross-tenant read, no anonymous endpoint. See
`2026-09-22-autopilot-research.md`.

## The false-positive traps

Each verified against a clean, never-joined Windows 11. **Testing key
*presence* instead of value *content* calls every Windows machine
domain-joined** — every install carries the keys.

**`45526b2` — stop an Entra-joined machine reading as clear.** A `grep` filter
meant to validate a tenant GUID **dropped a valid one**, so the check found no
tenant and reported PASS. Found on a real machine the owner knew was enrolled.

**`d066c3a` — tell Entra ID and Active Directory apart, and name who owns the
machine.** The two had been conflated. They are different locks with different
remedies, and the row now names the organisation.

**`768e9c3` — stop Autopilot claiming it looked at a hive it could not open.**
Four reads against an unopenable hive returned four empty strings, and the
verdict announced *"No local Autopilot traces"* — a claim to have looked. Found
on a real machine whose MDM row, on the same audit, said the hive was
unreadable.

**`d958b21` — five more checks that called a machine clean without looking**:
the MDM enrolment listing, UEFI setup mode on a legacy boot, a partial
BitLocker scan, an unrecognised BIOS password flag, and a TPM ownership field
absent from the output.

## What was deliberately not built

No "Run Check" buttons that re-query live — there is nothing live to query. The
checks run during the capture and the result is what the audit carries.

Nothing is ever removed. Detect → Verify → Report.

## Open questions

The `lock_locate_hives` SOFTWARE gate is deliberate: SECURITY is missing on a
damaged or part-copied install, and requiring it would turn every Windows check
UNKNOWN over a hive only one of them needs. Each check reports what its own
inputs allow.
