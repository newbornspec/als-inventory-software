import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { LocationsService } from './locations.service';

@Controller('locations')
@UseGuards(JwtAuthGuard)
export class LocationsController {
  constructor(private locations: LocationsService) {}

  @Get()
  findAll() {
    return this.locations.findAll();
  }
}
