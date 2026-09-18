#!/usr/bin/env bash
# Tests for the boot-drive guard - the checks that stop the wipe engine and the
# OS restore from ever targeting the drive the station booted from.
#
# Why this exists. gui_wipe_one's comment said it "refuses removable/USB
# devices"; the code only checked the removable flag. That held while every
# boot stick reported removable=1, and stops holding the day the boot drive is a
# portable SSD or an SSD-class stick - exactly what someone buys to make the
# boot faster. These tests exercise the REAL helper functions, pulled out of
# both scripts that carry them, so a copy drifting out of step also fails here.
#
#   bash tools/test-boot-guard.sh
#
# lsblk, findmnt and readlink are stubbed on PATH. The block-device test inside
# als_boot_disk is NOT stubbed - it runs against /dev/sda, which is real on the
# machines this has been run on. If it is not, those cases say so and are
# skipped rather than silently passing.

set -u
HERE=$(cd "$(dirname "$0")" && pwd)
PASS=0; FAIL=0

ok()   { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  FAIL  %s   (%s)\n' "$1" "$2"; }

# Pull a function's source out of a script, from "name() {" to the first "}" in
# column 0. Tests the real code rather than a copy of it.
extract() {
  awk -v fn="$2" '
    $0 ~ "^"fn"\\(\\) \\{" { on=1 }
    on { print }
    on && /^}/ { exit }
  ' "$1"
}

STUB=$(mktemp -d)
trap 'rm -rf "$STUB"' EXIT

cat > "$STUB/lsblk" <<'EOF'
#!/usr/bin/env bash
# -dno TRAN /dev/X   -> $STUB_TRAN
# -no PKNAME /dev/X  -> $STUB_PKNAME
case "$*" in
  *TRAN*)   printf '%s\n' "${STUB_TRAN:-}" ;;
  *PKNAME*) printf '%s\n' "${STUB_PKNAME:-}" ;;
esac
EOF
cat > "$STUB/findmnt" <<'EOF'
#!/usr/bin/env bash
# STUB_MOUNTS="mountpoint=source;mountpoint=source"
mp="${!#}"
IFS=';' read -ra pairs <<< "${STUB_MOUNTS:-}"
for p in "${pairs[@]}"; do
  [ "${p%%=*}" = "$mp" ] && { printf '%s\n' "${p#*=}"; exit 0; }
done
exit 1
EOF
cat > "$STUB/readlink" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${STUB_SYSPATH:-}"
EOF
chmod +x "$STUB/lsblk" "$STUB/findmnt" "$STUB/readlink"

for SCRIPT in "$HERE/hardware-audit.sh" "$HERE/gui/install-os.sh"; do
  name=$(basename "$SCRIPT")
  echo "$name"

  FUNCS=$(extract "$SCRIPT" als_disk_is_usb; extract "$SCRIPT" als_boot_disk)
  if [ -z "$FUNCS" ]; then bad "$name: helpers present" "not found in the file"; continue; fi

  # Run a snippet with the helpers defined and the stubs first on PATH.
  run() {
    env PATH="$STUB:$PATH" "$@" bash -c "$FUNCS"'
'"$SNIPPET"
  }

  # ------------------------------------------------------------- USB transport
  SNIPPET='als_disk_is_usb sdb && echo USB || echo NOT'

  r=$(run STUB_TRAN=usb STUB_SYSPATH=/sys/devices/x)
  [ "$r" = USB ] && ok "lsblk says TRAN=usb -> USB" || bad "lsblk says TRAN=usb -> USB" "$r"

  r=$(run STUB_TRAN=nvme STUB_SYSPATH=/sys/devices/pci0000:00/0000:00:1d.0/nvme/nvme0/nvme0n1)
  [ "$r" = NOT ] && ok "internal NVMe -> not USB" || bad "internal NVMe -> not USB" "$r"

  r=$(run STUB_TRAN=sata STUB_SYSPATH=/sys/devices/pci0000:00/0000:00:17.0/ata1/host0/target0:0:0/0:0:0:0/block/sda)
  [ "$r" = NOT ] && ok "internal SATA -> not USB" || bad "internal SATA -> not USB" "$r"

  # The case the belt-and-braces branch exists for: a bridge that leaves TRAN
  # empty. Without the sysfs check this is a USB SSD that passes as internal.
  r=$(run STUB_TRAN= STUB_SYSPATH=/sys/devices/pci0000:00/0000:00:14.0/usb2/2-1/2-1:1.0/host4/target4:0:0/4:0:0:0/block/sdb)
  [ "$r" = USB ] && ok "TRAN empty but sysfs runs through usb2 -> USB" || bad "TRAN empty but sysfs runs through usb2 -> USB" "$r"

  # And the pattern must not be so loose it calls things USB that are not.
  r=$(run STUB_TRAN=sata STUB_SYSPATH=/sys/devices/platform/usbcore-fake/block/sda)
  [ "$r" = NOT ] && ok "'usbcore' in a path is not a USB controller" || bad "'usbcore' in a path is not a USB controller" "$r"

  # ------------------------------------------------------------- boot disk
  SNIPPET='out=$(als_boot_disk); rc=$?; printf "%s|%s" "$out" "$rc"'

  if [ -b /dev/sda1 ] && [ -b /dev/sda ]; then
    r=$(run STUB_MOUNTS=/cdrom=/dev/sda1 STUB_PKNAME=sda)
    [ "$r" = "sda|0" ] && ok "/cdrom on a partition -> its disk" || bad "/cdrom on a partition -> its disk" "$r"

    r=$(run STUB_MOUNTS=/cdrom=/dev/sda STUB_PKNAME=)
    [ "$r" = "sda|0" ] && ok "/cdrom on a whole disk -> that disk" || bad "/cdrom on a whole disk -> that disk" "$r"

    r=$(run ALS_MEDIA=/mnt/als STUB_MOUNTS="/cdrom=/dev/nonexistent9;/mnt/als=/dev/sda1" STUB_PKNAME=sda)
    [ "$r" = "sda|0" ] && ok "ALS_MEDIA is checked first" || bad "ALS_MEDIA is checked first" "$r"
  else
    echo "  skip  boot-disk cases: /dev/sda is not a block device on this machine"
  fi

  r=$(run STUB_MOUNTS=)
  [ "$r" = "|1" ] && ok "nothing mounted -> no boot disk, rc 1" || bad "nothing mounted -> no boot disk, rc 1" "$r"

  # A mount whose source is not a block device (a loop file, a tmpfs) must be
  # skipped, never mistaken for the boot disk.
  r=$(run STUB_MOUNTS=/cdrom=/dev/nonexistent9 STUB_PKNAME=nonexistent)
  [ "$r" = "|1" ] && ok "non-block source is skipped" || bad "non-block source is skipped" "$r"
done

# The two copies must be the same code, or one script is protected and the
# other is not. install-os.sh's comment header differs on purpose; the
# FUNCTIONS must not.
a=$(extract "$HERE/hardware-audit.sh" als_disk_is_usb; extract "$HERE/hardware-audit.sh" als_boot_disk)
b=$(extract "$HERE/gui/install-os.sh" als_disk_is_usb; extract "$HERE/gui/install-os.sh" als_boot_disk)
echo "both copies"
[ -n "$a" ] && [ "$a" = "$b" ] && ok "helpers identical in both scripts" || bad "helpers identical in both scripts" "they differ"

# The refusals have to actually be wired in, not just defined.
echo "wiring"
grep -q 'als_disk_is_usb "$d"' "$HERE/hardware-audit.sh" && ok "gui_wipe_one calls the USB check" || bad "gui_wipe_one calls the USB check" "missing"
grep -q 'boot=$(als_boot_disk)' "$HERE/hardware-audit.sh" && ok "gui_wipe_one calls the boot-disk check" || bad "gui_wipe_one calls the boot-disk check" "missing"
grep -q 'als_disk_is_usb "$kname" && result_fail' "$HERE/gui/install-os.sh" && ok "install-os.sh refuses USB" || bad "install-os.sh refuses USB" "missing"
grep -q '_boot=$(als_boot_disk)' "$HERE/gui/install-os.sh" && ok "install-os.sh refuses the boot disk" || bad "install-os.sh refuses the boot disk" "missing"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
