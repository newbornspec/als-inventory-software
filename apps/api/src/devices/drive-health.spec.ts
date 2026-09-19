import { readFileSync } from 'fs';
import { join } from 'path';
import * as api from './drive-health';
// The web app's copy of the same formatter. Imported by relative path on
// purpose, as certificate-eligibility.spec does: every case below runs through
// BOTH, so the asset page cannot word a drive differently from the reports.
import * as web from '../../../web/lib/drive-health';

const COPIES = [
  ['api', api],
  ['web', web],
] as const;

// Contract C5 examples, as the station engine writes them.
const NVME_GOOD = {
  model: 'Samsung SSD 980',
  capacity: '500GB',
  type: 'NVMe',
  smartStatus: 'PASSED',
  healthPct: 97, // legacy figure: must never be shown as the percentage
  health: {
    measured: true,
    percent: 94,
    status: 'good',
    basis: 'life remaining 94% reported by the drive',
    reasons: [],
    source: 'nvme',
    smartPassed: true,
    temperatureC: 36,
    powerOnHours: 5678,
    powerCycles: 812,
    lifeUsedPct: 6,
    availableSparePct: 100,
    reallocatedSectors: null,
    pendingSectors: null,
    uncorrectableSectors: null,
    mediaErrors: 0,
    criticalWarning: 0,
    selfTest: 'passed',
    tool: 'smartctl 7.4',
  },
};

const HDD_BAD = {
  model: 'WDC WD10EZEX',
  type: 'HDD',
  health: {
    measured: true,
    percent: 45,
    status: 'bad',
    basis: '3 reallocated, 2 pending sectors; SMART passed',
    reasons: ['3 reallocated sectors', '2 pending sectors'],
    source: 'ata-hdd',
    smartPassed: true,
    temperatureC: 41,
    powerOnHours: 16083,
    lifeUsedPct: null,
    reallocatedSectors: 3,
    pendingSectors: 2,
    uncorrectableSectors: 0,
    mediaErrors: null,
    selfTest: 'none',
  },
};

const SSD_CAUTION = {
  type: 'SSD',
  health: {
    measured: true,
    percent: 72,
    status: 'caution',
    basis: 'life remaining 72% reported by the drive',
  },
};

const RAID = {
  type: 'HDD',
  health: {
    measured: false,
    reason: 'behind a RAID/Intel RST controller',
    action: 'set the storage mode to AHCI in the BIOS, then press Rescan',
    source: 'ata-hdd',
  },
};

// A profile captured before C5: only the legacy engine fields.
const OLD = {
  model: 'KXG6AZNV256G',
  type: 'NVMe',
  smartStatus: 'PASSED',
  healthPct: 97,
  ssdLifeUsedPct: 3,
};
const OLD_UNKNOWN = { model: 'X', type: 'SSD', smartStatus: 'unknown' };
const OLD_FAILED = { model: 'Y', type: 'HDD', smartStatus: 'FAILED!' };

describe.each(COPIES)('drive health wording (%s copy)', (_name, m) => {
  it('measured: percent + status from the bands, the basis and the key numbers', () => {
    const v = m.driveHealthView(NVME_GOOD);
    expect(v.kind).toBe('measured');
    expect(v.headline).toBe('94% · Good');
    expect(v.cell).toBe('94% Good');
    expect(v.percent).toBe(94);
    expect(v.status).toBe('good');
    expect(v.tone).toBe('good');
    expect(v.basis).toBe('life remaining 94% reported by the drive');
    expect(v.facts).toEqual([
      '36 °C',
      '5,678 h powered on',
      '6% life used',
      'no media errors',
    ]);
    expect(v.action).toBeNull();
  });

  it('never shows the legacy healthPct as the percentage', () => {
    const v = m.driveHealthView(NVME_GOOD);
    expect(v.headline).not.toContain('97');
    expect(m.driveHealthView(OLD).headline).not.toContain('97');
  });

  it("the owner's bands, at every edge", () => {
    const at = (percent: number) =>
      m.driveHealthView({
        health: { measured: true, percent, status: 'good' },
      });
    expect(at(100).headline).toBe('100% · Good');
    expect(at(90).headline).toBe('90% · Good');
    expect(at(89).headline).toBe('89% · Caution');
    expect(at(50).headline).toBe('50% · Caution');
    expect(at(49).headline).toBe('49% · Bad');
    expect(at(0).headline).toBe('0% · Bad');
    expect(at(89).tone).toBe('warn');
    expect(at(49).tone).toBe('bad');
    expect(m.statusForPercent(90)).toBe('good');
    expect(m.statusForPercent(89.4)).toBe('caution');
  });

  it('the status is derived from the percent, never taken from the stored field', () => {
    // A stored status that disagrees with the number cannot reach the screen.
    const v = m.driveHealthView({
      health: { measured: true, percent: 40, status: 'good' },
    });
    expect(v.status).toBe('bad');
    expect(v.headline).toBe('40% · Bad');
  });

  it('a fractional reading is rounded before banding', () => {
    expect(
      m.driveHealthView({ health: { measured: true, percent: 89.6 } }).headline,
    ).toBe('90% · Good');
  });

  it('bad sectors are counted in words', () => {
    const v = m.driveHealthView(HDD_BAD);
    expect(v.headline).toBe('45% · Bad');
    expect(v.facts).toEqual([
      '41 °C',
      '16,083 h powered on',
      '3 reallocated, 2 pending sectors',
    ]);
    expect(v.reasons).toEqual(['3 reallocated sectors', '2 pending sectors']);
    const one = m.driveHealthView({
      health: {
        measured: true,
        percent: 98,
        reallocatedSectors: 1,
        pendingSectors: 0,
      },
    });
    expect(one.facts).toEqual(['1 reallocated sector']);
    const clean = m.driveHealthView({
      health: {
        measured: true,
        percent: 100,
        reallocatedSectors: 0,
        pendingSectors: 0,
        uncorrectableSectors: 0,
      },
    });
    expect(clean.facts).toEqual(['no bad sectors']);
    const nvme = m.driveHealthView({
      health: { measured: true, percent: 40, mediaErrors: 2 },
    });
    expect(nvme.facts).toEqual(['2 media errors']);
  });

  it('a measured drive with no basis still says where the number came from', () => {
    expect(
      m.driveHealthView({ health: { measured: true, percent: 100 } }).basis,
    ).toBe("worked out from the drive's own SMART data");
  });

  it('not measurable: the reason and the action, no percentage', () => {
    const v = m.driveHealthView(RAID);
    expect(v.kind).toBe('not-measurable');
    expect(v.headline).toBe(
      'Not measurable — behind a RAID/Intel RST controller',
    );
    expect(v.action).toBe(
      'set the storage mode to AHCI in the BIOS, then press Rescan',
    );
    expect(v.cell).toBe('Not measurable — behind a RAID/Intel RST controller');
    expect(v.percent).toBeNull();
    expect(v.status).toBeNull();
    expect(v.tone).toBe('warn');
  });

  it('not measurable without a reason or action still gives one of each', () => {
    const v = m.driveHealthView({ health: { measured: false } });
    expect(v.headline).toBe('Not measurable — the station did not record why');
    expect(v.action).toBe('press Rescan on the station');
    const u = m.driveHealthView({
      health: { measured: false, reason: 'Unknown', action: ' unknown ' },
    });
    expect(u.headline).toBe('Not measurable — the station did not record why');
    expect(u.action).toBe('press Rescan on the station');
  });

  it('a percentage that is not a real 0-100 reading is not turned into one', () => {
    for (const percent of [101, -1, NaN, '94', null, undefined]) {
      const v = m.driveHealthView({ health: { measured: true, percent } });
      expect(v.kind).toBe('not-measurable');
      expect(v.percent).toBeNull();
      expect(v.headline).toBe(
        'Not measurable — the station sent a health reading that is not a valid percentage',
      );
    }
  });

  it('an old profile (no health) says Not scanned yet, whatever legacy fields it has', () => {
    for (const d of [
      OLD,
      OLD_UNKNOWN,
      {},
      null,
      'junk',
      { health: 'good' },
      { health: {} },
    ]) {
      const v = m.driveHealthView(d);
      expect(v.kind).toBe('not-scanned');
      expect(v.headline).toBe('Not scanned yet — rescan on the station');
      expect(v.percent).toBeNull();
      expect(v.tone).toBe('neutral');
    }
  });

  it("an old profile's SMART FAILED verdict is kept, but never becomes a percentage", () => {
    const v = m.driveHealthView(OLD_FAILED);
    expect(v.kind).toBe('not-scanned');
    expect(v.legacySmartFailed).toBe(true);
    expect(v.tone).toBe('bad');
    expect(v.cell).toBe(
      'Not scanned yet — rescan on the station (earlier scan: SMART FAILED)',
    );
  });

  describe('one report cell per machine', () => {
    it('one drive', () => {
      expect(m.driveHealthSummary([NVME_GOOD])).toBe('94% Good');
      expect(m.driveHealthSummary([RAID])).toBe(
        'Not measurable — behind a RAID/Intel RST controller',
      );
      expect(m.driveHealthSummary([OLD])).toBe(
        'Not scanned yet — rescan on the station',
      );
    });

    it('several drives: worst first', () => {
      expect(m.driveHealthSummary([NVME_GOOD, HDD_BAD])).toBe(
        '2 drives: 45% Bad, 94% Good',
      );
      expect(m.driveHealthSummary([NVME_GOOD, SSD_CAUTION, HDD_BAD])).toBe(
        '3 drives: 45% Bad, 72% Caution, 94% Good',
      );
    });

    it('several drives: unmeasured ones after the measured, each saying why', () => {
      expect(m.driveHealthSummary([OLD, RAID, NVME_GOOD])).toBe(
        '3 drives: 94% Good, not measurable (behind a RAID/Intel RST controller), not scanned yet',
      );
      expect(m.driveHealthSummary([OLD_FAILED, NVME_GOOD])).toBe(
        '2 drives: 94% Good, not scanned yet (earlier scan: SMART FAILED)',
      );
    });

    it('several old drives: said once', () => {
      expect(m.driveHealthSummary([OLD, OLD_UNKNOWN])).toBe(
        '2 drives: Not scanned yet — rescan on the station',
      );
    });

    it('no drives on record: a blank cell, like a missing battery', () => {
      for (const s of [undefined, null, [], 'x', [null, 'y']]) {
        expect(m.driveHealthSummary(s)).toBe('');
      }
    });
  });

  it('never says Unknown, for any input here', () => {
    const inputs = [
      NVME_GOOD,
      HDD_BAD,
      SSD_CAUTION,
      RAID,
      OLD,
      OLD_UNKNOWN,
      OLD_FAILED,
      {},
      { health: { measured: false, reason: 'unknown' } },
      { health: { measured: true, percent: 'unknown' } },
    ];
    for (const d of inputs) {
      const v = m.driveHealthView(d);
      const text = [
        v.headline,
        v.cell,
        v.basis,
        v.action,
        ...v.reasons,
        ...v.facts,
      ].join(' | ');
      expect(text).not.toMatch(/unknown/i);
    }
    expect(m.driveHealthSummary(inputs)).not.toMatch(/unknown/i);
  });
});

describe('the API and web copies', () => {
  it('are identical below their headers', () => {
    const body = (p: string) => {
      const src = readFileSync(p, 'utf8');
      return src.slice(src.indexOf('// Rules this file enforces'));
    };
    const apiSrc = body(join(__dirname, 'drive-health.ts'));
    expect(apiSrc.length).toBeGreaterThan(1000);
    expect(body(join(__dirname, '../../../web/lib/drive-health.ts'))).toBe(
      apiSrc,
    );
  });
});
