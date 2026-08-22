import {
  RAM_NONE,
  type MergeCandidate,
  mergeBlockers,
  SPEC_HEADERS,
  SPEC_WIDTHS,
  VARIANT_HEADERS,
  VARIANT_WIDTHS,
  composeLineVariant,
  palletLineTotal,
  parseRamGb,
  ramLabel,
  safeFilePart,
  specRow,
  variantRow,
  ASSET_HEADERS,
  ASSET_WIDTHS,
  assetReportRow,
} from './pallets.service';

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

// The Layout 1 report is an established document — operators and their buyers
// read it, and the multi-pallet export now shares its columns. Pinning the
// arrays against their literals means "Layout 1's report must not change"
// fails the build rather than shipping quietly. Same for Layout 2.
describe('report columns', () => {
  it('pins the Layout 1 columns', () => {
    expect(VARIANT_HEADERS).toEqual([
      'Pallet number',
      'Manufacturer',
      'Model',
      'Size',
      'Variant',
      'Stand',
      'Quantity',
      'Grade',
      'Unit cost (£)',
      'Line total (£)',
    ]);
    expect(VARIANT_WIDTHS).toEqual([16, 16, 22, 10, 14, 8, 10, 12, 14, 16]);
  });

  it('pins the Layout 2 columns', () => {
    expect(SPEC_HEADERS).toEqual([
      'Pallet number',
      'Manufacturer',
      'Model',
      'Chassis',
      'CPU',
      'Gen',
      'RAM',
      'Storage',
      'Quantity',
    ]);
    expect(SPEC_WIDTHS).toEqual([16, 16, 22, 12, 20, 10, 10, 16, 12]);
  });

  it('pins the asset-pallet columns', () => {
    // One row per DEVICE -- serial identity is this layout's entire point, so
    // its columns are the device's. Same freeze contract as the other two:
    // changing the document is a decision, not a drive-by.
    expect(ASSET_HEADERS).toEqual([
      'Pallet number',
      'Unit ID',
      'Serial / Tag',
      'Manufacturer',
      'Model',
      'Type',
      'CPU',
      'RAM',
      'Storage',
      'Screen',
      'Battery',
      'Grade',
      'Audit status',
      'Moved to pallet',
      'Moved by',
    ]);
    expect(ASSET_WIDTHS).toEqual([16, 12, 20, 16, 22, 12, 26, 9, 20, 9, 10, 12, 16, 20, 18]);
  });

  it('asset rows carry the full per-device spec, blank rather than zero-fill', () => {
    const a = {
      unitId: 'U-000042', tag: 'SN42',
      manufacturer: 'Dell', model: 'Latitude 7490', deviceType: 'Laptop',
      cpu: 'Intel Core i5-8350U', ramGb: 16, storage: '256GB NVMe + 1TB HDD',
      screenSize: '14"', batteryHealth: '87%',
      conditionGrade: 'grade_b', auditStatus: 'data_wiped',
      movedToPalletAt: null, movedToPalletByName: null,
    };
    const row = assetReportRow('PALLET-000009', a);
    expect(row[0]).toBe('PALLET-000009');
    expect(row).toHaveLength(ASSET_HEADERS.length);
    expect(row[ASSET_HEADERS.indexOf('CPU')]).toBe('Intel Core i5-8350U');
    // RAM renders with no space before GB, matching SPEC_RAM's convention.
    expect(row[ASSET_HEADERS.indexOf('RAM')]).toBe('16GB');
    expect(row[ASSET_HEADERS.indexOf('Storage')]).toBe('256GB NVMe + 1TB HDD');
    expect(row[ASSET_HEADERS.indexOf('Moved to pallet')]).toBe('');
    expect(row[ASSET_HEADERS.indexOf('Moved by')]).toBe('');

    // A hand-entered device with no profile: blanks, never 'null' or 0.
    const bare = { ...a, manufacturer: null, model: null, deviceType: null, cpu: null,
      ramGb: null, storage: null, screenSize: null, batteryHealth: null };
    const bareRow = assetReportRow('P', bare);
    expect(bareRow[ASSET_HEADERS.indexOf('RAM')]).toBe('');
    expect(bareRow[ASSET_HEADERS.indexOf('CPU')]).toBe('');
  });

  it('leads every row with the pallet number, in both layouts', () => {
    const line: any = { manufacturer: 'Dell', model: 'P2419H', size: '24', variantType: 'frameless', stand: true, quantity: 45, grade: 'a', unitCost: 12.5, variant: 'Dell', product: null };
    expect(variantRow('PALLET-000001', line)[0]).toBe('PALLET-000001');
    expect(specRow('PALLET-000001', line)[0]).toBe('PALLET-000001');
  });

  it('keeps quantity a count rather than expanding it into rows', () => {
    const line: any = { quantity: 45, unitCost: 2, variant: 'x', product: null };
    expect(variantRow('P', line)[VARIANT_HEADERS.indexOf('Quantity')]).toBe(45);
    expect(specRow('P', line)[SPEC_HEADERS.indexOf('Quantity')]).toBe(45);
  });

  it('leaves cost cells blank rather than zero when there is no unit cost', () => {
    const priced: any = { quantity: 4, unitCost: 2.5, variant: 'x', product: null };
    const unpriced: any = { quantity: 4, unitCost: null, variant: 'x', product: null };
    expect(palletLineTotal(priced)).toBe(10);
    expect(palletLineTotal(unpriced)).toBeNull();
    expect(variantRow('P', unpriced)[VARIANT_HEADERS.indexOf('Line total (£)')]).toBe('');
  });
});

// The merge validator is pure so it can be tested without a database — and so
// the workspace can grey out the Merge button WITH a reason rather than letting
// someone discover the problem via a 409.
describe('mergeBlockers', () => {
  const p = (over: Partial<MergeCandidate>): MergeCandidate => ({
    id: over.id ?? 'a',
    palletNumber: over.palletNumber ?? 'PALLET-000001',
    status: over.status ?? 'open',
    entryLayout: over.entryLayout ?? 'variant',
    totalQuantity: over.totalQuantity ?? 10,
    lineCount: over.lineCount ?? 2,
  });

  it('allows the ordinary case', () => {
    expect(
      mergeBlockers([
        p({ id: 'a', palletNumber: 'PALLET-000001' }),
        p({ id: 'b', palletNumber: 'PALLET-000002' }),
      ]),
    ).toEqual([]);
  });

  it('refuses more than two, in the words the spec specified', () => {
    expect(
      mergeBlockers([
        p({ id: 'a', palletNumber: 'PALLET-000001' }),
        p({ id: 'b', palletNumber: 'PALLET-000002' }),
        p({ id: 'c', palletNumber: 'PALLET-000003' }),
      ]),
    ).toEqual(['Please select exactly 2 pallets to merge.']);
  });

  it('refuses fewer than two, in the words the spec specified', () => {
    expect(mergeBlockers([p({})])).toEqual(['Merge requires exactly 2 pallets.']);
    expect(mergeBlockers([])).toEqual(['Merge requires exactly 2 pallets.']);
  });

  it('refuses the same pallet twice', () => {
    const blockers = mergeBlockers([p({ id: 'a' }), p({ id: 'a' })]);
    expect(blockers.join(' ')).toMatch(/more than once/);
  });

  it('refuses shipped goods', () => {
    const blockers = mergeBlockers([
      p({ id: 'a', palletNumber: 'PALLET-000001', status: 'shipped' }),
      p({ id: 'b', palletNumber: 'PALLET-000002' }),
    ]);
    expect(blockers.join(' ')).toMatch(/PALLET-000001 has shipped/);
  });

  it('refuses a pallet that was already merged, and says so', () => {
    const blockers = mergeBlockers([
      p({ id: 'a', palletNumber: 'PALLET-000001', status: 'merged' }),
      p({ id: 'b', palletNumber: 'PALLET-000002' }),
    ]);
    expect(blockers.join(' ')).toMatch(/PALLET-000001 was already merged/);
  });

  it('refuses an empty pallet — merging one burns a number for nothing', () => {
    expect(
      mergeBlockers([
        p({ id: 'a', palletNumber: 'PALLET-000001', totalQuantity: 0, lineCount: 0 }),
        p({ id: 'b', palletNumber: 'PALLET-000002' }),
      ]).join(' '),
    ).toMatch(/PALLET-000001 is empty/);
    // Lines that exist but sum to zero are just as empty.
    expect(
      mergeBlockers([
        p({ id: 'a', palletNumber: 'PALLET-000001', totalQuantity: 0, lineCount: 3 }),
        p({ id: 'b', palletNumber: 'PALLET-000002' }),
      ]).join(' '),
    ).toMatch(/PALLET-000001 is empty/);
  });

  it('refuses a cross-layout merge, naming which is which', () => {
    const blockers = mergeBlockers([
      p({ id: 'a', palletNumber: 'PALLET-000001', entryLayout: 'variant' }),
      p({ id: 'b', palletNumber: 'PALLET-000002', entryLayout: 'spec' }),
    ]);
    expect(blockers.join(' ')).toMatch(/PALLET-000001 is Layout 1/);
    expect(blockers.join(' ')).toMatch(/PALLET-000002 is Layout 2/);
    expect(blockers.join(' ')).toMatch(/cannot be merged/);
  });

  it('treats a null entryLayout as Layout 1 rather than a third layout', () => {
    expect(
      mergeBlockers([
        p({ id: 'a', palletNumber: 'PALLET-000001', entryLayout: null }),
        p({ id: 'b', palletNumber: 'PALLET-000002', entryLayout: 'variant' }),
      ]),
    ).toEqual([]);
  });

  it('reports every problem at once, not just the first', () => {
    const blockers = mergeBlockers([
      p({ id: 'a', palletNumber: 'PALLET-000001', status: 'shipped' }),
      p({ id: 'b', palletNumber: 'PALLET-000002', totalQuantity: 0, lineCount: 0 }),
    ]);
    expect(blockers.length).toBeGreaterThanOrEqual(2);
  });

  it('refuses to merge a pallet that holds serialized devices', () => {
    // v1 boundary: merging asset pallets needs a second move path for asset
    // rows plus asset-aware provenance. Until that exists, the blocker is what
    // keeps the lines-are-MOVED-not-copied invariant safe from the side.
    const blockers = mergeBlockers([
      p({ id: 'a', palletNumber: 'PALLET-000001', entryLayout: 'asset', totalQuantity: 5, lineCount: 0 }),
      p({ id: 'b', palletNumber: 'PALLET-000002', entryLayout: 'asset', totalQuantity: 3, lineCount: 0 }),
    ]);
    expect(blockers.some((b) => b.includes('serialized devices'))).toBe(true);
    // ...and the 'empty' rule must NOT also fire: an asset pallet with devices
    // is not empty, its lineCount just is 0.
    expect(blockers.some((b) => b.includes('empty'))).toBe(false);
  });
});
