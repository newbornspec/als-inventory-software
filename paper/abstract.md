# Abstract (draft 2)

Written to the IEEE Software limit of 150 words. Count verified below.

---

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

---

## Three actionable insights (IEEE Software requires these)

- **If a probe's failure value equals its negative value, the assertion is
  unearned.** Ask what read produced the answer, how that read fails, and
  whether the failure is observable — then give the vocabulary a third value
  that says *not established*.
- **Never cache a could-not-check.** An answer may be cached; a failure may
  not. One dead call settled a question for an entire session.
- **When an honesty check breaks a test, fix the fixture.** A test that must be
  weakened to accommodate the check was asserting the bug, not the contract.

---

## Notes on this draft

- **Draft 1 claimed 148 words and was 158.** Corrected by naming the domain
  more plainly ("an industrial platform that erases and certifies second-hand
  computers for resale"), which was shorter *and* clearer for a general
  software-engineering audience — a note draft 1 had already flagged.
- The "23" used in earlier informal write-ups is superseded by 32 call sites /
  15 fix commits. See `inclusion-criteria.md`.
- "Eighteen occurred on code paths that already had tests" comes from
  `test_existed` in `instances.csv`. Re-verify before submission.
- The recurrence claim is the contribution and should not be softened. It is an
  observation about one codebase's own timeline, so it survives the n=1
  limitation that weakens every other figure here.
- **Resolved in §5.1.** The excluded counter-example (`c74df68`) and the
  argument that the direction is structural rather than selective are both
  stated in the results. The abstract needs no footnote: the reviewer's
  question is answered where they will look for it.
