# 4. Method

**Draft 1. Brief; the full criteria are published with the dataset.**

---

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

---

## Drafting notes

- §4.1's admission that no tool was written is important. A reviewer will
  otherwise assume a detector exists and ask for its precision and recall.
- Keep the counting rules here; do not make the reader open the dataset to
  understand the headline number.
- The latency caveat must stay. It is the weakest measure in the paper.
