import * as ExcelJS from 'exceljs';
import {
  ASSET_HEADERS,
  PalletAssetRow,
  PalletsService,
} from './pallets.service';

// The pallet device report (and the multi-pallet export's device sheet, which
// uses the same ASSET_HEADERS / assetReportRow) carries Drive health right
// after Battery. This drives the real projection from hardware_profile through
// to the xlsx, so the column cannot be wired to the wrong field.

const DEVICES = [
  {
    id: 'a1',
    tag: 'SN1',
    unitId: 'U-1',
    palletId: 'p1',
    hardwareProfile: {
      battery: { health: '87%' },
      // A finished bench test (C6) with one failed component: the summary reads
      // "Failed:" and names it, exactly as the asset-page card does.
      hardwareTest: {
        status: 'FAILED',
        speaker: { status: 'PASSED', left: 'PASSED', right: 'PASSED' },
        keyboard: { status: 'FAILED', deviceType: 'Laptop – Standard' },
        camera: { status: 'PASSED', device: 'HD Webcam' },
        screen: { status: 'PASSED', deadPixels: 0 },
        trackpad: { status: 'PASSED', notApplicable: true },
      },
      storage: [
        {
          capacity: '512GB',
          type: 'NVMe',
          health: { measured: true, percent: 94 },
        },
        {
          capacity: '1TB',
          type: 'HDD',
          health: { measured: true, percent: 72 },
        },
      ],
    },
  },
  {
    id: 'a2',
    tag: 'SN2',
    unitId: 'U-2',
    palletId: 'p1',
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
    id: 'a3',
    tag: 'SN3',
    unitId: 'U-3',
    palletId: 'p1',
    hardwareProfile: null,
  },
];

function service() {
  const qb = {
    leftJoinAndSelect: () => qb,
    addSelect: () => qb,
    where: () => qb,
    orderBy: () => qb,
    getMany: () => Promise.resolve(DEVICES),
  };
  const svc = new PalletsService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { createQueryBuilder: () => qb } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return svc as unknown as {
    assetRowsByPallet(ids: string[]): Promise<Map<string, PalletAssetRow[]>>;
    generateAssetReport(p: unknown): Promise<{ buffer: Buffer }>;
  };
}

describe('pallet device report: Drive health column', () => {
  it('projects each device to its one-cell drive health summary', async () => {
    const rows = (await service().assetRowsByPallet(['p1'])).get('p1')!;
    expect(rows.map((r) => r.driveHealth)).toEqual([
      '2 drives: 72% Caution, 94% Good',
      'Not scanned yet — rescan on the station',
      null,
    ]);
    expect(rows[0].batteryHealth).toBe('87%');
    // The C6 bench test rides through the same projection, worded like the card;
    // devices without a test on record project to null (a blank cell).
    expect(rows.map((r) => r.hardwareTest)).toEqual([
      'Failed: keyboard',
      null,
      null,
    ]);
  });

  it('writes it beside Battery in the xlsx', async () => {
    const svc = service();
    const assets = (await svc.assetRowsByPallet(['p1'])).get('p1')!;
    const { buffer } = await svc.generateAssetReport({
      id: 'p1',
      palletNumber: 'PALLET-000001',
      status: 'open',
      totalQuantity: assets.length,
      assets,
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as never);
    const ws = wb.getWorksheet('Pallet Report')!;
    let headerRow = 0;
    ws.eachRow((r, i) => {
      if (r.getCell(1).value === 'Pallet number') headerRow = i;
    });
    const col = ASSET_HEADERS.indexOf('Drive health') + 1;
    expect(ws.getRow(headerRow).getCell(col).value).toBe('Drive health');
    expect(ws.getRow(headerRow).getCell(col - 1).value).toBe('Battery');
    expect(ws.getColumn(col).width).toBeGreaterThanOrEqual(28);
    expect(ws.getRow(headerRow + 1).getCell(col).value).toBe(
      '2 drives: 72% Caution, 94% Good',
    );
    expect(ws.getRow(headerRow + 2).getCell(col).value).toBe(
      'Not scanned yet — rescan on the station',
    );

    // Hardware test sits in the very next column, carrying the bench-test verdict.
    const hw = ASSET_HEADERS.indexOf('Hardware test') + 1;
    expect(hw).toBe(col + 1);
    expect(ws.getRow(headerRow).getCell(hw).value).toBe('Hardware test');
    expect(ws.getRow(headerRow + 1).getCell(hw).value).toBe('Failed: keyboard');
  });
});
