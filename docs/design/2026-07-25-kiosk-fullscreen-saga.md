# Making a browser fill a screen: seven attempts

## Status

Shipped, 19–27 July 2026. `d853439` · `de8be52` · `c9e4706` · `b616dda` ·
`2a05c2c` · `e63d96a` · `34b0e1c` · `332c47c` · `36d580d` · `80916ff` ·
`daa6421` · `f777de6` · `376a10e` · `6bd9bcb` · `582e32f`

Fifteen commits, most of them on one problem.

## The problem

The audit station is an appliance. A technician boots a PC from a USB stick and
should see one interface, full screen, with no desktop, no browser chrome and
no way to end up somewhere else.

The machine it boots is **whatever came through the door**: any manufacturer,
any graphics hardware, any panel resolution, sometimes no working display
driver. There is no fixed target to develop against.

## The attempts, in order

| Approach | Why it failed |
| --- | --- |
| Firefox `--kiosk` | Hides the toolbar but opens at ~90% and never fills |
| **Cage** (Wayland kiosk compositor) | Correct when present — not on the image |
| Auto-install Cage at boot | Needs a network. The bench often has none |
| X fallback with a window manager + `xdotool` | Another dependency not on the image |
| `xdotool` window resize | Deterministic, still an install |
| **python + libX11 via ctypes** | **Worked.** No packages, any display |

`376a10e` is the one that shipped: `fullscreen-x.py` talks to libX11 through
ctypes and resizes whatever top-level window appears to the exact screen size.

**The lesson, paid for over seven attempts: on a live-boot appliance, a
dependency you have to install is a dependency you do not have.** Every
approach that needed a package worked on the development machine and failed on
the bench. The one that shipped uses only what the image already carries —
Xorg, python3 — and that constraint is now written into the session script's
contract.

## The diagnostics that made it tractable

`36d580d` and `80916ff` added a **Display readout to the status bar**, showing
the resolution and **which launch path was actually taken** — cage, xinit or
session.

Until then every failure looked the same: a window that was not full screen.
Afterwards it was possible to tell *which* of five mechanisms had run. Most of
the progress after that point is attributable to being able to see this.

## A defect from the fix itself

`8d62208` — **the fullscreen enforcer must never touch popup windows.**

The resizer grabbed every top-level window, including dropdown menus, and
resized them to fill the screen — which made a dropdown snap shut the instant
it was clicked. The station had a dropdown that could not be used, and the
cause was the code that made the interface work at all.

## What else landed alongside

Wi-Fi connection in the GUI (`b616dda`), then **Ethernet** (`6bd9bcb`) when it
turned out the bench is often wired; saving the wipe to the batch and a
Shutdown control (`2a05c2c`); auto-fit for any resolution (`e63d96a`); and a
rebuild to a two-column console design (`582e32f`).

## What was deliberately not built

No custom compositor or display manager. The station uses the stock Ubuntu X
session and resizes one window inside it.

## Open questions

Superseded in September by the casper layer and the dedicated kiosk session,
where GNOME never draws at all — see `2026-09-02-casper-layer-and-kiosk-session.md`.
