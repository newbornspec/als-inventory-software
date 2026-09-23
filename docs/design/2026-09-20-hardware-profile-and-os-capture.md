# The hardware profile as one table, and reading the installed OS

## Status

Shipped, 20–21 September 2026. `aebd1c4` · `086ea3d` · `0fb5bcc` · `e686318` ·
`d8dfa95` · `67cbbc7` · `6327efd` · `e688db2` · `a0a4c66`

## The hardware profile

**`aebd1c4` then `0fb5bcc` — lay the profile out the way the owner designed it,
then show it as one table rather than a dozen cards.**

The profile had grown to dozens of fields across many groups, rendered as a
grid of cards. Reading it meant scanning a dozen boxes for the one line you
wanted. The owner supplied a design: **one table — Category, Parameter, Value,
Status, Details, Tested on** — and it reads far better for the same content.

**`086ea3d` — stop the profile asserting things it never measured.** Several
rows presented as measured facts were defaults or inferences.

**`e686318` — stop the word "unknown" reaching the hardware table.** The house
rule: "Unknown" appears in no output the operator sees. Every field either
carries a value or says, specifically, why it does not.

**`d8dfa95` — put Touchscreen back on the Display group, and unpin the
guards.** The table rewrite **dropped the Touchscreen row entirely**. It was
found in a final full-suite run, not by the reviewers who had graded the change
low-risk. The guards protecting the OS rows had also been pinned to an exact
source literal, so they passed vacuously after the rewrite — they were
loosened to accept the new shape *and taught the new shape*, so they did not
silently become no-ops.

**A test that no longer tests anything still passes.** That is the transferable
finding here.

## Reading the installed operating system

**`67cbbc7` — read the installed OS off the machine's own registry.**

The station boots Linux, so the machine's Windows is never running. But the
lock checks already mount the Windows volume **read-only** and read its hives
with hivex — so the same machinery can answer *what is installed on this
machine*, which is what tells a technician whether it still holds somebody's
data before anyone presses Wipe.

**`6327efd` — show it on the bench screen, not only in the web record.** The
person who needs it most is standing at the machine.

Composed honestly: product name and edition, the feature update, the build with
its UBR, the product ID, the install date, and the architecture — including the
registry quirk that makes a fully patched Windows 11 call itself "Windows 10
Pro".

## The defect that defined the rule

**`e688db2` — stop a BitLocker machine being reported as wiped.**

`libblkid` on a modern util-linux types an encrypted volume as **"BitLocker"**,
not as "ntfs". The volume scan filtered for `ntfs` only, so it walked straight
past the one disk that most needed noticing. A BitLocker machine laid out
ESP + MSR + C: has no NTFS anywhere, scored nothing, and was reported as
**"No operating system installed"** — on a machine holding every byte of the
customer's data, intact and merely unreadable.

The rule that came out of it, now enforced throughout the OS detection:

> **Encrypted outranks everything.** A volume nobody can read is the fact that
> decides what happens to the machine, and it must not be pushed aside by a
> second system that merely happened to be easier to look at.

And the one that guards the station itself: a mounted Linux root at `/` is the
**station's own Ubuntu**, and reporting it as the customer's operating system
would be the worst answer the code could give.

## The licence line

**`a0a4c66` — report the Windows licence the machine can actually prove.**

The owner asked for a green "Activated" tick. It cannot honestly exist:
activation is evaluated at runtime from sealed, machine-bound stores; an
expired KMS grant looks identical on disk to a live one; and a digital-licence
entitlement lives in Microsoft's cloud.

What **is** provable offline is the firmware licence — the ACPI **MSDM**
(OA 3.0) or **SLIC** (OA 2.x) table — and a configured KMS host. So that is
what is reported, with three rules: the word "Activated" is never claimed, a
firmware table that could not be listed never reads as "no licence", and —

> **MSDM embeds a working 29-character OEM product key at offset 56.** Record
> **presence only**. Never open the file.

A source-level test asserts that no reader in the OS block is ever pointed at
that directory. These records get exported and emailed.

## What was deliberately not built

No decoding of `DigitalProductId`, and no mapping of the product ID's middle
group — there is no published mapping for Windows 8/10/11, and a guessed
channel on a resale record is a false claim.

## Open questions

None outstanding.
