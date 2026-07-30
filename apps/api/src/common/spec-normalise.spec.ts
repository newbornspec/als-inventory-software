import {
  cleanCpuModel,
  hasBuiltInDisplay,
  lacksBuiltInDisplay,
  normaliseScreenSize,
  screenSizeFor,
  standardiseRamGb,
} from './spec-normalise';

describe('cleanCpuModel', () => {
  // Every distinct CPU string in the live BATCH-000020 export, verbatim.
  it.each([
    ['Intel(R) Core(TM) i3-8145U CPU @ 2.10GHz', 'Intel Core i3-8145U 2.10GHz'],
    ['Intel(R) Core(TM) i7-2600 CPU @ 3.40GHz', 'Intel Core i7-2600 3.40GHz'],
    ['Intel(R) Core(TM) i7-3770 CPU @ 3.40GHz', 'Intel Core i7-3770 3.40GHz'],
    ['Intel(R) Core(TM) i7-4770 CPU @ 3.40GHz', 'Intel Core i7-4770 3.40GHz'],
    ['Intel(R) Core(TM) i7-4790 CPU @ 3.60GHz', 'Intel Core i7-4790 3.60GHz'],
    ['Intel(R) Core(TM) i7-6700 CPU @ 3.40GHz', 'Intel Core i7-6700 3.40GHz'],
    ['Intel(R) Core(TM) i7-7700 CPU @ 3.60GHz', 'Intel Core i7-7700 3.60GHz'],
  ])('tidies %s', (raw, expected) => {
    expect(cleanCpuModel(raw)).toBe(expected);
  });

  it('handles AMD, including the graphics suffix that is a different component', () => {
    expect(cleanCpuModel('AMD Ryzen 5 3600 6-Core Processor')).toBe('AMD Ryzen 5 3600 6-Core');
    expect(cleanCpuModel('AMD Ryzen 5 5600G with Radeon Graphics')).toBe('AMD Ryzen 5 5600G');
  });

  it('keeps the maker by default and drops it only when asked', () => {
    const raw = 'Intel(R) Core(TM) i5-1145G7 CPU @ 2.60GHz';
    expect(cleanCpuModel(raw)).toBe('Intel Core i5-1145G7 2.60GHz');
    expect(cleanCpuModel(raw, { dropMaker: true })).toBe('Core i5-1145G7 2.60GHz');
  });

  it('is idempotent, so cleaning an already-clean string is safe', () => {
    const once = cleanCpuModel('Intel(R) Core(TM) i7-4770 CPU @ 3.40GHz');
    expect(cleanCpuModel(once)).toBe(once);
  });

  it('returns an empty string for missing input rather than "undefined"', () => {
    for (const bad of [null, undefined, '', '   ']) {
      expect(cleanCpuModel(bad as string)).toBe('');
    }
  });

  it('leaves a string with nothing to strip alone', () => {
    expect(cleanCpuModel('Apple M2 Pro')).toBe('Apple M2 Pro');
  });
});

describe('standardiseRamGb', () => {
  // The table from the spec, verbatim.
  it.each([
    [1.9, 2],
    [3.8, 4],
    [7, 8],
    [7.8, 8],
    [9, 10],
    [11, 12],
    [15, 16],
    [31, 32],
  ])('rounds %p GB up to %p GB', (detected, expected) => {
    expect(standardiseRamGb(detected)).toBe(expected);
  });

  it('leaves standard capacities untouched', () => {
    for (const gb of [2, 4, 6, 8, 12, 16, 24, 32, 64, 128]) {
      expect(standardiseRamGb(gb)).toBe(gb);
    }
  });

  it('never returns an odd capacity', () => {
    for (let gb = 1; gb <= 256; gb += 1) {
      expect(standardiseRamGb(gb)! % 2).toBe(0);
    }
  });

  it('rejects missing and implausible values rather than inventing one', () => {
    for (const bad of [null, undefined, 0, -4, NaN, Infinity, 5000]) {
      expect(standardiseRamGb(bad as number)).toBeNull();
    }
  });
});

describe('normaliseScreenSize', () => {
  it('adds the inch mark to a bare number', () => {
    expect(normaliseScreenSize('13.3')).toBe('13.3"');
    expect(normaliseScreenSize('14')).toBe('14"');
  });

  it('leaves an already-formatted value alone', () => {
    expect(normaliseScreenSize('14"')).toBe('14"');
    expect(normaliseScreenSize('15.6"')).toBe('15.6"');
  });

  it('converts the raw EDID millimetre string earlier tool versions stored', () => {
    // 310x170mm is a 14" panel; 344x193mm a 15.6"; 293x165mm a 13.3".
    expect(normaliseScreenSize('310 mm x 170 mm')).toBe('14"');
    expect(normaliseScreenSize('344 mm x 193 mm')).toBe('15.6"');
    expect(normaliseScreenSize('293 mm x 165 mm')).toBe('13.3"');
    expect(normaliseScreenSize('382 mm x 215 mm')).toBe('17.3"');
  });

  it('snaps a millimetre-derived diagonal to the marketed size', () => {
    expect(normaliseScreenSize('13.96')).toBe('14"');
    expect(normaliseScreenSize('15.53')).toBe('15.6"');
    expect(normaliseScreenSize('17.26')).toBe('17.3"');
  });

  it('does not mistake a resolution for a size', () => {
    expect(normaliseScreenSize('1920x1080')).toBeNull();
    expect(normaliseScreenSize('1366 x 768')).toBeNull();
  });

  it('rejects junk and out-of-range values', () => {
    for (const bad of [null, undefined, '', '   ', 'n/a', '0', '3', '99']) {
      expect(normaliseScreenSize(bad as string)).toBeNull();
    }
  });

  it('keeps a genuinely non-standard panel at its measured value', () => {
    expect(normaliseScreenSize('20.5')).toBe('20.5"');
  });
});

describe('hasBuiltInDisplay', () => {
  it('is true for the portable chassis types the audit tool reports', () => {
    for (const t of ['Laptop', 'laptop', 'Notebook', 'Convertible', 'Detachable', 'Portable']) {
      expect(hasBuiltInDisplay(t)).toBe(true);
    }
  });

  it('is false for anything without an integrated panel', () => {
    for (const t of ['Desktop', 'Tower', 'Server', 'Workstation', 'Monitor', '', null, undefined]) {
      expect(hasBuiltInDisplay(t as string)).toBe(false);
    }
  });
});

describe('lacksBuiltInDisplay', () => {
  it('is true only for chassis known to have no panel', () => {
    for (const t of ['Desktop', 'Tower', 'SFF', 'Server', 'Workstation', 'Thin Client']) {
      expect(lacksBuiltInDisplay(t)).toBe(true);
    }
  });

  it('is false for unknown types, so an unrecognised chassis keeps its value', () => {
    for (const t of ['', null, undefined, 'Laptop', 'Monitor', 'Tablet', 'Something New']) {
      expect(lacksBuiltInDisplay(t as string)).toBe(false);
    }
  });
});

describe('screenSizeFor', () => {
  it('keeps a normalised size for laptops', () => {
    expect(screenSizeFor('Laptop', '13.3')).toBe('13.3"');
    expect(screenSizeFor('Laptop', '310 mm x 170 mm')).toBe('14"');
  });

  it('drops any size on a desktop, however it was captured', () => {
    expect(screenSizeFor('Desktop', '24"')).toBeNull();
    expect(screenSizeFor('Desktop', '14')).toBeNull();
    expect(screenSizeFor('Server', '14"')).toBeNull();
  });

  // A real Latitude 7490 in the data has deviceType null and category "Laptop";
  // treating unknown as desktop would have deleted its correct 14".
  it('keeps the size when the chassis type is unknown', () => {
    expect(screenSizeFor(null, '14"')).toBe('14"');
    expect(screenSizeFor(undefined, '13.3')).toBe('13.3"');
    expect(screenSizeFor('Laptop', '14"')).toBe('14"');
  });
});
