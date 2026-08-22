import { Controller, Get, Header, Param, Query, Req, StreamableFile, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/guards/permissions.decorator';
import { ReportsService, type ReportFilters } from './reports.service';
import { ReportsExportService } from './reports-export.service';

function parseDate(s?: string): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d;
}
function buildFilters(q: Record<string, string>): ReportFilters {
  const clean = (v?: string) => (v && v.trim() ? v.trim() : undefined);
  return {
    batchId: clean(q.batchId),
    supplier: clean(q.supplier),
    manufacturer: clean(q.manufacturer),
    category: clean(q.category),
    grade: clean(q.grade),
  };
}

@Controller()
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ReportsController {
  constructor(
    private reports: ReportsService,
    private exports: ReportsExportService,
  ) {}

  @RequirePermissions('reports')
  @Get('reports/filter-options')
  getFilterOptions(@Req() req: any) {
    return this.reports.getFilterOptions(req.user);
  }

  // Full dashboard as a multi-sheet workbook, respecting date range + filters.
  @RequirePermissions('reports')
  @Get('reports/export.xlsx')
  async exportXlsx(@Query() q: Record<string, string>, @Req() req: any): Promise<StreamableFile> {
    const { buffer, filename } = await this.exports.dashboardXlsx(
      parseDate(q.from), parseDate(q.to), buildFilters(q), req.user,
    );
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  // Executive summary as a PDF, respecting date range + filters.
  @RequirePermissions('reports')
  @Get('reports/export.pdf')
  async exportPdf(@Query() q: Record<string, string>, @Req() req: any): Promise<StreamableFile> {
    const { buffer, filename } = await this.exports.dashboardPdf(
      parseDate(q.from), parseDate(q.to), buildFilters(q), req.user,
    );
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  // Alerts require the reports permission, like the rest of this controller.
  @RequirePermissions('reports')
  @Get('notifications')
  getNotifications(@Req() req: any) {
    return this.reports.getNotifications(req.user);
  }

  @RequirePermissions('reports')
  @Get('reports/assets.csv')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="assets.csv"')
  async exportAssetsCsv(@Req() req: any) {
    return this.reports.exportAssetsCsv(req.user);
  }

  @RequirePermissions('reports')
  @Get('reports/dashboard')
  getDashboard(@Req() req: any) {
    return this.reports.getDashboard(req.user);
  }

  // The Reports page roll-up. from/to (ISO dates) bound the sales metrics;
  // invalid or missing dates mean "all time".
  @RequirePermissions('reports')
  @Get('reports/overview')
  getOverview(@Query() q: Record<string, string>, @Req() req: any) {
    return this.reports.getOverview(parseDate(q.from), parseDate(q.to), req.user, buildFilters(q));
  }

  // Sales & finance analytics. from/to bound the summary + top-lists; the
  // monthly trend is a fixed rolling 12 months.
  @RequirePermissions('reports')
  @Get('reports/sales')
  getSales(@Query() q: Record<string, string>, @Req() req: any) {
    return this.reports.getSalesAnalytics(parseDate(q.from), parseDate(q.to), req.user, buildFilters(q));
  }

  // Batch → sub-lot performance for the drill-down. from/to bound revenue/profit.
  @RequirePermissions('reports')
  @Get('reports/batches')
  getBatchAnalytics(@Query() q: Record<string, string>, @Req() req: any) {
    return this.reports.getBatchAnalytics(parseDate(q.from), parseDate(q.to), req.user, buildFilters(q));
  }

  // Warehouse operations throughput (received/audited/shipped/sold/returned,
  // avg processing time, daily pulse). from/to bound the window.
  @RequirePermissions('reports')
  @Get('reports/warehouse')
  getWarehouse(@Query('from') from: string, @Query('to') to: string, @Req() req: any) {
    const parse = (s?: string) => {
      if (!s) return undefined;
      const d = new Date(s);
      return isNaN(d.getTime()) ? undefined : d;
    };
    return this.reports.getWarehouseThroughput(parse(from), parse(to), req.user);
  }

  // Per-user performance for the manager comparison. from/to bound the counts.
  @RequirePermissions('reports')
  @Get('reports/users')
  getUserPerformance(@Query('from') from: string, @Query('to') to: string, @Req() req: any) {
    const parse = (s?: string) => {
      if (!s) return undefined;
      const d = new Date(s);
      return isNaN(d.getTime()) ? undefined : d;
    };
    return this.reports.getUserPerformance(parse(from), parse(to), req.user);
  }

  // Consumables (bulk stock) analytics. Global — consumables aren't lot-scoped.
  @RequirePermissions('reports')
  @Get('reports/consumables')
  getConsumables(@Query('from') from: string, @Query('to') to: string) {
    const parse = (s?: string) => {
      if (!s) return undefined;
      const d = new Date(s);
      return isNaN(d.getTime()) ? undefined : d;
    };
    return this.reports.getConsumablesReport(parse(from), parse(to));
  }

  // Pallet analytics. Global — pallets aren't lot-scoped.
  @RequirePermissions('reports')
  @Get('reports/pallets')
  getPallets(@Query('from') from: string, @Query('to') to: string) {
    const parse = (s?: string) => {
      if (!s) return undefined;
      const d = new Date(s);
      return isNaN(d.getTime()) ? undefined : d;
    };
    return this.reports.getPalletAnalytics(parse(from), parse(to));
  }

  // Supplier performance (device inventory attributed via batch.source).
  @RequirePermissions('reports')
  @Get('reports/suppliers')
  getSuppliers(@Query() q: Record<string, string>, @Req() req: any) {
    return this.reports.getSupplierPerformance(parseDate(q.from), parseDate(q.to), req.user, buildFilters(q));
  }

  @RequirePermissions('reports')
  @Get('reports/profit')
  getLotProfitability(@Req() req: any) {
    return this.reports.getLotProfitability(req.user);
  }

  @RequirePermissions('reports')
  @Get('reports/assets/:id/costing')
  getAssetCosting(@Param('id') id: string, @Req() req: any) {
    return this.reports.getAssetCosting(id, req.user);
  }

  @RequirePermissions('reports')
  @Get('reports/profit.csv')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="lot-profit.csv"')
  async exportProfitCsv(@Req() req: any) {
    return this.reports.exportProfitCsv(req.user);
  }
}
