import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Put,
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/guards/permissions.decorator';
import { PalletsService } from './pallets.service';
import { CreatePalletDto } from './dto/create-pallet.dto';
import { CreatePalletSpecDto } from './dto/create-pallet-spec.dto';
import { UpdatePalletDto } from './dto/update-pallet.dto';
import { CreatePalletLineDto } from './dto/create-pallet-line.dto';
import { UpdatePalletLineDto } from './dto/update-pallet-line.dto';
import { ExportPalletsDto } from './dto/export-pallets.dto';
import { MergePalletsDto } from './dto/merge-pallets.dto';

@Controller('pallets')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PalletsController {
  constructor(private pallets: PalletsService) {}

  @RequirePermissions('pallets')
  @Get()
  findAll() {
    return this.pallets.findAll();
  }

  // Declared before ':id' so 'sold' isn't captured as a pallet id. The Sold
  // archive for pallet goods (unreturned sold quantities).
  @RequirePermissions('pallets', 'sold')
  @Get('sold')
  findSoldLines() {
    return this.pallets.findSoldLines();
  }

  // Declared before ':id' for the same reason as 'sold' above. The suggested
  // number for a new pallet — the operator can overwrite it. Needs the pallets
  // module permission like the rest of the page.
  @RequirePermissions('pallets')
  @Get('next-number')
  async nextNumber(): Promise<{ palletNumber: string }> {
    return { palletNumber: await this.pallets.nextPalletNumber() };
  }

  // Declared before ':id' like the two above. A POST because the selection
  // travels in the body, not the URL — see ExportPalletsDto. Same export
  // permission as the per-pallet report below: this carries the same purchase costs.
  @RequirePermissions('export')
  @Post('export.xlsx')
  @Header('Cache-Control', 'no-store')
  async exportMany(@Body() dto: ExportPalletsDto): Promise<StreamableFile> {
    const { buffer, filename } = await this.pallets.generateMultiReport(
      dto.ids,
    );
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  // Both declared before the ':id' routes, like 'sold' and 'next-number'.
  //
  // Its own merge_pallets permission: merging retires pallets and creates a
  // replacement, which is far closer to deleting a pallet than to editing a
  // line. Correcting what is on a pallet does not grant retiring one.
  @RequirePermissions('merge_pallets')
  @Post('merge/preview')
  mergePreview(@Body() dto: MergePalletsDto) {
    return this.pallets.previewMerge(dto.palletIds);
  }

  @RequirePermissions('merge_pallets')
  @Post('merge')
  merge(
    @Body() dto: MergePalletsDto,
    @Req() req: { user?: { userId?: string } },
  ) {
    return this.pallets.mergePallets(dto, req.user?.userId ?? null);
  }

  @RequirePermissions('pallets')
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.pallets.findOne(id);
  }

  @RequirePermissions('export')
  @Get(':id/report.xlsx')
  async report(@Param('id') id: string): Promise<StreamableFile> {
    const { buffer, filename } = await this.pallets.generateReport(id);
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  @RequirePermissions('pallets')
  @Post()
  create(@Body() dto: CreatePalletDto) {
    return this.pallets.create(dto);
  }

  // Layout 2 (spec table): create a pallet — empty body creates an empty grid
  // pallet (number generated immediately), rows fill it at creation if given.
  @RequirePermissions('pallets')
  @Post('spec')
  createFromSpec(@Body() dto: CreatePalletSpecDto) {
    return this.pallets.createFromSpec(dto);
  }

  // Layout 2 editor: one save replaces the pallet's metadata + all spec rows.
  @RequirePermissions('pallets')
  @Put(':id/spec')
  replaceSpec(@Param('id') id: string, @Body() dto: CreatePalletSpecDto) {
    return this.pallets.replaceSpec(id, dto);
  }

  @RequirePermissions('pallets')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdatePalletDto) {
    return this.pallets.update(id, dto);
  }

  @RequirePermissions('delete_pallet')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.pallets.remove(id);
  }

  // --- Sold workflow ---

  // Selling is normal warehouse work — gated by the sell_items permission.
  @RequirePermissions('sell_items')
  @Post(':id/sell')
  sellPallet(
    @Param('id') id: string,
    @Body() body: { saleTotal?: number },
    @Req() req: any,
  ) {
    return this.pallets.sellPallet(id, req.user.userId, body?.saleTotal);
  }

  @RequirePermissions('sell_items')
  @Post(':id/lines/:lineId/sell')
  sellLine(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() body: { quantity?: number; salePrice?: number },
    @Req() req: any,
  ) {
    return this.pallets.sellLine(
      id,
      lineId,
      body?.quantity,
      req.user.userId,
      body?.salePrice,
    );
  }

  // Bulk return from the Sold page — needs return_sold. No palletId -> each row
  // returns to its own original pallet.
  @RequirePermissions('return_sold')
  @Post('sold/return-bulk')
  bulkReturnSoldLines(
    @Body() body: { soldIds: string[]; palletId?: string },
    @Req() req: any,
  ) {
    return this.pallets.bulkReturnSoldLines(
      body?.soldIds ?? [],
      body?.palletId,
      req.user.userId,
    );
  }

  // Returning sold goods to inventory needs the return_sold permission.
  @RequirePermissions('return_sold')
  @Post('sold/:soldId/return')
  returnSoldLine(
    @Param('soldId') soldId: string,
    @Body() body: { palletId?: string | null },
    @Req() req: any,
  ) {
    return this.pallets.returnSoldLine(soldId, body?.palletId, req.user.userId);
  }

  // --- lines ---

  @RequirePermissions('pallets')
  @Post(':id/lines')
  addLine(@Param('id') id: string, @Body() dto: CreatePalletLineDto) {
    return this.pallets.addLine(id, dto);
  }

  @RequirePermissions('pallets')
  @Patch(':id/lines/:lineId')
  updateLine(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() dto: UpdatePalletLineDto,
  ) {
    return this.pallets.updateLine(id, lineId, dto);
  }

  // Removing a mistyped line is content-correction (input), not deleting the
  // whole pallet — it stays under the pallets permission. Whole-pallet delete
  // needs delete_pallet.
  @RequirePermissions('pallets')
  @Delete(':id/lines/:lineId')
  removeLine(@Param('id') id: string, @Param('lineId') lineId: string) {
    return this.pallets.removeLine(id, lineId);
  }
}
