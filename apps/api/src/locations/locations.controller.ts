import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { AnyAuthenticated } from '../auth/guards/permissions.decorator';
import { LocationsService } from './locations.service';

@Controller('locations')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class LocationsController {
  constructor(private locations: LocationsService) {}

  // Reference data: the location dropdown appears on asset forms across every
  // module, so any signed-in user may read the list. Explicitly declared, not
  // defaulted — PermissionsGuard fails closed.
  @AnyAuthenticated()
  @Get()
  findAll() {
    return this.locations.findAll();
  }
}
