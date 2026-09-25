**Draft 1. Compressed from the standalone draft in `paper/archive/`, which
retains the full treatment, the method, and the drafting history.**

---

## 12. Evidence integrity: the false absence

Every layer in Part II has, at some point, reported something it had not
established. This section names that defect, measures it across the whole
project, and reports an uncomfortable result about what naming it achieved.

### 12.1 The class

A **false absence** is a failed observation reported as a confirmed negative.
It requires four conditions, all of which must hold:

1. A probe reads state the program does not control — a device, a filesystem, a
   registry hive, a remote service.
2. The probe can fail **without raising**. It returns a value.
3. At the point of use, that failure value is **indistinguishable from a
   genuine negative**: empty string, empty list, zero, false, missing key.
4. The value is **reported as a finding**, unqualified, to a person or onto a
   record.

Condition 3 is the operational test, and a developer can apply it at the
keyboard: **does this probe's failure value equal its negative value?** If it
does, any assertion built on it is unearned.

The class has a direction, and the direction is not incidental. Failure
produces empty, zero, false, absent — and in a system that examines things for
problems, those are exactly the values that mean *no problem*. A probe that
fails resolves, every time, towards the reassuring answer.

The converse defect is self-correcting. A probe whose failure produced a
spurious *lock* would be chased down within a day, because a false alarm costs
somebody an hour and they complain. This is not hypothetical: §7.3 describes
one, a binary registry value that made machines appear domain-joined to an
organisation called "hex". It was caught almost immediately. A false absence
costs nothing visible, and gets certified.

### 12.2 What was catalogued

**32 call sites across 15 fix commits**, over 82 days and 526 commits. The
dataset, with the inclusion criteria written before the analysis, is published
in `paper/evidence/`.

| Finding | |
| --- | --- |
| Failed **towards the reassuring answer** | **32 / 32** |
| Reached a person, on screen or in a document | 31 / 32 |
| Could affect the erasure certificate | 18 / 32 |
| In the audit station rather than the server or web app | 28 / 32 |

The reported sentences were: *no lock detected*, *no operating system
installed*, *no TPM detected*, *not enrolled*, *not joined*, *no hidden
drives*, *no encrypted volumes*, *no BIOS password*, *limitations: none
reported*, *0 ports responded*, *not present*, *movement and buttons work*.
Every one asserts that something which would have been a problem is absent.

The single instance that reached nobody is the one that destroyed data: the
unreadable queue file of §5.4, treated as empty and then rewritten. It produced
no wrong sentence because it produced no sentence at all.

Twenty-three of the 32 are in two files, and 28 are in the station — the
component that boots a customer's machine and examines it. **The class
concentrates where code touches state it does not control**, which is the
sharpest practical guidance this catalogue offers.

### 12.3 Why the tests did not catch them

Eighteen of the 32 sat on code paths that **already had tests**. Those tests
caught **none** of them. Examining each fixture gives two categories, which are
the same blindness from opposite ends:

| | Count | The fixture… |
| --- | --- | --- |
| Working probe supplied | 14 | …gave the probe something it could read |
| Adverse state never constructed | 4 | …never built the subject that matters |

Neither is negligence. A fixture is written from the author's mental model of
the path, and that model is of the path *working*. Catching this class needs a
fixture in which **the probe fails and the subject is dirty** — two
independently unlikely conditions, jointly unrepresented.

During this work, four existing tests broke when a failure check was added. In
every case **the fixture was wrong, not the check**: each stubbed a command
that could not fail. One test's own name asserted the defect.

### 12.4 The recurrence finding

On 2 September a commit landed titled **"Never let a failed probe read as a
negative."** It repaired six lock detectors, **named** the class in its own
title, **documented** the reasoning in the affected functions, and **defended**
the fix with 75 new lines of tests — a third of the diff. By any ordinary
standard the lesson had been learned and recorded.

Nineteen days later, a systematic search of the same codebase found twenty-six
further instances. That figure conflates two claims of unequal strength, so
they are separated:

| | Instances | What it means |
| --- | --- | --- |
| Fixed **by** the naming commit | 6 | The instances that prompted the naming |
| Introduced **before** it, found later | 18 | Naming failed to **find** these |
| Introduced **after** it | **8** | Naming failed to **prevent** these |

The eighteen are a failure of *search*, not understanding — ten of them were
introduced earlier the same day by the commit that created the detectors, which
was verified by ancestry rather than assumed. Nobody claims a targeted fix is
an audit.

**The eight introduced afterwards are the finding.** Every one was written
seventeen to eighteen days after the class was named, by the same author, in
the same codebase, with the naming commit in the history and its tests passing.
Four of the eight are in the two files that commit had itself edited.

Three explanations, in increasing order of discomfort:

- **The fix was applied to call sites, not to a shape.** It introduced no type,
  no helper, no construct that would make the next probe honest by default. A
  lesson that lives in prose must be recalled; a lesson that lives in a type
  cannot be forgotten.
- **The class is invisible at the moment of writing.** The failure branch is
  not where the author's attention is, and the value it returns is the natural
  thing to return. Writing the defect requires no error and no carelessness.
- **All eight were written in a two-day burst** — the densest period in the
  project. They cluster precisely where new surface was being created fastest.
  The rule was not rejected under pressure; it never came to mind.

Stated precisely, and narrowly:

> **Naming a defect class, documenting it in the code, and defending it with
> tests was not sufficient to prevent the same author from writing eight fresh
> instances of it in the same codebase within three weeks.**

If that is the outcome under conditions this favourable — one author, a small
codebase, the lesson written in the file being edited — it is unlikely to be
better on a larger team.

### 12.5 The response, and what cannot be claimed

Three things changed, none of them more documentation: a **sweep** that is run
rather than hoped for; **tests that assert the third value**, not only the
negative; and **fixtures that can fail**.

**We cannot report whether this worked.** The observation window closes with
the sweep on 22 September. A codebase swept once is not a codebase that stays
swept, and on the evidence here the honest expectation is that instances will
accumulate again — which is precisely what §12.4 found the first time.

## Drafting notes

- This is a compression of roughly 3,700 words into about 1,300. The full
  treatment — the method, the inclusion criteria, the latency distribution, the
  threats specific to this dataset — is intact in `paper/archive/`, and should
  be offered as a companion artefact rather than folded back in.
- Cut in compression, and worth restoring if space allows: detection latency
  (median 19 days, bimodal, longest four at 68–70), and the how-found split
  (sweep 20, review 8, hardware 4) with its caveat that it is **not** a
  controlled comparison.
- §12.1's "hex" counter-example is described in §7.3. Keep both; they serve
  different arguments and neither restates the other.
- The 6 / 18 / 8 decomposition is recomputable from `evidence/instances.csv`.
