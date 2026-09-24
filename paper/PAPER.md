# False absence: a defect class in systems that report on external state

*Assembled from the section files in this folder — edit those, not this.*
*Drafting notes are excluded. Regenerate with `python paper/assemble.py`.*

## Abstract

Software that reports on external state — devices, filesystems, services —
contains a defect class in which a probe's failure is
indistinguishable from a genuine negative result, and is reported as one. We
catalogue 32 such defects across 15 fix commits in an industrial platform that
erases and certifies second-hand computers for resale. Every one failed towards
the reassuring answer: no lock, no operating system, no limitations, nothing
hidden. None produced a false alarm. Eighteen occurred on code paths that
already had tests, none of which caught them, because a fixture is written from
the successful path and so never constructs a broken probe examining a dirty
subject. The class was named in a commit message and fixed six times in one
day; nineteen days later a systematic search found twenty-six more, most in the
files that commit had itself edited. Naming a defect class does not prevent its
recurrence.

## 1. Introduction

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

## 2. The class

A **false absence** is a failed observation reported as a confirmed negative.

It requires four conditions, all of which must hold:

1. **A probe reads state the program does not control** — a device, a
   filesystem, a registry hive, a remote service, a file written by another
   process.
2. **The probe can fail without raising.** It returns a value. (A probe that
   throws into a handler which returns a value also qualifies; the handler is
   what produces the value.)
3. **At the point of use, the failure value is indistinguishable from a genuine
   negative result.** Empty string, empty list, zero, false, missing key,
   `null` — some value that also, legitimately, means *looked and found
   nothing*.
4. **That value is reported as a finding**, without qualification, to a person
   or onto a record.

Condition 3 is the operational test, and it is one a developer can apply at the
keyboard: **does this probe's failure value equal its negative value?** If it
does, any assertion built on it is unearned.

## 2.1 The asymmetry

The class has a direction, and the direction is not incidental.

Failure produces `""`, `[]`, `0`, `false`, absent. In a system that examines
something for problems, those are the values that mean *no problem*: no lock,
no encryption, no hidden partition, no limitation. So a probe that fails
resolves, every time, towards the reassuring answer.

The converse defect is possible but self-correcting. A probe whose failure
produced a spurious *lock* would be chased down within a day, because a false
alarm costs somebody an hour and they complain. A false absence costs nothing
visible, and gets certified.

This is why the class survives in codebases that are otherwise well tested: it
generates no incidents, no support calls, and no failing builds. It generates
only quiet, confident, wrong answers.

## 2.2 What it is not

The class overlaps three familiar ideas and is none of them. **Exception
swallowing** is one mechanism that produces a false absence, but most instances
we catalogue involve no exception at all — a filter that matches nothing, a
parse that yields an empty array. **Fail-silent behaviour**, in the
dependability tradition, means a component *stops* rather than emitting a wrong
result; a false absence is the opposite, continuing and speaking with
confidence. The **null-versus-absent** distinction is the *remedy*, not the
defect: a system lacking it must pick one meaning for one value, and picks the
wrong one. §9 positions the work against each.

## 2.3 The remedy has to exist in three places

Recognising the class implies a fix that is easy to state and easy to
under-implement: give the vocabulary a third value.

Two states cannot express three worlds. *Present*, *absent* and **not
established** are three answers, and the third has to be sayable in all three
of:

- **the type** — so the code cannot conflate them;
- **the stored field** — so the record preserves the distinction; and
- **the sentence a person reads** — so the operator is not left to infer it.

Implementing the first two and not the third produces a system that knows it
could not check and still prints *not detected*. We did exactly this more than
once. A field that says "could not check" and a screen that renders that as a
blank has moved the defect, not removed it.

## 3. The system

The codebase is a commercial platform for IT asset disposal: the business of
taking in second-hand computers, establishing what they are, erasing them, and
reselling them. It comprises a web application and API, and a **bootable USB
audit station** that boots a customer's machine into Linux, examines it, wipes
its drives and files a record.

Three properties of the domain matter for this paper.

**The station examines a machine it knows nothing about.** Every machine is
different hardware, in unknown condition, possibly with an unreadable drive, a
locked firmware, an encrypted volume or no operating system at all. Almost
every question the station answers requires probing something it does not
control. This is the architectural position where the class lives.

**The station boots Linux, so the machine's Windows is never running.** The
installed operating system is read from its registry hives offline, with the
volume mounted read-only. There is no API to ask, no agent to query — only
artefacts to interpret, each of which can be unreadable for reasons that look
identical to being absent.

**The output is a legal document.** The platform issues a Certificate of Data
Erasure that a buyer relies on. A false absence here is not a cosmetic defect:
it is a signed statement that a machine carries no lock, no residual data, or
no limitation, made by code that failed to look.

The observation window is **82 days and 526 commits**, from the project's first
commit to the end of the sweep. The system was under active development
throughout by a single developer, shipping to a working warehouse.

## 4. Method

## 4.1 How instances were found

Three sources, in the order they occurred:

- **Code review** — reading code for the shape, usually while working on
  something adjacent.
- **Real hardware** — a technician observing an answer they independently knew
  to be wrong: a machine they knew was enrolled, encrypted, or had working
  ports.
- **A systematic sweep** — an explicit search of the codebase for the shape,
  conducted 21–22 September, examining every probe that reported a negative.

The sweep was not a static-analysis pass. No tool was written for it; it was a
manual reading of every site where a read result became a reported finding.
Whether the class is amenable to automated detection is untested and is left as
future work.

## 4.2 Classification

Each candidate was admitted only if all four conditions in §2 held. Five
categories were excluded: crashes and other noisy failures; wrong values that
are not absences; absences correctly reported as unknown; defects fixed before
ever being committed in a broken state; and test-only code.

## 4.3 Counting

Three fix commits each repaired several independent call sites, so we report
both counts: **32 call sites** — one per distinct code path where a failure
value was reported as a finding — and **15 fix commits**. A call site is
distinct when it has its own probe and its own reported sentence; six detectors
each making their own read and announcing their own negative are six, fixed
together because they were found together.

## 4.4 Provenance

For each instance we recovered the introducing commit with `git log -S` on a
string the fix removed, restricted to the file. Where the string post-dated the
defect, we used the commit that created the enclosing function; four entries
rest on that weaker method and are marked.

Detection latency is calendar days between introduction and fix. It is an
**upper bound on time-to-detection, not a measure of exposure**: station code
does not reach a machine until the next USB sync.

## 5. Results

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

The class concentrates where code touches state it does not control.

## 6. The recurrence finding

On 2 September 2026 at 20:22, a commit landed with the title **"Never let a
failed probe read as a negative."** It repaired six lock detectors whose
registry reads could fail and whose failure was being reported as a confirmed
negative: *not enrolled*, *not joined*, *no traces*.

The commit did three things beyond the repair. It **named** the class, in its
own title and in a body explaining the shape. It **documented** the reasoning
in the affected functions. And it **defended** the fix with 75 new lines of
tests — a third of the diff.

By any ordinary standard, the lesson had been learned and recorded.

Nineteen days later, a systematic search of the same codebase found
twenty-six further instances of the same class.

## 6.1 Two different failures, counted separately

"Twenty-six more" conflates two claims of unequal strength, and we separate
them.

| | Instances | What it means |
| --- | --- | --- |
| Fixed **by** the naming commit | 6 | The instances that prompted the naming |
| Introduced **before** it, found later | 18 | Naming failed to **find** these |
| Introduced **after** it | **8** | Naming failed to **prevent** these |

The eighteen require care. Ten were introduced earlier the same day, by
`a61f70b` at 18:56 — the commit that created the lock detectors in the first
place. We verified by ancestry that it precedes the naming commit, so those ten
were already present in the code being repaired at 20:22. The author fixed six
defects of a named class in a file that contained sixteen, and stopped.

That is a failure of **search**, not of understanding, and it is the less
surprising result. Nobody claims a targeted fix is an audit.

**The eight introduced afterwards are the finding.**

## 6.2 The eight written after the class was named

| Introduced | Component | File | Detected by |
| --- | --- | --- | --- |
| 19 Sep | hidden-drive scan | `hardware-audit.sh` | sweep |
| 19 Sep | hidden drives (sysfs path) | `hardware-audit.sh` | review |
| 19 Sep | wipe limitations | `wipe-detail.ts` | sweep |
| 19 Sep | certificate gate | `wipe-rollup.ts` | sweep |
| 20 Sep | OS disk verdict | `hardware-audit.sh` | sweep |
| 20 Sep | OS detection (BitLocker) | `hardware-audit.sh` | hardware |
| 20 Sep | trackpad summary | `hardware-test.ts` | sweep |
| 20 Sep | USB port test | `index.html` | hardware |

Every one was written **seventeen to eighteen days after** the class was named,
by the same author, in the same codebase, with the naming commit in the
history and its tests passing in CI. Four of the eight are in the two files
that commit had itself edited.

These are not old code discovered late. They are new instances of a documented
defect class, written by someone who had documented it.

## 6.3 Why naming was not enough

We offer three explanations, in increasing order of how uncomfortable they are.

**The fix was applied to call sites, not to a shape.** The naming commit
repaired six specific reads. It did not introduce a type, a helper, or any
construct that would make the next probe honest by default. A lesson that lives
in prose must be recalled; a lesson that lives in a type cannot be forgotten.
Every one of the eight was written by someone who would have agreed with the
rule if asked — and was not asked, because nothing asked.

**The class is invisible at the moment of writing.** A developer writing a
probe is thinking about what it reads. The failure branch is not where their
attention is, and the value it returns — empty, zero, false — is the natural
thing to return. Writing the defect requires no error and no carelessness. It
requires only not thinking about a second thing while thinking about a first.

**All eight were written in a two-day burst.** Every one was introduced on 19
or 20 September — 125 commits across those two days, the densest in the
project, carrying four separate pieces of work: the erasure remediation waves,
per-drive health, reading the installed OS, and the hardware test module. The
defects cluster precisely where new surface was being created fastest. The rule
was not rejected under time pressure; it simply never came to mind, because the
attention was on making something work.

## 6.4 What we changed as a result

The response was not more documentation. It was to make the class **findable
on demand** and **harder to write**:

- A **sweep** — an explicit, periodic search for the shape, rather than
  trusting that it will be noticed. The sweep found 20 of the 32 instances in
  this catalogue; code review found 8 and real hardware 4.
- **Tests that assert the third value**, not just the negative. A test that
  only checks "reports absent when absent" passes over the defect. The suites
  now assert that a *broken probe* reports *could not check*.
- **Fixtures that can fail.** Four times, adding a failure check broke an
  existing test whose stub modelled a command that cannot fail. Those fixtures
  were corrected rather than the checks weakened.

We cannot report whether this worked. The sweep concluded on 22 September and
the observation window closes there. **A codebase that has been swept once is
not a codebase that stays swept**, and on the evidence here the honest
expectation is that instances will accumulate again.

## 6.5 The claim, stated precisely

We do not claim that naming a defect class is useless. The naming commit fixed
six real defects and its tests still hold.

We claim something narrower and, we think, more useful:

> **Naming a defect class, documenting it in the code, and defending it with
> tests was not sufficient to prevent the same author from writing eight fresh
> instances of it in the same codebase within three weeks.**

If that is the outcome under conditions this favourable — a single author, a
small codebase, the lesson written in the file being edited — it is unlikely to
be better on a larger team with more turnover.

The remedy is not more emphasis. It is to move the rule out of memory: into
types, into fixtures that can fail, and into a search that is run rather than
hoped for.

## 7. What to do about it

The remedy that follows from §6 is not more emphasis. A rule that must be
recalled will be forgotten by the person who wrote it, within three weeks, in
the file they wrote it in. The rule has to be moved out of memory.

## 7.1 Three questions, at the keyboard

For any output that asserts an absence:

1. **What read produced this, and how does that read fail?** If the failure
   value equals the negative value — empty, zero, false, missing — the
   assertion is unearned.
2. **Is the failure observable?** An exit status, an exception, a sentinel.
   Where the code discards it (`2>/dev/null` with no status check, a bare
   `except: pass`, a filter that silently drops what it cannot parse), the
   observation existed and was thrown away.
3. **Does the vocabulary have a third value?** *Present*, *absent* and *not
   established* — in the type, in the stored field, **and** in the sentence a
   person reads.

## 7.2 Two corollaries, learned the hard way

**A could-not-check is never cached.** An answer may be cached; a failure may
not. One dead call settled the optical-drive question for an entire session,
because the failure was memoised alongside the successes.

**When an honesty check breaks a test, fix the fixture.** This happened four
times. Every time, the fixture modelled a command that cannot fail — a stubbed
subprocess result with no exit status. A test that must be weakened to
accommodate an honesty check was asserting the bug, not the contract.

## 7.3 Where to look first

28 of 32 instances were in the component that probes the outside world, and 23
in two files (§5.6). A team adopting nothing else from this paper can act on
that: identify the component that probes, read every site where a read result
becomes a reported finding, and apply question 1. That is what the sweep was,
and it found 20 of the 32.

## 7.4 What we do not claim

We changed three things after the sweep: we made the search explicit and
repeatable, we required tests to assert the third value rather than only the
negative, and we corrected fixtures so a probe can fail in them.

**We cannot report whether this worked.** The observation window closes with
the sweep. A codebase swept once is not a codebase that stays swept, and on the
evidence here the honest expectation is that instances will accumulate again
— which is precisely what §6 found the first time.

## 8. Threats to validity

**One system, one domain.** Every instance comes from a single codebase in IT
asset disposal. The class is claimed to generalise to any software that reports
on state it does not control; that claim rests on the mechanism described in
§2, not on evidence from a second system. We have none.

**One observer, who is also the author of the defects.** The same person wrote
the code, introduced the defects, found them, fixed them and classified them.
There is no independent classification, and condition 3 in §2 —
*indistinguishable at the point of use* — requires judgement. A second rater
would strengthen the catalogue considerably and was not available.

**Retrospective classification.** Instances were identified after the class was
named, by someone looking for it. Instances that were fixed before the class
had a name, or that were never recognised as members, are absent by
construction. The catalogue is therefore a lower bound of unknown tightness.

**No base rate.** Nothing here establishes whether 32 instances in 82 days is
high, low or typical. Without a comparable measurement in another system, the
count is a description of this codebase and not a rate.

**Detection latency is soft.** `git log -S` finds where a *string* first
appeared, which is not always where the defect began: a refactor that moves a
line resets it. Four entries fall back to the enclosing function's creation
date. Latency is reported as an upper bound and should not be treated as
exposure time, since station code reaches a machine only at the next sync.

**The detection-method comparison is confounded.** The sweep looked hardest and
looked last; code review operates on code just written. §5.5 reports the split
and explicitly declines to rank the methods.

## What survives these

The recurrence finding in §6 is the paper's main result, and it is the claim
least damaged by the above. It is an observation about **one codebase's own
timeline**: a class was named at a known moment, and eight fresh instances were
written afterwards by the same author. That needs no base rate, no second
system and no external rater. The single-observer threat, which weakens the
catalogue, arguably *strengthens* this one: the person who forgot the rule is
the person who wrote it down.

## 9. Related work

**Dependability taxonomy.** Avižienis, Laprie, Randell and Landwehr's fault /
error / failure framework gives the vocabulary for silent failure, and the
notion of a *fail-silent* component that stops rather than emitting a wrong
result. A false absence is the complement: the component neither stops nor
signals, and emits a result that is wrong in a specific direction.

**Error-handling defects.** Empirical studies of error handling in
distributed systems — most prominently Yuan et al.'s analysis of failures in
data-intensive systems — establish that error-handling code is
disproportionately buggy and under-tested. Our contribution is narrower and
orthogonal: we characterise what the erroneous handler *produces*, and show
that in a reporting system its output has a consistent and dangerous
direction.

**Silent data corruption and sensor validation.** Control and instrumentation
practice already distinguishes "no signal" from "signal reads zero", and
invests in validity flags to keep them apart. That discipline has not
transferred to general-purpose software that probes an environment, where the
two are routinely collapsed into one value.

**Option types and null semantics.** The distinction between *absent* and
*unknown* is well established in type systems and in database theory. We treat
it as the remedy rather than the subject: the contribution here is evidence of
what happens in a real system that lacks the distinction, and — in §6 —
evidence that knowing about the distinction is not sufficient to apply it.

**Alarm design.** Work on alarm fatigue in clinical monitoring documents the
cost of false positives. The class described here is the mirror: a failure mode
that generates no alarms at all, and is therefore invisible to every process
that responds to them.
