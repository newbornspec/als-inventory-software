// The web app's component table (Audit workspace, Goods In): each Storage row
// carries the drive's health. The web app has no test runner of its own, so,
// as certificate-eligibility.spec does, this imports the web file by relative
// path. hardware-spec.ts imports its drive-health copy relatively for this.
import { specRows } from '../../../web/lib/hardware-spec';

const storageRows = (storage: unknown[]) =>
  specRows({ storage: storage as never }).filter(
    (r) => r.component === 'Storage',
  );

describe('Storage spec rows show drive health', () => {
  it('a measured drive: "94% Good" chip, tone from the band, the basis as a note', () => {
    const [good, caution, bad] = storageRows([
      {
        capacity: '512GB',
        model: 'Samsung SSD 980',
        serialNumber: 'S1',
        health: {
          measured: true,
          percent: 94,
          basis: 'life remaining 94% reported by the drive',
        },
      },
      { capacity: '256GB', health: { measured: true, percent: 72 } },
      { capacity: '1TB', health: { measured: true, percent: 45 } },
    ]);
    expect(good.flag).toEqual({ label: '94% Good', tone: 'good' });
    expect(good.note).toBe('life remaining 94% reported by the drive');
    expect(good.sub).toBe('S/N S1');
    expect(caution.flag).toEqual({ label: '72% Caution', tone: 'warn' });
    expect(bad.flag).toEqual({ label: '45% Bad', tone: 'bad' });
  });

  it('a drive the station could not measure says why and what to do', () => {
    const [row] = storageRows([
      {
        capacity: '1TB',
        health: {
          measured: false,
          reason: 'behind a RAID/Intel RST controller',
          action: 'set the storage mode to AHCI in the BIOS, then press Rescan',
        },
      },
    ]);
    expect(row.flag).toEqual({ label: 'Not measurable', tone: 'warn' });
    expect(row.note).toBe(
      'Not measurable — behind a RAID/Intel RST controller — set the storage mode to AHCI in the BIOS, then press Rescan',
    );
  });

  it('an old profile: not scanned yet, and its SMART FAILED verdict still flagged', () => {
    const [ok, failed] = storageRows([
      { capacity: '256GB', smartStatus: 'PASSED', healthPct: 97 },
      { capacity: '1TB', smartStatus: 'FAILED!' },
    ]);
    expect(ok.flag).toBeUndefined();
    expect(ok.note).toBe('Health: Not scanned yet — rescan on the station');
    expect(failed.flag).toEqual({ label: 'SMART FAILED', tone: 'bad' });
    expect(failed.note).toBe('Health: Not scanned yet — rescan on the station');
  });

  it('never "Unknown"', () => {
    const rows = storageRows([
      { smartStatus: 'unknown' },
      { health: { measured: false, reason: 'unknown' } },
    ]);
    for (const r of rows) {
      expect(`${r.flag?.label ?? ''} ${r.note ?? ''}`).not.toMatch(/unknown/i);
    }
  });
});
