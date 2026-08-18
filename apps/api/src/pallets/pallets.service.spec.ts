import { RAM_NONE, composeLineVariant, parseRamGb, ramLabel, safeFilePart } from './pallets.service';

// composeLineVariant fills pallet_lines.variant, which is NOT NULL and is read
// by the report, the sold snapshot and sold-return matching. safeFilePart
// guards an HTTP header. Both are worth pinning down.

describe('composeLineVariant', () => {
  it('joins the spec fields in reading order', () => {
    expect(
      composeLineVariant({
        manufacturer: 'Dell',
        model: 'P2419H',
        size: '24"',
        variantType: 'frameless',
        stand: true,
      }),
    ).toBe('Dell · P2419H · 24" · Frameless · Stand');
  });

  it('skips fields the operator left blank', () => {
    expect(
      composeLineVariant({ manufacturer: 'HP', size: '23"', variantType: 'normal', stand: false }),
    ).toBe('HP · 23" · Normal · No stand');
  });

  it('distinguishes "no stand" from "not recorded"', () => {
    expect(composeLineVariant({ manufacturer: 'HP', stand: false })).toBe('HP · No stand');
    expect(composeLineVariant({ manufacturer: 'HP', stand: null })).toBe('HP');
    expect(composeLineVariant({ manufacturer: 'HP' })).toBe('HP');
  });

  it('never returns empty — the column is NOT NULL', () => {
    expect(composeLineVariant({})).toBe('Unspecified');
    expect(composeLineVariant({ manufacturer: '   ', model: '' })).toBe('Unspecified');
  });

  it('trims what the operator typed', () => {
    expect(composeLineVariant({ manufacturer: '  Lenovo  ', size: ' 24" ' })).toBe('Lenovo · 24"');
  });
});

describe('safeFilePart', () => {
  it('leaves a generated pallet number alone', () => {
    expect(safeFilePart('PALLET-000045', 'fallback')).toBe('PALLET-000045');
  });

  it('neutralises characters that would corrupt a Content-Disposition header', () => {
    // A quote truncates the header, a slash or semicolon corrupts it, and a
    // newline makes Node throw ERR_INVALID_CHAR.
    expect(safeFilePart('PK15 "MONITORS"', 'x')).toBe('PK15-MONITORS');
    expect(safeFilePart('A/B;C', 'x')).toBe('A-B-C');
    expect(safeFilePart('bad\r\nInjected: header', 'x')).toBe('bad-Injected-header');
  });

  it('falls back when nothing usable survives', () => {
    expect(safeFilePart('///', 'the-uuid')).toBe('the-uuid');
    expect(safeFilePart('', 'the-uuid')).toBe('the-uuid');
  });

  it('does not leave stray separators at the ends', () => {
    expect(safeFilePart(' PALLET 45 ', 'x')).toBe('PALLET-45');
  });
});

// RAM round-trip. products.ram_gb is an int, so "None" cannot be stored as text
// the way products.cpu is; 0 is the sentinel and NULL still means "not said".
// The grid reads its value back through this, so if the pair disagreed, picking
// None would silently come back blank.
describe('RAM None round-trip', () => {
  it('stores None as the 0 sentinel, not as null', () => {
    expect(parseRamGb('None')).toBe(RAM_NONE);
    expect(parseRamGb('none')).toBe(0);
  });

  it('keeps "not specified" distinct from "None"', () => {
    expect(parseRamGb('')).toBeNull();
    expect(parseRamGb(null)).toBeNull();
    expect(parseRamGb(undefined)).toBeNull();
  });

  it('still parses real capacities, with or without a space', () => {
    expect(parseRamGb('16GB')).toBe(16);
    expect(parseRamGb('16 GB')).toBe(16);
    expect(parseRamGb('128GB')).toBe(128);
  });

  it('renders each case back the way it went in', () => {
    expect(ramLabel(parseRamGb('None'))).toBe('None');
    expect(ramLabel(parseRamGb('16GB'))).toBe('16 GB');
    expect(ramLabel(parseRamGb(''))).toBe('');
  });

  it('round-trips through the grid format too', () => {
    const gridCell = (n: number | null) => (n == null ? '' : n === 0 ? 'None' : `${n}GB`);
    for (const typed of ['None', '2GB', '8GB', '128GB']) {
      expect(gridCell(parseRamGb(typed))).toBe(typed);
    }
  });
});
