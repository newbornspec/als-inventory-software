import * as ExcelJS from 'exceljs';
import { BatchesService } from './batches.service';

// The owner asked for each drive's health percentage "in the system report",
// next to battery health. The Lot report is the export whose column is
// literally called "Battery health"; Drive health must sit right after it and
// carry the one-cell summary from devices/drive-health.ts.

const drive = (percent: number) => ({
  capacity: '512GB',
  type: 'NVMe',
  health: { measured: true, percent, status: 'good' },
});

const ASSETS = [
  {
    tag: 'A1',
    unitId: 'U-1',
    hardwareProfile: {
      battery: { health: '87%' },
      storage: [
        drive(94),
        {
          capacity: '1TB',
          type: 'HDD',
          health: { measured: true, percent: 45 },
        },
      ],
    },
  },
  {
    tag: 'A2',
    unitId: 'U-2',
    // Captured before drive health existed: legacy fields only.
    hardwareProfile: {
      storage: [
        {
          capacity: '256GB',
          type: 'SSD',
          smartStatus: 'PASSED',
          healthPct: 97,
        },
      ],
    },
  },
  {
    tag: 'A3',
    unitId: 'U-3',
    hardwareProfile: {
      storage: [
        {
          capacity: '1TB',
          type: 'HDD',
          health: {
            measured: false,
            reason: 'behind a RAID/Intel RST controller',
            action:
              'set the storage mode to AHCI in the BIOS, then press Rescan',
          },
        },
      ],
    },
  },
  // Hand-entered, no profile at all.
  { tag: 'A4', unitId: 'U-4', hardwareProfile: null },
];

async function report() {
  const qb = {
    leftJoinAndSelect: () => qb,
    addSelect: () => qb,
    where: () => qb,
    orderBy: () => qb,
    addOrderBy: () => qb,
    getMany: () => Promise.resolve(ASSETS),
  };
  const svc = new BatchesService(
    {} as never,
    { createQueryBuilder: () => qb } as never,
    {} as never,
  );
  jest.spyOn(svc, 'findOne').mockResolvedValue({
    id: 'b1',
    batchNumber: 'LOT-1',
    actualUnitCount: 4,
  } as never);
  const { buffer } = await svc.generateReport('b1');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as never);
  const ws = wb.getWorksheet('Lot Report')!;
  let headerRow = 0;
  ws.eachRow((r, i) => {
    if (r.getCell(1).value === 'Unit ID') headerRow = i;
  });
  const headers = (ws.getRow(headerRow).values as unknown[]).slice(1);
  const col = (name: string) => headers.indexOf(name) + 1;
  const cell = (row: number, name: string) =>
    ws.getRow(headerRow + row).getCell(col(name)).value;
  return { ws, headers, col, cell };
}

describe('Lot report: Drive health column', () => {
  it('sits right after Battery health, with room for a two-drive summary', async () => {
    const { ws, headers, col } = await report();
    expect(headers).toContain('Drive health');
    expect(col('Drive health')).toBe(col('Battery health') + 1);
    expect(ws.getColumn(col('Drive health')).width).toBeGreaterThanOrEqual(28);
    // Unit cost stays the last column: the total row writes into it.
    expect(headers[headers.length - 1]).toBe('Unit cost (£)');
  });

  it('carries the measured percentages, worst first, and never "Unknown"', async () => {
    const { cell, ws } = await report();
    expect(cell(1, 'Battery health')).toBe('87%');
    expect(cell(1, 'Drive health')).toBe('2 drives: 45% Bad, 94% Good');
    // The old profile's healthPct (97) is not presented as the new percentage.
    expect(cell(2, 'Drive health')).toBe(
      'Not scanned yet — rescan on the station',
    );
    expect(cell(3, 'Drive health')).toBe(
      'Not measurable — behind a RAID/Intel RST controller — set the storage mode to AHCI in the BIOS, then press Rescan',
    );
    // No drives on record: blank, like a missing battery.
    expect(cell(4, 'Drive health') ?? '').toBe('');
    ws.eachRow((r) => {
      for (const v of (r.values as unknown[]).slice(1)) {
        if (typeof v === 'string') expect(v).not.toMatch(/unknown/i);
      }
    });
  });
});
