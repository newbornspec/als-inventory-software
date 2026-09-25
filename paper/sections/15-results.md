**Draft 1.**

---

## 15. Results

This section reports what exists, what runs, and what has been proven — and is
deliberate about the difference between those three.

### 15.1 What was built

| | |
| --- | --- |
| Period | 9 July – 24 September 2026 (78 days) |
| Commits | 535 |
| Code | ~101,000 lines |
| Domain entities | 23, across 62 schema migrations |
| Web pages | 30 |
| API controllers | 23 |
| Automated test files | 96 (46 API, 50 audit station) |
| Design records | 40 |
| Engineers | 1 |

Capability, by layer:

| Layer | Delivered |
| --- | --- |
| Inventory | Three stock tiers, lot hierarchy, manifest reconciliation, pallets with a merge invariant, ownership scoping in six enforcement passes, append-only activity |
| Capture | Offline-first scanning (barcode and OCR) with a durable on-stick queue |
| Station | Bootable Secure Boot appliance, overlay layer, kiosk session, operator sign-in, sync by stick with version stamping |
| Inspection | Hardware profile, offline registry parsing, four management-state checks, per-drive health as a percentage, installed-OS capture |
| Erasure | Method ladder with fallback reporting, per-drive verdicts, hidden-area checks, read-back after every erase |
| Certification | Signed, chained, tamper-evident certificates with optional public verification |
| Functional test | Seven technician-confirmed tests with three-valued verdicts |
| Back office | Eleven reporting slices, one-query operational dashboard, fail-closed permissions, WCAG 2.2 AA pass |

### 15.2 What runs

The API, database and sync service run on one hosting platform; the web
application on another; the audit station runs from USB sticks in the
warehouse. All three are in production use by the business the system was built
for.

**We report no production telemetry, because none was collected.** There are no
figures here for machines processed, certificates issued, or time saved per
device. That instrumentation was never built — the business needed the system
to work before it needed the system measured — and inventing plausible numbers
after the fact is exactly the failure this paper spends thirteen sections
arguing against.

A reader evaluating whether to adopt any of this should know that the strongest
operational claim we can make is that it is in daily use and has not been
replaced.

### 15.3 What is proven, and how

The distinction that matters most is between what has been exercised on real
hardware and what has only been reasoned about or tested in a harness.

| Proven by | What |
| --- | --- |
| **Real hardware, repeatedly** | Booting and full-screen operation across varied machines; hardware capture; drive health; the keyboard, speaker, camera and screen tests; offline registry reads on encrypted and domain-joined machines |
| **Real hardware, once or twice** | The overlay layer boot chain; the Autopilot artefact reads; the OOBE observation |
| **Harness only** | The wipe ladder's branch logic, the lock detectors' three-valued returns, the migration chain, the certificate signing and chaining |
| **Reasoned, not run** | The pre-installation-environment hash capture (§11.3, blocked) |

Four of the 32 defects in §12 were found by a technician on real hardware and
would not have been found by any harness. That ratio is the most useful
calibration in this paper: **harnesses catch the logic, hardware catches the
assumptions.**

### 15.4 The defect result

Restated here as a result rather than as an argument:

| | |
| --- | --- |
| False-absence call sites catalogued | **32**, across 15 fix commits |
| Failing towards the reassuring answer | **32 / 32** |
| Sitting on code paths that already had tests | 18, of which caught by those tests: **0** |
| Written **after** the class was named, documented and tested | **8**, within 18 days |

### 15.5 The negative results

Three things were attempted and did not work, and are reported as results
because the field under-reports them:

**Seven approaches to full-screen kiosk display failed** before one succeeded,
and six of the seven failed for the same reason: they needed a package that was
not on the image (§6.2).

**A layer rebuild could not be performed off the target machine**, not for the
obvious reason but because its safety gate would have passed *vacuously* in a
container — reporting no conflict because it could not see, rather than because
there was none (§6.6).

**Autopilot registration cannot be determined offline.** After substantial
research this is reported as a boundary rather than a to-do (§11.2). The
system answers the question three other ways, one of which is definitive, and
none of which is the way the business originally asked for.

## Drafting notes

- §15.2's refusal to report telemetry is the most likely thing a reviewer
  objects to, and the most important thing in the section. It stays.
- If the business ever instruments throughput, this section gains a subsection
  and §16 loses a limitation. Until then, do not estimate.
- §15.3's four-row table was compiled for this draft and is a judgement about
  each item's evidence, not a measurement. Say so if challenged — or better,
  cross-check each row against the "How it was proved" heading in the
  corresponding design record before submission.
- All figures in §15.1 are recomputed from the repository, not carried from
  §1.2. They agree; if one is edited, edit both.
