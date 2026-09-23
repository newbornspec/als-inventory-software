# Device locks, and the port to an Ubuntu Secure Boot base

## Status

Shipped, 2 September 2026. `a61f70b` · `d8d10fd` · `48903fd` · `a574c6a` ·
`2b3ebc9` · `e99a5ba` · `533a61a` · `2346ad7` · `36a042a` · `5e6bea9` ·
`91d30dc` · `62aa2a7` · `58cbb93` · `0f5a426`

## The problem

A second-hand business PC can be **locked to its previous owner** in ways no
amount of wiping removes: a BIOS administrator password, a domain join, an
MDM enrolment, an Autopilot registration, an Absolute/Computrace agent baked
into firmware, or BitLocker.

Buying such a machine is buying something you cannot resell. Before this, the
audit said nothing about any of it.

## What was built

**`a61f70b` — Device Locks & Management Status**, a set of detectors in
`lock-checks.sh`, surfaced on the asset page (`d8d10fd`) and shipped to the
sticks (`48903fd`).

The vocabulary is the design. Each check reports `PASS`, `DETECTED`, `LOCKED`,
`WARNING` or **`UNKNOWN`**, and the device roll-up is `CLEAR`, `LOCKED`,
`WARNING` or **`UNVERIFIED`** — where **any single UNKNOWN makes the whole
device UNVERIFIED**. A device is only ever CLEAR when every check ran and every
one came back negative.

## The base changed: SystemRescue to Ubuntu

**`2b3ebc9` — port the audit tooling to an Ubuntu (Secure Boot) live base.**

SystemRescue ships no Microsoft-signed shim and will not boot with Secure Boot
enabled. That was tolerable while the station only read hardware. It stopped
being tolerable the moment a **BIOS administrator password** became something
being detected: you cannot ask an operator to disable Secure Boot in firmware
to run a tool whose job is to report on firmware settings.

Ubuntu's signed shim boots unmodified. **This decision is not to be revisited.**

`2346ad7` corrected the stick build itself — Rufus ISO mode, one partition —
after builds that produced a stick that would not boot.

## Four detectors that were wrong, found by attacking them

**`91d30dc` — the MDM check passed every machine it ever saw.** It tested for
the presence of an enrolment key that every Windows install carries. It had
never once reported an enrolled machine.

**`5e6bea9` — Absolute: "Enabled" is the factory default, not a lock.** The
check read a firmware attribute and reported any value other than absent as a
lock. Most machines ship with the module *available but not activated*, so the
check flagged ordinary stock as carrying anti-theft software.

**`36a042a` — rewrite the Absolute check: parse WPBT instead of grepping it.**
Grepping a binary ACPI table for a string matches on coincidence. Parsing the
table structure is the only way to say what it actually contains.

**`58cbb93` — stop reporting every machine as WARNING.** The roll-up was
producing a warning on clean hardware, which trains an operator to ignore it.

## The commit that named the class

**`533a61a` — Never let a failed probe read as a negative.**

Six detectors whose hive reads could fail were returning the empty string,
which the verdict logic read as *"nothing found"* — reporting **not enrolled,
not joined, no traces** about machines nobody had successfully looked at.

This is the origin of the false-absence work. It was named here, fixed six
times, and **recurred anyway** nineteen days later — which is the finding the
September sweep documents.

## Also here

`62aa2a7` — elevate the audit, not the whole interface. The GUI runs
unprivileged and elevates only the engine.
`a574c6a` — the Secure Boot finding recorded from real hardware rather than
reasoned about.
`0f5a426` — four ways the audit could mislead or look hung.

## What was deliberately not built

**Nothing is ever removed.** The station detects and reports locks; clearing an
Autopilot or MDM registration is the registering organisation's job through
Microsoft's own process. Detect → Verify → Report.

## Open questions

No `LOCKED` path had fired on real hardware at this point — every detection was
reasoning plus fixtures. That remained true for weeks, and is why the owner
testing an Autopilot-locked ThinkPad in late September was so valuable.
