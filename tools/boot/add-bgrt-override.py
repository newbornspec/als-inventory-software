#!/usr/bin/env python3
"""Repack als-splash.img so it overrides Ubuntu's OWN theme as well as adding ours.

WHY THIS EXISTS

The first attempt added a theme called `als` and selected it two ways: a
plymouthd.conf in the archive, and plymouth.splash=als on the kernel command
line. Both are sound - verified by reading Ubuntu's own /casper/initrd:

  - two-step.so IS in the initramfs, so our ModuleName resolves.
  - /etc/plymouth/ in the initramfs is EMPTY, so our plymouthd.conf would not
    have been shadowed by anything.
  - bgrt.plymouth really is ModuleName=two-step with UseFirmwareBackground=true
    and ImageDir=/usr/share/plymouth/themes//spinner, which is precisely the
    Dell-logo-plus-Ubuntu-wordmark screen that was photographed.

So the theme was fine and the selection was fine. What did not happen was the
archive being unpacked at all - which points at GRUB's `if [ -f /als-splash.img ]`
test failing and the else branch loading only /casper/initrd.

That conditional is now gone from the default entry. But rather than bet the
whole result on one hypothesis again, this adds a SECOND, independent mechanism
to the same archive: overwrite the files Ubuntu's own theme already loads.

  usr/share/plymouth/themes/bgrt/bgrt.plymouth   <- ours
  usr/share/plymouth/themes/spinner/animation-*.png, watermark.png  <- ours

Now the splash does not depend on theme SELECTION working at all. Even if
plymouth.splash= is ignored and plymouthd.conf is never read, plymouthd loads
`bgrt` - and bgrt is now our file, pointing at our images, with
UseFirmwareBackground=false so the Dell logo does not come back.

Two mechanisms, one boot. If it still shows the Ubuntu wordmark after this,
the archive genuinely is not being unpacked and the splash is not worth more
of anyone's time - the GRUB menu is already gone, which was half the goal.
"""
import io, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, 'dist')
SRC  = os.path.join(DIST, 'als-splash.img')

# bgrt's own [boot-up] section sets UseFirmwareBackground=true, which is what
# paints the firmware's Dell logo. two-step reads the mode-specific section on
# top of [two-step], so every mode has to be overridden, not just the base.
BGRT = """[Plymouth Theme]
Name=BGRT
Description=Replaced by the ALS audit station
ModuleName=two-step

[two-step]
ImageDir=/usr/share/plymouth/themes/spinner
BackgroundStartColor=0x0b1220
BackgroundEndColor=0x0b1220
HorizontalAlignment=.5
VerticalAlignment=.58
WatermarkHorizontalAlignment=.5
WatermarkVerticalAlignment=.42
Transition=none
TransitionDuration=0.0
ProgressBarBackgroundColor=0x0b1220
ProgressBarForegroundColor=0x1f3350
DialogHorizontalAlignment=.5
DialogVerticalAlignment=.75
TitleHorizontalAlignment=.5
TitleVerticalAlignment=.5
MessageBelowAnimation=true
DialogClearsFirmwareBackground=true
UseFirmwareBackground=false

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


def read_cpio(raw):
    """Yield (name, mode, data) for a newc archive."""
    off = 0
    while off < len(raw):
        if raw[off:off + 6] != b'070701':
            break
        def fld(i):
            return int(raw[off + 6 + i * 8: off + 6 + (i + 1) * 8], 16)
        mode, namesize, filesize = fld(1), fld(11), fld(6)
        name = raw[off + 110: off + 110 + namesize - 1].decode('ascii')
        hdr = 110 + namesize
        hdr += (-hdr) % 4
        data = off + hdr
        if name == 'TRAILER!!!':
            break
        yield name, mode, raw[data:data + filesize]
        off = data + filesize + ((-filesize) % 4)


def entry(name, mode, data=b''):
    """One newc header + payload, both padded to 4 bytes."""
    def h(v):
        return b'%08X' % v
    nb = name.encode('ascii') + b'\0'
    out = (b'070701' + h(0) + h(mode) + h(0) + h(0) + h(1) + h(0)
           + h(len(data)) + h(0) + h(0) + h(0) + h(0) + h(len(nb)) + h(0) + nb)
    out += b'\0' * ((-len(out)) % 4)
    out += data
    out += b'\0' * ((-len(data)) % 4)
    return out


def main():
    if not os.path.exists(SRC):
        sys.exit('%s not found - run make-splash.py first' % SRC)

    items = list(read_cpio(io.open(SRC, 'rb').read()))
    print('read %s: %d entries' % (os.path.basename(SRC), len(items)))

    # Our frames, taken straight from the theme we already built.
    frames = {n.rsplit('/', 1)[1]: d for n, m, d in items
              if '/themes/als/' in n and n.endswith('.png')}
    if not frames:
        sys.exit('no PNGs found in the existing archive')

    out = bytearray()
    seen = set()

    def add_dir(p):
        for i in range(1, p.count('/') + 2):
            d = '/'.join(p.split('/')[:i])
            if d and d not in seen:
                seen.add(d)
                out.extend(entry(d, 0o040755))

    # Everything the first archive already carried, unchanged.
    for name, mode, data in items:
        if name not in seen:
            seen.add(name)
            out.extend(entry(name, mode, data))

    # Mechanism 2: become Ubuntu's own theme.
    add_dir('usr/share/plymouth/themes/bgrt')
    out.extend(entry('usr/share/plymouth/themes/bgrt/bgrt.plymouth',
                     0o100644, BGRT.encode('utf-8')))
    print('override: usr/share/plymouth/themes/bgrt/bgrt.plymouth')

    add_dir('usr/share/plymouth/themes/spinner')
    n = 0
    for fname, data in sorted(frames.items()):
        p = 'usr/share/plymouth/themes/spinner/' + fname
        out.extend(entry(p, 0o100644, data))
        n += 1
    print('override: %d image(s) into themes/spinner/' % n)

    out.extend(entry('TRAILER!!!', 0))
    out.extend(b'\0' * ((-len(out)) % 512))

    io.open(SRC, 'wb').write(bytes(out))
    print('wrote %s (%d bytes)' % (SRC, len(out)))

    # Parse it straight back. An archive the kernel cannot read is the one
    # failure mode that looks exactly like the bug we are trying to fix.
    back = list(read_cpio(io.open(SRC, 'rb').read()))
    print('verified: parses back to %d entries' % len(back))
    need = ['usr/share/plymouth/themes/bgrt/bgrt.plymouth',
            'usr/share/plymouth/themes/spinner/watermark.png',
            'usr/share/plymouth/themes/als/als.plymouth',
            'etc/plymouth/plymouthd.conf']
    names = [b[0] for b in back]
    for p in need:
        print('  %-52s %s' % (p, 'present' if p in names else 'MISSING'))
    if any(p not in names for p in need):
        sys.exit('an expected path is missing - refusing to call this good')


if __name__ == '__main__':
    main()
