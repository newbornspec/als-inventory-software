# The casper layer, and a kiosk session that ships switched off

## Status

Shipped, 2–4 September 2026. `1c51a56` · `c5077dc` · `9a83791` · `221522c` ·
`8414527` · `b7c27e3` · `1faf738` · `c73d08b` · `efc39ac` · `db4caec` ·
`f7132b2` · `7412da3` · `9dd039c` · `bad2f16` · `83e0986` · `4b34f16` ·
`b6f352c` · `c734665` · `41c49f6` · `e2608fa` · `621bb86`

Twenty-one commits, mostly on one stubborn problem.

## The problem

Two things the July fullscreen work could not solve:

**The live session is amnesiac.** Every `apt install nvme-cli` is discarded at
reboot — and without `nvme-cli` an NVMe drive cannot be secure-erased, which is
most of what comes through the door.

**The kiosk does not start by itself.** SystemRescue ran `autorun` at boot;
Ubuntu's casper has no such hook, so an operator had to type a command every
time.

## What was built: an overlay layer

**`1c51a56` — boot straight into the kiosk, via a casper overlay layer.**

This was read out of **the stick's own initrd**, not from documentation,
because most of what is written about casper online is wrong for 24.04.

Layer selection is driven by one variable:

```
LAYERFS_PATH=minimal.standard.live.squashfs
```

casper builds the stack by repeatedly stripping the last dot-component off that
name, and the **longest name ends up highest priority**. So a layer named
`minimal.standard.live.als.squashfs` extends the chain and sits on top of
everything.

**The naming trap, which the script now refuses to be talked out of:** the
chain only walks *up*, by stripping components. Call the layer `als.squashfs`
and the chain is just "als" — casper would mount a few hundred kilobytes **as
the entire root**, find no `/sbin/init`, and panic. The name must extend a
chain whose every ancestor already exists.

## Three failures that each cost boots

**`c5077dc` — the layer's root was 0700.** `mktemp -d` creates a directory at
0700, and `mksquashfs` faithfully preserved that as the layer's **root**.
Overlayfs takes a merged directory's mode from the topmost layer — ours — so
`/` on the booted system became `drwx------ root root`. No non-root user could
traverse it, GDM never started, and the machine stopped at a text console with
nothing anywhere saying why. `17f8d0e` later extended the fix to `/usr`, `/etc`
and `/var` for the same reason.

**`7412da3` — the text-console boots were `/lib`, not the autostart.** Days
were spent believing the autostart entry was at fault. `/lib`, `/bin`, `/sbin`
and `/lib64` are **symlinks into `/usr`**; a real directory of that name in the
overlay shadows the symlink and the system cannot find its libraries. The
autostart was innocent the whole time.

**`9a83791` — `undo` reverted a setting it had nothing to do with.** The tool
meant to make experiments safe was itself destructive.

## How the investigation was actually made to work

**`221522c` — separate the half that works from the half that keeps breaking.**
Packages (the safe half) split from autostart (the unstable half), so a build
could ship the first without risking the second.

**`b7c27e3` — record that `--with-autostart` does not work, and what was ruled
out.** A commit whose entire content is documenting a failure and the
eliminated hypotheses. `c73d08b` later brought the header back in line once
more was known.

**`83e0986` — add a boot entry that proves whether the initrd conditional is
the bug.** Rather than guessing at the splash behaviour, ship an entry that
answers the question. `4b34f16` then *"stop guessing at the splash"* and drop
the conditional entirely.

**`db4caec`, `f7132b2` — let the mode be set without carrying the stick to
another machine**, and say plainly that a reboot wipes the test.

## What shipped

**`c734665` — a kiosk session, so GNOME never draws — and it ships switched
off.**

The contract in `als-session.sh`, every line of which serves it:

1. **Off by default.** No `gui/kiosk.mode` on the stick, or any word other than
   `on`, and it hands straight to the stock Ubuntu session. The layer can be
   rebuilt, armed and booted with **zero** change in behaviour.
2. **Every failure path ends in the stock session**, with a message on screen
   saying why. There is no path that ends in a black screen.
3. **Only what is proven present**: Xorg, `xsetroot`, python3, and the
   `fullscreen-x.py` already on the stick. No gnome-kiosk, no cage, no xdotool.

**`b6f352c` — a kiosk mode, now that the reason for avoiding it turned out to
be false.** A constraint that had been treated as fixed was re-tested and was
not real.

## What was deliberately not built

No custom initrd. The layer extends casper's existing chain rather than
replacing its logic — the one piece of this that must never be fragile.

## Open questions

`41c49f6` — the package gate refused a build for a reason that did not apply
(dependency upgrades that this build never downloads). That gate is also why
the layer cannot be rebuilt off the audit machine, which came up again on
23 September.
