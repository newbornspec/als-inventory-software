# What is knowable about Autopilot registration

## Status

Research, 22 September 2026. No code. Decides the four tiers that the records
either side of this one implement.

## The problem

The owner's words: *"That's the only challenge I'm having. I really want this
software to be able to solve this autopilot issue."*

A machine arrives, is audited, wiped, refurbished and sold — and at the buyer's
first boot it is claimed by an organisation nobody knew about. The money is
already spent.

## The constraint, and who says so

Autopilot registration is a row in Microsoft's cloud, keyed to the device's
**hardware hash**. It is not on the disk. Wiping does not touch it.
Reinstalling Windows does not touch it. The device only learns about it by
asking, at OOBE, over a network.

The device asks like this:

```
DeviceInfo (EKPub, SMBIOS serial, OfflineDeviceID)
  -> login.live.com/ppsecure/deviceaddcredential.srf
  -> HWDeviceID
  -> login.live.com/RST2.srf
  -> x-device-token
  -> GET ztd.dds.microsoft.com/ztd/device/AutopilotDeviceBootstrapPolicies
  -> profile JSON, or 807 ZtdDeviceIsNotRegistered
```

There is no public API into that last step for anyone but the tenant that owns
the device. Michael Niehaus, who built Autopilot at Microsoft, documented this
exact flow and wrote of the device token:

> *"If you could come up with that device token, you'd be able to make that GET
> request yourself — it would be nice to be able to check if a device presently
> has an Autopilot profile assigned."*

That is the person best placed to know, describing it as a thing that would be
nice to have rather than a thing that exists.

**So on a disk that has been wiped, nothing can give a certain answer.**
Anything claiming otherwise is guessing, or reimplementing an undocumented
Microsoft auth protocol.

## The four tiers

| Tier | Answers a wiped disk? | Status |
| --- | --- | --- |
| 1. Read the artefacts already on the mounted volume | No | Built — see `2026-09-22-autopilot-offline-evidence.md` |
| 2. Capture the hardware hash at intake, before the wipe | No | **Blocked** — needs a bench session |
| 3. Record the first-boot OOBE screen | **Yes, definitively** | Built — see `2026-09-23-autopilot-oobe-check.md` |
| 4. Reimplement the ZTD query | Yes, until Microsoft changes it | **Not built, recommended against** |

## Tier 2, and why it is blocked

The 4K hardware hash is the only identifier Microsoft will act on, and the
station wipes it away without recording it. It cannot be read from Linux — it
comes out of `MDM_DevDetail_Ext01.DeviceHardwareData` via the MDM WMI bridge,
which needs Windows running. The established route without the installed OS is
**WinPE**, running `Get-WindowsAutopilotInfo.ps1` or ADK `OA3Tool.exe`.

One real caveat: a hash captured in WinPE is **not byte-identical** to one from
the full OS — the WinPE version is missing the hard-drive serial, display and
GPU components. Close enough for the tooling people use daily, but an
approximation, and the record must say which kind it is.

It is blocked rather than skipped: building it needs the Windows ADK, a WinPE
image added to the stick, and a real machine to prove it on. Written blind it
would be something nobody could verify — and an unverified hash capture is
worse than none, because its entire purpose is to be the identifier Microsoft
acts on.

## Tier 4, and why it is recommended against

The device identity that unlocks the ZTD query is **EKPub + SMBIOS serial +
OfflineDeviceID**, and every one of those is readable from Linux — the TPM
endorsement key through `tpm2-tools`, already on the stick, and the serial
through `dmidecode`, already read. The station could in principle make the same
GET the machine makes at OOBE.

It would be the machine asking about itself, from the machine, while the
business lawfully possesses it. That is not ethically murky. It is
**operationally reckless**:

1. **The protocol is undocumented.** SOAP against a Passport-era endpoint,
   known only from packet captures and reverse-engineering of `wlidsvc.dll`.
   The one public write-up states outright that what is known is insufficient
   to reimplement independently.
2. **It is unsupported and unversioned.** Microsoft owes nobody notice before
   changing it. The day it changes, the station starts producing wrong answers
   about whether customers' machines are locked — and the failure would look
   like a clean result.
3. **It is an unsupported client against a Microsoft authentication endpoint.**
4. **It puts the most consequential claim in the product on the least stable
   foundation in it.** Everything else in this system is built so a failed read
   reads as "could not check". This component's failure mode is a confident
   wrong answer, testable against nothing.

The sane version of Tier 4 is not to reimplement the protocol. It is to let
Windows do it — which is Tier 3.

## The business remedy

Microsoft Commercial/Intune support **will** deregister a device from an
unreachable tenant on proof of ownership. It is not a consumer support process;
it needs escalation, and the phrase that reaches the right desk is:

> *"Windows Autopilot device-record deregistration from an inaccessible
> previous tenant based on proof of ownership"*

The evidence pack they ask for:

- the serial number and hardware information;
- the original proof of purchase, containing a unique device identifier;
- proof of ownership transfer;
- **screenshots showing the previous organisation's Autopilot OOBE screen**;
- Autopilot diagnostic logs.

The system can produce or hold four of those five. So the honest framing of the
whole feature is not "detect Autopilot" — it is **make every locked machine
arrive at that support request with its evidence already gathered**, instead of
being discovered at the end and written off.

## Open questions

Tier 2 remains unbuilt and needs a bench session. Whether an OOBE-discovered
lock should reach an already-issued erasure certificate is an owner decision —
see the Open questions of `2026-09-23-autopilot-oobe-check.md`.

## Sources

- [Connect the dots: from hardware hash to Autopilot profile](https://oofhours.com/2022/08/01/connect-the-dots-from-hardware-hash-to-autopilot-profile/) — Michael Niehaus
- [Step by step: how Windows retrieves the Autopilot profile](https://call4cloud.nl/autopilot-profile-x-device-token-autopilot-marker/)
- [Windows Autopilot registration overview](https://learn.microsoft.com/en-us/autopilot/registration-overview)
- [Deregistering an Autopilot device](https://github.com/MicrosoftDocs/memdocs/blob/main/autopilot/includes/deregister-autopilot-device.md)
- [Autopilot device deregistration — PC locked to previous tenant](https://learn.microsoft.com/en-us/answers/questions/5989287/windows-autopilot-device-deregistration-pc-locked)
- [Can you create an Autopilot hash from WinPE?](https://mikemdm.de/2023/01/29/can-you-create-a-autopilot-hash-from-winpe-yes/)
