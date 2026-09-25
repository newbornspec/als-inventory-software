**Draft 1.**

---

## 17. Lessons for building evidence-producing systems

The thesis, restated as the constraint it actually is:

> **Every output of this system is a claim about a machine the system does not
> control. Its entire value is how honestly it separates what it has
> established from what it has merely assumed.**

What follows is what that cost to learn, in the order a team would need it.

### 17.1 Before writing a probe

**Classify the claim by knowability tier (§11).** Is it measured, recovered
from an artefact, perishable, or withheld? The tier determines which kind of
effort will work: code, a parser, a process change, or none. Writing a cleverer
probe for a perishable fact is wasted work; writing one for a withheld fact
produces a guess with the appearance of a measurement.

**Ask whether the failure value equals the negative value.** If the probe
returns empty, zero, false or absent both when it looked and found nothing *and*
when it could not look, any assertion built on it is unearned. This single
question, applied at the keyboard, is the cheapest defence available and it
found 20 of the 32 defects in §12.

### 17.2 While designing the vocabulary

**Three values, in three places.** *Present*, *absent* and **not established** —
and the third has to be sayable in **the type**, **the stored field**, and **the
sentence a person reads**. Implementing the first two and not the third produces
a system that knows it could not check and prints *not detected* anyway. We did
exactly that more than once.

**Decide which way the third value leans, per domain.** In lock detection, an
unestablished result must not read as *safe*, so it promotes the device to
unverified (§7.4). In functional testing, an unestablished result must not read
as *broken*, so it is attention rather than failure (§9.2). These look like
opposite rules and are the same rule: **the third value must not collapse into
whichever of the other two is convenient.**

**Never cache a failure.** An answer may be memoised; an inability to answer may
not. One dead call settled a hardware question for an entire session because the
failure was cached alongside the successes.

### 17.3 While writing tests

**A fixture that supplies a working probe tests nothing about failure.**
Eighteen of the 32 defects sat on tested code paths and the tests caught none.
Catching this class needs a fixture where **the probe fails and the subject is
adverse** — two independently unlikely conditions that no author constructs
without deciding to.

**When an honesty check breaks a test, fix the fixture.** This happened four
times, and every time the fixture modelled a command that could not fail. A
test that must be weakened to accommodate an honesty check was asserting the
bug.

**Discover tests with a glob, not a list** (§14.3). A hand-maintained list that
has fallen behind reports the same green as a complete one.

### 17.4 While shipping

**A dependency you have to install is a dependency you do not have** (§6.2).
Seven approaches to one problem, six of them failing for this reason. On any
appliance, live-boot image, or constrained target, the packages already present
are the only ones that exist.

**Code and schema must never disagree in either direction** (§14.4). Migrate
before the code that needs the column; drop the code before the table it uses.
Both failures look like an outage and neither looks like a schema problem.

**Instrument what the software is doing, not only what it found.** The kiosk
work became tractable only when the status bar showed *which of five launch
paths had run*. Before that, every failure looked identical. The same applies to
a network check that says which address it reached and a restore that shows it
is alive.

**A summary and its drill-down must be computed from the same predicate**
(§10.3). Otherwise the page contradicts itself at the moment a user trusts it
most — and only when somebody clicks.

### 17.5 About the organisation, not the code

**Naming a defect class is not a control.** This is the finding we least
expected and most want others to have. A commit that named the class, explained
it in the affected functions and added tests covering a third of its own diff
did not stop the same author writing eight fresh instances within three weeks
(§12.4).

The reason is that the fix was applied to call sites rather than to a shape.
**A lesson that lives in prose must be recalled; a lesson that lives in a type
cannot be forgotten.** So:

| Instead of | Do |
| --- | --- |
| Documenting the rule | Making the wrong thing hard to express — a type, a helper, a return shape |
| Trusting it will be noticed | Running an explicit, repeatable search for the shape |
| Fixing the instances you found | Reading every site in the component that probes |

**Look where code touches state it does not control.** 28 of 32 instances were
in the component that boots a customer's machine; 23 were in two files. A team
adopting nothing else can act on that: find the component that probes, read
every site where a read result becomes a reported finding, and apply §17.1's
second question.

**Removal is a feature.** Three shipped modules were deleted because they
modelled a business that did not exist (§13). The useful measure of a system
under active development is not how much it contains but how much of what it
contains is load-bearing — and deletions need a safe pattern, because the
dangerous part is the schema, not the code.

### 17.6 The one we would tell someone first

Of everything above, the finding with the widest application is the smallest:

> **In a system that looks for problems, a probe that fails returns the value
> that means "no problem". So every failure resolves towards the reassuring
> answer, silently, and gets certified.**

Thirty-two instances. Not one false alarm. The asymmetry is not a property of
this codebase; it is a property of what empty, zero and false mean in a system
whose job is to find things wrong.

## Drafting notes

- §17.1's second question and §12.1's condition 3 are the same test. Deliberate:
  a reader may arrive at either section first.
- §17.2 and §17.3 are the actionable-insight set if a venue asks for three:
  the third value in three places, the failure-equals-negative question, and
  the fixture that can fail.
- Check at assembly that §17's thesis paragraph is word-for-word identical to
  §1.1's.
- This section deliberately repeats conclusions from Parts II and III. That is
  its function — but if the paper is cut for length, cut here rather than from
  the sections that carry the evidence.
