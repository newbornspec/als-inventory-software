# Inclusion criteria and counting rules

Written **before** analysis, and applied uniformly. This document exists so the
count in the paper can be defended, and so a reader can recount from
`instances.csv` and get the same answer.

## What counts as an instance of the class

All four must hold:

1. **A probe reads external state.** State the code does not control: a
   device, a filesystem, a registry hive, a network service, a stored record
   written by another process. Pure internal logic errors are excluded.
2. **The probe can fail, and does so without raising.** It returns a value.
   (A probe that throws, and whose exception is swallowed, counts — the
   swallow is what produces the value.)
3. **The failure value is indistinguishable from a genuine negative result**
   at the point of use. Empty string, empty list, zero, false, missing key,
   `None` — where the same value also means "looked, found nothing".
4. **That value was reported as a finding**, to a person or onto a record,
   without qualification.

## What is excluded, and why

| Excluded | Reason |
| --- | --- |
| Crashes, 500s, hangs | Not silent. They announce themselves. |
| Wrong values that are not absences | Different class — e.g. `c74df68`, where a binary blob was reported as the domain name "hex". That is a false **presence**. Noted separately; not counted. |
| Absences correctly reported as unknown | The system doing its job. |
| Defects found and fixed in the same commit, never committed in a broken state | Never existed in the codebase. |
| Test-only code | Does not reach a record or a screen. |

**A note on the one exclusion that was tempting.** `c74df68` ("domain hex")
has the same root cause — a value nobody decoded, reported as a fact — and the
same consequence, a wrong claim on a customer's audit. It is excluded because
its *direction* is opposite: it invents a presence rather than an absence, so
including it would weaken the directional finding, which is the paper's main
quantitative claim. It belongs in the discussion, not in the count.

## The counting problem, and how it is resolved

Three fix commits each repaired several independent call sites:
`533a61a` (six), `d958b21` (five), `5ab21f1` (seven). Counting a commit as one
instance understates; counting every changed line overstates.

**Two counts are reported, and both are derivable from the dataset:**

| Count | Definition | Value |
| --- | --- | --- |
| **Call sites** | One per distinct code path where the failure value was reported as a finding. `instances.csv` row count. | **32** |
| **Fix commits** | One per commit that repaired at least one call site. Distinct `group_commit`. | **15** |

A call site is *distinct* when it has its own probe and its own reported
sentence. Six lock detectors each making their own hive read and each
announcing their own negative are six call sites, not one — they were fixed
together because they were found together, not because they are one defect.

**The paper leads with 32 and states 15 alongside it.** Neither number is
presented without the other.

> Earlier informal write-ups of this work said "23". That was the row count of
> a narrative table which grouped some call sites and split others. It is
> superseded by this document; the discrepancy is recorded here rather than
> quietly corrected.

## Field definitions

| Field | Definition |
| --- | --- |
| `intro_commit` | The commit that introduced the defective code path, found with `git log -S` on a string the fix removed or changed, restricted to the file. Where the string post-dates the defect, the commit that created the enclosing function is used. |
| `latency_days` | Calendar days between `intro_date` and `fix_date`. **Not** a measure of exposure: a defect is only exposed once it ships to a stick, which for station code is the next sync. Treat as an upper bound on time-to-detection and nothing more. |
| `user_visible` | The reported value reached a screen, a report or an exported document. |
| `reached_certificate` | The value could affect the erasure certificate — the legally consequential output. |
| `found_by` | `review` (reading code), `hardware` (observed on a real machine), `sweep` (the systematic search of 21–22 September). |
| `test_existed` | A test covered the code path at the time the defect was live. |
| `why_test_missed` | Where `test_existed` is yes, what the fixture did instead. |

## Threats specific to this dataset

- **Single observer.** One person wrote, catalogued and fixed every instance.
  There is no independent classification, and criterion 3 requires judgement.
- **Retrospective.** Instances were classified after the class was named.
  Instances that did not survive into the sweep are absent by construction.
- **`latency_days` is soft.** `git log -S` finds where a *string* first
  appeared, which is not always where the *defect* began — a refactor that
  moved a line resets it. Four entries where the enclosing function was used
  instead are the least reliable.
- **`found_by` is not a controlled comparison.** The sweep looked hardest and
  found most. It cannot be concluded that sweeps outperform review, only that
  the sweep found what review and normal use had left.
- **No base rate.** Nothing here says whether 32 in 82 days is high or low.
