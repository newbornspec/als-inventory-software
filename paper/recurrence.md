# 6. The recurrence finding

**Draft 2. 902 words of body, counted excluding tables and notes.**

---

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

---

## Drafting notes

- **Ordering was verified**, not assumed: `git merge-base --is-ancestor
  a61f70b 533a61a`. The ten same-day instances genuinely pre-date the naming.
- The 6 / 18 / 8 decomposition is the section's spine and is recomputable from
  `instances.csv` by `intro_date` against 2026-09-02.
- §6.3's third explanation (the two-day burst) is the weakest — it is a
  correlation over eight points and should be offered, not argued. Draft 1 said
  "six of the eight"; the dataset says all eight were introduced on 19–20
  September. Corrected.
- **Word counts in this file must exclude the tables**, whose markdown
  separators are also `---`. Draft 1's automated count returned 152 for a
  section of roughly 1,000 words. Count the body explicitly.
- §6.4's list describes what we did; it is **not** evidence that it worked, and
  §6.4's closing paragraph must survive editing. A reviewer will otherwise read
  the section as claiming a cure.
- Consider whether "the same author" should be stated in §1 as well, since it
  is load-bearing here and is also a threat to validity.
- Cross-check the 20 / 8 / 4 detection split against `found_by` before
  submission.
