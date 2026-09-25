**Draft 1.**

---

## 7. Layer 4: deep inspection

Reading a machine's hardware is the easy half. The commercially and legally
interesting questions are about its *state*: is it locked to somebody else's
organisation, is it encrypted, is there a BIOS password, how much life is left
in the drive, what operating system is installed. All of these must be answered
about a machine whose operating system is never started.

### 7.1 The constraint, stated as a capability

The station boots Linux, mounts the Windows volume **read-only**, and parses
its registry hives offline. Everything follows from that one sentence.

| Impossible | Available instead |
| --- | --- |
| Live management-status queries | The registry keys those tools read |
| PowerShell, WMI, any live API | The hive files, parsed directly |
| Asking the machine's OS anything | The artefacts its OS left behind |

This is not a limitation to engineer around; it is the shape of the problem.
And it has one genuine advantage over the live equivalent: parsing a hive file
directly **ignores the access-control list** that would block the same query on
a running system, so the SECURITY hive — normally unreadable even to an
administrator without extra work — is simply a file.

### 7.2 What a powered-off Windows will tell you

Four management states matter to a resale business, because each one can make a
machine unsellable or unusable to its buyer:

| State | Where it is read from |
| --- | --- |
| **Entra ID (Azure AD) join** | The cloud-domain-join key: tenant identifier, tenant display name, device identifier |
| **Active Directory domain join** | The SECURITY hive: the primary domain SID, the domain names, corroborated by the machine account and cached logons |
| **MDM enrolment** | The enrolment keys, keeping the organisation's domain only |
| **Licence and activation** | The firmware-embedded licence marker, recorded as *present*, never transcribed |

Two rules govern all four, and both are about restraint rather than capability.

**Personal identity is never read.** The cloud-domain-join key contains a user's
email address. It is a former employee's identity, it has no bearing on whether
the machine can be resold, and it is never read. Only the **organisation's
domain** is recorded. The same precedent applies to MDM enrolment, where only
the domain part of the enrolling account is kept.

**A product key is recorded as present, never transcribed.** The system needs to
say a licence exists. It does not need to hold the key, and holding it would
make the audit record a thing worth stealing.

### 7.3 Three mechanical traps, and the one that got through

Reading hives offline is fiddly in ways that are worth recording, because each
of these cost a debugging session and none is documented anywhere convenient:

1. **The values live in the key's default, unnamed value**, which the
   convenient command-line getter cannot fetch at all — it needs the
   interactive shell's value-listing command.
2. **They are binary UTF-16LE**, and the shell drops NUL bytes silently, so the
   string arrives mangled unless the NULs are stripped deliberately.
3. **A binary value is printed in a `hex:04,00,...` form.** The name extractor
   took the first token and reported the machine's domain as the literal string
   **"hex"**.

The third one shipped, and appeared on a real audit. It is worth dwelling on
because it runs *opposite* to everything else in this paper: it is a false
**presence** — a machine asserted to be domain-joined to an organisation called
"hex" when it was not domain-joined at all. It was noticed within a day,
precisely because a false alarm is the kind of error somebody chases. §12
returns to it as the exception that demonstrates the direction of the other 32
defects is structural rather than selective.

### 7.4 Locks, and the promotion rule

The station runs a set of independent detectors — encryption, BIOS password,
firmware lock, management enrolment, hidden partitions — and each returns one
of three values, never two: **present**, **absent**, or **could not be
established**.

The device-level verdict is then computed by a rule that is the operational
heart of the thesis:

> **Any detector returning "could not be established" promotes the whole device
> to UNVERIFIED.**

Not *unlocked with a caveat*. Not *probably fine*. A device on which one of
five checks could not run is a device whose lock status is unknown, and it says
so. This is deliberately conservative and deliberately expensive: it produces
more machines needing a second look, which is the correct trade when the
alternative is selling somebody a laptop that turns out to belong to a bank.

The rule exists in code rather than in a convention, and it is enforced at the
point where the detectors are collected: a detector that returns success while
having filed no finding at all is itself recorded as an unknown, rather than
being treated as a silent pass.

### 7.5 Drive health: never "Unknown"

A buyer's first question about a second-hand machine is *how much life is left
in the drive*. SMART answers it, but not in a form anyone can act on: raw
vendor-specific counters, with different fields on SATA, NVMe, eMMC and SAS.

The requirement, set by the business, was uncompromising:

> **Drive health is a percentage, in named bands, and it is never "Unknown".**

Where health genuinely cannot be measured, the row states **what could not be
measured and what to do about it** — for example, that the drive sits behind a
RAID controller, together with the instruction to switch the storage mode in
firmware and rescan. That is an answer. "Unknown" is not; it is a blank
pretending to be one.

Three implementation decisions made it hold:

- **One formula, in one place**, with a presentation layer per application, so
  a drive reading 74% on the bench is not "Caution" in the kiosk and "Fair" in
  a report. Identical wording across three surfaces was treated as a
  requirement, not a nicety.
- **Show what was measured, not a fresh guess.** The kiosk was re-probing
  drives without privilege and getting *worse* answers than the capture already
  held. Displaying the captured measurement fixed it.
- **Do not grade a drive down for a warm afternoon or a bad cable.**
  Temperature and interface CRC errors were dragging grades down; neither is a
  wear indicator.

### 7.6 Reading the installed operating system

The station reports which Windows is installed by reading it from the machine's
own registry — never by inferring it, and never by reporting the station's own
Ubuntu.

One case governs the design. A **BitLocker-encrypted machine** presents a
volume that cannot be read. The naive implementation looks for Windows, fails
to find it, and reports *no operating system installed* — which is both wrong
and commercially significant, since it makes a working encrypted laptop look
like a bare-metal box. An encrypted volume must read as *encrypted, therefore
not readable*, which is a different sentence from *empty*.

This is the same defect shape as everything else in this section, which is why
the layer that produces the most valuable findings also produced the majority
of the defects catalogued in §12.

## Drafting notes

- Registry paths, tool names and command flags are deliberately described
  rather than quoted. The design records hold the exact strings; a paper that
  reproduces them dates quickly and invites a reviewer to test them.
- §7.3's "hex" defect is the counter-example §12 excludes from its 32. Both
  sections must describe it identically; check at assembly.
- §7.4's promotion rule and §9's three-valued verdict are the same idea applied
  to different subject matter. Keep both — the repetition is the argument — but
  do not let either grow into a restatement of §2.
- The privacy rules in §7.2 are the owner's standing instructions, not
  inventions of this paper. If the business is named, say so explicitly.
