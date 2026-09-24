# 5. Results

**Draft 2. 758 words of body, counted excluding tables and notes.**

---

We catalogue **32 call sites across 15 fix commits**, over 82 days and 526
commits. The full dataset, with inclusion criteria, is published alongside this
paper.

## 5.1 Direction

**All 32 failed towards the reassuring answer.** Not one produced a false
alarm.

The reported findings were: *no lock detected*, *no operating system
installed*, *no TPM detected*, *not enrolled*, *not joined*, *no hidden
drives*, *no encrypted volumes*, *no BIOS password*, *limitations: none
reported*, *0 ports responded*, *not present*, *movement and buttons work*.
Every one asserts that a thing which would have been a problem is absent.

This is not a property of the defects we chose to record. It follows from the
mechanism. A probe fails and returns empty, zero, false or missing; those are
the values that mean *nothing found*; and *nothing found*, in a system looking
for problems, means *no problem*. A probe whose failure produced a spurious
lock would be noticed within a day, because somebody would chase it.

One defect with the same root cause ran the other way and is excluded from the
count: a binary registry value reported as the literal domain name `hex`. It is
a false *presence*. We note it because it is the exception that shows the
direction is structural, not selective — and because including it would flatter
the statistic we are reporting.

## 5.2 What they reached

| | Count |
| --- | --- |
| Reported to a person, on screen or in a document | **31 / 32** |
| Could affect the erasure certificate | **18 / 32** |

The single defect that reached nobody was the one that destroyed data: an
unreadable queue file was treated as empty and then rewritten, discarding
audit records that had not yet uploaded. It produced no wrong sentence because
it produced no sentence at all.

## 5.3 Why the tests did not catch them

Eighteen of the 32 sat on code paths that **already had tests**. Those tests
caught **none** of them.

Examining each fixture gives two categories, and they are the same blindness
from opposite ends:

| | Count | The fixture… |
| --- | --- | --- |
| Working probe supplied | **14** | …gave the probe something it could read: a readable hive, a valid JSONL queue, a well-formed array, a GUID matching the filter, a device that answered |
| Adverse state never constructed | **4** | …never built the subject that matters: a locked drive, a legacy boot, a BitLocker volume, a record with zero rows |

Neither is negligence. A fixture is written from the author's mental model of
the path, and the author's model is of the path working. Catching this class
requires a fixture in which **the probe fails and the subject is dirty** — two
independently unlikely conditions, jointly unrepresented.

During this work, four existing tests broke when a failure check was added. In
every case the fixture was wrong, not the check: each stubbed a command that
could not fail, typically a subprocess result with no exit status. One test's
own name asserted the defect — it required that a probe returning nothing be
read as an empty result.

## 5.4 Detection latency

Days between the commit that introduced a defect and the commit that fixed it.

| min | q1 | median | q3 | max | mean |
| --- | --- | --- | --- | --- | --- |
| 0 | 1 | **19** | 43 | 70 | 21.7 |

The distribution is bimodal rather than central: **13 were caught within two
days, 8 survived more than thirty**, and the median falls in a sparse middle.
A false absence is either noticed while the surrounding work is still in hand,
or it persists for weeks — because nothing in normal operation distinguishes it
from a correct result.

The four longest-lived, at 68 to 70 days, are instructive: a TPM reported as
absent when it was merely disabled in firmware; a laptop recorded as a desktop
because its battery would not report a percentage; profile fields presented as
measured that were never measured; and namespace coverage computed and then
discarded. All four shipped wrong answers for more than two months, and all
four read as entirely ordinary output.

## 5.5 How they were found

| Method | Found | Median latency |
| --- | --- | --- |
| Systematic sweep | 20 | 20 days |
| Code review | 8 | 0 days |
| Real hardware | 4 | 10 days |

**This is not a controlled comparison and must not be read as one.** The sweep
looked hardest and looked last, so it found what the other two had left. Code
review's median latency of zero reflects only that review happens on code that
was just written.

What can be said is narrower: *normal operation found nothing*. Every instance
was found by somebody deliberately looking, or by a technician who
independently knew the true answer — an Autopilot-registered machine, a
BitLocker machine, a laptop with working USB ports. Where the truth was not
known in advance, the wrong answer was indistinguishable from the right one.

## 5.6 Where they cluster

| File | Instances |
| --- | --- |
| `tools/lock-checks.sh` | 16 |
| `tools/hardware-audit.sh` | 7 |
| `tools/gui/server.py` | 3 |
| `tools/gui/index.html` | 2 |
| API and web (4 files) | 4 |

Twenty-three of 32 (72%) are in two files, and **28 of 32 are in the station**
— the component that boots a customer's machine and examines it. Only four are
in the server or web application, which mostly *display* what the station
reported.

The class concentrates where code touches state it does not control. That is
the paper's thesis restated as a distribution, and it is the most directly
actionable result here: if a codebase has a component that probes the outside
world, that is where to look first.

---

## Drafting notes

- Every figure recomputed from `instances.csv` immediately before commit; all
  18 claims verified.
- Draft 1 said “the longest-lived, at 68 and 70 days” and named three, silently
  skipping a fourth at 69. Corrected to name all four. A small thing, but the
  paper argues that omissions read as completeness.
- §5.5's caveat paragraph must survive editing. Without it the table reads as
  "sweeps beat code review", which the data cannot support.
- §5.1's excluded counter-example (`c74df68`) answers the reviewer question
  that §1 and the abstract both left open. Having made the decision here, check
  that the abstract's note points at this section.
- The bimodality in §5.4 is asserted from a five-number summary over n=32. It
  is visible but not tested; either plot it or soften the wording. Do not
  claim a distribution shape a reader cannot verify from the table.
- Consider cutting §5.6's final paragraph if the word budget binds — it
  restates §2 rather than reporting.
