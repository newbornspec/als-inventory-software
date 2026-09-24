# Abstract (draft 1)

**148 words.** Written to the IEEE Software limit of 150.

---

Software that reports on external state — devices, filesystems, remote
services — contains a defect class in which a probe's failure is
indistinguishable from a genuine negative result, and is reported as one. We
catalogue 32 such defects across 15 fix commits in one industrial codebase, an
IT-asset-disposal auditing platform whose output is a legally consequential
data-erasure certificate. Every one failed towards the reassuring answer: no
lock, no operating system, no limitations, nothing hidden. None produced a
false alarm. Eighteen occurred on code paths that already had tests, none of
which caught them, because a fixture is written from the successful path and
so never constructs a broken probe examining a dirty subject. Most
significantly, the class was explicitly named in a commit message and fixed six
times on one day; nineteen days later a systematic search found twenty-two
more, most in the files that commit had itself edited. Naming a defect class
does not prevent its recurrence.

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

- The "23" used in earlier informal write-ups is superseded by 32 call sites /
  15 fix commits. See `inclusion-criteria.md`.
- "Eighteen occurred on code paths that already had tests" is from
  `test_existed` in `instances.csv`; verify once more before submission.
- The recurrence claim is the paper's contribution and should not be softened.
  It is an observation about one codebase's own timeline, so it survives the
  n=1 limitation.
- Consider whether "IT-asset-disposal auditing platform" needs a clause of
  explanation for a general SE audience. Probably one: *"...which erases and
  certifies second-hand computers for resale."*
