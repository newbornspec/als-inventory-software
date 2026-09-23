# The hardware test module — contract C6

## Status

Shipped, 20 September 2026. `91228c1` · `466b4a1` · `2916af2` · `9f87ba9` ·
`12850fd` · `602de01` · `9de2754` · `0308608` · `0d7b702` · `a143ad9` ·
`839e7cc` · `3c6e823` · `63e9c95` · `294c3e6` · `cad59f2` · `0353bdd` ·
`834071e`

## The problem

The station could describe a machine's hardware and say nothing about whether
it **works**. A laptop with a dead speaker, a stuck key, a broken camera or a
dead trackpad reads as perfect on a specification sheet.

## The principle that governs it

From the owner's specification, and the single most important line in it:

> **Do not pretend the browser can diagnose hardware it cannot measure.**

A web page cannot measure whether a speaker produces sound, or whether a camera
image is in focus. What it *can* do is drive the hardware and **ask a
technician what happened**. Every result in this module is a human's answer,
recorded as such (`confirmedBy: 'technician'`).

And its companion, §7:

> **Do not confuse "not detected" with "not verified".**

A test that could not run is **ATTENTION**, never **FAILED**. Failing a
component because the station could not test it would condemn working hardware.

## The seven tests

| Test | What the station does | What the technician answers |
| --- | --- | --- |
| Speaker | Unmutes, plays a tone per side | Did you hear it, both sides? |
| Keyboard | On-screen layout, lights each key pressed | Good / has an issue |
| Camera | Live preview | Is the image good? |
| Screen | Full-screen colour fields | How many dead pixels? |
| Trackpad | Tracks movement, buttons, scroll | Good / has an issue |
| Microphone | Records and plays back | Could you hear yourself? |
| USB ports | Counts ports that responded | — |

## The keyboard test, which took five attempts

**`12850fd`** built an on-screen layout that lights keys as they are pressed.
Then real hardware:

**`602de01` — stop a pressed key from clicking a live control.** Pressing
Space or Enter activated the focused button — so testing the keyboard fired the
verdict buttons.

**`0d7b702` — detect on keydown, so browser shortcuts stop firing.** Detection
ran on `keyup`; the browser acts on `keydown`. F3 opened Find, F5 reloaded the
page, F7 turned on caret browsing. **Always too late.**

**`a143ad9` — let the key grab stand down for text fields.** The fix swallowed
every keystroke, including in the notes field and the Settings panel — so
typing a note silently did nothing.

Then, on 22 September, the two layers below the browser — see
`2026-09-22-keypress-ownership.md`.

**The general lesson**: an input test must not be driven by the same input it
is testing. The mouse is the way out of the keyboard test, and the instructions
say so.

## Honest reporting

**`466b4a1` — make the card tell the truth about where the result is.** The
card implied the result was already on the audit record when it was held
locally until the audit was filed.

**`63e9c95` — a human summary, not a JSON dump.** The asset page was printing
the raw `hardwareTest` object: audio mixer commands, sink names, the exact keys
a keyboard was missing, colour swatches, raw booleans and a history log. One
formatter, shared between the API and the web app so a device cannot read
"Passed" in one place and "Failed" in the next.

**`294c3e6` — a Hardware test column in the batch and pallet xlsx reports.**

**`834071e` — let the unreadable-drive screen be looked at, not just tested.**

**`0353bdd` — fix the checklist where it would mislead the owner.** The
operator checklist itself was reviewed for claims it could not support.

## What was deliberately not built

No automated pass/fail on anything a browser cannot measure. No attempt to
analyse camera image quality, audio levels or touch accuracy — all are
technician judgements.

## How it was proved

A test suite per component: `test-hwtest.py`, `-keyboard`, `-camera`,
`-screen`, `-speaker`, `-trackpad`, `-microphone`, `-usb`, plus
`test-hardware-tests-doc.py` which checks the operator documentation against
what the module actually does.

## Open questions

The module ships by **stick sync**, no layer rebuild. Hardware Test 2 — a
two-drive machine — was still unproven on hardware at the time of writing.
