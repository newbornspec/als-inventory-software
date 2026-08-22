import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/guards/permissions.decorator';
import { ExpectedLineItemsService } from './expected-line-items.service';
import { ImportExpectedDto } from './dto/import-expected.dto';

// Expected inventory for a purchase lot — nested under the lot it belongs to.
@Controller('batches/:batchId/expected')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ExpectedLineItemsController {
  constructor(private expected: ExpectedLineItemsService) {}

  @RequirePermissions('goods_in')
  @Get()
  findForBatch(@Param('batchId') batchId: string) {
    return this.expected.findForBatch(batchId);
  }

  // The receiving diff: expected supplier list vs. what was actually scanned in.
  @RequirePermissions('goods_in')
  @Get('reconciliation')
  reconcile(@Param('batchId') batchId: string) {
    return this.expected.reconcile(batchId);
  }

  // Bulk import of parsed supplier rows — replaces any existing expected list
  // for this lot. Import requires the edit_batch permission.
  @RequirePermissions('edit_batch')
  @Post('import')
  import(@Param('batchId') batchId: string, @Body() dto: ImportExpectedDto, @Req() req: any) {
    return this.expected.importForBatch(batchId, dto, req.user);
  }

  @RequirePermissions('clear_manifest')
  @Delete()
  clear(@Param('batchId') batchId: string) {
    return this.expected.clearForBatch(batchId);
  }
}
