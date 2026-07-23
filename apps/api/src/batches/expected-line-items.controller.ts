import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/guards/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/user.entity';
import { ExpectedLineItemsService } from './expected-line-items.service';
import { ImportExpectedDto } from './dto/import-expected.dto';

// Expected inventory for a purchase lot — nested under the lot it belongs to.
@Controller('batches/:batchId/expected')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ExpectedLineItemsController {
  constructor(private expected: ExpectedLineItemsService) {}

  @Get()
  findForBatch(@Param('batchId') batchId: string) {
    return this.expected.findForBatch(batchId);
  }

  // The receiving diff: expected supplier list vs. what was actually scanned in.
  @Get('reconciliation')
  reconcile(@Param('batchId') batchId: string) {
    return this.expected.reconcile(batchId);
  }

  // Bulk import of parsed supplier rows — replaces any existing expected list
  // for this lot. Import is a manager/admin action (same as creating the lot).
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @Post('import')
  import(@Param('batchId') batchId: string, @Body() dto: ImportExpectedDto, @Req() req: any) {
    return this.expected.importForBatch(batchId, dto, req.user);
  }

  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @Delete()
  clear(@Param('batchId') batchId: string) {
    return this.expected.clearForBatch(batchId);
  }
}
