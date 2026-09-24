# 3. The system

**Draft 1. Deliberately brief — context, not a system description.**

---

The codebase is a commercial platform for IT asset disposal: the business of
taking in second-hand computers, establishing what they are, erasing them, and
reselling them. It comprises a web application and API, and a **bootable USB
audit station** that boots a customer's machine into Linux, examines it, wipes
its drives and files a record.

Three properties of the domain matter for this paper.

**The station examines a machine it knows nothing about.** Every machine is
different hardware, in unknown condition, possibly with an unreadable drive, a
locked firmware, an encrypted volume or no operating system at all. Almost
every question the station answers requires probing something it does not
control. This is the architectural position where the class lives.

**The station boots Linux, so the machine's Windows is never running.** The
installed operating system is read from its registry hives offline, with the
volume mounted read-only. There is no API to ask, no agent to query — only
artefacts to interpret, each of which can be unreadable for reasons that look
identical to being absent.

**The output is a legal document.** The platform issues a Certificate of Data
Erasure that a buyer relies on. A false absence here is not a cosmetic defect:
it is a signed statement that a machine carries no lock, no residual data, or
no limitation, made by code that failed to look.

The observation window is **82 days and 526 commits**, from the project's first
commit to the end of the sweep. The system was under active development
throughout by a single developer, shipping to a working warehouse.

---

## Drafting notes

- Keep this under 300 words. Every additional sentence here is a sentence the
  results cannot have, and a reader does not need to be able to rebuild the
  system — only to believe the instances.
- The third property is the one that makes a reviewer care. Do not cut it.
- "A single developer" is load-bearing for §6 and is a threat in §8. Stated
  here once, plainly.
