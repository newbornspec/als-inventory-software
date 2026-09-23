# The Autopilot evidence already under our feet

## Status

Shipped, 22 September 2026. `8059f3a`. Tier 1 of
`2026-09-22-autopilot-research.md`.

## The problem

The owner tested a ThinkPad T14 he believed was Autopilot-locked. The audit's
Autopilot row said **UNKNOWN**, with high confidence and this detail:

> The Autopilot service was contacted on 2026-08-04T08:31:02Z and returned no
> profile, and no tenant is assigned locally.

The row was *right* to refuse to say PASS — a cached "no profile" cannot
disprove a cloud registration. But the check was reading **two registry keys**
on a volume it had already mounted read-only, and ignoring everything else on
it.

## Why it matters

A machine registered by the offline "existing devices" route can have nothing
whatever in the registry cache and its whole identity in a JSON file on disk.
Such a device was being reported as unverifiable while its owner's domain sat
on the volume in plain text.

## What was built

`lock-checks.sh` mounts the Windows volume and read only
`Windows\System32\config`. These were on the same mounted volume, unopened:

| Artefact | What it holds |
| --- | --- |
| `Windows\ServiceState\wmansvc\AutopilotDDSZTDFile.json` | The profile the device downloaded from Microsoft's ZTD service. **Names the tenant.** |
| `Windows\ServiceState\Autopilot\*.json` | Same, Windows 1903 and later |
| `Windows\Provisioning\Autopilot\AutopilotConfigurationFile.json` | Offline registration: `CloudAssignedTenantId`, `CloudAssignedTenantDomain`, `ZtdCorrelationId` |
| `...winevt\Logs\Microsoft-Windows-ModernDeployment-Diagnostics-Provider%4Autopilot.evtx` | Every ZTD attempt and result, with dates |

**The files.** Any tenant found makes the device LOCKED and names the
organisation. Leaf directories are resolved case-insensitively, because
Microsoft's own documentation spells them both ways (Autopilot/AutoPilot,
ServiceState/servicestate) and ntfs-3g presents names as stored.

**The event log.** The registry holds the last answer; the log holds every
answer. Each `807 ZtdDeviceIsNotRegistered` is counted, so the negative becomes
"asked eleven times and told no every time" rather than "told no once, in
August". A `908 HardwareMismatchDetected` is its own **LOCKED** verdict: the
service *recognised* the device and refused it because the hash has moved —
a live registration with a swapped mainboard, not a clean machine.

## A bug that had been live all along

`_ap_field`'s separator class was quote/colon/backslash with **no whitespace**,
so it matched `{"CloudAssignedTenantDomain":"contoso.com"}` and missed
`{"CloudAssignedTenantDomain": "contoso.com"}` — which is how Microsoft writes
these files, and how any pretty-printed JSON is written.

It had been failing on the **registry** path too. A registered machine whose
cached profile had a space after the colon yielded no tenant and was reported
as unverifiable.

It was found only because the new fixtures were written to look like real
files rather than like the parser's happy path. **That is the transferable
lesson from this change.**

## What was deliberately not built

Nothing was inferred from an artefact that could not be read. A profile file
present and unopenable is reported as unreadable, and that outranks the cached
"no profile" below it — the file that could not be read is the one that would
have named the tenant.

Of a profile that also carries an assigned user and a device name, **only the
organisation is taken**. A previous employee's identity has no place on a
resale audit.

## How it was proved

`test-lock-checks.sh` 175 → 220 checks, including: a filename with a space is
read rather than filed as a fault; an unrelated `.json` is not mistaken for a
profile; a tenant named in the registry is preferred over one in a file; the
spacing bug is pinned in six forms.

## Open questions

The event-log half needed `evtxexport`, which the stock image lacks — resolved
the next day, see `2026-09-23-event-log-reader-on-stick.md`.
