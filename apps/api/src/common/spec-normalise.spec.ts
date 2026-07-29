import {
  hasBuiltInDisplay,
  lacksBuiltInDisplay,
  normaliseScreenSize,
  screenSizeFor,
  standardiseRamGb,
} from './spec-normalise';

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
