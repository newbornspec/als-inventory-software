import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Location } from './location.entity';

@Injectable()
export class LocationsService {
  constructor(@InjectRepository(Location) private locations: Repository<Location>) {}

  findAll(): Promise<Location[]> {
    return this.locations.find({ order: { name: 'ASC' } });
  }
}
