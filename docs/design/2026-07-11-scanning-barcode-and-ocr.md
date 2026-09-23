# Scanning: barcode, OCR, and a camera in a warehouse

## Status

Shipped, 11 July 2026. `0e4e3a3` · `ef054f3` · `54016f8` · `9d2180d` ·
`1d58e20` · `a34dbbd` · `230c991`

Phases 2.4a, 2.4b, 2.5 — and three rounds of correction after them.

## The problem

Every device has to be identified by its serial or service tag. Typing them is
slow and error-prone; the labels are small, often worn, and sometimes have no
barcode at all — just printed text.

## The decision: free, not paid

A commercial scanning SDK was considered and rejected. The system uses the
browser's **native `BarcodeDetector`** for barcodes (`0e4e3a3`) and
**full-resolution camera OCR** for text-only labels (`ef054f3`).

The reasoning: a paid SDK is a per-device licence on hardware the business
keeps buying, for a job the platform can do. The trade-off accepted is that
`BarcodeDetector` support varies by browser, and OCR accuracy on a worn label
is worse than a dedicated engine's.

## What the corrections taught

The first version worked in an office and poorly in a warehouse. Three rounds:

**`9d2180d` — extract the Service Tag from vendor labels, not regulatory
noise.** A Dell label carries the service tag, the express service code, FCC
identifiers, regulatory model numbers and certification marks. Naive OCR
returned whichever string it read most confidently, which was frequently a
regulatory number. The fix was to know what a vendor's tag actually looks like
rather than take the clearest text.

**`1d58e20` then `230c991` — the scan box, added and then removed.** A tighter
box that cropped detection was added to help the operator aim. It was then
dropped in favour of **full-frame detection and full-resolution still-photo
OCR**: cropping threw away the pixels OCR needed, and a live video frame is
lower resolution than a still. Taking a photograph and reading that beat
streaming.

**`a34dbbd` — resilient torch and on-screen engine status.** The torch toggle
failed on some devices and the operator could not tell which detection engine
was running. Showing what the software is actually doing beats letting the
operator guess why it is not working.

**`54016f8` — tag normalisation.** The same device scanned from a barcode and
read by OCR produced different strings. One normaliser, applied to both.

## Why it matters

This is the point where a device enters the system. A misread tag creates a
duplicate asset or attaches a wipe record to the wrong machine.

## What was deliberately not built

No server-side OCR. The image never leaves the device, which keeps a photograph
of a customer's asset label off the network.

## Open questions

A dedicated USB barcode gun (Honeywell) was specified later and **parked** —
see the scanner integration plan. The camera path is what is in use.
