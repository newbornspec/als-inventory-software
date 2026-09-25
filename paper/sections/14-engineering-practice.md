**Draft 1.**

---

## 14. Engineering practice

Three practices in this project are worth reporting because each exists to
defend against a failure the previous sections keep describing: something that
is wrong while appearing to be fine.

### 14.1 Design records

Every coherent piece of work ends with a dated record in the repository — 40 of
them, covering 9 July to 24 September. Not one per commit: one per change, with
its commits listed inside it.

The headings are **fixed**, because the value of the documents is that they can
be read against each other:

*Status* (shipped / partial / blocked, with commit hashes) · *The problem* ·
*Why it matters* · *What was built* · **What was deliberately NOT built** ·
*How it was proved* · *Open questions*.

The fifth heading is the one that justifies the practice. A commit message says
what changed; a diff says how. Neither recovers the alternative that looked
equally good at the time and was rejected, and that is the information a person
returning to the code six months later actually needs.

Three rules govern them, and the first is the point of the whole exercise:

1. **Honesty over tidiness.** A record saying "this was never tested on
   hardware" is worth more than one implying it was.
2. **No record is written before the work is done.** These are records, not
   plans.
3. **Name the failure modes** — especially the ones that survived review.

This paper is written from those records. That is the strongest practical
argument for keeping them: a project documented only in commit messages cannot
be written up afterwards without reconstructing the reasoning from memory,
which is precisely the source this project has repeatedly found unreliable.

### 14.2 Testing something that erases drives

The audit station is shell and Python running against real hardware, and the
thing it does most consequentially is destroy data. Testing it presents an
obvious hazard.

The rule is absolute and enforced in the harnesses themselves: **a wipe test
points at a temporary regular file, never a device node.** The harness refuses
outright if its scratch directory is under `/dev`, and the stubbed tools refuse
any invocation that names a device. A safety rule that exists only in the
author's intention is one bad path expansion away from wiping a development
machine.

The suites are bash and Python standard library **by rule** — no package
installs, no database — for the same reason as §6.2's kiosk lesson: a
dependency you have to install is one that will eventually not be there.

### 14.3 CI, and a list that stops covering things

Until the continuous-integration job existed, the station's tests ran only when
somebody remembered to run them by hand on a Linux machine. A change to the
engine that erases customer drives could merge with every one of them red.

One detail of that job is worth extracting as a general principle. The tests
are discovered by a **glob, not a list**:

> Every test file matching the pattern runs. A new test is covered the moment
> it is committed — because a hand-maintained list is exactly the thing that
> silently stops covering the newest test.

That is the paper's defect class applied to the build system. A list that has
fallen behind reports the same green as a list that is complete.

The job deliberately covers what the hosting platforms' own builds cannot: the
API typecheck, the full migration chain **from scratch against a real
Postgres**, the seed, the newest migration's down-and-up, and a boot smoke test
— because dependency-injection failures only surface at runtime, and a
typecheck passes happily with a missing provider.

### 14.4 Two migration hazards

The first was described in §3.4: TypeORM selects every mapped column, so
shipping an entity before its migration takes the table down. Closed by running
migrations as a pre-deploy command on the newly built image, while the previous
version still serves traffic.

The second is subtler and was caught by CI rather than in production. **A
migration can work perfectly on the long-lived production database and destroy
every fresh one**, because the whole chain runs in a single transaction: a
statement that is harmless when applied to a table full of data can fail — or
cascade — when applied to the chain building that table from nothing. Nobody
runs the full chain from scratch in normal work. The only defence is a job that
does it on every push.

The third, from §13.2, is the mirror image: on removal, drop the code first and
the table second, because they deploy separately.

All three are instances of one rule, which is worth stating once:

> **Code and schema must never be in a state where one expects something the
> other does not have — in either direction, at any point in the deploy.**

### 14.5 Where the practice is weak

Two gaps are real and are not presented as anything else.

**The web application has no automated tests.** Ninety-six test files cover the
API and the station; the user interface is covered by the build, by manual use,
and by the consistency passes of §10.5. Several of the defects those passes
found would have been caught by tests that do not exist.

**The station's tests are harnesses, not hardware.** They stub the destructive
tools and verify the logic around them. That is the right trade — the
alternative is a lab of sacrificial drives — but it means the suites cannot
catch a defect that lives in the gap between what a tool does in a stub and
what it does on a real controller. Four of the defects in §12 were found by a
technician on real hardware, and no test harness would have found them.

## Drafting notes

- §14.3's glob-versus-list point is small and genuinely transferable. It is a
  candidate for §17.
- §14.4's unified rule covers all three hazards and did not exist as a stated
  rule before this draft. Check it against the three cases once more before
  submission — a unification is exactly the kind of tidy claim this paper is
  suspicious of.
- The "96 test files" figure is the sum of 46 API spec files and 50 station
  test scripts, both counted from the repository. §3.5 carries the same number.
- §14.5 must survive editing. Without it §14 reads as a description of good
  practice rather than an account of actual practice.
