**Draft 1. Word count measured, not estimated — see the notes.**

---

## Abstract

An IT asset disposition business resells second-hand computers and issues two
documents about each one: a specification, and a certificate stating that the
previous owner's data has been destroyed. Both are claims about a machine the
business does not control, made once by a technician, about hardware that is
then sold. Nothing in normal operation reveals when such a claim is wrong.

We report the design and construction of a complete production system for this
job — 535 commits and roughly 101,000 lines over 78 days by one engineer —
comprising an offline-first inventory platform, a bootable audit appliance that
inspects and erases a customer's machine without starting its operating system,
an inspection layer that reads a powered-off Windows from its registry hives,
signed and chained erasure certificates, and a functional-test module that
records a technician's judgement as the measurement it is. We describe each
layer, what was rejected in building it, and what remains unproven.

Three findings generalise. First, claims about external state fall into four
**knowability tiers** — measured, recovered from an artefact, perishable, or
withheld by a third party — and the tier determines whether code, a process
change, or nothing will produce an answer; the commercially most valuable
question in this domain sits in the fourth tier, and we report how it was
answered by observation instead of deduction. Second, we catalogue 32 call sites
exhibiting a defect we name the **false absence**: a failed observation reported
as a confirmed negative. All 32 failed towards the reassuring answer; 18 sat on
code paths with existing tests, which caught none. Third, and least comfortable:
naming that class in a commit, documenting it in the affected code and defending
it with tests did not prevent the same author writing eight fresh instances
within three weeks.

We also report three deliberate feature removals, and argue that the useful
measure of a system under development is how much of it is load-bearing.

## Drafting notes

- The previous draft of this project's paper asserted its own abstract word
  count three times before measuring it, and was wrong each time. This one is
  measured with `python paper/assemble.py` before every commit and the figure is
  never written into the prose.
- No length limit applies yet because no venue is chosen (§ README). If one is,
  the third finding is the one to keep and the layer summary is the one to cut.
- The three findings are in the same order as §19's. Keep them synchronised.
