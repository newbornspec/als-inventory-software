# Making the station boot faster, measured

## Status

Shipped, 19 September 2026. `e43a452` · `df05e6f` · `40b0efa` · `2500b9f` ·
`bb73f49` · `e846fa4` · `3bc97a9` · `22dc8cd` · `d565a90` · `fed5a91` ·
`d0514a8` · `3d3d716` · `47f930a` · `a7d9269` · `6f9587a` · `8d3e6f0`

Merged as `1527a60`.

## The problem

The station took too long between power-on and a usable interface. The measured
figure was **APP READY at 82 seconds** on a Dell Latitude 3310, and the single
largest cost was `snapd.seeded.service` at **95 seconds** — snapd copying
eleven seeded snaps, about 1.4 GB.

## What was built

**`22dc8cd` — boot without seeding snaps: Firefox ESR in the layer.**

The snap Firefox is the reason snapd seeds at all. Baking **Firefox ESR** into
the layer and masking snapd removes the largest single cost in the boot.

**`d565a90` — never mask snapd over a half-unpacked Firefox ESR.** The
dangerous ordering: masking snapd while the ESR install is incomplete leaves a
machine with no browser at all. The guard makes the mask conditional on the
replacement actually being in place.

**`e43a452` — build the layer with lz4 when the stick's kernel is proven to
read it.**

Since the boot is **I/O-bound at 34 MB/s** (measured on 18 September), the
trade is right: lz4 decompresses far faster than the default at the cost of a
larger file, and reading a larger file quickly beats reading a smaller one
slowly. The condition matters — *when the stick's kernel is proven to read it*.
The kernel is inspected rather than assumed, because a layer the kernel cannot
decompress is an unbootable stick.

**`bb73f49` — check the stick has room for the bigger layer, and log the kernel
it was judged by.** lz4 makes the layer larger; a build that fills the stick is
worse than a slow boot. And logging *which kernel* the decision was based on
means a later failure can be traced to the judgement.

**`df05e6f`, `2500b9f` — start Firefox from a profile template made at build
time**, and count that copy in the measured figure. A fresh Firefox profile is
built on first start, which is slow; building it once at layer-build time and
copying it is much faster. Counting the copy in the number is the honest part —
otherwise the measurement improves while the operator's wait does not.

**`40b0efa`, `3bc97a9` — stop a fresh profile's background downloads**, and
*say what the network prefs actually stop, as measured*. The second commit is
the discipline: preference names imply what they do, and the comment records
what was **observed** to stop rather than what the name suggests.

**`fed5a91` — stop the Firefox Terms of Use modal covering the kiosk every
boot.** A dialog over the interface on every single boot.

## Instrumentation

**`d0514a8` — boot straight into the app, stop a 5.9 GB self-check, report
every boot.** The self-check was reading the whole medium on every boot.

**`3d3d716` — write the boot report the moment the app appears.** Not when the
script finishes: the number that matters is when the operator can *use* it.

**`7eda9ea` — find the real shutdown-logo cause; fix three wrong boot
instruments.** Three of the measurements had been wrong, so decisions had been
made on bad numbers. Fixing the instruments mattered more than the logo.

**`47f930a` — say SHUTTING DOWN on the shutdown splash, not STARTING.** The
shutdown splash said the machine was starting.

## cloud-init

**`a7d9269`, `6f9587a`, `8d3e6f0` — switch cloud-init off in the layer with its
own marker file**, then *correct the notes against the station's real image*.
cloud-init on a live image spends time on a configuration source that does not
exist. The second commit is the pattern this project keeps returning to:
**check the documentation against the machine.**

## What was deliberately not built

No custom kernel or initrd rebuild. Every gain came from carrying less and
reading it faster.

## Open questions

None outstanding.
