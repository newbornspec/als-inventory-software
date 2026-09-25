# 2. The class

**Draft 1. Body word count verified at the end of this file.**

---

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

---

## Drafting notes

- Deliberately short. The definition earns its keep by being applied in §5 and
  §6; restating it at length here would spend budget the results need.
- §2.2 is the compressed form of the related-work positioning. If a reviewer
  wants more, expand it into §10 rather than growing this section.
- The four conditions are the same ones in `inclusion-criteria.md`, worded for
  a reader rather than for a coder. Keep them synchronised: if the criteria
  change, this changes.
- §2.3's last paragraph is an admission about our own system and should stay.
  It is the difference between describing a remedy and reporting one.
- Do **not** add a formal notation. It was tried and added nothing that the
  operational test in §2 does not already give.
