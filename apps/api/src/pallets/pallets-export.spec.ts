import * as ExcelJS from 'exceljs';
import { PalletsService } from './pallets.service';

// The export must contain the ITEM LINES, not just pallet totals — and the
// sheet holding them has to be findable. It was once named "Layout 2", after
// the entry mode that built the pallet, and a reader who did not spot the
// second tab reasonably concluded the stock was missing from the file.
//
// Stubbed repositories rather than a database: this is about the shape of the
// workbook, and the shape is what regressed.

const PALLETS: any[] = [
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', palletNumber: 'PALLET-000089', description: '7th Gen Tiny', supplier: 'ALS', buyer: null, location: { name: 'HQ' }, status: 'ready', entryLayout: 'spec', createdAt: new Date('2026-08-18T10:00:00Z') },
  { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', palletNumber: 'PALLET-000095', description: '6th/7th Gen', supplier: 'ALS', buyer: null, location: { name: 'HQ' }, status: 'ready', entryLayout: 'spec', createdAt: new Date('2026-08-20T10:00:00Z') },
];

const mkLines = (palletId: string, n: number, qty: number, source?: string) =>
  Array.from({ length: n }, (_, i) => ({
    id: `${palletId}-${i}`,
    palletId,
    quantity: qty,
    variant: `Item ${i}`,
    unitCost: null,
    sourcePalletId: source ? 'old' : null,
    sourcePalletNumber: source ?? null,
    product: { manufacturer: 'Dell', model: `Model-${i}`, chassis: 'SFF', cpu: 'i5', gen: '7th', ramGb: 8, storage: '512GB' },
  }));

function svcFor(pallets: any[], lines: any[]) {
  const opVal = (op: any) => (op && typeof op === 'object' && !Array.isArray(op) ? (op.value ?? op._value) : op);
  const repo = (rows: any[], key: string) => ({
    find: async (o: any) => {
      const v = opVal(o?.where?.[key]);
      return Array.isArray(v) ? rows.filter((r) => v.includes(r[key])) : rows;
    },
    createQueryBuilder: () => {
      const qb: any = {
        select: () => qb, addSelect: () => qb, where: () => qb, groupBy: () => qb,
        getRawMany: async () => {
          const m = new Map<string, { total: number; lines: number }>();
          for (const l of lines) {
            const e = m.get(l.palletId) ?? { total: 0, lines: 0 };
            e.total += l.quantity; e.lines += 1;
            m.set(l.palletId, e);
          }
          return [...m].map(([palletId, v]) => ({ palletId, total: String(v.total), lines: String(v.lines) }));
        },
      };
      return qb;
    },
  });
  return new PalletsService(
    repo(pallets, 'id') as any,
    repo(lines, 'palletId') as any,
    {} as any, {} as any, {} as any,
    // assets / assetHistory / batches — the line-pallet export paths under
    // test never touch them (withTotals skips its asset query when no pallet
    // is asset-layout), so inert stubs are correct here.
    {} as any, {} as any, {} as any,
    {} as any,
    { record: async () => {} } as any,
  );
}

async function load(buffer: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  return wb;
}

const rowsOf = (ws: ExcelJS.Worksheet) => {
  const out: any[][] = [];
  ws.eachRow((r) => {
    const v = (r.values as any[]).slice(1);
    if (v.some((c) => c != null && c !== '')) out.push(v);
  });
  return out;
};

describe('multi-pallet export', () => {
  const lines = [...mkLines('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 39, 7), ...mkLines('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 20, 14)];

  it('puts the item lines on a sheet called "Items", one row per line', async () => {
    const svc = svcFor(PALLETS, lines);
    const { buffer } = await svc.generateMultiReport(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']);
    const wb = await load(buffer);

    // Items FIRST: the workbook opens on the stock, not on the totals.
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Items', 'Summary']);
    expect(wb.views?.[0]?.activeTab).toBe(0);

    const items = rowsOf(wb.getWorksheet('Items')!);
    const dataRows = items.filter((r) => String(r[0] ?? '').startsWith('PALLET-'));
    // 59 item lines — NOT 2 pallet-summary rows.
    expect(dataRows).toHaveLength(59);
    expect(dataRows.filter((r) => r[0] === 'PALLET-000089')).toHaveLength(39);
    expect(dataRows.filter((r) => r[0] === 'PALLET-000095')).toHaveLength(20);
  });

  it('keeps each line quantity rather than expanding or summing it', async () => {
    const svc = svcFor(PALLETS, lines);
    const wb = await load((await svc.generateMultiReport(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'])).buffer);
    const items = rowsOf(wb.getWorksheet('Items')!);
    const header = items.find((r) => r[0] === 'Pallet number')!;
    const qtyAt = header.indexOf('Quantity');
    const data = items.filter((r) => String(r[0] ?? '').startsWith('PALLET-'));
    expect(data.every((r) => r[qtyAt] === 7 || r[qtyAt] === 14)).toBe(true);
    // 39*7 + 20*14 = 553, and the pallet totals must agree with the lines.
    expect(data.reduce((n, r) => n + Number(r[qtyAt]), 0)).toBe(553);
  });

  it('does not date-format the meta block (Pallets included was rendering as 02/01/1900)', async () => {
    const svc = svcFor(PALLETS, lines);
    const wb = await load((await svc.generateMultiReport(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'])).buffer);
    const summary = wb.getWorksheet('Summary')!;
    const included = rowsOf(summary).find((r) => r[0] === 'Pallets included');
    expect(included?.[1]).toBe(2);
    expect(included?.[1]).not.toBeInstanceOf(Date);
  });

  it('says on the Summary where the item detail lives', async () => {
    const svc = svcFor(PALLETS, lines);
    const wb = await load((await svc.generateMultiReport(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'])).buffer);
    const note = rowsOf(wb.getWorksheet('Summary')!).find((r) => r[0] === 'Item detail');
    expect(String(note?.[1])).toContain('59 item lines');
    expect(String(note?.[1])).toContain('Items');
  });

  it('adds an Original pallet column once lines carry merge provenance', async () => {
    const merged = [
      { ...PALLETS[0], id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', palletNumber: 'PALLET-000201' },
    ];
    const mergedLines = [
      ...mkLines('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 39, 7, 'PALLET-000089'),
      ...mkLines('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 20, 14, 'PALLET-000095'),
    ];
    const svc = svcFor(merged, mergedLines);
    const wb = await load((await svc.generateMultiReport(['dddddddd-dddd-4ddd-8ddd-dddddddddddd'])).buffer);
    const items = rowsOf(wb.getWorksheet('Items')!);
    const header = items.find((r) => r[0] === 'Pallet number')!;
    expect(header[1]).toBe('Original pallet');
    const data = items.filter((r) => r[0] === 'PALLET-000201');
    expect(data).toHaveLength(59);
    expect(data.filter((r) => r[1] === 'PALLET-000089')).toHaveLength(39);
    expect(data.filter((r) => r[1] === 'PALLET-000095')).toHaveLength(20);
  });

  it('names the sheets apart only when the selection mixes layouts', async () => {
    const mixed = [PALLETS[0], { ...PALLETS[1], id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', entryLayout: 'variant' }];
    const mixedLines = [...mkLines('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 3, 5), ...mkLines('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 2, 4)];
    const svc = svcFor(mixed, mixedLines);
    const wb = await load((await svc.generateMultiReport(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'])).buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'Items (Layout 1)',
      'Items (Layout 2)',
      'Summary',
    ]);
  });
});
