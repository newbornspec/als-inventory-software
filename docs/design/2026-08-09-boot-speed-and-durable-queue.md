# Boot speed, and a queue that survives a power cut

## Status

Shipped, 9 August 2026. `e7f24e0` · `cb19337` · `bb1d1f4` · `6dbf8e8` ·
`10e6173` · `8cff770` · `e09ffcd` · `1166f43` · `16fb264` · `ed1a767` ·
`8a4fc74` · `47c7200` · `8ef2a5f`

## The durable queue

**`8a4fc74` — keep the offline queue on the stick so a power-off cannot lose an
audit.**

The station held queued audit records in memory. A technician who audited six
machines with no network and then powered down lost all six, with no indication
that anything had been lost. On a bench where machines are powered off as a
matter of course, this was a question of when, not whether.

The queue moved onto the USB stick itself. The stick is the one thing
guaranteed to still be there after a power cut.

This is also the component whose *read* path was found to be destructive a
month later (`7037985`): a queue file that existed but could not be fully read
was treated as empty and then **rewritten**, destroying the records it had
failed to parse. Making storage durable and making it safe to read are two
different jobs.

## Boot speed, and honest instrumentation

**`16fb264`, `ed1a767` — `fast-boot.ps1`**, which skips the GRUB menu on an
audit stick, split into its own script from the boot-message work so each does
one thing.

**`e7f24e0` — make a silent restore visibly alive, not indistinguishable from a
dead one.** An OS restore writes several gigabytes with no output. The operator
sees a still screen and cannot tell a working restore from a hung one. Same
class as the network check: the system knew it was working and was not saying
so.

**`cb19337` — sync-usb gains watch mode, a cache flush, and a version stamp on
the stick.**

The **version stamp** is the important part. Before it, nobody could tell which
build a given stick was running, so a bug report could not be tied to a
version. The **cache flush** matters because Windows reports a file copy to
removable media as complete before the data has left the buffer — pulling the
stick immediately leaves a truncated file that verifies as present.

**`bb1d1f4` — stop blaming the internet when ping is filtered.** The check
tested one address by ICMP. A site that filters ping — or blocks that one
address, as this one does — produced a red failure on a station that was
uploading audits perfectly well. The check now tries several addresses and both
protocols, and shows the routing table.

**`6dbf8e8` — judge the station by whether it can reach ALS Inventory.** The
decisive correction. Every other layer exists to *explain* a failure, not to be
one: treated as failures in their own right they cried wolf, and operators went
looking for network faults that were not there.

## Also on this day

`10e6173`, `8cff770` — name an OS image by what it *is*, let the operator name
each one, and say when the install finished.
`e09ffcd`, `1166f43` — strip three pieces of kiosk chrome that were not earning
their space.
`47c7200` — the golden-image guide as a PDF in the web app.
**`8ef2a5f` — mark binary assets binary before autocrlf corrupts one.** Git on
Windows rewrites line endings; a PDF or a `.deb` that goes through that
transformation is silently destroyed.

## What was deliberately not built

No server-side queue mirror. The stick is the durable store, and the record
stays there until the server confirms it.

## Open questions

Boot time was measured properly in September (`95ed17c`) and found to be
I/O-bound at 34 MB/s, which redirected the optimisation work entirely.
