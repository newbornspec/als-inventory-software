# 1. Introduction

**Draft 2. 814 words (counted), targeting IEEE Software's 4,200-word total.**

---

On 20 September 2026, an audit station examined a second-hand laptop and
reported: **No operating system installed.**

The laptop's disk was full. It held a working Windows installation and every
document its previous owner had created. The drive was encrypted with
BitLocker, and that was the entire cause. Our detection code enumerated the
machine's filesystems and looked for `ntfs`. On an encrypted machine
`libblkid` — the library that identifies filesystems — does not report `ntfs`.
It reports `BitLocker`. A BitLocker machine laid out in the standard way, with
an EFI system partition, a Microsoft reserved partition and an encrypted
`C:`, has no NTFS filesystem anywhere on it. Our scan matched nothing, and
matching nothing was indistinguishable, in the code, from finding an empty
disk.

The sentence the operator read was not a guess or a hedge. It was a confident,
declarative finding, produced by a function that had looked at the disk and
understood none of what it saw. And it was the most dangerous sentence the
system could have produced, because a machine reported as blank is a machine
nobody looks at twice.

We did not find this by testing. We found it because a technician was holding
the laptop and knew it was not empty.

## 1.1 The shape, not the bug

The BitLocker filter was repaired in an afternoon. What took longer was
recognising that the same shape was everywhere.

A probe reads some state the program does not control — a device, a
filesystem, a registry hive, a queued file written by another process. The
probe can fail: the device is unreadable, the hive will not open, the command
is missing, the parse fails. When it fails it does not raise; it returns a
value. And the value it returns — an empty string, an empty list, zero, false,
a missing key — is the *same value* it returns when it succeeded and found
nothing.

At the point of use, the two are indistinguishable. The code picks one, and it
picks the one that reads as an answer.

We call this a **false absence**: a failed observation reported as a confirmed
negative.

The class is not symmetric, and the asymmetry is what makes it dangerous.
Failure produces empty, zero, missing and false — precisely the values that
mean *nothing is wrong*. A crash is noisy and gets fixed within the hour. A
false absence is quiet, and gets printed on a certificate.

## 1.2 Why conventional testing does not find it

Eighteen of the defects we catalogue occurred on code paths that already had
tests. None of those tests caught them.

This is not negligence. A fixture is written from the path its author is
thinking about, which is the path where the probe works. Catching this class
requires a fixture in which **the probe fails and the subject is dirty** — two
independently plausible conditions, jointly unrepresented. §5.3 gives the
breakdown, and the four occasions on which adding a failure check broke a test
whose fixture modelled a command that could not fail.

## 1.3 Contributions

We report on an industrial codebase, a platform that erases and certifies
second-hand computers for resale, over 82 days and 526 commits. Its principal
output is a data-erasure certificate that a buyer relies on, which makes an
over-confident negative a commercial and legal exposure rather than a cosmetic
defect.

1. **A catalogue of 32 instances across 15 fix commits**, with the commit that
   introduced each, detection latency, whether the value was user-visible, and
   whether a test covered the path. Inclusion criteria are stated in advance
   and the dataset is published.
2. **A directional finding.** All 32 failed towards the reassuring answer. Not
   one produced a false alarm. We argue this direction is structural rather
   than incidental.
3. **A recurrence finding, which is the paper's main result.** The class was
   explicitly named in a commit message on 2 September, and six instances were
   fixed together that day. Nineteen days later, a systematic search of the same
   codebase found twenty-six more — 17 of them (65%) in the two files that the
   naming commit had itself edited. **Naming a defect class, documenting it, and
   defending it with new tests did not prevent its recurrence.**

Section 2 defines the class. Section 3 describes the system. Section 4 gives
our method and criteria. Sections 5 and 6 present the catalogue and the
recurrence result. Section 7 offers a rule we now apply, and Section 8 the
threats to validity.

---

## Drafting notes

- **Length**: run a word count before this is considered done. Every previous
  estimate in this project was wrong until measured.
- The opening must stay concrete. Resist moving the definition earlier; a
  reader who has not felt the BitLocker case will read §1.1 as obvious.
- "We did not find this by testing" — verify against `instances.csv`:
  `found_by` for instance 25 is `hardware`. Correct.
- §1.2's claim of eighteen is `test_existed = yes` in the dataset. Re-verify at
  submission.
- **"twenty-two more" was wrong and is now twenty-six.** Twenty-two was a
  leftover from the superseded count of 23; under the stated criteria it is
  32 total minus the 6 fixed on 2 September. The recurrence finding is
  therefore *stronger* than the legacy figure suggested, not weaker. Third
  time a pre-measurement number has survived into prose in this project.
- The "65% in the same two files" figure maps each instance's `layer` to a
  file; the mapping is in the verification script, not yet in the CSV. Add a
  `file` column before submission so the claim is checkable without it.
- Consider whether §1.3 item 3 should name the commit hash inline. Probably
  not in the introduction; it belongs in §6.
- Open question from `abstract.md` still stands: whether to footnote the one
  excluded counter-example (`c74df68`) beside the directional claim.
