**Draft 1.**

---

## 9. Layer 6: functional testing, and the human as an instrument

Every layer so far describes what a machine *is*. None of them establishes
whether it **works**. A laptop with a dead speaker, a stuck key, a broken
camera or an unresponsive trackpad reads as perfect on a specification sheet,
and is then sold as perfect.

### 9.1 The principle

The station's interface is a web page. A web page cannot measure whether a
speaker produced sound, or whether a camera image is in focus. The governing
rule for this layer was therefore set as a prohibition:

> **Do not pretend the browser can diagnose hardware it cannot measure.**

What the page *can* do is drive the hardware and **ask a technician what
happened**. Every result in this module is a human's answer, and is recorded as
one — the stored finding carries the fact that it was confirmed by a
technician, not measured by software.

This is an unusual thing to build deliberately. It is also the honest design:
the alternative is a probe that emits a confident verdict about something it
did not observe, which is the defect this entire paper is about, dressed as a
feature.

### 9.2 Could-not-run is not failed

The companion rule matters as much:

> **A test that could not run is ATTENTION, never FAILED.**

Marking a component failed because the station could not test it would condemn
working hardware — a machine downgraded, or scrapped, because a driver was
missing on the live image. The three-valued vocabulary from §7.4 applies here
with the polarity reversed: in lock detection, an unestablished result must not
read as *safe*; in functional testing, an unestablished result must not read as
*broken*.

Both rules are the same rule. **The third value has to exist, and it must not
collapse into whichever of the other two is convenient.**

### 9.3 The seven tests

| Test | What the station does | What the technician answers |
| --- | --- | --- |
| Speaker | Unmutes, plays a tone on each side | Did you hear it, both sides? |
| Keyboard | On-screen layout, lights each key as pressed | Good, or has an issue |
| Camera | Live preview | Is the image good? |
| Screen | Full-screen colour fields | How many dead pixels? |
| Trackpad | Tracks movement, buttons and scroll | Good, or has an issue |
| Microphone | Records and plays back | Could you hear yourself? |
| USB ports | Counts the ports that responded | — |

The USB row is the one without a human answer, and is consequently the one that
produced a false absence: zero ports responding was reported as *zero working
ports* rather than as a test that did not run. It appears in §12's catalogue,
found on real hardware by a technician who knew the laptop's ports worked.

### 9.4 The keyboard test, which took five attempts

The keyboard test is the most instructive thing in this layer, because every
attempt failed for a different reason and none of the reasons were about
keyboards:

1. **A pressed key activated the focused control.** Space and Enter fired the
   verdict buttons, so testing the keyboard answered the question the test was
   asking.
2. **Browser shortcuts fired.** Detection moved earlier in the event sequence
   so the page could claim the key before anything else acted on it.
3. **Function keys triggered browser features.** On one machine a function key
   opened a bookmark panel over the interface.
4. **A virtual-terminal switch blanked the screen**, which no page-level code
   can prevent (§6.3).
5. **Machine-level keys acted before any software saw them** — brightness and
   display-output keys on a Lenovo laptop blacked out the interface entirely.

The first three were fixable in the page. The fourth needed the X server
reconfigured. The fifth could only be addressed by removing the offending
keysyms altogether, because the firmware acts first.

The sequence is a small case study in a general problem: **a test that asks a
human to exercise arbitrary hardware is a test that invites the hardware to
interfere with the test.** The fix is not cleverness in the page; it is
knowing which layer owns each input and defending at the right one.

### 9.5 Why this layer ships by file copy

The entire module reaches the stations by stick sync, with no layer rebuild
(§6.6), because it is interface and probe code rather than packages. That was
a deliberate constraint on the design, not a happy accident: a functional-test
module that required rebuilding a filesystem image would have been revised
perhaps twice instead of the five times the keyboard test actually needed.

## Drafting notes

- §9.2's observation — that the two rules are the same rule with opposite
  polarity — is one of the better ideas in the paper and is not in any design
  record. Make sure §17 picks it up.
- The USB row's defect is in §12's dataset. Cross-check the description.
- Five attempts are listed but the design record enumerates the commits; if a
  reviewer wants them, they are in `2026-09-20-hardware-test-module-c6.md` and
  `2026-09-22-keypress-ownership.md`.
- This is the shortest section in Part II. That is proportionate — but check it
  does not read as an afterthought, because the human-as-instrument decision is
  more novel than its length suggests.
