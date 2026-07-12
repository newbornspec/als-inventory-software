import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssetPhoto } from './asset-photo.entity';
import { Asset } from '../assets/asset.entity';
import { PhotosController } from './photos.controller';
import { PhotosService } from './photos.service';

@Module({
  imports: [TypeOrmModule.forFeature([AssetPhoto, Asset])],
  controllers: [PhotosController],
  providers: [PhotosService],
})
export class PhotosModule {}
