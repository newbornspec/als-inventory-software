// Which asset a station capture belongs to (remediation spec D-6, owner
// decision D24).
//
// The asset is keyed on its tag, and the tag is the machine's serial number.
// A machine whose firmware reports no serial (a white-box desktop, a board
// swap, "To Be Filled By O.E.M." - hardware-audit.sh blanks those) used to get
// tag HW-<timestamp>: a NEW asset for every upload. Since the station files one
// record per drive, a two-drive machine with no serial became two assets, each
// showing one drive, and nothing could ever see that the machine had a second
// drive - let alone that its wipe failed.
//
// So, with no serial, the asset is keyed on the SMBIOS system UUID
// (identification.biosUuid), as tag UUID-<uuid>, matched case-insensitively
// like the serial. Only when neither exists does the old HW-<timestamp>
// behaviour remain. This is the owner's reversible policy choice (D24) over
// refusing such machines outright.
//
// A UUID is only used when it can identify ONE machine. Firmware that never
// had a UUID programmed reports placeholders shared by thousands of boards -
// all zeros, all Fs, the well-known AMI and OEM defaults below, or a
// Dell UUID built from a blank service tag - and keying on one
// of those would merge unrelated machines into one asset, which is far worse
// than splitting one machine into two. Those are ignored.
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACEHOLDER_UUIDS = new Set([
  // The AMI default, as dmidecode 2.6+ prints it...
  '03000200-0400-0500-0006-000700080009',
  // ...and in raw byte order, as SMBIOS < 2.6 boards report it.
  '00020003-0004-0005-0006-000700080009',
  // An Insyde/OEM placeholder left on unprogrammed boards.
  '12345678-1234-5678-90AB-CDDEEFAABBCC',
]);

// Dell derives the system UUID from the service tag: "4C4C4544" ("DELL") then
// the seven tag characters in bytes 5, 6, 9, 10, 13, 14 and 15 (byte 10 with
// its high bit set). A replacement motherboard whose tag was never programmed
// encodes seven spaces - 4C4C4544-0000-2010-8020-80C04F202020 - and every
// such Dell shares it. A tag that is all spaces or NULs identifies nothing.
const DELL_TAG_BYTES = [5, 6, 9, 10, 13, 14, 15];
function isBlankDellTag(hex: string): boolean {
  if (!hex.startsWith('4C4C4544')) return false;
  return DELL_TAG_BYTES.every((i) => {
    const b = parseInt(hex.slice(i * 2, i * 2 + 2), 16) & 0x7f;
    return b === 0x00 || b === 0x20;
  });
}

export function usableBiosUuid(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const uuid = raw.trim().toUpperCase();
  if (!UUID_SHAPE.test(uuid)) return null;
  const hex = uuid.replace(/-/g, '');
  // One repeated digit: 00000000-..., FFFFFFFF-..., and the like.
  if (/^(.)\1*$/.test(hex)) return null;
  if (PLACEHOLDER_UUIDS.has(uuid)) return null;
  if (isBlankDellTag(hex)) return null;
  return uuid;
}

// The tag the asset is looked up (and created) by, or null when the capture
// carries no usable identity at all.
export function hostTag(
  serial: string | null,
  biosUuid: unknown,
): string | null {
  if (serial) return serial;
  const uuid = usableBiosUuid(biosUuid);
  return uuid ? `UUID-${uuid}` : null;
}
