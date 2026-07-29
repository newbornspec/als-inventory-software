import { normaliseHardwareProfile } from './normalise-profile';
import { HardwareProfile } from './hardware-profile.type';

describe('normaliseHardwareProfile', () => {
  it('standardises RAM and keeps the raw reading for diagnostics', () => {
    const out = normaliseHardwareProfile(
      { memory: { totalGb: 15, type: 'DDR4', speed: '2400 MT/s' } },
      'Desktop',
    );
    expect(out!.memory).toEqual({
      totalGb: 16,
      detectedGb: 15,
      type: 'DDR4',
      speed: '2400 MT/s',
    });
  });

  it('does not add detectedGb when the reading was already standard', () => {
    const out = normaliseHardwareProfile({ memory: { totalGb: 16, type: 'DDR3' } }, 'Desktop');
    expect(out!.memory).toEqual({ totalGb: 16, type: 'DDR3' });
    expect(out!.memory).not.toHaveProperty('detectedGb');
  });

  it('keeps memory type and speed — only the export drops them', () => {
    const out = normaliseHardwareProfile(
      { memory: { totalGb: 7, type: 'DDR4', speed: '3200 MT/s' } },
      'Desktop',
    );
    expect(out!.memory!.type).toBe('DDR4');
    expect(out!.memory!.speed).toBe('3200 MT/s');
    expect(out!.memory!.totalGb).toBe(8);
  });

  it('normalises the screen size on a laptop', () => {
    const out = normaliseHardwareProfile(
      { display: { size: '13.3', resolution: '1366x768' } },
      'Laptop',
    );
    expect(out!.display).toEqual({ size: '13.3"', resolution: '1366x768' });
  });

  it('drops the screen size on a desktop but keeps the resolution', () => {
    const out = normaliseHardwareProfile(
      { display: { size: '24"', resolution: '1920x1080' } },
      'Desktop',
    );
    expect(out!.display).toEqual({ resolution: '1920x1080' });
  });

  it('removes the display section entirely when size was all it held', () => {
    const out = normaliseHardwareProfile({ display: { size: '24"' } }, 'Desktop');
    expect(out).not.toHaveProperty('display');
  });

  it('falls back to the deviceType inside the profile when none is passed', () => {
    const out = normaliseHardwareProfile(
      { identification: { deviceType: 'Laptop' }, display: { size: '14' } },
      null,
    );
    expect(out!.display!.size).toBe('14"');
  });

  it('keeps a size when the chassis type is unknown rather than deleting it', () => {
    const out = normaliseHardwareProfile({ display: { size: '14"' } }, null);
    expect(out!.display!.size).toBe('14"');
  });

  it('never mutates the profile it was given — the same object is written twice', () => {
    const input: HardwareProfile = {
      memory: { totalGb: 15 },
      display: { size: '24"' },
      identification: { deviceType: 'Desktop' },
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    normaliseHardwareProfile(input, 'Desktop');
    expect(input).toEqual(snapshot);
  });

  it('passes unknown sections through untouched', () => {
    const out = normaliseHardwareProfile(
      { storage: [{ capacity: '512GB', type: 'NVMe' }], somethingNew: { a: 1 } } as HardwareProfile,
      'Laptop',
    );
    expect(out!.storage).toEqual([{ capacity: '512GB', type: 'NVMe' }]);
    expect((out as any).somethingNew).toEqual({ a: 1 });
  });

  it('handles a null profile', () => {
    expect(normaliseHardwareProfile(null, 'Laptop')).toBeNull();
  });
});
