import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { ReportsService, type ReportFilters } from './reports.service';
import type { RequestUser } from '../common/ownership';

// Turns the live report data (respecting the same date range + dimension
// filters as the dashboard) into downloadable workbooks/PDFs. It only reads
// the ReportsService methods, so exports never drift from the on-screen numbers.
@Injectable()
export class ReportsExportService {
  constructor(private reports: ReportsService) {}

  private filterSummary(from?: Date, to?: Date, filters: ReportFilters = {}): string[] {
    const parts: string[] = [];
    parts.push(`Date range: ${from ? from.toLocaleDateString('en-GB') : 'all time'}${to ? ' – ' + to.toLocaleDateString('en-GB') : ''}`);
    const dims = Object.entries(filters).filter(([, v]) => v);
    parts.push(dims.length ? `Filters: ${dims.map(([k, v]) => `${k}=${v}`).join(', ')}` : 'Filters: none');
    parts.push(`Generated: ${new Date().toLocaleString('en-GB')}`);
    return parts;
  }

  async dashboardXlsx(
    from?: Date,
    to?: Date,
    filters: ReportFilters = {},
    user?: RequestUser,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const [overview, sales, batches, suppliers, warehouse, consumables, users, pallets] =
      await Promise.all([
        this.reports.getOverview(from, to, user, filters),
        this.reports.getSalesAnalytics(from, to, user, filters),
        this.reports.getBatchAnalytics(from, to, user, filters),
        this.reports.getSupplierPerformance(from, to, user, filters),
        this.reports.getWarehouseThroughput(from, to, user),
        this.reports.getConsumablesReport(from, to),
        this.reports.getUserPerformance(from, to, user),
        this.reports.getPalletAnalytics(from, to),
      ]);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'ALS Trade Wholesales';

    const header = (ws: ExcelJS.Worksheet, cols: number, title: string) => {
      ws.mergeCells(1, 1, 1, cols);
      const c = ws.getCell(1, 1);
      c.value = title;
      c.font = { size: 14, bold: true };
      let r = 2;
      for (const line of this.filterSummary(from, to, filters)) {
        ws.getCell(r, 1).value = line;
        ws.getCell(r, 1).font = { size: 9, color: { argb: 'FF808080' } };
        r += 1;
      }
      return r + 1; // first free row
    };
    const tableHead = (ws: ExcelJS.Worksheet, row: number, labels: string[]) => {
      const hr = ws.getRow(row);
      hr.values = labels;
      hr.font = { bold: true };
      hr.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
        cell.border = { bottom: { style: 'thin' } };
      });
    };

    // --- Summary ---
    const s = wb.addWorksheet('Summary');
    s.columns = [{ width: 26 }, { width: 18 }];
    let r = header(s, 2, 'ALS Trade — Reports Summary');
    const k = overview.kpis;
    const kpis: [string, string | number][] = [
      ['Total devices', k.totalAssets],
      ['Active devices', k.activeAssets],
      ['In stock', k.inStock],
      ['Awaiting audit', k.awaitingAudit],
      ['Ready for sale', k.readyForSale],
      ['Units sold (range)', k.soldUnits],
      ['Lots', k.lots],
      ['Sub-lots', k.subLots],
      ['Active pallets', k.activePallets],
      ['Pallet units', k.palletUnits],
      ['Consumable items', k.consumableItems],
      ['Consumable units', k.consumableUnits],
      ['Warehouse value (£)', k.warehouseValue],
      ['Revenue (£)', k.revenue],
      ['Cost of sold (£)', k.costOfSold],
      ['Profit (£)', k.profit],
      ['Margin (%)', k.marginPct ?? '—'],
      ['Users', k.users],
    ];
    for (const [label, value] of kpis) {
      s.getCell(r, 1).value = label;
      s.getCell(r, 1).font = { bold: true };
      s.getCell(r, 2).value = value;
      r += 1;
    }

    // --- Inventory ---
    const inv = wb.addWorksheet('Inventory');
    inv.columns = [{ width: 24 }, { width: 12 }, { width: 12 }, { width: 12 }];
    r = header(inv, 4, 'Inventory (active)');
    const block = (title: string, rows: { label: string; count: number }[], extra?: (row: any) => (string | number)[]) => {
      inv.getCell(r, 1).value = title;
      inv.getCell(r, 1).font = { bold: true };
      r += 1;
      for (const row of rows) {
        inv.getCell(r, 1).value = row.label;
        inv.getCell(r, 2).value = row.count;
        if (extra) extra(row).forEach((v, i) => (inv.getCell(r, 3 + i).value = v));
        r += 1;
      }
      r += 1;
    };
    block('By category', overview.byCategory);
    inv.getCell(r, 1).value = 'By manufacturer';
    inv.getCell(r, 1).font = { bold: true };
    r += 1;
    tableHead(inv, r, ['Manufacturer', 'Units', 'Share %', 'Avg grade']);
    r += 1;
    for (const m of overview.byManufacturer) {
      inv.getCell(r, 1).value = m.label;
      inv.getCell(r, 2).value = m.count;
      inv.getCell(r, 3).value = m.pct;
      inv.getCell(r, 4).value = m.avgGrade ?? '—';
      r += 1;
    }
    r += 1;
    block('By grade', overview.byGrade);
    block('By audit status', overview.byAuditStatus);

    // --- Sales ---
    const sa = wb.addWorksheet('Sales');
    sa.columns = [{ width: 24 }, { width: 14 }, { width: 14 }];
    r = header(sa, 3, 'Sales & finance');
    const ss = sales.summary;
    for (const [label, value] of [
      ['Units sold', ss.soldUnits], ['Revenue (£)', ss.revenue], ['Cost (£)', ss.cost],
      ['Profit (£)', ss.profit], ['Margin (%)', ss.marginPct ?? '—'],
      ['Avg sell price (£)', ss.avgSellPrice ?? '—'], ['Sold today', ss.soldToday], ['Sold this month', ss.soldThisMonth],
    ] as [string, string | number][]) {
      sa.getCell(r, 1).value = label;
      sa.getCell(r, 1).font = { bold: true };
      sa.getCell(r, 2).value = value;
      r += 1;
    }
    r += 1;
    sa.getCell(r, 1).value = 'Monthly (revenue / profit / units)';
    sa.getCell(r, 1).font = { bold: true };
    r += 1;
    tableHead(sa, r, ['Month', 'Revenue', 'Profit', 'Units']);
    r += 1;
    for (const m of sales.monthly) {
      sa.getCell(r, 1).value = m.month;
      sa.getCell(r, 2).value = m.revenue;
      sa.getCell(r, 3).value = m.profit;
      sa.getCell(r, 4).value = m.units;
      r += 1;
    }

    // --- Batches ---
    const ba = wb.addWorksheet('Batches');
    ba.columns = [{ width: 16 }, { width: 20 }, { width: 12 }, { width: 8 }, { width: 8 }, { width: 8 }, { width: 12 }, { width: 12 }, { width: 12 }];
    r = header(ba, 9, 'Batch performance');
    tableHead(ba, r, ['Lot', 'Supplier', 'Status', 'Sub-lots', 'Assets', 'Sold', 'Cost', 'Revenue', 'Profit']);
    r += 1;
    for (const b of batches) {
      ba.getCell(r, 1).value = b.batchNumber;
      ba.getCell(r, 2).value = b.source ?? '';
      ba.getCell(r, 3).value = b.status;
      ba.getCell(r, 4).value = b.totalSubLots;
      ba.getCell(r, 5).value = b.totalAssets;
      ba.getCell(r, 6).value = b.unitsSold;
      ba.getCell(r, 7).value = b.totalCost ?? '';
      ba.getCell(r, 8).value = b.revenue;
      ba.getCell(r, 9).value = b.profit;
      r += 1;
    }

    // --- Suppliers ---
    const su = wb.addWorksheet('Suppliers');
    su.columns = [{ width: 24 }, { width: 8 }, { width: 8 }, { width: 10 }, { width: 8 }, { width: 12 }, { width: 12 }, { width: 12 }];
    r = header(su, 8, 'Supplier performance');
    tableHead(su, r, ['Supplier', 'Lots', 'Assets', 'Avg grade', 'Sold', 'Revenue', 'Profit', 'Return %']);
    r += 1;
    for (const sp of suppliers) {
      su.getCell(r, 1).value = sp.label;
      su.getCell(r, 2).value = sp.batches;
      su.getCell(r, 3).value = sp.assets;
      su.getCell(r, 4).value = sp.avgGrade ?? '—';
      su.getCell(r, 5).value = sp.unitsSold;
      su.getCell(r, 6).value = sp.revenue;
      su.getCell(r, 7).value = sp.profit;
      su.getCell(r, 8).value = sp.returnRate ?? '—';
      r += 1;
    }

    // --- Warehouse ---
    const wh = wb.addWorksheet('Warehouse');
    wh.columns = [{ width: 24 }, { width: 14 }];
    r = header(wh, 2, 'Warehouse operations');
    for (const [label, value] of [
      ['Received', warehouse.metrics.received], ['Scanned', warehouse.metrics.scanned],
      ['Audited', warehouse.metrics.audited], ['Shipped', warehouse.metrics.shipped],
      ['Sold', warehouse.metrics.sold], ['Returned', warehouse.metrics.returned],
      ['Processed assets', warehouse.processedAssets],
      ['Avg processing (days)', warehouse.avgProcessingDays ?? '—'],
    ] as [string, string | number][]) {
      wh.getCell(r, 1).value = label;
      wh.getCell(r, 1).font = { bold: true };
      wh.getCell(r, 2).value = value;
      r += 1;
    }

    // --- Consumables ---
    const co = wb.addWorksheet('Consumables');
    co.columns = [{ width: 24 }, { width: 14 }];
    r = header(co, 2, 'Consumables');
    const cs = consumables.summary;
    for (const [label, value] of [
      ['Items', cs.items], ['Units on hand', cs.unitsOnHand], ['Used (range)', cs.usedInRange],
      ['Used this month', cs.usedThisMonth], ['Avg monthly usage', cs.avgMonthlyUsage],
      ['Low stock', cs.lowStock], ['Out of stock', cs.outOfStock],
    ] as [string, string | number][]) {
      co.getCell(r, 1).value = label;
      co.getCell(r, 1).font = { bold: true };
      co.getCell(r, 2).value = value;
      r += 1;
    }

    // --- Users ---
    const us = wb.addWorksheet('Users');
    us.columns = [{ width: 22 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 10 }, { width: 10 }, { width: 12 }, { width: 20 }];
    r = header(us, 8, 'User performance');
    tableHead(us, r, ['User', 'Role', 'Lots', 'Added', 'Audited', 'Sold', 'Returned', 'Last activity']);
    r += 1;
    for (const u of users) {
      us.getCell(r, 1).value = u.name;
      us.getCell(r, 2).value = u.role;
      us.getCell(r, 3).value = u.batchesCreated;
      us.getCell(r, 4).value = u.assetsAdded;
      us.getCell(r, 5).value = u.assetsAudited;
      us.getCell(r, 6).value = u.itemsSold;
      us.getCell(r, 7).value = u.itemsReturned;
      us.getCell(r, 8).value = u.lastActivity ? new Date(u.lastActivity).toLocaleString('en-GB') : '—';
      r += 1;
    }

    // --- Pallets ---
    const pa = wb.addWorksheet('Pallets');
    pa.columns = [{ width: 16 }, { width: 20 }, { width: 10 }, { width: 8 }, { width: 8 }, { width: 8 }, { width: 12 }, { width: 16 }];
    r = header(pa, 8, 'Pallet analytics');
    tableHead(pa, r, ['Pallet', 'Description', 'Status', 'Variants', 'Units', 'Sold', 'Revenue', 'Location']);
    r += 1;
    for (const p of pallets.pallets) {
      pa.getCell(r, 1).value = p.palletNumber;
      pa.getCell(r, 2).value = p.description ?? '';
      pa.getCell(r, 3).value = p.status;
      pa.getCell(r, 4).value = p.variants;
      pa.getCell(r, 5).value = p.unitsOnPallet;
      pa.getCell(r, 6).value = p.unitsSold;
      pa.getCell(r, 7).value = p.revenue;
      pa.getCell(r, 8).value = p.location ?? '';
      r += 1;
    }

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return { buffer, filename: `als-reports-${new Date().toISOString().slice(0, 10)}.xlsx` };
  }

  async dashboardPdf(
    from?: Date,
    to?: Date,
    filters: ReportFilters = {},
    user?: RequestUser,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const [overview, sales, suppliers] = await Promise.all([
      this.reports.getOverview(from, to, user, filters),
      this.reports.getSalesAnalytics(from, to, user, filters),
      this.reports.getSupplierPerformance(from, to, user, filters),
    ]);

    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c as Buffer));
    const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

    doc.fontSize(18).font('Helvetica-Bold').text('ALS Trade — Reports Summary');
    doc.moveDown(0.3);
    doc.fontSize(9).font('Helvetica').fillColor('#666');
    for (const line of this.filterSummary(from, to, filters)) doc.text(line);
    doc.fillColor('#000').moveDown(0.8);

    // KPI grid (3 columns).
    const k = overview.kpis;
    const money = (n: number) => `£${n.toLocaleString('en-GB')}`;
    const kpis: [string, string][] = [
      ['Total devices', String(k.totalAssets)],
      ['In stock', String(k.inStock)],
      ['Ready for sale', String(k.readyForSale)],
      ['Units sold', String(k.soldUnits)],
      ['Revenue', money(k.revenue)],
      ['Profit', money(k.profit)],
      ['Margin', k.marginPct == null ? '—' : `${k.marginPct.toFixed(1)}%`],
      ['Warehouse value', money(k.warehouseValue)],
      ['Lots', String(k.lots)],
      ['Active pallets', String(k.activePallets)],
      ['Consumables', String(k.consumableUnits)],
      ['Users', String(k.users)],
    ];
    const colW = (doc.page.width - 80) / 3;
    let startY = doc.y;
    kpis.forEach((kpi, i) => {
      const col = i % 3;
      const rowN = Math.floor(i / 3);
      const x = 40 + col * colW;
      const y = startY + rowN * 46;
      doc.rect(x, y, colW - 8, 40).fill('#f4f4f4');
      doc.fillColor('#888').fontSize(8).font('Helvetica').text(kpi[0].toUpperCase(), x + 8, y + 6, { width: colW - 24 });
      doc.fillColor('#111').fontSize(15).font('Helvetica-Bold').text(kpi[1], x + 8, y + 17, { width: colW - 24 });
    });
    doc.y = startY + Math.ceil(kpis.length / 3) * 46 + 12;
    doc.fillColor('#000');

    // Top manufacturers (sales).
    const section = (title: string) => {
      doc.moveDown(0.5).fontSize(12).font('Helvetica-Bold').fillColor('#000').text(title).moveDown(0.2);
      doc.fontSize(9).font('Helvetica');
    };
    section('Top selling manufacturers');
    if (sales.topManufacturers.length === 0) doc.fillColor('#888').text('No sales in range.').fillColor('#000');
    for (const m of sales.topManufacturers.slice(0, 6)) {
      doc.text(`${m.label} — ${m.units} units, ${money(m.revenue)}`);
    }

    section('Supplier performance');
    if (suppliers.length === 0) doc.fillColor('#888').text('No suppliers.').fillColor('#000');
    for (const s of suppliers.slice(0, 8)) {
      const rr = s.returnRate == null ? '' : `, return ${s.returnRate.toFixed(0)}%`;
      doc.text(`${s.label} — ${s.assets} assets, grade ${s.avgGrade ?? '—'}, ${money(s.revenue)} rev / ${money(s.profit)} profit${rr}`);
    }

    doc.end();
    const buffer = await done;
    return { buffer, filename: `als-reports-${new Date().toISOString().slice(0, 10)}.pdf` };
  }
}
