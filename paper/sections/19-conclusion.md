**Draft 1.**

---

## 19. Conclusion

An ITAD business sells second-hand computers and issues documents saying what
they are and that the data on them is gone. Those documents are claims about
machines nobody in the business controls, made once, briefly, by a technician,
about hardware that is then sold. Nothing in the normal operation of such a
business tells you when one of them is wrong.

We built the whole system for that job in 78 days: an offline-first inventory
platform, a bootable audit appliance that examines and erases a customer's
machine without ever starting its operating system, an inspection layer that
reads a powered-off Windows out of its own registry, an erasure engine whose
certificates are signed and chained, and a functional-test module that treats a
technician's answer as the measurement it is. Part II describes each layer and
what was rejected in building it.

Three findings generalise beyond the business.

**Claims have knowability tiers, and the tier decides what effort will work.**
Measured, recovered from an artefact, perishable, or withheld by a third party.
Code answers the first two. The third needs a process change upstream of
whatever destroys the fact. The fourth needs to be reported as unanswered — and
the most valuable question this system could answer, whether a machine is
registered to somebody else's provisioning tenant, turned out to sit there. We
built three partial answers, one of them definitive, by abandoning deduction and
observing the moment the machine itself finds out.

**In a system that looks for problems, every failed probe fails towards the
reassuring answer.** Empty, zero, false and absent are the values that mean *no
problem*. We catalogued 32 call sites where a failed observation was reported as
a confirmed negative, and all 32 pointed the same way. Eighteen sat on code
paths that already had tests, and those tests caught none of them, because a
fixture is written from the author's model of the path working.

**Naming the defect class was not enough.** A commit named it, documented it in
the affected functions, and defended the fix with tests worth a third of its own
diff. Eight fresh instances were written within the next three weeks, by the
same author, in the same files. The lesson had been recorded and was not
recalled — because a rule that lives in prose must be remembered, and the moment
it is needed is the moment attention is on making something work. The remedy is
not more emphasis. It is to move the rule into a type, into fixtures that can
fail, and into a search that is run rather than hoped for.

What we cannot report is whether that worked. The observation window closes with
the sweep, and a codebase swept once is not a codebase that stays swept. We
report the response rather than a cure, for the same reason the rest of this
paper distinguishes what was established from what was assumed — which is the
only discipline that made any of it trustworthy.

The system is in daily use. Its most valuable property is not any single
capability described here. It is that when it cannot establish something, it
says so.

## Drafting notes

- Three findings, in the order §11, §12.1, §12.4. Do not add a fourth; the
  deletion argument (§13) is an argument rather than a finding and belongs in
  the body.
- The closing line is the paper's thesis in nine words. Check it survives any
  edit.
- Deliberately no future-work paragraph. What is blocked or undecided is in §16
  where a reader can act on it, and a conclusion that ends on a to-do list ends
  on the weakest available note.
