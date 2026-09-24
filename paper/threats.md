# 8. Threats to validity

**Draft 1.**

---

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

---

## Drafting notes

- The closing subsection is doing real work and should not be cut for budget.
  Without it, a reviewer reads six paragraphs of limitations and concludes
  nothing survives.
- "Arguably strengthens" is the right hedge. Do not upgrade it.
- If a second rater becomes available before submission, re-rate a random
  sample of ten and report the agreement. That single addition would answer
  the most serious threat here.
