# Who owns a keypress

## Status

Shipped, 22 September 2026. `80d0ed3` · `e4818d0` · `1e05f3c` · `d183a89`

## The problem

Reported from the bench, with photographs. On a Lenovo ThinkPad T14, during
the hardware test's keyboard check — whose instruction to the technician is
literal, *press every key on this machine's keyboard* — two things happened:

1. Pressing Escape took the kiosk off the screen and left it black.
2. Pressing F12 opened Firefox's bookmarks sidebar over the audit, **while a
   capture was live and the page's key guard was up**.

The page already had a key guard, written after an earlier incident with the
same shape (F3/F5/F7 opening Find, reloading, and turning on caret browsing).
It did not help.

## Why it matters

Both faults interrupt an audit in progress, and the black-screen one reads to
an operator as a crashed machine. The photographs also showed a third problem
nobody had reported: **the entire F row registered as "not seen"** — 71 keys
unseen out of 85 — because in media-key mode none of those keys sends F1–F12
at all. Twelve keys the technician could not test and was not told how to.

## The mechanism

A key pressed on a laptop running a kiosk browser can be consumed at three
different depths. A web page only ever sees what the two below it decline to
take.

| Layer | Example keys | Can the page veto it? | What it costs when it fires |
| --- | --- | --- | --- |
| The page | Escape, F3/F5/F7, Ctrl+W, Ctrl+R | Yes — `preventDefault` in a capture-phase `keydown` | Find bar opens, page reloads, tab closes |
| The display server | Ctrl+Alt+F1–F12 (VT switch), Ctrl+Alt+Backspace (zap) | **No** — the X server acts before any client is offered the event | The kiosk vanishes to a text console or dies outright. *This is what a black screen looks like.* |
| The machine | Brightness, display-output switch, aeroplane mode, volume, and the ThinkPad ★ key | **No** — the embedded controller or a kernel driver acts, often with no event delivered at all | Screen dark, display switched to an absent monitor, Wi-Fi off mid-upload, bookmarks sidebar over the audit |

The ★ on F12 deserves its own note. With Fn-Lock off it does not send F12 —
it sends `XF86Favorites`, and Firefox routes that as an **app command**, not a
key event. There is no cancellable `keydown`, so `preventDefault` has nothing
to work with.

## What was built

**The page.** The guard was attached by `startCapture` and removed by
`stopCapture`, so it existed only while keys were being *counted*. But the
board outlives the counting: after "Stop capturing keys" the technician is
still at the keyboard, reviewing unlit keys and typing a note. The listener now
lives as long as the board does. While only guarding it cancels a narrower set
— Escape, F1–F24, and anything held with Ctrl/Alt/Meta — and lets plain typing
and navigation through, so Tab still reaches the notes field. Swallowing
everything on a stopped board would have traded one fault for an accessibility
one. A key pressed after Stop is swallowed but deliberately **not counted**.

The check reads `event.key` **and** `event.code`. They agree for Escape and the
F row on an ordinary keyboard, but a remapped or non-Latin layout can change
`key` while `code` stays physical — and physical is what the browser's own
shortcut table uses.

**The display server.** `setxkbmap -option '' -option srvrkeys:none`.
The option name was checked against `base.lst` rather than remembered; it is
described there as *"Special keys (Ctrl+Alt+<key>) handled in a server"*. The
empty `-option` in front of it is not decoration: it clears whatever options
the machine already had, which is the only way to be sure
`terminate:ctrl_alt_bksp` is not among them. There is no `terminate:none` to
ask for — terminate is the group and that is its only member.

**The machine.** No veto exists, so the only remaining move is to *undo*. While
the keyboard board is up, the station watches the two pieces of state one of
those keys can leave it in and restores them: a backlight driven below a
twelfth of its scale goes back to what the technician had, and a radio switched
off during the test is switched back on. For the browser app-commands, the
keysyms are taken off the keycode with `xmodmap` — a keycode is cleared only
when *every* keysym on it is one of the dead ones, which is what keeps real F12
testable with Fn-Lock on.

**The instructions.** They now say which keys the laptop handles itself, what
to do if one dims the screen, and — the finding from the photograph — how to
switch the F row over (Fn+Esc on a ThinkPad).

## What was deliberately not built

The first version put `setxkbmap` in the baked layer session, which meant
delivering it cost a `mksquashfs` rebuild and a reboot. It did not have to: the
baked session runs a shim whose only job is to hand off to
`gui/als-autostart.sh` **on the stick**, which already runs with `DISPLAY` set
and already carries the screen-blanking duty for exactly this reason. Moved
there in `1e05f3c`. The repo already had a test asserting that rule for screen
blanking; it was missed.

## How it was proved

`test-hwtest-keyboard.py` 52 → 59 checks. `test-keyguard.py` is new, 61 checks,
including the `xmodmap` keycode selector lifted straight out of the shell and
run against a keymap laid out as `xmodmap -pke` prints one: star, home, back
and sleep are selected; F12, a letter, the media-play key and a key carrying
both are not.

One existing assertion had to be deleted — it asserted the guard was **gone**
after Stop, which had been true and was the bug. It was replaced by what it
was really protecting: a keystroke aimed at the notes field is never cancelled.

The watchdog writes to a customer's machine, so its constraints are tested
separately: only volatile state (backlight, rfkill — both cleared by a power
cycle), never the disk; it restores what it *found*, not what looks right; a
radio the operator had already turned off is left alone; and **a sysfs read it
could not make is not a screen at zero**, or the watchdog would become the very
bug class it exists to survive.

## Open questions

The display-output key. On some models it switches to an absent external
monitor in firmware, and the station cannot reliably detect or undo that from
Linux. The honest answer is the instruction: *press it again*.
