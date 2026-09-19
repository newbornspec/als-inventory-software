#!/usr/bin/env python3
"""
Build the ALS boot splash: a Plymouth theme, plus the tiny cpio archive that
injects it into the live initramfs WITHOUT rebuilding /casper/initrd.

Runs on Windows with nothing but the Python standard library.

    python make-splash.py                    # writes dist\
    python make-splash.py --verify           # ... and lists the archive back
    python make-splash.py --text "ALS AUDIT STATION" --sub "STARTING"

WHAT IT PRODUCES

    dist/als-splash.img          -> copy to the ROOT of the stick (FAT32)
    dist/theme/...               -> the same theme, for the squashfs layer
                                    (the SHUTDOWN splash comes from there, not
                                    from the initramfs)

WHY A CPIO AND NOT A REBUILT INITRAMFS

    The Linux initramfs loader accepts a CONCATENATION of cpio archives; each
    one is unpacked in turn into the same rootfs and later archives overwrite
    earlier files (init/initramfs.c, clean_path()/do_name(): an existing file of
    the same type is reopened O_TRUNC).  This is the same mechanism early CPU
    microcode uses.  GRUB's `initrd` command already takes several files and
    concatenates them, so:

        initrd /casper/initrd /als-splash.img

    ...adds our theme to Ubuntu's own initramfs without touching it, and
    DELETING als-splash.img from Windows puts everything back.

    Secure Boot is unaffected: shim verifies grub, grub verifies the kernel,
    and nothing verifies the initrd - which is why every Ubuntu machine on
    earth still boots after a locally generated initrd.img is written.

FORMAT NOTES (newc, "070701")

    110-byte ASCII header, then the NUL-terminated name padded so that
    header+name is a multiple of 4, then the data padded to a multiple of 4.
    Written UNCOMPRESSED, which is what the kernel's "*buf == '0' and 4-byte
    aligned" fast path expects for a trailing segment.
"""

import argparse
import os
import struct
import sys
import zlib

# --------------------------------------------------------------------------
# 5x7 bitmap font.  Written out in binary so it can be read and corrected by
# eye; there is no font file to ship and nothing to install.
# --------------------------------------------------------------------------
FONT = {
    'A': ('01110', '10001', '10001', '11111', '10001', '10001', '10001'),
    'B': ('11110', '10001', '11110', '10001', '10001', '10001', '11110'),
    'C': ('01110', '10001', '10000', '10000', '10000', '10001', '01110'),
    'D': ('11110', '10001', '10001', '10001', '10001', '10001', '11110'),
    'E': ('11111', '10000', '11110', '10000', '10000', '10000', '11111'),
    'F': ('11111', '10000', '11110', '10000', '10000', '10000', '10000'),
    'G': ('01110', '10001', '10000', '10111', '10001', '10001', '01111'),
    'H': ('10001', '10001', '10001', '11111', '10001', '10001', '10001'),
    'I': ('11111', '00100', '00100', '00100', '00100', '00100', '11111'),
    'J': ('00111', '00010', '00010', '00010', '00010', '10010', '01100'),
    'K': ('10001', '10010', '10100', '11000', '10100', '10010', '10001'),
    'L': ('10000', '10000', '10000', '10000', '10000', '10000', '11111'),
    'M': ('10001', '11011', '10101', '10101', '10001', '10001', '10001'),
    'N': ('10001', '11001', '10101', '10011', '10001', '10001', '10001'),
    'O': ('01110', '10001', '10001', '10001', '10001', '10001', '01110'),
    'P': ('11110', '10001', '10001', '11110', '10000', '10000', '10000'),
    'Q': ('01110', '10001', '10001', '10001', '10101', '10010', '01101'),
    'R': ('11110', '10001', '10001', '11110', '10100', '10010', '10001'),
    'S': ('01111', '10000', '10000', '01110', '00001', '00001', '11110'),
    'T': ('11111', '00100', '00100', '00100', '00100', '00100', '00100'),
    'U': ('10001', '10001', '10001', '10001', '10001', '10001', '01110'),
    'V': ('10001', '10001', '10001', '10001', '10001', '01010', '00100'),
    'W': ('10001', '10001', '10001', '10101', '10101', '11011', '10001'),
    'X': ('10001', '10001', '01010', '00100', '01010', '10001', '10001'),
    'Y': ('10001', '10001', '01010', '00100', '00100', '00100', '00100'),
    'Z': ('11111', '00001', '00010', '00100', '01000', '10000', '11111'),
    '0': ('01110', '10001', '10011', '10101', '11001', '10001', '01110'),
    '1': ('00100', '01100', '00100', '00100', '00100', '00100', '01110'),
    '2': ('01110', '10001', '00001', '00010', '00100', '01000', '11111'),
    '3': ('11111', '00010', '00100', '00010', '00001', '10001', '01110'),
    '4': ('00010', '00110', '01010', '10010', '11111', '00010', '00010'),
    '5': ('11111', '10000', '11110', '00001', '00001', '10001', '01110'),
    '6': ('00110', '01000', '10000', '11110', '10001', '10001', '01110'),
    '7': ('11111', '00001', '00010', '00100', '01000', '01000', '01000'),
    '8': ('01110', '10001', '10001', '01110', '10001', '10001', '01110'),
    '9': ('01110', '10001', '10001', '01111', '00001', '00010', '01100'),
    ' ': ('00000', '00000', '00000', '00000', '00000', '00000', '00000'),
    '.': ('00000', '00000', '00000', '00000', '00000', '01100', '01100'),
    '-': ('00000', '00000', '00000', '01110', '00000', '00000', '00000'),
    ':': ('00000', '01100', '01100', '00000', '01100', '01100', '00000'),
    '/': ('00001', '00010', '00010', '00100', '01000', '01000', '10000'),
}

GLYPH_W, GLYPH_H, ADVANCE = 5, 7, 6


# --------------------------------------------------------------------------
# Minimal RGBA PNG writer.  Plymouth loads PNGs through libpng; 8-bit RGBA
# (colour type 6) is what every stock Ubuntu theme image already is.
# --------------------------------------------------------------------------
def write_png(path, width, height, pixels):
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)                                  # filter type 0: None
        raw += pixels[y * stride:(y + 1) * stride]

    def chunk(tag, data):
        body = tag + data
        return (struct.pack('>I', len(data)) + body
                + struct.pack('>I', zlib.crc32(body) & 0xffffffff))

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as fh:
        fh.write(png)
    return len(png)


def new_canvas(width, height):
    return bytearray(width * height * 4)               # transparent


def put(buf, width, x, y, rgba):
    i = (y * width + x) * 4
    buf[i:i + 4] = bytes(rgba)


def draw_text(buf, width, x0, y0, text, scale, rgb):
    r, g, b = rgb
    pen = x0
    for ch in text.upper():
        rows = FONT.get(ch)
        if rows is None:
            raise SystemExit('character %r is not in the built-in font' % ch)
        for ry, row in enumerate(rows):
            for rx, bit in enumerate(row):
                if bit != '1':
                    continue
                for sy in range(scale):
                    for sx in range(scale):
                        put(buf, width, pen + rx * scale + sx,
                            y0 + ry * scale + sy, (r, g, b, 255))
        pen += ADVANCE * scale
    return pen - x0


def text_width(text, scale):
    return len(text) * ADVANCE * scale - scale         # trim the trailing gap


def draw_disc(buf, width, cx, cy, radius, rgb, alpha):
    r, g, b = rgb
    rr = radius * radius
    for y in range(cy - radius, cy + radius + 1):
        for x in range(cx - radius, cx + radius + 1):
            if (x - cx) ** 2 + (y - cy) ** 2 <= rr:
                put(buf, width, x, y, (r, g, b, alpha))


def draw_rect(buf, width, x0, y0, x1, y1, rgb, border=None):
    """Fill [x0,x1) x [y0,y1); an optional 1px border in another colour."""
    for y in range(y0, y1):
        for x in range(x0, x1):
            edge = x in (x0, x1 - 1) or y in (y0, y1 - 1)
            put(buf, width, x, y, (border if (edge and border) else rgb) + (255,))


# --------------------------------------------------------------------------
# cpio (newc), uncompressed
# --------------------------------------------------------------------------
class Cpio:
    def __init__(self):
        self.out = bytearray()
        self.ino = 1
        self.names = []

    def _entry(self, name, mode, data):
        name_b = name.encode('ascii') + b'\0'
        fields = [0x070701, self.ino, mode, 0, 0, 1, 0, len(data),
                  0, 0, 0, 0, len(name_b), 0]
        hdr = b'070701' + b''.join(b'%08X' % f for f in fields[1:])
        self.ino += 1
        self.out += hdr + name_b
        self.out += b'\0' * (-len(self.out) % 4)
        self.out += data
        self.out += b'\0' * (-len(self.out) % 4)
        self.names.append(name)

    def add_dir(self, name):
        self._entry(name, 0o040755, b'')

    def add_file(self, name, data):
        self._entry(name, 0o100644, data)

    def finish(self):
        # TRAILER!!! must have nlink 1 and filesize 0.
        name_b = b'TRAILER!!!\0'
        fields = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, len(name_b), 0]
        hdr = b'070701' + b''.join(b'%08X' % f for f in fields)
        self.out += hdr + name_b
        self.out += b'\0' * (-len(self.out) % 4)
        # A little zero padding after the trailer is skipped by the kernel and
        # keeps the next 4-byte boundary obvious if anything is ever appended.
        self.out += b'\0' * (-len(self.out) % 512)
        return bytes(self.out)


def read_back(blob):
    """Parse our own archive again, so the build proves what it wrote."""
    pos, listing = 0, []
    while pos < len(blob):
        if blob[pos] == 0:
            pos += 1
            continue
        if blob[pos:pos + 6] != b'070701':
            raise SystemExit('bad magic at offset %d' % pos)
        f = [int(blob[pos + 6 + i * 8:pos + 14 + i * 8], 16) for i in range(13)]
        mode, size, namesize = f[1], f[6], f[11]
        name = blob[pos + 110:pos + 110 + namesize - 1].decode('ascii')
        pos += 110 + namesize
        pos += -pos % 4
        if name == 'TRAILER!!!':
            listing.append(('-', 0, name))
            break
        listing.append(('d' if (mode & 0o170000) == 0o040000 else 'f', size, name))
        pos += size
        pos += -pos % 4
    return listing


# --------------------------------------------------------------------------
THEME = 'als'
THEME_DIR = 'usr/share/plymouth/themes/' + THEME

PLYMOUTH_FILE = """\
[Plymouth Theme]
Name=ALS Audit Station
Description=Flat background, wordmark, and a chasing indicator that proves the machine is alive

# two-step, and this is NOT a style choice.
#
# The initramfs-tools plymouth hook copies exactly ONE splash plugin into the
# initramfs: the ModuleName of whatever theme is default at build time, plus
# text.so, details.so and label.so. Ubuntu 24.04's default theme is bgrt, and
# bgrt is ModuleName=two-step. So two-step.so is the only real splash plugin
# in /casper/initrd, and a theme using `script` would load nothing and fall
# straight back to Ubuntu's splash.
#
# Check it yourself from the live session before trusting this:
#     lsinitramfs /cdrom/casper/initrd | grep plymouth/
#
# two-step also REFUSES a theme whose ImageDir lacks lock.png, entry.png or
# bullet.png - the password-prompt images - even on a machine that never asks
# for a password (plymouth 24.004 two-step/plugin.c show_splash_screen, and
# ply-entry.c ply_entry_load). This theme shipped without them for weeks, so it
# never loaded ANYWHERE: at boot plymouthd fell through to the bgrt override in
# als-splash.img (which looked identical, so nobody could tell), and at shutdown
# to Ubuntu's stock bgrt in the real root - the Dell logo and the Ubuntu
# wordmark. make-splash.py now refuses to write a theme without them.
ModuleName=two-step

[two-step]
ImageDir=/usr/share/plymouth/themes/als

# Flat fill.  Both ends the same colour, so no gradient banding on 16-bit modes.
BackgroundStartColor=0x0b1220
BackgroundEndColor=0x0b1220

# The chasing dots.
HorizontalAlignment=.5
VerticalAlignment=.58

# The wordmark.
WatermarkHorizontalAlignment=.5
WatermarkVerticalAlignment=.42

# No fade: a transition that fails is a black screen, and a transition that
# works buys nothing on a machine that boots once a day.
Transition=none
TransitionDuration=0.0

# If plymouth decides to draw its own progress bar (it does when there is no
# progress-*.png, which we deliberately do not ship), keep it quiet.
ProgressBarBackgroundColor=0x0b1220
ProgressBarForegroundColor=0x1f3350

DialogHorizontalAlignment=.5
DialogVerticalAlignment=.75
TitleHorizontalAlignment=.5
TitleVerticalAlignment=.5
MessageBelowAnimation=true
DialogClearsFirmwareBackground=true
UseFirmwareBackground=false

# two-step reads UseEndAnimation and UseFirmwareBackground ONLY from these
# per-mode groups (load_mode_settings), never from [two-step] above. Without
# them UseEndAnimation defaults to true and the dots play an end sequence before
# the screen is handed over. The bgrt override that has actually been drawing
# the boot splash sets exactly this, so the look does not change.
[boot-up]
UseEndAnimation=false
UseFirmwareBackground=false

[shutdown]
UseEndAnimation=false
UseFirmwareBackground=false

[reboot]
UseEndAnimation=false
UseFirmwareBackground=false
"""

# Every file two-step will not load a theme without. Checked before anything is
# written, so a theme that would silently fall back to Ubuntu's never ships.
TWO_STEP_REQUIRES = ('lock.png', 'entry.png', 'bullet.png')

# The line under the wordmark. The BOOT splash is drawn from als-splash.img
# (the initramfs cpio); the SHUTDOWN and reboot splash from the copy of the
# theme in the layer (dist/theme -> make-als-layer.sh), which is never shown
# at boot - plymouthd keeps the images it loaded from the initramfs until the
# desktop takes over. So the two copies can say different things, and the
# layer copy (--theme-only) says what is actually happening: the owner saw
# "STARTING" while the station powered off, 2026-09-19. Two-step has only one
# watermark image per theme, so this is the only way to word the two apart.
BOOT_SUBTITLE = 'STARTING'
LAYER_SUBTITLE = 'SHUTTING DOWN'

# For the LAYER only: our theme under the name plymouthd falls back to. If als
# ever fails to load in the real root, the fallback is still ours rather than
# Ubuntu's. make-als-layer.sh copies themes/bgrt when it finds it here.
# ImageDir stays themes/als - the real root's spinner images are Ubuntu's.
BGRT_FILE = PLYMOUTH_FILE.replace(
    'Name=ALS Audit Station',
    'Name=BGRT\n# Replaced by the ALS audit station: the fallback theme is ours too.', 1)

PLYMOUTHD_CONF = """\
# Read by plymouthd BEFORE anything else, and it wins over
# /usr/share/plymouth/plymouthd.defaults and over the default.plymouth
# alternative.  That is the whole trick: no update-alternatives, no
# plymouth-set-default-theme, no initramfs rebuild.
#
# If the theme named here fails to load for any reason, plymouthd falls
# through to /usr/share/plymouth/themes/default.plymouth - i.e. you get
# Ubuntu's own splash back.  The failure mode of this file is a visible
# Ubuntu logo, never a black screen.
[Daemon]
Theme=als
ShowDelay=0
DeviceTimeout=8
"""


def build_images(outdir, wordmark, subtitle, frames):
    os.makedirs(outdir, exist_ok=True)
    made = []

    # ---- watermark.png : wordmark over a transparent background -----------
    s1, s2 = 6, 3
    w1 = text_width(wordmark, s1)
    w2 = text_width(subtitle, s2) if subtitle else 0
    gap = 16
    width = max(w1, w2) + 8
    height = GLYPH_H * s1 + (gap + GLYPH_H * s2 if subtitle else 0) + 8
    buf = new_canvas(width, height)
    draw_text(buf, width, (width - w1) // 2, 4, wordmark, s1, (0xF2, 0xF6, 0xFB))
    if subtitle:
        draw_text(buf, width, (width - w2) // 2, 4 + GLYPH_H * s1 + gap,
                  subtitle, s2, (0x7E, 0x96, 0xB8))
    n = write_png(os.path.join(outdir, 'watermark.png'), width, height, buf)
    made.append(('watermark.png', n))

    # ---- the chasing dots -------------------------------------------------
    # Shipped under BOTH prefixes on purpose.  two-step drives "throbber-*"
    # free-running during boot and "animation-*" at the end; Ubuntu's own
    # spinner theme uses the animation- name for the thing you see moving.
    # Which one this build of the plugin animates is not worth a boot to find
    # out - they are 400 bytes each, so ship both and something always moves.
    dots, radius, pitch, pad = 12, 5, 25, 8
    w = pad * 2 + (dots - 1) * pitch + radius * 2
    h = radius * 2 + 4
    cy = h // 2
    for f in range(frames):
        buf = new_canvas(w, h)
        for i in range(dots):
            d = (i - f) % dots
            alpha = max(40, 255 - d * 40)
            draw_disc(buf, w, pad + radius + i * pitch, cy, radius,
                      (0x4D, 0xA3, 0xFF), alpha)
        for prefix in ('throbber-', 'animation-'):
            name = '%s%04d.png' % (prefix, f + 1)
            n = write_png(os.path.join(outdir, name), w, h, buf)
            made.append((name, n))

    # ---- the password-prompt images ----------------------------------------
    # Never seen on this stick (nothing here is encrypted), and two-step will
    # not load the theme without them - see TWO_STEP_REQUIRES. Drawn in the
    # theme's own colours in case plymouth ever does show a prompt.
    field, edge, ink = (0x13, 0x20, 0x3A), (0x1F, 0x33, 0x50), (0x7E, 0x96, 0xB8)

    buf = new_canvas(420, 160)                          # the dialog behind it
    draw_rect(buf, 420, 0, 0, 420, 160, field, edge)
    made.append(('box.png', write_png(os.path.join(outdir, 'box.png'), 420, 160, buf)))

    buf = new_canvas(300, 34)                           # the text field
    draw_rect(buf, 300, 0, 0, 300, 34, field, (0x4D, 0xA3, 0xFF))
    made.append(('entry.png', write_png(os.path.join(outdir, 'entry.png'), 300, 34, buf)))

    buf = new_canvas(10, 10)                            # one typed character
    draw_disc(buf, 10, 5, 5, 4, (0xF2, 0xF6, 0xFB), 255)
    made.append(('bullet.png', write_png(os.path.join(outdir, 'bullet.png'), 10, 10, buf)))

    lw, lh = 20, 26                                     # a padlock
    buf = new_canvas(lw, lh)
    for y in range(12):                                 # the shackle: a ring's top
        for x in range(lw):
            d2 = (x + 0.5 - 10) ** 2 + (y + 0.5 - 10) ** 2
            if 16 <= d2 <= 49:
                put(buf, lw, x, y, ink + (255,))
    draw_rect(buf, lw, 1, 11, 19, lh, ink)              # the body
    draw_disc(buf, lw, 10, 17, 2, (0x0B, 0x12, 0x20), 255)
    draw_rect(buf, lw, 9, 18, 11, 22, (0x0B, 0x12, 0x20))
    made.append(('lock.png', write_png(os.path.join(outdir, 'lock.png'), lw, lh, buf)))
    return made


def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument('--out', default=os.path.join(here, 'dist'))
    ap.add_argument('--text', default='ALS AUDIT STATION')
    ap.add_argument('--sub', default=None,
                    help='line under the wordmark (default: %s for the boot '
                         'archive, %s with --theme-only)'
                         % (BOOT_SUBTITLE, LAYER_SUBTITLE))
    ap.add_argument('--frames', type=int, default=12)
    ap.add_argument('--verify', action='store_true')
    ap.add_argument('--theme-only', action='store_true',
                    help='write dist\\theme\\ (the layer copy, i.e. the SHUTDOWN '
                         'splash) and leave als-splash.img alone - the boot '
                         'archive on the stick is the one proven on hardware')
    ap.add_argument('--stick', metavar='E:',
                    help='also copy onto the stick: <stick>\\als-splash.img and '
                         '<stick>\\boot\\theme\\.  grub.cfg is NEVER written '
                         'automatically - that one is armed by hand.')
    args = ap.parse_args()

    theme_out = os.path.join(args.out, 'theme', THEME_DIR)
    os.makedirs(theme_out, exist_ok=True)
    sub = args.sub if args.sub is not None else (
        LAYER_SUBTITLE if args.theme_only else BOOT_SUBTITLE)
    made = build_images(theme_out, args.text, sub, args.frames)
    missing = [f for f in TWO_STEP_REQUIRES if f not in dict(made)]
    if missing:
        raise SystemExit('two-step will not load a theme without %s - refusing '
                         'to write one that falls back to Ubuntu' % ', '.join(missing))

    with open(os.path.join(theme_out, THEME + '.plymouth'), 'w',
              newline='\n') as fh:
        fh.write(PLYMOUTH_FILE)
    conf_dir = os.path.join(args.out, 'theme', 'etc', 'plymouth')
    os.makedirs(conf_dir, exist_ok=True)
    with open(os.path.join(conf_dir, 'plymouthd.conf'), 'w',
              newline='\n') as fh:
        fh.write(PLYMOUTHD_CONF)
    bgrt_dir = os.path.join(args.out, 'theme', 'usr', 'share', 'plymouth',
                            'themes', 'bgrt')
    os.makedirs(bgrt_dir, exist_ok=True)
    with open(os.path.join(bgrt_dir, 'bgrt.plymouth'), 'w', newline='\n') as fh:
        fh.write(BGRT_FILE)

    if args.theme_only:
        print('theme     : %s  (%d images)' % (theme_out, len(made)))
        print('fallback  : %s' % os.path.join(bgrt_dir, 'bgrt.plymouth'))
        print('archive   : NOT written (--theme-only)')
        print()
        print('Sync the stick (sync-usb.ps1 -Apply copies boot\\dist\\theme to')
        print('boot\\theme), then rebuild the layer so the shutdown splash picks it up.')
        return

    # ---- pack ------------------------------------------------------------
    c = Cpio()
    for d in ('usr', 'usr/share', 'usr/share/plymouth',
              'usr/share/plymouth/themes', THEME_DIR, 'etc', 'etc/plymouth'):
        c.add_dir(d)
    c.add_file(THEME_DIR + '/' + THEME + '.plymouth',
               PLYMOUTH_FILE.encode('ascii'))
    for name, _ in sorted(made):
        with open(os.path.join(theme_out, name), 'rb') as fh:
            c.add_file(THEME_DIR + '/' + name, fh.read())
    c.add_file('etc/plymouth/plymouthd.conf', PLYMOUTHD_CONF.encode('ascii'))
    blob = c.finish()

    img = os.path.join(args.out, 'als-splash.img')
    with open(img, 'wb') as fh:
        fh.write(blob)

    # Parse it back before claiming success.  A malformed segment here does not
    # fail loudly at boot - the kernel prints "Initramfs unpacking failed" and
    # carries on - so the check has to happen on this side.
    listing = read_back(blob)
    print('theme     : %s' % theme_out)
    print('archive   : %s  (%d bytes, %d entries)'
          % (img, len(blob), len(listing) - 1))
    if args.verify:
        for kind, size, name in listing:
            print('  %s %7d  %s' % (kind, size, name))
    if len(blob) % 4:
        raise SystemExit('archive is not 4-byte aligned - refusing')

    if args.stick:
        stick = args.stick
        if len(stick) == 1:
            stick += ':'
        if not os.path.isdir(stick + os.sep):
            raise SystemExit('%s is not there' % stick)
        if not os.path.isfile(os.path.join(stick + os.sep, 'hardware-audit.sh')):
            raise SystemExit('%s does not look like an audit stick '
                             '(no hardware-audit.sh) - refusing to write to it'
                             % stick)
        dst_img = os.path.join(stick + os.sep, 'als-splash.img')
        with open(dst_img, 'wb') as fh:
            fh.write(blob)
        dst_theme = os.path.join(stick + os.sep, 'boot', 'theme')
        src_theme = os.path.join(args.out, 'theme')
        for root, _dirs, files in os.walk(src_theme):
            rel = os.path.relpath(root, src_theme)
            tgt = os.path.join(dst_theme, rel) if rel != '.' else dst_theme
            os.makedirs(tgt, exist_ok=True)
            for f in files:
                with open(os.path.join(root, f), 'rb') as a:
                    with open(os.path.join(tgt, f), 'wb') as b:
                        b.write(a.read())
        print()
        print('written to the stick:')
        print('  %s' % dst_img)
        print('  %s\\...' % dst_theme)
        print('grub.cfg was NOT touched - arm it by hand.')
    else:
        print()
        print('Copy dist\\als-splash.img to the ROOT of the stick, and put')
        print('dist\\theme\\ into the squashfs layer (see make-als-layer.sh).')
        print('Or re-run with  --stick E:  to do both.')


if __name__ == '__main__':
    main()
