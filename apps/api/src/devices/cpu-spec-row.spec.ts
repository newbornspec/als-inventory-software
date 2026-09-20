// The CPU row of the shared component-specification table — the cell the Goods
// In panel and the Audit workspace price stock from, whose whole job is one
// clean line of spec.
//
// The station scrapes cpu.baseClock out of the CPU's own model name (the
// "@ 2.10GHz" lscpu prints), so on every Intel machine the model and the base
// clock are the SAME figure arriving twice. Nothing wrote cpu.baseClock until
// the station started capturing it, so the row silently doubled the clock the
// day that capture shipped. These cases pin the composition with the real
// strings a station produces.
//
// As drive-health-rows.spec does, this imports the web file by relative path:
// the web app has no test runner of its own.
import {
  specRows,
  type HardwareProfileLike,
} from '../../../web/lib/hardware-spec';

const cpuRow = (cpu: HardwareProfileLike['cpu']) =>
  specRows({ cpu }).find((r) => r.component === 'CPU');

describe('the CPU spec row never prints the same clock twice', () => {
  it('an Intel model that already carries its clock is not given a second one', () => {
    const row = cpuRow({
      manufacturer: 'Intel',
      model: 'Intel(R) Core(TM) i3-8145U CPU @ 2.10GHz',
      baseClock: '2.10 GHz',
      maxClock: '3.90 GHz',
      cores: 2,
      threads: 4,
      generation: '8th Gen',
    });
    expect(row?.params).toBe(
      'Intel(R) Core(TM) i3-8145U CPU @ 2.10GHz (3.90 GHz boost, 2c/4t, 8th Gen)',
    );
  });

  it('a model with no frequency of its own still gets the base clock', () => {
    const row = cpuRow({
      manufacturer: 'AMD',
      model: 'AMD Ryzen 5 PRO 4650U with Radeon Graphics',
      baseClock: '2.10 GHz',
      cores: 6,
      threads: 12,
    });
    expect(row?.params).toBe(
      'AMD Ryzen 5 PRO 4650U with Radeon Graphics 2.10 GHz (6c/12t)',
    );
  });

  it('spacing around the @ does not let a duplicate through', () => {
    for (const model of [
      'Intel(R) Xeon(R) CPU E3-1245 v5 @ 3.50GHz',
      'Intel(R) Core(TM) i7-6700 CPU @3.40 GHz',
      'Intel(R) Core(TM) i5-4590 CPU @ 3.30 ghz',
    ]) {
      const row = cpuRow({ model, baseClock: '3.50 GHz' });
      expect(row?.params).toBe(model);
    }
  });

  it('a profile captured before the station read the base clock is unchanged', () => {
    const row = cpuRow({
      manufacturer: 'Intel',
      model: 'Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz',
      maxClock: '3.40 GHz',
      cores: 4,
      threads: 8,
    });
    expect(row?.params).toBe(
      'Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz (3.40 GHz boost, 4c/8t)',
    );
  });
});
