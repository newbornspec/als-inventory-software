# Technical design records

One dated document per piece of work, kept in this repository. The purpose is a
paper trail an engineer — or a technical paper — can be written from later,
without having to reconstruct the reasoning from commit messages and memory.

**Coverage: 9 July – 24 September 2026, 534 commits, 40 records.**

## The convention

    docs/design/YYYY-MM-DD-<short-slug>.md

The date is the date the work shipped. A slug is two to five words, lower case,
hyphenated. One document per coherent change, not one per commit: a change that
took four commits gets one record, and its commits are listed inside it.

## What every record contains

The headings are fixed, because the value of these documents is that they can
be read against each other.

| Section | What goes in it |
| --- | --- |
| **Status** | Shipped / partial / blocked, the date, and the commit hashes |
| **The problem** | What was wrong, and how it was found. Name the machine or the report if it came from the bench. |
| **Why it matters** | What the defect cost, or would have cost, in the real business |
| **What was built** | The mechanism, concretely enough to re-derive it |
| **What was deliberately NOT built** | And why. This is often the most valuable section. |
| **How it was proved** | Tests, counts, what ran where. Anything unverified is named as unverified. |
| **Open questions** | Decisions left to the owner, and anything still unproven on real hardware |

## Rules

1. **Honesty over tidiness.** A record that says "this was never tested on
   hardware" is worth more than one that implies it was. Where a fix was found
   by accident, say so; where a test passed for the wrong reason, say that too.
2. **No record is written before the work is done.** These are records of what
   happened, not plans.
3. **The reasoning, not just the outcome.** Anyone can read the diff. What they
   cannot recover is why one approach was chosen over another that looked
   equally good at the time.
4. **Name the failure modes.** Especially the ones that survived review.

## Index

Newest first.

### September 2026 — the audit station becomes evidence

| Date | Record | What it covers |
| --- | --- | --- |
| 09-24 | [technical-paper-draft](2026-09-24-technical-paper-draft.md) | The complete paper draft, its dataset, and the three figures that were wrong when checked |
| 09-23 | [technical-paper-plan](2026-09-23-technical-paper-plan.md) | Which of the three threads carries a paper, and what evidence each one has |
| 09-23 | [autopilot-oobe-check](2026-09-23-autopilot-oobe-check.md) | The first-boot OOBE check: the only Autopilot answer that is not inference |
| 09-23 | [event-log-reader-on-stick](2026-09-23-event-log-reader-on-stick.md) | Shipping a package by file copy instead of a squashfs rebuild |
| 09-22 | [autopilot-offline-evidence](2026-09-22-autopilot-offline-evidence.md) | Reading the Autopilot artefacts already on the mounted volume |
| 09-22 | [autopilot-research](2026-09-22-autopilot-research.md) | What is and is not knowable about Autopilot registration; the four tiers |
| 09-22 | [keypress-ownership](2026-09-22-keypress-ownership.md) | Three layers own a keypress; only one offers software a veto |
| 09-22 | [false-absence-sweep](2026-09-22-false-absence-sweep.md) | The recurring bug class, its evidence table, and the rule that closes it |
| 09-21 | [windows-management-checks](2026-09-21-windows-management-checks.md) | Entra, domain, MDM and licence: what an offline hive read can prove |
| 09-20 | [hardware-profile-and-os-capture](2026-09-20-hardware-profile-and-os-capture.md) | One table, and reading the installed Windows from its own registry |
| 09-20 | [hardware-test-module-c6](2026-09-20-hardware-test-module-c6.md) | Seven technician-confirmed functional tests |
| 09-19 | [drive-health-c5](2026-09-19-drive-health-c5.md) | Per-drive health as a percentage, never "Unknown" |
| 09-19 | [boot-speed-lz4-and-firefox](2026-09-19-boot-speed-lz4-and-firefox.md) | Making the station boot faster, measured |
| 09-19 | [operator-signin-and-kiosk-hardening](2026-09-19-operator-signin-and-kiosk-hardening.md) | Who actually did the wipe, and locking down the kiosk service |
| 09-19 | [signed-certificates-and-public-verify](2026-09-19-signed-certificates-and-public-verify.md) | Tamper-evident certificates and a public check |
| 09-19 | [erasure-remediation](2026-09-19-erasure-remediation.md) | The 42-step programme: per-drive verdicts, hidden areas, honest levels |
| 09-08 | [account-safety-and-golden-images](2026-09-08-account-safety-and-golden-images.md) | Disable don't delete; clonezilla; splitting the grade; measuring the boot |
| 09-02 | [casper-layer-and-kiosk-session](2026-09-02-casper-layer-and-kiosk-session.md) | An overlay layer, and a kiosk session that ships switched off |
| 09-02 | [device-locks-and-ubuntu-base](2026-09-02-device-locks-and-ubuntu-base.md) | Ownership locks, the Secure Boot port, and the commit that named the class |

### August 2026 — hardening and consistency

| Date | Record | What it covers |
| --- | --- | --- |
| 08-23 | [visual-system-redesign-series](2026-08-23-visual-system-redesign-series.md) | Thirty-one pages into one system, and the ten defects it exposed |
| 08-22 | [permissions-rebuilt-fail-closed](2026-08-22-permissions-rebuilt-fail-closed.md) | Fail-closed authorization, the workflow split, and CI |
| 08-20 | [pallet-merge-and-repairs-removal](2026-08-20-pallet-merge-and-repairs-removal.md) | The merge invariant, and deleting a working module |
| 08-20 | [dashboard-and-accessibility](2026-08-20-dashboard-and-accessibility.md) | An operational control centre and a WCAG 2.2 AA pass |
| 08-17 | [pallet-layouts-hardened-and-invoicing](2026-08-17-pallet-layouts-hardened-and-invoicing.md) | Typed pallet numbers, explicit "None", and invoicing |
| 08-09 | [boot-speed-and-durable-queue](2026-08-09-boot-speed-and-durable-queue.md) | A queue that survives a power cut, and honest network checks |

### July 2026 — building the platform

| Date | Record | What it covers |
| --- | --- | --- |
| 07-29 | [unit-id-labels-and-spec-rules](2026-07-29-unit-id-labels-and-spec-rules.md) | Unit ID, thermal labels, and normalising captured specifications |
| 07-26 | [light-redesign-and-kiosk-diagnostics](2026-07-26-light-redesign-and-kiosk-diagnostics.md) | 24 pages relit, and teaching the station to explain itself |
| 07-25 | [kiosk-fullscreen-saga](2026-07-25-kiosk-fullscreen-saga.md) | Seven attempts to make a browser fill a screen |
| 07-25 | [reports-bi-dashboard](2026-07-25-reports-bi-dashboard.md) | Eleven analytics slices in one day |
| 07-25 | [sold-workflow](2026-07-25-sold-workflow.md) | Deleting the sales module and replacing it with a status |
| 07-24 | [pallet-layouts-and-inventory-rollup](2026-07-24-pallet-layouts-and-inventory-rollup.md) | Two pallet layouts, and counting all three stock tiers |
| 07-23 | [hierarchy-ownership-and-activity](2026-07-23-hierarchy-ownership-and-activity.md) | Lot → Asset → Hardware, ownership in six passes, the activity log |
| 07-15 | [erasure-certificates-and-wipe-v1](2026-07-15-erasure-certificates-and-wipe-v1.md) | The first wipe engine and the first certificate |
| 07-13 | [hardware-audit-tool](2026-07-13-hardware-audit-tool.md) | A bootable capture, and "the station's hardware is not the machine's" |
| 07-12 | [sales-costing-and-sessions](2026-07-12-sales-costing-and-sessions.md) | A module later deleted, and the auth faults found underneath it |
| 07-11 | [pallets-and-consumables](2026-07-11-pallets-and-consumables.md) | The two stock tiers that are not serialised devices |
| 07-11 | [scanning-barcode-and-ocr](2026-07-11-scanning-barcode-and-ocr.md) | Free scanning over a paid SDK, and what a warehouse does to it |
| 07-11 | [receiving-reconciliation](2026-07-11-receiving-reconciliation.md) | Expected against actual, and why a false "extra" is an accusation |
| 07-10 | [purchase-lots-and-manifest](2026-07-10-purchase-lots-and-manifest.md) | The catalogue, pre-arrival lots, and the migration-ordering hazard |
| 07-09 | [foundation-and-powersync](2026-07-09-foundation-and-powersync.md) | Offline-first architecture, and four silent sync faults |

## Reading these as one story

Three threads run the length of the project, and a paper could be written from
any of them:

**1. The failure that presents as a clean result.** It starts on day two with
PowerSync hanging silently, runs through the USB stick being mistaken for the
machine's drive, the screen size never being read, TRIM certified as a wipe,
and a BitLocker machine reported as having no operating system — and is finally
named, measured and closed in the false-absence sweep. **Thirty-two catalogued
call sites across fifteen fix commits. Not one produced a false alarm; every
single one failed towards the reassuring answer.** The dataset is
`paper/instances.csv`; the paper written from it is `paper/PAPER.md`.

**2. Building the wrong thing, and deleting it.** Warranty tracking, the sales
module, the repairs log — three working features removed within six weeks
because they modelled a business that does not exist. The discipline of removing
them is why the app stayed small enough to redesign.

**3. What a machine can and cannot be made to tell you.** From reading DMI, to
parsing registry hives offline, to the hard limit at Autopilot — where the
answer lives in Microsoft's cloud and no amount of engineering will produce it.
The system's value comes from being precise about which side of that line each
claim sits on.
