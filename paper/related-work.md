# 9. Related work

**Draft 1. Positioning only — the class's boundaries are in §2.2.**

---

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

---

## Drafting notes

- **Every citation here must be checked against the actual paper before
  submission.** These are positioned from memory of the literature and at least
  one attribution is likely to be imprecise. Do not submit on this draft.
- IEEE Software allows 15 references. This section implies 5–8; the remainder
  should go to the system's own artefacts and to any second empirical study
  found during the check above.
- Search terms for the literature review: "error handling bugs empirical",
  "fail-silent", "silent failure detection", "sensor validity flag", "null
  semantics unknown absent", "exception swallowing empirical study".
- If a prior naming of this exact class is found, the paper's framing changes
  from *naming* to *measuring*, and §6 becomes the sole contribution. Check
  before writing the final draft.
