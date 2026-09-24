# 7. What to do about it

**Draft 1.**

---

The remedy that follows from §6 is not more emphasis. A rule that must be
recalled will be forgotten by the person who wrote it, within three weeks, in
the file they wrote it in. The rule has to be moved out of memory.

## 7.1 Three questions, at the keyboard

For any output that asserts an absence:

1. **What read produced this, and how does that read fail?** If the failure
   value equals the negative value — empty, zero, false, missing — the
   assertion is unearned.
2. **Is the failure observable?** An exit status, an exception, a sentinel.
   Where the code discards it (`2>/dev/null` with no status check, a bare
   `except: pass`, a filter that silently drops what it cannot parse), the
   observation existed and was thrown away.
3. **Does the vocabulary have a third value?** *Present*, *absent* and *not
   established* — in the type, in the stored field, **and** in the sentence a
   person reads.

## 7.2 Two corollaries, learned the hard way

**A could-not-check is never cached.** An answer may be cached; a failure may
not. One dead call settled the optical-drive question for an entire session,
because the failure was memoised alongside the successes.

**When an honesty check breaks a test, fix the fixture.** This happened four
times. Every time, the fixture modelled a command that cannot fail — a stubbed
subprocess result with no exit status. A test that must be weakened to
accommodate an honesty check was asserting the bug, not the contract.

## 7.3 Where to look first

28 of 32 instances were in the component that probes the outside world, and 23
in two files (§5.6). A team adopting nothing else from this paper can act on
that: identify the component that probes, read every site where a read result
becomes a reported finding, and apply question 1. That is what the sweep was,
and it found 20 of the 32.

## 7.4 What we do not claim

We changed three things after the sweep: we made the search explicit and
repeatable, we required tests to assert the third value rather than only the
negative, and we corrected fixtures so a probe can fail in them.

**We cannot report whether this worked.** The observation window closes with
the sweep. A codebase swept once is not a codebase that stays swept, and on the
evidence here the honest expectation is that instances will accumulate again
— which is precisely what §6 found the first time.

---

## Drafting notes

- §7.4 must survive editing. A reviewer — or a reader looking for a method —
  will otherwise take §7.1–7.3 as a validated remedy. It is a response, not a
  result.
- §7.1 duplicates the three actionable insights required by IEEE Software.
  Check at submission that the submitted bullet list and this section agree
  word for word.
- Resist adding a fourth question. Three is memorable; four is a checklist
  nobody runs.
