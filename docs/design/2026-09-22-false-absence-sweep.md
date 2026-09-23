# The false-absence bug class, and the sweep that closed it

## Status

Shipped, 21–22 September 2026. Fifteen commits, ending at `b36e3ab`.

`533a61a` · `086ea3d` · `e688db2` · `be8d27d` · `fe44ab7` · `45526b2` ·
`768e9c3` · `d958b21` · `7037985` · `d197ebe` · `5ab21f1` · `66d72bc` ·
`5bc49d4` · `3092fd5` · `b36e3ab`

## The problem

A **false absence** is a probe whose failure is indistinguishable from a
genuine negative, reported as a negative.

A registry read that cannot open the hive returns the empty string, and so does
a hive with nothing in it. A device scan that times out returns no devices, and
so does a machine with none. The code sees one value and cannot tell which
world it is in, so it picks the one that reads as an answer.

The class is not symmetric, and that is what makes it dangerous. Failures
produce empty, zero, missing and false — the values that mean *nothing is
wrong*. A crash is noisy and gets fixed; a failed read is silent and gets
certified. In an audit system the asymmetry points the same way every time:
towards the machine being clean, the drive being erased, the lock being absent,
the certificate being issuable.

It survives testing for a structural reason. The test fixture supplies a
working probe, because a fixture is written from the successful path. Nothing
in the suite constructs the state where the probe is broken *and* the machine
is dirty, so the bug is invisible to every test that exists and to every code
review that reads the happy path.

## Why it matters

The output of this system is an erasure certificate a buyer relies on. Every
one of the twenty-three defects failed in the direction that costs money and
breaks the law. Not one produced a false alarm.

## The evidence table

Newest first. "Found by" is how the defect actually surfaced, not how it could
have been.

| Date | Commit | The probe that failed | What the record then said | Found by |
| --- | --- | --- | --- | --- |
| 2026-09-22 | `b36e3ab` | Hidden-drive scan could not list the PCI directory, or no python3 | "No hidden drives" — a panel identical to a fully enumerated machine | Sweep |
| 2026-09-22 | `3092fd5` | No lock detector filed a row at all | "No lock detected" on the certificate | Sweep |
| 2026-09-22 | `3092fd5` | A detector returned success having filed nothing | That check silently absent from the verdict | Sweep |
| 2026-09-22 | `3092fd5` | An NTFS volume left hibernated refused to mount | "No readable Windows installation found on the internal disks" | Sweep |
| 2026-09-21 | `5bc49d4` | Trackpad gesture fields absent rather than false | "Movement and buttons work" | Sweep |
| 2026-09-21 | `66d72bc` | Wipe limitations arrived in an unexpected shape and were filtered out | "Limitations: None reported" | Sweep |
| 2026-09-21 | `5ab21f1` | A locked self-encrypting drive returned no partition table | "No operating system installed" | Sweep |
| 2026-09-21 | `5ab21f1` | A TPM disabled in firmware is not handed to the OS | "No TPM detected" | Sweep |
| 2026-09-21 | `5ab21f1` | A flat or removed battery reports no health percentage | Device type recorded as Desktop; laptop display capture then skipped | Sweep |
| 2026-09-21 | `5ab21f1` | `lsblk` failed and its exit status was discarded | "Optical: Not present" — and the failure was cached for the session | Sweep |
| 2026-09-21 | `5ab21f1` | No reference time could be fetched to compare the clock against | A green tick against "System clock" | Sweep |
| 2026-09-21 | `5ab21f1` | Any hardware field the capture could not fill | "Not detected" on the bench panel | Sweep |
| 2026-09-21 | `5ab21f1` | Namespace coverage recorded in a variable nobody read | A certificate with no limitation on it | Sweep |
| 2026-09-21 | `d197ebe` | The station recorded no drives, so the expected-drive set was empty | A "wiped" certificate for a machine whose drives were never listed | Sweep |
| 2026-09-21 | `7037985` | A queue file that existed but could not be fully read | Treated as empty, then rewritten — destroying the audits waiting to upload | Sweep |
| 2026-09-21 | `d958b21` | Five lock checks: MDM enrolment listing, UEFI setup mode on legacy boot, a partial BitLocker scan, an unrecognised BIOS password flag, a TPM ownership field absent from output | "Not enrolled", no row at all, "no encrypted volumes", "no password", "no owner authorisation set" | Sweep |
| 2026-09-21 | `768e9c3` | Four registry reads against a hive that could not be opened | "No local Autopilot traces" — a claim to have looked | Real machine, cross-checked against another row on the same audit |
| 2026-09-21 | `45526b2` | A grep filter dropped a valid tenant GUID | An Entra-joined machine read as CLEAR | Real machine the owner knew was enrolled |
| 2026-09-21 | `fe44ab7` | The USB bus could not be read | "0 ports responded" | Real machine |
| 2026-09-20 | `be8d27d` | A relative sysfs path read nothing on every real Intel RST machine | No hidden drives, plus an invented drive count | Code review |
| 2026-09-20 | `e688db2` | libblkid types an encrypted volume "BitLocker", not "ntfs", so an ntfs-only filter walked past it | "No operating system installed" on a machine holding all of the customer's data | Real machine |
| 2026-09-20 | `086ea3d` | Several hardware-profile fields with nothing behind them | Asserted as measured | Code review |
| 2026-09-02 | `533a61a` | Six lock detectors whose hivex reads failed | Six negatives: not enrolled, not joined, no traces | Code review |

Two entries stand for more than one call site: `533a61a` fixed six lock
detectors together and `d958b21` fixed five.

## What the table shows

**Naming the class did not stop it.** `533a61a`, on 2 September, is titled
"Never let a failed probe read as a negative" and fixed six instances at once.
Nineteen days later the same codebase yielded twenty-two more, most of them in
the two files that commit had itself edited. The class was understood,
documented in the commit message, and defended by new tests — and it recurred
anyway, because each fix was applied to the call sites that had been noticed
rather than to the shape.

**Reviews and tests found the cheap ones; hardware found the expensive ones.**
The four instances that surfaced on a real machine are the four that had
already shipped, and three of them were only caught because the operator knew
the true answer independently — an Autopilot-locked machine, a BitLocker
machine, an Entra-joined machine. Where the truth was not known in advance, the
wrong answer was indistinguishable from the right one.

**The engine was sound; the edges were not.** A separate audit of the
erase-and-verify path — read-back verification, sanitize status, hidden-area
handling, namespace enumeration, drive identity matching — found no instances.
Every defect sits in a probe that *describes* the machine, or in the layer that
turns a description into a sentence. The dangerous code was not the code doing
the destructive work.

## The rule

For any output that asserts an absence, three questions, in order:

1. **What read produced this, and how does that read fail?** If the failure
   value equals the negative value — empty string, empty list, zero, false,
   missing key — the assertion is unearned.
2. **Is the failure observable?** An exit status, an exception, a sentinel. If
   the code discards it (`2>/dev/null` with no `$?` check, `except: pass`, a
   filter that drops what it cannot parse), the observation exists and was
   thrown away.
3. **Does the vocabulary have a third value?** Two states cannot express three
   worlds. "Present", "absent" and "not established" are three answers, and the
   third has to be sayable in the type, the field, and the sentence on screen.

Two rules that fall out of the fixes rather than the theory:

- **A could-not-check is never cached.** An answer may be cached; a failure may
  not. One dead call settled the optical-drive question for a whole session.
- **Fix the fixture, not the check.** Four times in this sweep, adding a failure
  check broke a test — because the fixture modelled a command that cannot fail
  (a stubbed subprocess result with no exit status). The fixture was wrong each
  time. A test that has to be weakened to accommodate an honesty check is a
  test that was asserting the bug; one of them said so in its own name.

## What was deliberately not built

No attempt was made to tune the remaining UNKNOWNs into answers. Where the
truth is genuinely unavailable offline, the row keeps saying so.

## Open questions

Should a machine with drives hidden behind a RAID/Intel RST controller
(`profile.hiddenStorage`, which `expectedDrivesOf` never reads) be certifiable
at all? Left as-is: refusing would block real work on RST laptops, issuing
prints a certificate for disks nobody erased. **Owner's decision.**
